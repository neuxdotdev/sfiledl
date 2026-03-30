import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const DEFAULT_CONFIG = {
  browser: {
    headless: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    proxy: null,
  },
  timeouts: {
    pageLoad: 60000,
    buttonWait: 30000,
    download: 120000,
    fallback: 10000,
  },
  retry: {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2,
  },
  rateLimit: {
    enabled: true,
    minDelay: 2000,
  },
  download: {
    chunkSize: 1024 * 1024,
    validateChecksum: false,
    resumeEnabled: false,
  },
  logging: {
    level: "INFO",
    file: null,
    json: false,
  },
  debug: {
    enabled: false,
    saveArtifacts: true,
    artifactsDir: null,
  },
  batch: {
    concurrency: 1,
    stopOnError: true,
  },
  notifications: {
    webhook: null,
    onSuccess: false,
    onError: true,
  },
};
function loadConfigFile() {
  const configPath = join(rootDir, "sfiledljs.config.json");
  if (!existsSync(configPath)) {
    console.log("[Config] Using default configuration");
    return {};
  }
  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content);
    console.log("[Config] Loaded sfiledljs.config.json");
    return userConfig;
  } catch (error) {
    console.error("[Config] Error reading config file:", error.message);
    return {};
  }
}
function mergeConfig(defaults, user) {
  const result = { ...defaults };
  for (const key in user) {
    if (
      user[key] !== null &&
      typeof user[key] === "object" &&
      !Array.isArray(user[key])
    ) {
      result[key] = mergeConfig(defaults[key] || {}, user[key]);
    } else {
      result[key] = user[key];
    }
  }
  return result;
}
const userConfig = loadConfigFile();
export const CONFIG = mergeConfig(DEFAULT_CONFIG, userConfig);
