import { createWriteStream } from "fs";
import { CONFIG } from "./config.js";
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LEVELS[CONFIG.logging.level] ?? LEVELS.INFO;
let logStream = null;
if (CONFIG.logging.file) {
  logStream = createWriteStream(CONFIG.logging.file, { flags: "a" });
}
function formatMessage(message, level, meta = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] ${level}`;
  if (CONFIG.logging.json) {
    return JSON.stringify({ timestamp, level, message, ...meta }) + "\n";
  }
  const metaStr =
    Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `${prefix}: ${message}${metaStr}\n`;
}
function log(message, level = "INFO", meta = {}) {
  if (LEVELS[level] < currentLevel) return;
  const formatted = formatMessage(message, level, meta);
  const colors = {
    DEBUG: "\x1b[36m",
    INFO: "\x1b[32m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  if (level !== "DEBUG" || CONFIG.debug.enabled) {
    console.log(`${colors[level] || ""}${formatted.trim()}${reset}`);
  }
  if (logStream) {
    logStream.write(formatted);
  }
}
export const Logger = {
  debug: (msg, meta) => log(msg, "DEBUG", meta),
  info: (msg, meta) => log(msg, "INFO", meta),
  warn: (msg, meta) => log(msg, "WARN", meta),
  error: (msg, meta) => log(msg, "ERROR", meta),
  progress: (current, total, label = "") => {
    const percent = Math.round((current / total) * 100);
    const bar = "█".repeat(percent / 5) + "░".repeat(20 - percent / 5);
    log(`[${bar}] ${percent}% ${label}`, "INFO");
  },
  close: () => logStream?.end(),
};
process.on("SIGINT", () => {
  Logger.info("Shutting down logger...");
  Logger.close();
  process.exit(0);
});
