import * as path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { BrowserManager } from '../browser/browser-manager.js'
import { Logger } from '../utils/logger.js'
import { NetworkError, AppError } from '../errors/index.js'
import { DownloadOptions, DownloadResult, normalizeOptions } from '../config/schema.js'
import { DEFAULTS } from '../config/defaults.js'
import { InputValidator } from './validator.js'
import { sleep, calculateRetryDelay } from '../utils/helpers.js'
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}
function safeProgress(
	onProgress: unknown,
	percent: number,
	total: number,
	meta: Record<string, unknown>,
): void {
	if (typeof onProgress === 'function') {
		try {
			;(onProgress as any)(percent, total, meta)
		} catch (err) {
			console.warn('Progress callback error:', err)
		}
	}
}
async function executeDownload(
	url: string,
	saveDir: string,
	opts: ReturnType<typeof normalizeOptions>,
	logger: Logger,
): Promise<DownloadResult> {
	const startTime = Date.now()
	const browserMgr = new BrowserManager(logger.child('BrowserManager'), {
		headless: opts.headless,
		userAgent: opts.userAgent,
		timeout: opts.timeout,
		debug: opts.debug,
		downloadButtonTimeout: opts.downloadButtonTimeout,
	})
	let finalPath: string
	let fileSize: number
	let method: 'direct' | 'fallback'
	try {
		logger.info('Starting download workflow', { url })
		safeProgress(opts.onProgress, 10, 100, {
			stage: 'launch',
			message: 'Launching browser',
			attempt: 1,
		})
		await browserMgr.launch()
		await browserMgr.goto(url, 'networkidle')
		safeProgress(opts.onProgress, 30, 100, { stage: 'navigation', message: 'Page loaded' })
		await browserMgr.waitForDownloadButton()
		safeProgress(opts.onProgress, 50, 100, {
			stage: 'button',
			message: 'Download button ready',
		})
		const intermediateUrl = await browserMgr.getIntermediateUrl()
		const autoUrl = intermediateUrl.includes('?')
			? `${intermediateUrl}&auto=1`
			: `${intermediateUrl}?auto=1`
		logger.debug('Triggering download', { autoUrl })
		safeProgress(opts.onProgress, 70, 100, { stage: 'trigger', message: 'Download triggered' })
		let download = await browserMgr.startDownloadAndWait(autoUrl)
		if (download) {
			const suggested = download.suggestedFilename() || 'file.bin'
			const filename = InputValidator.sanitizeFilename(suggested)
			finalPath = path.join(saveDir, filename)
			await download.saveAs(finalPath)
			const stat = await fs.stat(finalPath)
			fileSize = stat.size
			method = 'direct'
			logger.info('Saved via direct download', { path: finalPath, size: fileSize })
		} else {
			logger.warn('Direct download not captured, trying fallback')
			const fallback = await browserMgr.fallbackCollectFileResponse()
			if (!fallback) {
				throw new NetworkError('No download event and no file response found', {
					url,
					intermediateUrl,
					autoUrl,
					stage: 'fallbackFailed',
				})
			}
			const { buffer, filename: rawName } = fallback
			const filename = InputValidator.sanitizeFilename(rawName)
			finalPath = path.join(saveDir, filename)
			await fs.writeFile(finalPath, buffer)
			fileSize = buffer.length
			method = 'fallback'
			logger.info('Saved via fallback', { path: finalPath, size: fileSize })
		}
		safeProgress(opts.onProgress, 100, 100, { stage: 'complete', message: 'Download finished' })
		const result: DownloadResult = {
			filePath: finalPath,
			size: fileSize,
			method,
			durationMs: Date.now() - startTime,
			attempts: 1,
		}
		if (opts.correlationId !== undefined) {
			result.correlationId = opts.correlationId
		}
		return result
	} catch (err: unknown) {
		const error = err instanceof Error ? err : new Error(String(err))
		const appError =
			error instanceof AppError
				? error
				: new NetworkError(error.message, {
						url,
						saveDir,
						correlationId: opts.correlationId,
						originalError: error.message,
						errorName: error.name,
					})
		if (opts.saveDebugArtifacts) {
			const debugPath = await browserMgr.saveDebugArtifacts(appError.message)
			if (debugPath) {
				;(appError as any).debugPath = debugPath
				if (appError.context && typeof appError.context === 'object') {
					;(appError.context as any).debugPath = debugPath
				}
			}
		}
		throw appError
	} finally {
		await browserMgr
			.close()
			.catch((e) => logger.error('Failed to close browser', { error: e.message }))
		await logger.close().catch((e) => console.error('Failed to close logger', e))
	}
}
export async function downloadSfile(
	url: string,
	saveDir: string,
	options?: DownloadOptions,
): Promise<DownloadResult> {
	const opts = normalizeOptions(options)
	const correlationId = opts.correlationId || randomUUID()
	type LoggerConstructorParams = ConstructorParameters<typeof Logger>
	type LoggerOptionsType = LoggerConstructorParams[0]
	const loggerOptions: LoggerOptionsType = {
		debugMode: opts.debug,
		correlationId,
		prefix: 'downloadSfile',
	}
	if (opts.logFile !== undefined) {
		loggerOptions.logFile = opts.logFile
	}
	const logger = new Logger(loggerOptions)
	InputValidator.validateUrl(url)
	InputValidator.validateSaveDir(saveDir)
	InputValidator.validateOptions(options)
	await fs.mkdir(saveDir, { recursive: true })
	let lastError: Error | undefined
	let attempt = 0
	while (attempt < opts.retries) {
		attempt++
		try {
			logger.info(`Download attempt ${attempt}/${opts.retries}`, { url })
			const result = await executeDownload(url, saveDir, opts, logger)
			logger.info(`Download succeeded`, {
				duration: result.durationMs,
				attempts: attempt,
				method: result.method,
			})
			return {
				...result,
				attempts: attempt,
				correlationId,
			}
		} catch (err: unknown) {
			lastError = err instanceof Error ? err : new Error(String(err))
			const isRetryable = lastError instanceof AppError && lastError.retryable
			const isLastAttempt = attempt >= opts.retries
			if (!isRetryable || isLastAttempt) {
				logger.error(`Download failed permanently`, {
					error: lastError.message,
					attempt,
					retryable: isRetryable,
					lastAttempt: isLastAttempt,
				})
				throw lastError
			}
			const delay = calculateRetryDelay(attempt, opts.retryDelay, DEFAULTS.maxRetryDelay)
			logger.warn(`Retrying download`, {
				attempt,
				maxAttempts: opts.retries,
				delayMs: Math.round(delay),
				error: lastError.message,
			})
			safeProgress(opts.onProgress, 0, 100, {
				stage: 'retry',
				message: `Retry ${attempt}/${opts.retries}`,
				attempt,
			})
			await sleep(delay)
		}
	}
	throw lastError || new Error('Download failed after all retries')
}
export async function downloadSfileSafe(
	url: string,
	saveDir: string,
	options?: DownloadOptions,
): Promise<import('../utils/result.js').Result<DownloadResult, Error>> {
	try {
		const result = await downloadSfile(url, saveDir, options)
		return { success: true, value: result }
	} catch (error) {
		return { success: false, error: error as Error }
	}
}
export function createDownloader(defaultOptions?: DownloadOptions) {
	const defaults = normalizeOptions(defaultOptions)
	return {
		async download(
			url: string,
			saveDir: string,
			callOptions?: DownloadOptions,
		): Promise<DownloadResult> {
			const merged = stripUndefined({ ...defaults, ...callOptions })
			return downloadSfile(url, saveDir, merged as DownloadOptions)
		},
		async downloadSafe(
			url: string,
			saveDir: string,
			callOptions?: DownloadOptions,
		): Promise<import('../utils/result.js').Result<DownloadResult, Error>> {
			const merged = stripUndefined({ ...defaults, ...callOptions })
			return downloadSfileSafe(url, saveDir, merged as DownloadOptions)
		},
		withOptions(newDefaults: Partial<DownloadOptions>) {
			const merged = stripUndefined({ ...defaults, ...newDefaults })
			return createDownloader(merged as DownloadOptions)
		},
	}
}
