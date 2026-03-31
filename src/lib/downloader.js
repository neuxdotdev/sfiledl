import { mkdir, stat, writeFile, readFile, unlink, access, rename, open } from 'fs/promises'
import { createWriteStream, createReadStream, existsSync } from 'fs'
import { join, basename, dirname, resolve, extname } from 'path'
import { createHash } from 'crypto'
import EventEmitter from 'events'
import { Logger, createLogger } from './logger.js'
import { CONFIG, ConfigHelper } from './config.js'
import { BrowserManager, BrowserPlugin } from './browser.js'
import {
	validateSfileUrl,
	validateFilename,
	validateFilePath,
	ValidationError,
	SecurityError,
	sanitizeFilename,
} from './validators.js'
import {
	sleep,
	exponentialBackoff,
	withTimeout,
	withRetry,
	calculateFileHash,
	createRateLimiter,
	getMemoryUsage,
	atomicWrite,
	fileExists,
	getFileSize,
} from './utils.js'
const DOWNLOAD_CONSTANTS = Object.freeze({
	STREAM_HIGH_WATER_MARK: 1024 * 1024,
	BACKPRESSURE_THRESHOLD: 2 * 1024 * 1024,
	CHUNK_SIZE_DEFAULT: 1024 * 1024,
	MAX_RECOVERY_ATTEMPTS: 2,
	RECOVERY_DELAY_BASE: 2000,
	CIRCUIT_BREAKER_THRESHOLD: 5,
	CIRCUIT_BREAKER_RESET: 60000,
	TEMP_FILE_SUFFIX: '.tmp',
	LOCK_FILE_SUFFIX: '.lock',
	LOCK_TIMEOUT: 30000,
	ATOMIC_WRITE_RETRIES: 3,
	ETA_SMOOTHING_FACTOR: 0.1,
	PROGRESS_UPDATE_INTERVAL: 1000,
	MIN_THROTTLE_BPS: 100 * 1024,
	MAX_THROTTLE_BPS: 100 * 1024 * 1024,
	SUPPORTED_ALGORITHMS: ['md5', 'sha1', 'sha256', 'sha512'],
	DEFAULT_CHECKSUM_ALGORITHM: 'sha256',
	CHECK_EXISTING_ON_START: true,
	SKIP_IF_SIZE_MATCH: true,
	SKIP_IF_CHECKSUM_MATCH: true,
})
export class DownloadError extends Error {
	constructor(message, code, details = {}) {
		super(message)
		this.name = 'DownloadError'
		this.code = code
		this.details = details
		this.timestamp = new Date().toISOString()
		this.retryable = details.retryable ?? true
		this.fatal = details.fatal ?? false
	}
	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			details: this.details,
			timestamp: this.timestamp,
			retryable: this.retryable,
			fatal: this.fatal,
			stack: process.env.NODE_ENV === 'development' ? this.stack : undefined,
		}
	}
}
export class DownloadValidationError extends DownloadError {
	constructor(message, details = {}) {
		super(message, 'VALIDATION_FAILED', { ...details, retryable: false })
		this.name = 'DownloadValidationError'
	}
}
export class DownloadNetworkError extends DownloadError {
	constructor(message, details = {}) {
		super(message, 'NETWORK_ERROR', { ...details, retryable: true })
		this.name = 'DownloadNetworkError'
	}
}
export class DownloadFileError extends DownloadError {
	constructor(message, details = {}) {
		super(message, 'FILE_ERROR', { ...details, retryable: false })
		this.name = 'DownloadFileError'
	}
}
export class DownloadCancelledError extends DownloadError {
	constructor(message = 'Download cancelled by user') {
		super(message, 'CANCELLED', { retryable: false, fatal: true })
		this.name = 'DownloadCancelledError'
	}
}
export class DownloadState {
	constructor(url, options = {}) {
		this.url = url
		this.state = 'pending'
		this.attempt = 0
		this.startTime = null
		this.endTime = null
		this.filename = null
		this.savePath = null
		this.tempPath = null
		this.expectedSize = null
		this.downloadedBytes = 0
		this.progress = 0
		this.speedBps = 0
		this.etaSeconds = null
		this.lastProgressUpdate = null
		this.checksumAlgorithm =
			options.checksumAlgorithm || DOWNLOAD_CONSTANTS.DEFAULT_CHECKSUM_ALGORITHM
		this.expectedChecksum = options.expectedChecksum || null
		this.actualChecksum = null
		this.metadata = { ...options.metadata }
		this.errors = []
		this.warnings = []
		this.paused = false
		this.cancelled = false
		this._pausePromise = null
		this._cancelSignal = null
	}
	transition(newState, updates = {}) {
		const validTransitions = {
			pending: ['validating', 'cancelled', 'failed'],
			validating: ['preparing', 'failed', 'cancelled'],
			preparing: ['navigating', 'failed', 'cancelled'],
			navigating: ['extracting', 'failed', 'cancelled'],
			extracting: ['downloading', 'failed', 'cancelled'],
			downloading: ['verifying', 'paused', 'failed', 'cancelled'],
			paused: ['downloading', 'cancelled', 'failed'],
			verifying: ['completed', 'failed', 'cancelled'],
			completed: [],
			failed: [],
			cancelled: [],
		}
		const allowed = validTransitions[this.state] || []
		if (!allowed.includes(newState)) {
			throw new DownloadError(
				`Invalid state transition: ${this.state} → ${newState}`,
				'INVALID_STATE_TRANSITION',
				{ currentState: this.state, attemptedState: newState },
			)
		}
		const oldState = this.state
		this.state = newState
		Object.assign(this, updates)
		if (newState === 'downloading' && !this.startTime) {
			this.startTime = Date.now()
		}
		if (['completed', 'failed', 'cancelled'].includes(newState)) {
			this.endTime = Date.now()
		}
		return { oldState, newState, ...updates }
	}
	updateProgress(downloadedBytes, totalBytes = null) {
		this.downloadedBytes = downloadedBytes
		const now = Date.now()
		if (totalBytes) {
			this.expectedSize = totalBytes
			this.progress = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
		}
		if (this.lastProgressUpdate && downloadedBytes > 0) {
			const timeDelta = (now - this.lastProgressUpdate) / 1000
			const bytesDelta = downloadedBytes - (this._lastDownloadedBytes || 0)
			if (timeDelta > 0 && bytesDelta > 0) {
				const instantSpeed = bytesDelta / timeDelta
				this.speedBps = this.speedBps
					? DOWNLOAD_CONSTANTS.ETA_SMOOTHING_FACTOR * instantSpeed +
						(1 - DOWNLOAD_CONSTANTS.ETA_SMOOTHING_FACTOR) * this.speedBps
					: instantSpeed
				if (this.expectedSize && this.speedBps > 0) {
					const remaining = this.expectedSize - downloadedBytes
					this.etaSeconds = Math.ceil(remaining / this.speedBps)
				}
			}
		}
		this._lastDownloadedBytes = downloadedBytes
		this.lastProgressUpdate = now
	}
	async pause() {
		if (this.state !== 'downloading') {
			throw new DownloadError('Can only pause during download', 'INVALID_PAUSE_STATE')
		}
		this.paused = true
		this.transition('paused')
		this._pausePromise = new Promise((resolve, reject) => {
			this._resumeCallback = resolve
			this._pauseReject = reject
		})
		return this._pausePromise
	}
	resume() {
		if (this.state !== 'paused') {
			throw new DownloadError('Can only resume from paused state', 'INVALID_RESUME_STATE')
		}
		this.paused = false
		this.transition('downloading')
		if (this._resumeCallback) {
			this._resumeCallback()
			this._resumeCallback = null
		}
	}
	cancel(reason = 'User cancelled') {
		if (['completed', 'failed', 'cancelled'].includes(this.state)) {
			return
		}
		this.cancelled = true
		this._cancelSignal = reason
		if (this._pauseReject) {
			this._pauseReject(new DownloadCancelledError(reason))
		}
		this.transition('cancelled', { cancelReason: reason })
	}
	recordError(error) {
		this.errors.push({
			message: error.message,
			code: error.code,
			timestamp: new Date().toISOString(),
			stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
		})
	}
	recordWarning(message, details = {}) {
		this.warnings.push({
			message,
			timestamp: new Date().toISOString(),
			...details,
		})
	}
	snapshot() {
		return {
			url: this.url,
			state: this.state,
			attempt: this.attempt,
			filename: this.filename,
			savePath: this.savePath,
			progress: this.progress,
			downloadedBytes: this.downloadedBytes,
			expectedSize: this.expectedSize,
			speedBps: this.speedBps,
			speedHuman: this._formatSpeed(this.speedBps),
			etaSeconds: this.etaSeconds,
			etaHuman: this._formatETA(this.etaSeconds),
			startTime: this.startTime,
			endTime: this.endTime,
			duration: this.endTime && this.startTime ? this.endTime - this.startTime : null,
			checksum: {
				algorithm: this.checksumAlgorithm,
				expected: this.expectedChecksum,
				actual: this.actualChecksum,
				verified:
					this.actualChecksum && this.expectedChecksum
						? this.actualChecksum === this.expectedChecksum
						: null,
			},
			errors: this.errors.slice(-5),
			warnings: this.warnings.slice(-5),
			paused: this.paused,
			cancelled: this.cancelled,
		}
	}
	_formatSpeed(bps) {
		if (!bps || bps < 1024) return `${Math.round(bps)} B/s`
		if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
		return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
	}
	_formatETA(seconds) {
		if (seconds == null || !isFinite(seconds)) return '—'
		if (seconds < 60) return `${Math.round(seconds)}s`
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`
		return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
	}
}
class FileLock {
	constructor(filePath, timeout = DOWNLOAD_CONSTANTS.LOCK_TIMEOUT) {
		this.filePath = filePath
		this.lockPath = `${filePath}${DOWNLOAD_CONSTANTS.LOCK_FILE_SUFFIX}`
		this.timeout = timeout
		this._held = false
		this._releaseFn = null
	}
	async acquire() {
		const startTime = Date.now()
		while (Date.now() - startTime < this.timeout) {
			try {
				const fd = await open(this.lockPath, 'wx')
				await fd.write(
					JSON.stringify({
						pid: process.pid,
						acquired: Date.now(),
						purpose: 'sfile-download',
					}),
				)
				await fd.close()
				this._held = true
				this._releaseFn = async () => {
					try {
						await unlink(this.lockPath)
					} catch (err) {}
					this._held = false
				}
				return true
			} catch (err) {
				if (err.code === 'EEXIST') {
					try {
						const content = await readFile(this.lockPath, 'utf-8')
						const lockInfo = JSON.parse(content)
						const age = Date.now() - lockInfo.acquired
						if (age > 5 * 60 * 1000) {
							globalLogger.warn('Found stale lock file, removing', {
								path: this.lockPath,
								age,
							})
							await unlink(this.lockPath)
							continue
						}
						await sleep(100)
						continue
					} catch (readErr) {
						try {
							await unlink(this.lockPath)
						} catch {}
						continue
					}
				}
				throw err
			}
		}
		throw new DownloadError(
			`Failed to acquire file lock within ${this.timeout}ms`,
			'LOCK_TIMEOUT',
			{ path: this.filePath },
		)
	}
	async release() {
		if (this._held && this._releaseFn) {
			await this._releaseFn()
		}
	}
	async [Symbol.asyncDispose]() {
		await this.release()
	}
}
export class DownloadStrategy {
	constructor(name) {
		this.name = name
	}
	async execute(context) {
		throw new Error('Strategy must implement execute()')
	}
	async isApplicable(context) {
		return true
	}
}
export class DirectDownloadStrategy extends DownloadStrategy {
	constructor() {
		super('direct')
	}
	async isApplicable({ downloadEventAvailable }) {
		return downloadEventAvailable !== false
	}
	async execute({ page, autoUrl, timeout }) {
		globalLogger.debug('Using DirectDownloadStrategy')
		const downloadPromise = page.waitForEvent('download', { timeout }).catch((err) => {
			globalLogger.debug('Download event wait failed', { error: err.message })
			return null
		})
		await page.goto(autoUrl, { waitUntil: 'commit', timeout })
		const download = await downloadPromise
		if (!download) {
			throw new DownloadNetworkError('Download event not triggered', {
				strategy: this.name,
				url: autoUrl,
			})
		}
		return {
			method: 'direct',
			download,
			stream: await download.createReadStream(),
			suggestedFilename: download.suggestedFilename(),
		}
	}
}
export class ResponseInterceptStrategy extends DownloadStrategy {
	constructor() {
		super('response-intercept')
	}
	async execute({ page, autoUrl, timeout, fallbackDelay }) {
		globalLogger.debug('Using ResponseInterceptStrategy')
		const responses = []
		const onResponse = (res) => responses.push(res)
		page.on('response', onResponse)
		await page.goto(autoUrl, { waitUntil: 'commit', timeout })
		await sleep(fallbackDelay || DOWNLOAD_CONSTANTS.RECOVERY_DELAY_BASE)
		page.off('response', onResponse)
		const fileResponse = responses
			.reverse()
			.find(
				(r) =>
					r.headers()['content-disposition']?.includes('attachment') ||
					r.url().includes('/downloadfile/') ||
					r.headers()['content-length']?.length > 0,
			)
		if (!fileResponse) {
			throw new DownloadNetworkError('No file response found', {
				strategy: this.name,
				responsesFound: responses.length,
				url: autoUrl,
			})
		}
		return {
			method: 'response-intercept',
			response: fileResponse,
			stream: await fileResponse.body(),
			suggestedFilename: basename(fileResponse.url().split('?')[0]),
			headers: fileResponse.headers(),
		}
	}
}
export class FetchFallbackStrategy extends DownloadStrategy {
	constructor() {
		super('fetch-fallback')
	}
	async isApplicable({ extractedUrl }) {
		return !!extractedUrl && !extractedUrl.includes('sfile.co/download/')
	}
	async execute({ extractedUrl, timeout }) {
		globalLogger.debug('Using FetchFallbackStrategy')
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), timeout)
		try {
			const response = await fetch(extractedUrl, {
				headers: {
					'User-Agent': CONFIG.browser.userAgent,
					'Accept': '*/*',
				},
				signal: controller.signal,
				redirect: 'follow',
			})
			if (!response.ok) {
				throw new DownloadNetworkError(`HTTP ${response.status}`, {
					status: response.status,
					url: extractedUrl,
				})
			}
			return {
				method: 'fetch-fallback',
				response,
				stream: response.body,
				suggestedFilename:
					response.headers
						.get('content-disposition')
						?.match(/filename[^;=\n]*=["']?([^"'\n;]+)/i)?.[1] ||
					basename(extractedUrl.split('?')[0]),
				headers: Object.fromEntries(response.headers.entries()),
			}
		} finally {
			clearTimeout(timeoutId)
		}
	}
}
export class SfileDownloader extends EventEmitter {
	constructor(options = {}) {
		super()
		this.saveDir = resolve(options.saveDir || process.cwd())
		this.onProgress = options.onProgress
		this.onComplete = options.onComplete
		this.onError = options.onError
		this.browserMgr =
			options.browserMgr ||
			new BrowserManager({
				enableStealth: ConfigHelper.get('browser.stealth.enabled', false),
				blockResources: ConfigHelper.get('browser.blockResources', true),
			})
		this._ownsBrowser = !options.browserMgr
		this.enableChecksum =
			options.enableChecksum ?? ConfigHelper.get('download.validateChecksum', false)
		this.checksumAlgorithm =
			options.checksumAlgorithm || DOWNLOAD_CONSTANTS.DEFAULT_CHECKSUM_ALGORITHM
		this.throttleBps = options.throttleBps || null
		this.skipExisting = options.skipExisting ?? true
		this.chunkSize = options.chunkSize || DOWNLOAD_CONSTANTS.CHUNK_SIZE_DEFAULT
		this.webhooks = {
			onStart: options.webhooks?.onStart,
			onProgress: options.webhooks?.onProgress,
			onComplete: options.webhooks?.onComplete,
			onError: options.webhooks?.onError,
		}
		this._currentDownload = null
		this._downloadHistory = []
		this._circuitBreaker = {
			failures: 0,
			lastFailure: null,
			open: false,
		}
		this._rateLimiter = CONFIG.rateLimit.enabled
			? createRateLimiter({
					tokensPerInterval: 10,
					interval: 1000,
				})
			: null
		this.logger = options.logger?.child?.('downloader') || createLogger('downloader')
		this._setupEventHandlers()
	}
	_setupEventHandlers() {
		this.browserMgr.on('page:error', (err) => {
			this._currentDownload?.recordError(
				new DownloadNetworkError(err.message, { source: 'browser' }),
			)
		})
		this.browserMgr.on('browser:unhealthy', () => {
			this.logger.warn('Browser reported unhealthy, may affect downloads')
		})
	}
	async download(url, options = {}) {
		const urlValidation = validateSfileUrl(url)
		if (!urlValidation.valid) {
			throw new DownloadValidationError(urlValidation.error, {
				code: urlValidation.code,
				details: urlValidation.details,
			})
		}
		if (this._circuitBreaker.open) {
			const elapsed = Date.now() - this._circuitBreaker.lastFailure
			if (elapsed < DOWNLOAD_CONSTANTS.CIRCUIT_BREAKER_RESET) {
				throw new DownloadError(
					'Circuit breaker open - too many recent failures',
					'CIRCUIT_BREAKER_OPEN',
					{ resetIn: DOWNLOAD_CONSTANTS.CIRCUIT_BREAKER_RESET - elapsed },
				)
			}
			this._circuitBreaker = { failures: 0, lastFailure: null, open: false }
		}
		await mkdir(this.saveDir, { recursive: true })
		const state = new DownloadState(url, {
			checksumAlgorithm: this.checksumAlgorithm,
			expectedChecksum: options.expectedChecksum,
			metadata: options.metadata,
		})
		this._currentDownload = state
		this.emit('download:start', state.snapshot())
		await this._notifyWebhook('onStart', state.snapshot())
		let result
		try {
			result = await withRetry(() => this._executeDownloadFlow(state, options), {
				maxAttempts: CONFIG.retry.maxAttempts,
				initialDelay: CONFIG.retry.initialDelay,
				maxDelay: CONFIG.retry.maxDelay,
				backoffFactor: CONFIG.retry.backoffFactor,
				shouldRetry: (err) => {
					return (
						err.retryable !== false &&
						!(err instanceof DownloadValidationError) &&
						!(err instanceof DownloadFileError)
					)
				},
				onRetry: (attempt, err, delay) => {
					state.attempt = attempt
					state.recordWarning(`Retry attempt ${attempt}: ${err.message}`, {
						delay,
					})
					this.logger.info(`Retrying download in ${delay}ms...`, {
						attempt,
						url: url.slice(0, 80),
					})
					this.emit('download:retry', { attempt, error: err.message, delay })
				},
			})
			this._circuitBreaker.failures = 0
			this._downloadHistory.push({
				url,
				result: { ...result, timestamp: Date.now() },
				state: state.snapshot(),
			})
			if (this._downloadHistory.length > 100) {
				this._downloadHistory.shift()
			}
			this.logger.info('Download completed successfully', {
				file: result.filename,
				size: result.size,
				duration: result.duration,
				method: result.method,
			})
			this.emit('download:complete', result)
			await this._notifyWebhook('onComplete', result)
			this.onComplete?.(result)
			return result
		} catch (err) {
			state.recordError(err)
			this._circuitBreaker.failures++
			this._circuitBreaker.lastFailure = Date.now()
			if (this._circuitBreaker.failures >= DOWNLOAD_CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
				this._circuitBreaker.open = true
				this.logger.error('Circuit breaker opened - pausing downloads', {
					failures: this._circuitBreaker.failures,
				})
			}
			const errorInfo = {
				url,
				message: err.message,
				code: err.code,
				attempt: state.attempt,
				duration: state.endTime ? state.endTime - state.startTime : null,
				state: state.snapshot(),
				fatal: err.fatal,
			}
			this.logger.error('Download failed', errorInfo)
			this.emit('download:error', errorInfo)
			await this._notifyWebhook('onError', errorInfo)
			this.onError?.(errorInfo)
			throw err
		} finally {
			await this._cleanupDownload(state)
			if (this._ownsBrowser && !options.reuseBrowser) {
				await this.browserMgr.close()
			}
			this._currentDownload = null
		}
	}
	async _executeDownloadFlow(state, options) {
		state.transition('validating')
		await this._validateDownloadPreconditions(state, options)
		state.transition('preparing')
		const { filename, savePath, tempPath } = await this._prepareFilePaths(state, options)
		state.filename = filename
		state.savePath = savePath
		state.tempPath = tempPath
		if (this.skipExisting && (await this._shouldSkipDownload(state, options))) {
			this.logger.info('️ Skipping download - file already exists', {
				path: savePath,
			})
			state.transition('completed', {
				skipped: true,
				reason: 'file_exists',
			})
			return {
				success: true,
				skipped: true,
				filename,
				path: savePath,
				size: await getFileSize(savePath),
				method: 'skipped',
			}
		}
		if (!this.browserMgr.isReady) {
			await this.browserMgr.launch()
		}
		state.transition('navigating')
		const page = await this.browserMgr.newPage()
		try {
			await page.goto(url, {
				waitUntil: 'networkidle',
				timeout: CONFIG.timeouts.pageLoad,
			})
			state.transition('extracting')
			const button = page.locator('#download')
			await button.waitFor({
				state: 'visible',
				timeout: CONFIG.timeouts.buttonWait,
			})
			await page.waitForFunction(
				() => {
					const btn = document.querySelector('#download')
					if (!btn) return false
					const href = btn.getAttribute('href')
					const style = window.getComputedStyle(btn)
					return href && href !== '#' && style.pointerEvents !== 'none'
				},
				{ timeout: CONFIG.timeouts.buttonWait },
			)
			const intermediateUrl = await page.$eval('#download', (el) => el.href)
			this.logger.debug('Intermediate URL extracted', {
				url: intermediateUrl.slice(0, 100),
			})
			const autoUrl = intermediateUrl.includes('?')
				? `${intermediateUrl}&auto=1`
				: `${intermediateUrl}?auto=1`
			state.transition('downloading')
			const strategies = [
				new DirectDownloadStrategy(),
				new ResponseInterceptStrategy(),
				new FetchFallbackStrategy(),
			]
			let downloadResult
			for (const strategy of strategies) {
				if (
					await strategy.isApplicable({
						downloadEventAvailable: true,
						extractedUrl: intermediateUrl,
					})
				) {
					try {
						downloadResult = await strategy.execute({
							page,
							autoUrl,
							extractedUrl: intermediateUrl,
							timeout: CONFIG.timeouts.download,
							fallbackDelay: CONFIG.timeouts.fallback,
						})
						this.logger.debug(`Strategy succeeded: ${strategy.name}`)
						break
					} catch (err) {
						this.logger.debug(`Strategy failed: ${strategy.name}`, {
							error: err.message,
						})
					}
				}
			}
			if (!downloadResult) {
				throw new DownloadNetworkError('All download strategies failed', {
					attempted: strategies.map((s) => s.name),
				})
			}
			await this._saveDownloadedContent({
				...downloadResult,
				state,
				savePath,
				tempPath,
				onProgress: (bytes) => this._onDownloadProgress(state, bytes),
			})
			state.transition('verifying')
			if (this.enableChecksum && state.expectedChecksum) {
				await this._verifyChecksum(savePath, state)
			}
			await rename(tempPath, savePath)
			const stats = await stat(savePath)
			state.transition('completed')
			return {
				success: true,
				filename,
				path: savePath,
				size: stats.size,
				method: downloadResult.method,
				duration: state.endTime - state.startTime,
				checksum: state.actualChecksum,
				checksumVerified: state.expectedChecksum
					? state.actualChecksum === state.expectedChecksum
					: null,
			}
		} finally {
		}
	}
	async _validateDownloadPreconditions(state, options) {
		const dirValidation = await validateFilePath(this.saveDir, {
			requireWritable: true,
			baseDir: process.cwd(),
		})
		if (!dirValidation.valid) {
			throw new DownloadValidationError(
				`Save directory invalid: ${dirValidation.error}`,
				'INVALID_SAVE_DIR',
				{ details: dirValidation.details },
			)
		}
		if (
			state.expectedChecksum &&
			!DOWNLOAD_CONSTANTS.SUPPORTED_ALGORITHMS.includes(state.checksumAlgorithm)
		) {
			throw new DownloadValidationError(
				`Unsupported checksum algorithm: ${state.checksumAlgorithm}`,
				'UNSUPPORTED_CHECKSUM_ALGORITHM',
				{ supported: DOWNLOAD_CONSTANTS.SUPPORTED_ALGORITHMS },
			)
		}
	}
	async _prepareFilePaths(state, options) {
		let filename = options.filename
		if (!filename && state.expectedFilename) {
			filename = state.expectedFilename
		}
		if (!filename) {
			filename = basename(new URL(state.url).pathname) || 'download'
		}
		const filenameValidation = validateFilename(filename, {
			allowDangerousExtensions: options.allowDangerousExtensions ?? false,
			maxLength: 200,
		})
		if (!filenameValidation.valid) {
			throw new DownloadValidationError(
				`Invalid filename: ${filenameValidation.error}`,
				'INVALID_FILENAME',
				{ details: filenameValidation.details },
			)
		}
		filename = filenameValidation.value
		const savePath = join(this.saveDir, filename)
		const tempPath = `${savePath}${DOWNLOAD_CONSTANTS.TEMP_FILE_SUFFIX}`
		return { filename, savePath, tempPath }
	}
	async _shouldSkipDownload(state, options) {
		if (!(await fileExists(state.savePath))) {
			return false
		}
		const existingStats = await stat(state.savePath)
		if (
			DOWNLOAD_CONSTANTS.SKIP_IF_SIZE_MATCH &&
			state.expectedSize &&
			existingStats.size === state.expectedSize
		) {
			state.recordWarning('Skipping: file size matches expected', {
				size: existingStats.size,
			})
			return true
		}
		if (
			DOWNLOAD_CONSTANTS.SKIP_IF_CHECKSUM_MATCH &&
			state.expectedChecksum &&
			this.enableChecksum
		) {
			try {
				const existingChecksum = await calculateFileHash(state.savePath, {
					algorithm: state.checksumAlgorithm,
				})
				if (existingChecksum === state.expectedChecksum) {
					state.recordWarning('Skipping: file checksum matches expected', {
						algorithm: state.checksumAlgorithm,
					})
					return true
				}
			} catch (err) {
				this.logger.debug('Checksum comparison failed, proceeding with download', {
					error: err.message,
				})
			}
		}
		return false
	}
	async _saveDownloadedContent({
		stream,
		suggestedFilename,
		onProgress,
		state,
		savePath,
		tempPath,
		headers,
	}) {
		if (!state.filename && suggestedFilename) {
			const sanitized = sanitizeFilename(suggestedFilename)
			state.filename = sanitized
			state.savePath = join(this.saveDir, sanitized)
			state.tempPath = `${state.savePath}${DOWNLOAD_CONSTANTS.TEMP_FILE_SUFFIX}`
			tempPath = state.tempPath
		}
		if (headers?.['content-length']) {
			const size = parseInt(headers['content-length'], 10)
			if (size > 0 && !state.expectedSize) {
				state.expectedSize = size
			}
		}
		const lock = new FileLock(tempPath)
		await lock.acquire()
		try {
			if (stream instanceof require('stream').Readable) {
				await this._saveFromNodeStream(stream, tempPath, state, onProgress)
			} else if (stream instanceof Uint8Array || Buffer.isBuffer(stream)) {
				await atomicWrite(tempPath, stream)
				state.updateProgress(stream.length, stream.length)
			} else if (stream?.getReader) {
				await this._saveFromWebStream(stream, tempPath, state, onProgress)
			} else {
				throw new DownloadFileError('Unsupported stream type', {
					type: typeof stream,
					constructor: stream?.constructor?.name,
				})
			}
		} finally {
			await lock.release()
		}
	}
	async _saveFromNodeStream(readable, outputPath, state, onProgress) {
		return new Promise((resolve, reject) => {
			let downloaded = 0
			let lastProgressTime = Date.now()
			const writeStream = createWriteStream(outputPath, {
				highWaterMark: DOWNLOAD_CONSTANTS.STREAM_HIGH_WATER_MARK,
			})
			const throttle = this.throttleBps
				? (chunk) => {
						const now = Date.now()
						const elapsed = (now - lastProgressTime) / 1000
						const expectedBytes = this.throttleBps * elapsed
						if (downloaded > expectedBytes) {
							const waitMs = ((downloaded - expectedBytes) / this.throttleBps) * 1000
							return sleep(Math.min(waitMs, 100))
						}
						return Promise.resolve()
					}
				: () => Promise.resolve()
			readable.on('data', async (chunk) => {
				if (writeStream.write(chunk) === false) {
					readable.pause()
					writeStream.once('drain', () => readable.resume())
				}
				downloaded += chunk.length
				if (this.throttleBps) {
					await throttle(chunk)
				}
				state.updateProgress(downloaded, state.expectedSize)
				onProgress?.(downloaded)
				const now = Date.now()
				if (now - lastProgressTime >= DOWNLOAD_CONSTANTS.PROGRESS_UPDATE_INTERVAL) {
					this.emit('download:progress', state.snapshot())
					lastProgressTime = now
				}
			})
			readable.on('end', () => {
				writeStream.end()
			})
			readable.on('error', (err) => {
				writeStream.destroy(err)
				reject(
					new DownloadNetworkError(`Stream error: ${err.message}`, {
						original: err,
						downloaded,
					}),
				)
			})
			writeStream.on('finish', resolve)
			writeStream.on('error', (err) => {
				reject(
					new DownloadFileError(`Write error: ${err.message}`, {
						original: err,
						path: outputPath,
					}),
				)
			})
		})
	}
	async _saveFromWebStream(webStream, outputPath, state, onProgress) {
		const reader = webStream.getReader()
		const writeStream = createWriteStream(outputPath, {
			highWaterMark: DOWNLOAD_CONSTANTS.STREAM_HIGH_WATER_MARK,
		})
		let downloaded = 0
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				if (writeStream.write(value) === false) {
					await new Promise((resolve) => writeStream.once('drain', resolve))
				}
				downloaded += value.length
				state.updateProgress(downloaded, state.expectedSize)
				onProgress?.(downloaded)
				if (this.throttleBps && downloaded > 0) {
					const elapsed = (Date.now() - state.startTime) / 1000
					const expectedBytes = this.throttleBps * elapsed
					if (downloaded > expectedBytes) {
						const waitMs = ((downloaded - expectedBytes) / this.throttleBps) * 1000
						await sleep(Math.min(waitMs, 100))
					}
				}
			}
			await new Promise((resolve, reject) => {
				writeStream.end(resolve)
				writeStream.on('error', reject)
			})
		} finally {
			reader.releaseLock()
		}
	}
	_onDownloadProgress(state, downloadedBytes) {
		state.updateProgress(downloadedBytes, state.expectedSize)
		if (this.onProgress) {
			this.onProgress(state.snapshot())
		}
		this.emit('download:progress', state.snapshot())
		if (this.webhooks.onProgress && state.lastProgressUpdate) {
			const now = Date.now()
			if (now - (state._lastWebhookProgress || 0) >= 10000) {
				this._notifyWebhook('onProgress', state.snapshot())
				state._lastWebhookProgress = now
			}
		}
	}
	async _verifyChecksum(filePath, state) {
		if (!state.expectedChecksum) {
			state.recordWarning('No expected checksum provided, skipping verification')
			return
		}
		this.logger.debug('Verifying file checksum', {
			algorithm: state.checksumAlgorithm,
			expected: state.expectedChecksum,
		})
		const actual = await calculateFileHash(filePath, {
			algorithm: state.checksumAlgorithm,
			onProgress: (done, total) => {
				if (state.expectedSize) {
					const verificationProgress = 100 + (done / total) * 10
					state.progress = Math.min(110, verificationProgress)
					this.emit('download:progress', state.snapshot())
				}
			},
		})
		state.actualChecksum = actual
		if (actual !== state.expectedChecksum) {
			throw new DownloadFileError(
				`Checksum mismatch: expected ${state.expectedChecksum}, got ${actual}`,
				'CHECKSUM_MISMATCH',
				{
					algorithm: state.checksumAlgorithm,
					expected: state.expectedChecksum,
					actual,
					fatal: true,
				},
			)
		}
		this.logger.debug('Checksum verified successfully')
	}
	async _cleanupDownload(state) {
		if (state.tempPath && state.state !== 'completed') {
			try {
				await access(state.tempPath)
				await unlink(state.tempPath)
				this.logger.debug('Cleaned up temporary file', {
					path: state.tempPath,
				})
			} catch (err) {}
		}
		if (!state.endTime && !['completed', 'failed', 'cancelled'].includes(state.state)) {
			state.endTime = Date.now()
		}
	}
	async _notifyWebhook(hookName, payload) {
		const url = this.webhooks[hookName]
		if (!url) return
		try {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 5000)
			await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					event: hookName,
					timestamp: Date.now(),
					...payload,
				}),
				signal: controller.signal,
			}).catch(() => {})
			clearTimeout(timeout)
		} catch (err) {
			this.logger.debug('Webhook notification failed', {
				hook: hookName,
				error: err.message,
			})
		}
	}
	getCurrentState() {
		return this._currentDownload?.snapshot() || null
	}
	getHistory(limit = 20) {
		return this._downloadHistory.slice(-limit).reverse()
	}
	getMetrics() {
		const completed = this._downloadHistory.filter((h) => h.result?.success).length
		const failed = this._downloadHistory.length - completed
		return {
			total: this._downloadHistory.length,
			completed,
			failed,
			successRate:
				this._downloadHistory.length > 0
					? Math.round((completed / this._downloadHistory.length) * 100)
					: 0,
			circuitBreaker: { ...this._circuitBreaker },
			memory: getMemoryUsage(),
			browser: this.browserMgr.getMetrics?.() || {},
		}
	}
	exportPrometheusMetrics() {
		const m = this.getMetrics()
		if (!m) return null
		return (
			[
				'# HELP sfile_downloads_total Total download attempts',
				'# TYPE sfile_downloads_total counter',
				`sfile_downloads_total ${m.total}`,
				'',
				'# HELP sfile_downloads_completed Total successful downloads',
				'# TYPE sfile_downloads_completed counter',
				`sfile_downloads_completed ${m.completed}`,
				'',
				'# HELP sfile_downloads_failed Total failed downloads',
				'# TYPE sfile_downloads_failed counter',
				`sfile_downloads_failed ${m.failed}`,
				'',
				'# HELP sfile_download_success_rate Success rate percentage',
				'# TYPE sfile_download_success_rate gauge',
				`sfile_download_success_rate ${m.successRate}`,
				'',
				'# HELP sfile_circuit_breaker_open Circuit breaker status',
				'# TYPE sfile_circuit_breaker_open gauge',
				`sfile_circuit_breaker_open ${m.circuitBreaker.open ? 1 : 0}`,
			].join('\n') + '\n'
		)
	}
	static async batchDownload(urls, options = {}) {
		const {
			saveDir = process.cwd(),
			concurrency = ConfigHelper.get('batch.concurrency', 3),
			onBatchProgress,
			stopOnError = ConfigHelper.get('batch.stopOnError', false),
			...downloadOptions
		} = options
		const results = []
		const queue = [...urls]
		const active = new Map()
		let completed = 0
		const reportProgress = () => {
			if (onBatchProgress) {
				onBatchProgress({
					total: urls.length,
					completed,
					active: active.size,
					pending: queue.length,
					results: results.filter((r) => r.status !== 'pending'),
				})
			}
		}
		reportProgress()
		while (queue.length > 0 || active.size > 0) {
			while (active.size < concurrency && queue.length > 0) {
				const url = queue.shift()
				const promise = (async () => {
					const downloader = new SfileDownloader({
						saveDir,
						...downloadOptions,
					})
					try {
						const result = await downloader.download(url, {
							...downloadOptions,
							reuseBrowser: active.size > 0,
						})
						return { url, status: 'fulfilled', value: result }
					} catch (err) {
						return { url, status: 'rejected', reason: err }
					} finally {
						await downloader.close()
					}
				})()
				active.set(url, promise)
			}
			if (active.size > 0) {
				const settled = await Promise.race(
					Array.from(active.entries()).map(([url, p]) =>
						p.then((result) => ({ url, result })),
					),
				)
				active.delete(settled.url)
				results.push(settled.result)
				completed++
				reportProgress()
				if (stopOnError && settled.result.status === 'rejected') {
					queue.length = 0
					await Promise.allSettled(Array.from(active.values()))
					break
				}
			}
		}
		return results
	}
	async close(options = {}) {
		this.logger.debug('Closing SfileDownloader...')
		if (
			this._currentDownload &&
			!['completed', 'failed', 'cancelled'].includes(this._currentDownload.state)
		) {
			this._currentDownload.cancel('Downloader closed')
		}
		if (options.saveHistory && this._downloadHistory.length > 0) {
			try {
				const historyPath = join(this.saveDir, '.download_history.json')
				await writeFile(
					historyPath,
					JSON.stringify(
						{
							version: 1,
							saved: Date.now(),
							entries: this._downloadHistory,
						},
						null,
						2,
					),
				)
				this.logger.debug('Download history saved', { path: historyPath })
			} catch (err) {
				this.logger.warn('Failed to save download history', {
					error: err.message,
				})
			}
		}
		if (this._ownsBrowser) {
			await this.browserMgr.close()
		}
		this.emit('downloader:closed')
		this.logger.info('SfileDownloader closed')
	}
	async shutdown(options) {
		return this.close(options)
	}
	async pause() {
		if (this._currentDownload?.state === 'downloading') {
			await this._currentDownload.pause()
			this.emit('download:paused', this._currentDownload.snapshot())
		}
	}
	resume() {
		if (this._currentDownload?.state === 'paused') {
			this._currentDownload.resume()
			this.emit('download:resumed', this._currentDownload.snapshot())
		}
	}
	cancel(reason = 'User cancelled') {
		if (
			this._currentDownload &&
			!['completed', 'failed', 'cancelled'].includes(this._currentDownload.state)
		) {
			this._currentDownload.cancel(reason)
			this.emit('download:cancelled', {
				reason,
				state: this._currentDownload.snapshot(),
			})
		}
	}
	isDownloading() {
		return this._currentDownload?.state === 'downloading'
	}
	getCurrentDownload() {
		return this._currentDownload
	}
	updateConfig(updates) {
		const allowed = ['throttleBps', 'enableChecksum', 'skipExisting', 'chunkSize']
		for (const key of allowed) {
			if (key in updates) {
				const old = this[key]
				this[key] = updates[key]
				this.logger.debug(`Config updated: ${key}`, {
					from: old,
					to: updates[key],
				})
				this.emit('config:updated', { key, old, new: updates[key] })
			}
		}
	}
	registerStrategy(strategy) {
		if (!(strategy instanceof DownloadStrategy)) {
			throw new TypeError('Strategy must extend DownloadStrategy')
		}
		this.logger.debug(`Strategy registered: ${strategy.name}`)
	}
	static create(options) {
		return new SfileDownloader(options)
	}
}
export const downloadFile = async (url, options = {}) => {
	const downloader = new SfileDownloader(options)
	try {
		return await downloader.download(url, options)
	} finally {
		await downloader.close()
	}
}
export const downloadBatch = async (urls, options = {}) => {
	return SfileDownloader.batchDownload(urls, options)
}
export default SfileDownloader
