import { DEFAULTS } from './defaults.js'
export interface DownloadOptions {
	headless?: boolean
	debug?: boolean
	userAgent?: string
	timeout?: number
}
export interface DownloadResult {
	filePath: string
	size: number
	method: 'direct' | 'fallback'
}
export function normalizeOptions(opts?: DownloadOptions) {
	return {
		headless: opts?.headless ?? DEFAULTS.headless,
		debug: opts?.debug ?? false,
		userAgent: opts?.userAgent ?? DEFAULTS.userAgent,
		timeout: opts?.timeout ?? DEFAULTS.timeout,
	}
}
