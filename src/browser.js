import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { Logger } from "./logger.js";
import { CONFIG } from "./config.js";
import { sleep } from "./utils.js";
const BROWSER_LAUNCH_RETRIES = 3;
const BROWSER_LAUNCH_DELAY = 1000;
const PAGE_CRASH_RECOVERY_ATTEMPTS = 2;
const MEMORY_WARNING_THRESHOLD = 1024 * 1024 * 1024;
export class BrowserManager {
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleLogs = [];
    this.networkLogs = [];
    this.isClosed = false;
    this._eventListeners = new Map();
    this._healthCheckInterval = null;
    this.options = {
      enableStealth: options.enableStealth ?? false,
      blockResources: options.blockResources ?? true,
      enableProxy: options.enableProxy ?? true,
      ...options,
    };
  }
  async launch() {
    let lastError;
    for (let attempt = 1; attempt <= BROWSER_LAUNCH_RETRIES; attempt++) {
      try {
        Logger.debug(
          `Browser launch attempt ${attempt}/${BROWSER_LAUNCH_RETRIES}`,
        );
        const launchOptions = await this._buildLaunchOptions();
        this.browser = await chromium.launch(launchOptions);
        await this._verifyBrowserHealth();
        await this._createContext();
        await this._setupPageProtections();
        Logger.info("Browser launched successfully", {
          headless: CONFIG.browser.headless,
          proxy: !!launchOptions.proxy,
          stealth: this.options.enableStealth,
        });
        return this;
      } catch (err) {
        lastError = err;
        Logger.warn(`Browser launch attempt ${attempt} failed: ${err.message}`);
        await this._safeCleanup();
        if (attempt < BROWSER_LAUNCH_RETRIES) {
          const delay = BROWSER_LAUNCH_DELAY * attempt;
          Logger.info(`Retrying browser launch in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }
    throw new Error(
      `Failed to launch browser after ${BROWSER_LAUNCH_RETRIES} attempts: ${lastError?.message}`,
    );
  }
  async _buildLaunchOptions() {
    const options = {
      headless: CONFIG.browser.headless,
      args: this._buildBrowserArgs(),
    };
    if (this.options.enableProxy && CONFIG.browser.proxy?.server) {
      options.proxy = {
        server: CONFIG.browser.proxy.server,
        username: CONFIG.browser.proxy.username,
        password: CONFIG.browser.proxy.password,
        bypass: CONFIG.browser.proxy.bypass,
      };
      Logger.debug("Proxy configured", { server: CONFIG.browser.proxy.server });
    }
    if (this.options.enableStealth) {
      try {
        const { chromium: stealthChromium } = await import("playwright-extra");
        const stealth = await import("puppeteer-extra-plugin-stealth");
        stealthChromium.use(stealth.default());
        return { ...options, chromium: stealthChromium };
      } catch (err) {
        Logger.warn("Stealth plugin not available, continuing without", {
          error: err.message,
        });
      }
    }
    return options;
  }
  _buildBrowserArgs() {
    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--window-position=0,0",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
    ];
    if (CONFIG.browser.headless) {
      args.push("--disable-extensions", "--disable-background-networking");
    }
    if (CONFIG.debug.enabled) {
      args.push("--remote-debugging-port=9222");
    }
    return args;
  }
  async _verifyBrowserHealth() {
    try {
      const version = await this.browser.version();
      if (!version) throw new Error("Browser version check failed");
      Logger.debug("Browser health check passed", { version });
      return true;
    } catch (err) {
      Logger.error("Browser health check failed", { error: err.message });
      throw err;
    }
  }
  async _createContext() {
    const contextOptions = {
      userAgent: CONFIG.browser.userAgent,
      viewport: CONFIG.browser.viewport,
      acceptDownloads: true,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "no-preference",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    };
    this.context = await this.browser.newContext(contextOptions);
    await this.context.addCookies([
      {
        name: "safe_link_counter",
        value: "1",
        domain: ".sfile.co",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);
    Logger.debug("Browser context created with anti-detection settings");
  }
  async _setupPageProtections() {
    this.page = await this.context.newPage();
    this.page.on("crash", () => this._handlePageCrash());
    this.page.on("close", () => this._handlePageClose());
    this._setupListeners();
    if (this.options.blockResources) {
      await this._blockUnnecessaryResources();
    }
    if (CONFIG.debug.enabled) {
      this._startHealthMonitoring();
    }
    Logger.debug("Page protections enabled");
  }
  async _blockUnnecessaryResources() {
    await this.page.route(
      "**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,ico}",
      (route) => {
        route.abort("blockedbyclient");
      },
    );
    const blockPatterns = [
      "**/ads/**",
      "**/analytics/**",
      "**/tracking/**",
      "**/doubleclick.net/**",
      "**/googletagmanager.com/**",
    ];
    for (const pattern of blockPatterns) {
      await this.page.route(pattern, (route) => route.abort("blockedbyclient"));
    }
    Logger.debug("Resource blocking enabled for performance");
  }
  _setupListeners() {
    const consoleHandler = (msg) => {
      const entry = {
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: Date.now(),
      };
      this.consoleLogs.push(entry);
      if (CONFIG.debug.enabled || entry.type === "error") {
        Logger.debug(`[CONSOLE] ${entry.type}: ${entry.text}`);
      }
    };
    this.page.on("console", consoleHandler);
    this._eventListeners.set("console", {
      target: this.page,
      handler: consoleHandler,
    });
    const errorHandler = (err) => {
      Logger.error(`[PAGE ERROR] ${err.message}`, { stack: err.stack });
      this.consoleLogs.push({
        type: "pageerror",
        text: err.message,
        timestamp: Date.now(),
      });
    };
    this.page.on("pageerror", errorHandler);
    this._eventListeners.set("pageerror", {
      target: this.page,
      handler: errorHandler,
    });
    if (CONFIG.debug.enabled) {
      const reqHandler = (req) => {
        this.networkLogs.push({
          type: "request",
          url: req.url(),
          method: req.method(),
          timestamp: Date.now(),
        });
        Logger.debug(`[REQ] ${req.method()} ${req.url().slice(0, 80)}`);
      };
      const resHandler = (res) => {
        this.networkLogs.push({
          type: "response",
          url: res.url(),
          status: res.status(),
          timestamp: Date.now(),
        });
        Logger.debug(`[RES] ${res.status()} ${res.url().slice(0, 80)}`);
      };
      this.page.on("request", reqHandler);
      this.page.on("response", resHandler);
      this._eventListeners.set("request", {
        target: this.page,
        handler: reqHandler,
      });
      this._eventListeners.set("response", {
        target: this.page,
        handler: resHandler,
      });
    }
    const failHandler = (req) => {
      Logger.warn(
        `[REQ FAILED] ${req.failure()?.errorText} - ${req.url().slice(0, 80)}`,
      );
    };
    this.page.on("requestfailed", failHandler);
    this._eventListeners.set("requestfailed", {
      target: this.page,
      handler: failHandler,
    });
  }
  async _handlePageCrash() {
    Logger.error("Page crashed! Attempting recovery...");
    for (let attempt = 1; attempt <= PAGE_CRASH_RECOVERY_ATTEMPTS; attempt++) {
      try {
        Logger.info(
          `Recovery attempt ${attempt}/${PAGE_CRASH_RECOVERY_ATTEMPTS}`,
        );
        if (this.context) {
          this.page = await this.context.newPage();
          this._setupListeners();
          if (this.options.blockResources) {
            await this._blockUnnecessaryResources();
          }
          Logger.info("Page recovered successfully");
          return true;
        }
      } catch (err) {
        Logger.warn(`Recovery attempt ${attempt} failed: ${err.message}`);
        if (attempt === PAGE_CRASH_RECOVERY_ATTEMPTS) {
          Logger.error("Page recovery failed, browser restart required");
          await this.close();
          return false;
        }
        await sleep(1000 * attempt);
      }
    }
    return false;
  }
  _handlePageClose() {
    Logger.debug("Page closed");
    this.page = null;
  }
  _startHealthMonitoring() {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(async () => {
      if (!this.page || this.isClosed) return;
      try {
        const client = await this.page.context().newCDPSession(this.page);
        const { metrics } = await client.send("Performance.getMetrics");
        const jsHeap =
          metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0;
        if (jsHeap > MEMORY_WARNING_THRESHOLD) {
          Logger.warn(
            `High memory usage detected: ${(jsHeap / 1024 / 1024).toFixed(2)} MB`,
          );
        }
        await client.detach();
      } catch (err) {}
    }, 30000);
  }
  async newPage() {
    if (this.isClosed) {
      throw new Error("BrowserManager is closed. Call launch() first.");
    }
    this.page = await this.context.newPage();
    this._setupListeners();
    if (this.options.blockResources) {
      await this._blockUnnecessaryResources();
    }
    Logger.debug("New page created with protections");
    return this.page;
  }
  async saveDebugArtifacts(dir = null) {
    if (this.isClosed || !CONFIG.debug.saveArtifacts) return null;
    try {
      const artifactsDir =
        dir ||
        CONFIG.debug.artifactsDir ||
        join(process.cwd(), "debug_artifacts", `session_${Date.now()}`);
      await mkdir(artifactsDir, { recursive: true });
      const tasks = [];
      if (this.page && !this.page.isClosed()) {
        tasks.push(
          this.page
            .screenshot({
              path: join(artifactsDir, "screenshot.png"),
              fullPage: true,
            })
            .catch((err) =>
              Logger.warn("Screenshot failed", { error: err.message }),
            ),
        );
        tasks.push(
          this.page
            .content()
            .then((html) => writeFile(join(artifactsDir, "page.html"), html))
            .catch((err) =>
              Logger.warn("HTML save failed", { error: err.message }),
            ),
        );
      }
      tasks.push(
        writeFile(
          join(artifactsDir, "console.json"),
          JSON.stringify(this.consoleLogs, null, 2),
        ).catch((err) =>
          Logger.warn("Console log save failed", { error: err.message }),
        ),
      );
      if (CONFIG.debug.enabled) {
        tasks.push(
          writeFile(
            join(artifactsDir, "network.json"),
            JSON.stringify(this.networkLogs, null, 2),
          ).catch((err) =>
            Logger.warn("Network log save failed", { error: err.message }),
          ),
        );
      }
      await Promise.allSettled(tasks);
      Logger.info(`Debug artifacts saved to ${artifactsDir}`);
      return artifactsDir;
    } catch (err) {
      Logger.error(`Failed to save artifacts: ${err.message}`);
      return null;
    }
  }
  async _safeCleanup() {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch (err) {
      Logger.warn("Cleanup encountered error", { error: err.message });
    }
  }
  async close() {
    if (this.isClosed) return;
    this.isClosed = true;
    Logger.debug("Starting graceful shutdown...");
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
    for (const [name, { target, handler }] of this._eventListeners) {
      try {
        target.off(name, handler);
      } catch (err) {
        Logger.warn(`Failed to remove listener ${name}`, {
          error: err.message,
        });
      }
    }
    this._eventListeners.clear();
    this.consoleLogs = [];
    this.networkLogs = [];
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close();
        Logger.debug("Page closed");
      }
    } catch (err) {
      Logger.warn("Page close error", { error: err.message });
    }
    try {
      if (this.context) {
        await this.context.close();
        Logger.debug("Context closed");
      }
    } catch (err) {
      Logger.warn("Context close error", { error: err.message });
    }
    try {
      if (this.browser) {
        await this.browser.close();
        Logger.debug("Browser closed");
      }
    } catch (err) {
      Logger.warn("Browser close error", { error: err.message });
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    Logger.info("BrowserManager shutdown complete");
  }
  getStatus() {
    return {
      isClosed: this.isClosed,
      hasBrowser: !!this.browser,
      hasContext: !!this.context,
      hasPage: !!this.page && !this.page?.isClosed(),
      consoleLogCount: this.consoleLogs.length,
      networkLogCount: this.networkLogs.length,
      memory: process.memoryUsage
        ? {
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            heapTotal: Math.round(
              process.memoryUsage().heapTotal / 1024 / 1024,
            ),
          }
        : null,
    };
  }
}
export const createBrowserManager = (options) => new BrowserManager(options);
