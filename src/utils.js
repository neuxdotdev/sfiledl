import { createHash } from "crypto";
import { createReadStream } from "fs";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const exponentialBackoff = (attempt, config) => {
  const delay = Math.min(
    config.initialDelay * Math.pow(config.backoffFactor, attempt - 1),
    config.maxDelay,
  );
  return delay + Math.random() * 1000;
};
export const calculateMD5 = async (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
};
