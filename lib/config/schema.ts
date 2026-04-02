import { DEFAULTS } from './defaults.js'
export interface DownloadOptions {
	headless?: boolean
	userAgent?: string
	timeout?: number
	downloadButtonTimeout?: number
	retries?: number
	retryDelay?: number
	onProgress?: (
		percent: number,
		total: 100,
		meta: { stage: string; message: string; attempt?: number },
	) => void
	correlationId?: string
	debug?: boolean
	saveDebugArtifacts?: boolean
	logFile?: string
	_internal?: {
		stage?: string
	}
}
export interface DownloadResult {
	filePath: string
	size: number
	method: 'direct' | 'fallback'
	correlationId?: string
	durationMs?: number
	attempts?: number
}
type NormalizedOptions = Required<
	Omit<DownloadOptions, 'onProgress' | 'correlationId' | '_internal' | 'logFile'>
> & {
	onProgress?: DownloadOptions['onProgress']
	correlationId?: string
	_internal?: DownloadOptions['_internal']
	logFile?: string
}
export function normalizeOptions(opts?: DownloadOptions): NormalizedOptions {
	const base = {
		headless: opts?.headless ?? DEFAULTS.headless,
		userAgent: opts?.userAgent ?? DEFAULTS.userAgent,
		timeout: opts?.timeout ?? DEFAULTS.timeout,
		downloadButtonTimeout: opts?.downloadButtonTimeout ?? DEFAULTS.downloadButtonTimeout,
		retries: opts?.retries ?? DEFAULTS.retries,
		retryDelay: opts?.retryDelay ?? DEFAULTS.retryDelay,
		debug: opts?.debug ?? false,
		saveDebugArtifacts: opts?.saveDebugArtifacts ?? DEFAULTS.saveDebugArtifacts,
	}
	const optional = {
		...(opts?.onProgress !== undefined && { onProgress: opts.onProgress }),
		...(opts?.correlationId !== undefined && { correlationId: opts.correlationId }),
		...(opts?._internal !== undefined && { _internal: opts._internal }),
		...(opts?.logFile !== undefined && { logFile: opts.logFile }),
	}
	return { ...base, ...optional } as NormalizedOptions
}
