import { mkdir, stat, writeFile } from "fs/promises";
import { createWriteStream } from "fs";
import { join, basename } from "path";
import { Logger } from "./logger.js";
import { CONFIG } from "./config.js";
import { BrowserManager } from "./browser.js";
import { validateSfileUrl, sanitizeFilename } from "./validators.js";
import { sleep, exponentialBackoff, calculateMD5 } from "./utils.js";
export class SfileDownloader {
  constructor({ saveDir, onProgress, onComplete, onError } = {}) {
    this.saveDir = saveDir || process.cwd();
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.browserMgr = new BrowserManager();
    this.stats = { attempts: 0, startTime: null, endTime: null };
  }
  async download(url, options = {}) {
    this.stats.startTime = Date.now();
    this.stats.attempts = 0;
    if (!validateSfileUrl(url)) {
      throw new Error(`Invalid sfile.co URL: ${url}`);
    }
    await mkdir(this.saveDir, { recursive: true });
    let lastError;
    for (let attempt = 1; attempt <= CONFIG.retry.maxAttempts; attempt++) {
      this.stats.attempts = attempt;
      Logger.info(`Download attempt ${attempt}/${CONFIG.retry.maxAttempts}`, {
        url,
      });
      try {
        const result = await this._executeDownload(url, options);
        this.stats.endTime = Date.now();
        result.duration = this.stats.endTime - this.stats.startTime;
        result.attempts = attempt;
        Logger.info("Download successful", {
          file: result.filename,
          size: result.size,
          duration: `${result.duration}ms`,
        });
        this.onComplete?.(result);
        return result;
      } catch (err) {
        lastError = err;
        Logger.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < CONFIG.retry.maxAttempts) {
          const delay = exponentialBackoff(attempt, CONFIG.retry);
          Logger.info(`Retrying in ${delay}ms...`);
          await sleep(delay);
          await this._resetPage();
        }
      }
    }
    this.stats.endTime = Date.now();
    const errorInfo = {
      url,
      message: lastError.message,
      attempts: this.stats.attempts,
      duration: this.stats.endTime - this.stats.startTime,
    };
    Logger.error("All download attempts failed", errorInfo);
    this.onError?.(errorInfo);
    throw lastError;
  }
  async _executeDownload(url, options) {
    if (!this.browserMgr.browser) {
      await this.browserMgr.launch();
    }
    const page = await this.browserMgr.newPage();
    try {
      Logger.debug("Navigating to initial URL");
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: CONFIG.timeouts.pageLoad,
      });
      Logger.debug("Waiting for #download button");
      const button = page.locator("#download");
      await button.waitFor({
        state: "visible",
        timeout: CONFIG.timeouts.buttonWait,
      });
      Logger.debug("Waiting for button to become active");
      await page.waitForFunction(
        () => {
          const btn = document.querySelector("#download");
          if (!btn) return false;
          const href = btn.getAttribute("href");
          const style = window.getComputedStyle(btn);
          return href && href !== "#" && style.pointerEvents !== "none";
        },
        { timeout: CONFIG.timeouts.buttonWait },
      );
      const intermediateUrl = await page.$eval("#download", (el) => el.href);
      Logger.debug("Intermediate URL extracted", { url: intermediateUrl });
      const autoUrl = intermediateUrl.includes("?")
        ? `${intermediateUrl}&auto=1`
        : `${intermediateUrl}?auto=1`;
      Logger.debug("Setting up download event listener");
      const downloadPromise = page
        .waitForEvent("download", { timeout: CONFIG.timeouts.download })
        .catch((err) => {
          Logger.warn("Download event timeout", { error: err.message });
          return null;
        });
      Logger.debug("Navigating to auto URL");
      await page.goto(autoUrl, {
        waitUntil: "commit",
        timeout: CONFIG.timeouts.pageLoad,
      });
      const download = await downloadPromise;
      if (download) {
        return await this._handleDirectDownload(download);
      } else {
        Logger.warn("Falling back to response interception");
        return await this._handleFallbackDownload(page);
      }
    } catch (err) {
      await this.browserMgr.saveDebugArtifacts();
      throw err;
    }
  }
  async _handleDirectDownload(download) {
    const filename = sanitizeFilename(
      download.suggestedFilename() || "file.bin",
    );
    const savePath = join(this.saveDir, filename);
    Logger.info("Saving file via download event", { filename });
    let downloaded = 0;
    const stream = await download.createReadStream();
    const writeStream = createWriteStream(savePath);
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => {
        downloaded += chunk.length;
        writeStream.write(chunk);
        if (this.onProgress && downloaded % CONFIG.download.chunkSize < 1024) {
          this.onProgress({ downloaded, total: null, filename });
        }
      });
      stream.on("end", async () => {
        writeStream.end();
        const stats = await stat(savePath);
        if (CONFIG.download.validateChecksum) {
          const md5 = await calculateMD5(savePath);
          Logger.debug("File checksum", { md5 });
        }
        resolve({
          success: true,
          filename,
          path: savePath,
          size: stats.size,
          method: "direct",
        });
      });
      stream.on("error", reject);
      writeStream.on("error", reject);
    });
  }
  async _handleFallbackDownload(page) {
    const responses = [];
    const onResponse = (res) => responses.push(res);
    page.on("response", onResponse);
    await sleep(CONFIG.timeouts.fallback);
    page.off("response", onResponse);
    const fileResponse = responses
      .reverse()
      .find(
        (r) =>
          r.headers()["content-disposition"]?.includes("attachment") ||
          r.url().includes("/downloadfile/"),
      );
    if (!fileResponse) {
      throw new Error("No file response found in fallback mode");
    }
    const buffer = await fileResponse.body();
    const filename = sanitizeFilename(
      basename(fileResponse.url().split("?")[0]) || "file.bin",
    );
    const savePath = join(this.saveDir, filename);
    await writeFile(savePath, buffer);
    Logger.info("File saved via fallback", { filename, size: buffer.length });
    return {
      success: true,
      filename,
      path: savePath,
      size: buffer.length,
      method: "fallback",
    };
  }
  async _resetPage() {
    if (this.browserMgr.page) {
      await this.browserMgr.page.close();
      this.browserMgr.page = null;
    }
  }
  async close() {
    await this.browserMgr.close();
  }
  static async batchDownload(urls, options = {}) {
    const { saveDir, concurrency = CONFIG.batch.concurrency } = options;
    const results = [];
    const queue = [...urls];
    const active = new Set();
    while (queue.length > 0 || active.size > 0) {
      while (active.size < concurrency && queue.length > 0) {
        const url = queue.shift();
        const downloader = new SfileDownloader({ saveDir });
        const promise = downloader
          .download(url)
          .then((res) => ({ success: true, url, result: res }))
          .catch((err) => ({ success: false, url, error: err.message }))
          .finally(() => {
            active.delete(promise);
            downloader.close();
          });
        active.add(promise);
        results.push(promise);
      }
      if (active.size > 0) {
        await Promise.race(active);
      }
    }
    return Promise.all(results);
  }
}
