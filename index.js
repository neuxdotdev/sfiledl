#!/usr/bin/env node
import { readFile } from "fs/promises";
import { SfileDownloader } from "./src/downloader.js";
import { Logger } from "./src/logger.js";
import { CONFIG } from "./src/config.js";
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const [key, value] = args[i].slice(2).split("=");
    flags[key] = value ?? true;
  } else if (args[i].startsWith("-")) {
    flags[args[i].slice(1)] = true;
  } else {
    positional.push(args[i]);
  }
}
const [url, saveDir] = positional;
if (flags.help || flags.h || !url) {
  console.log(`
Sfile Downloader - Super Complete Edition
Usage:
  bun run index.js <url> [saveDir] [options]
Options:
  --headless=false     Run browser with UI
  --debug              Enable debug mode
  --retry=N            Max retry attempts (default: ${CONFIG.retry.maxAttempts})
  --concurrency=N      Batch download concurrency (default: ${CONFIG.batch.concurrency})
  --proxy=URL          Use proxy server
  --log-file=path      Save logs to file
  --json               Output logs as JSON
  --batch=file.txt     Download URLs from file (one per line)
Examples:
  bun run index.js https://sfile.co/xyz ./downloads
  bun run index.js --batch=urls.txt --concurrency=3
  DEBUG=true bun run index.js https://sfile.co/abc
  `);
  process.exit(0);
}
(async () => {
  if (flags.batch) {
    const content = await readFile(flags.batch, "utf-8");
    const urls = content
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u);
    Logger.info(`Starting batch download: ${urls.length} URLs`);
    const results = await SfileDownloader.batchDownload(urls, {
      saveDir: saveDir || process.cwd(),
      concurrency: flags.concurrency || CONFIG.batch.concurrency,
    });
    const success = results.filter((r) => r.success).length;
    Logger.info(`Batch complete: ${success}/${results.length} succeeded`);
    process.exit(success === results.length ? 0 : 1);
  }
  const downloader = new SfileDownloader({
    saveDir: saveDir || process.cwd(),
    onProgress: ({ downloaded, filename }) => {
      Logger.info(`${filename}: ${(downloaded / 1024 / 1024).toFixed(2)} MB`);
    },
    onComplete: (result) => {
      console.log(`Saved: ${result.path}`);
    },
    onError: (err) => {
      console.error(`Failed: ${err.message}`);
    },
  });
  if (flags.debug) CONFIG.debug.enabled = true;
  if (flags.headless === "false") CONFIG.browser.headless = false;
  if (flags.proxy) CONFIG.browser.proxy = { server: flags.proxy };
  if (flags["log-file"]) CONFIG.logging.file = flags["log-file"];
  if (flags.json) CONFIG.logging.json = true;
  if (flags.retry) CONFIG.retry.maxAttempts = parseInt(flags.retry);
  try {
    await downloader.download(url);
    process.exit(0);
  } catch (err) {
    process.exit(1);
  } finally {
    await downloader.close();
    Logger.close();
  }
})();
