export const validateSfileUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("sfile.co");
  } catch {
    return false;
  }
};
export const sanitizeFilename = (name) => {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
};
