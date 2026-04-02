export const DEFAULTS = {
	userAgent:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
	headless: true,
	timeout: 60000,
	downloadButtonTimeout: 30000,
	fallbackWaitMs: 3000,
	retries: 3,
	retryDelay: 1000,
	maxRetryDelay: 30000,
	saveDebugArtifacts: true,
	maxFilenameLength: 255,
	sanitizeReplacement: '_',
} as const
export type Defaults = typeof DEFAULTS
