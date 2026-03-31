#!/usr/bin/env node
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
	type Download,
	type Response,
	type LaunchOptions,
	type BrowserContextOptions,
} from 'playwright'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { exit } from 'process'
type Result<T, E extends Error = Error> =
	| { readonly success: true; readonly value: T }
	| { readonly success: false; readonly error: E }
const isOk = <T, E extends Error>(
	result: Result<T, E>,
): result is Result<T, E> & {
	readonly success: true
	readonly value: T
} => result.success
const isErr = <T, E extends Error>(
	result: Result<T, E>,
): result is Result<T, E> & {
	readonly success: false
	readonly error: E
} => !result.success
const safeStringify = (value: unknown, space?: number): string => {
	try {
		return JSON.stringify(value, null, space)
	} catch {
		return '[Circular or unserializable]'
	}
}
const sanitizeFilename = (name: string, replacement = '_'): string => {
	const sanitized = name
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement)
		.replace(new RegExp(`${replacement}+`, 'g'), replacement)
		.trim()
		.slice(0, 255)
	return sanitized || 'file.bin'
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
abstract class AppError extends Error {
	readonly timestamp: string
	readonly context: Record<string, unknown> | undefined
	constructor(
		message: string,
		public readonly code: string,
		public readonly retryable: boolean = true,
		context?: Record<string, unknown>,
	) {
		super(message)
		this.name = this.constructor.name
		this.timestamp = new Date().toISOString()
		this.context = context !== undefined ? Object.freeze({ ...context }) : undefined
		Error.captureStackTrace?.(this, this.constructor)
	}
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			retryable: this.retryable,
			timestamp: this.timestamp,
			context: this.context,
			stack: process.env['NODE_ENV'] === 'development' ? this.stack : undefined,
		}
	}
}
class ValidationError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'VALIDATION_ERROR', false, context)
	}
}
class NetworkError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'NETWORK_ERROR', true, context)
	}
}
class FileError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'FILE_ERROR', false, context)
	}
}
class BrowserError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'BROWSER_ERROR', true, context)
	}
}
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
interface LogEntry {
	readonly timestamp: string
	readonly level: LogLevel
	readonly message: string
	readonly context?: Readonly<Record<string, unknown>>
}
class Logger {
	private static readonly LEVELS: Readonly<Record<LogLevel, number>> = Object.freeze({
		DEBUG: 0,
		INFO: 1,
		WARN: 2,
		ERROR: 3,
	})
	private minLevel: LogLevel
	private entries: LogEntry[] = []
	private maxEntries = 1000
	private logFile?: string
	constructor(minLevel: LogLevel = 'INFO') {
		this.minLevel = minLevel
	}
	setLogLevel(level: LogLevel): void {
		this.minLevel = level
	}
	useLogFile(path: string): void {
		this.logFile = path
	}
	private shouldLog(level: LogLevel): boolean {
		return Logger.LEVELS[level] >= Logger.LEVELS[this.minLevel]
	}
	private format(entry: LogEntry): string {
		const ctx = entry.context !== undefined ? ` ${safeStringify(entry.context)}` : ''
		return `[${entry.timestamp}] ${entry.level}: ${entry.message}${ctx}`
	}
	private record(entry: LogEntry): void {
		this.entries.push(entry)
		if (this.entries.length > this.maxEntries) {
			this.entries.shift()
		}
	}
	private output(entry: LogEntry): void {
		const formatted = this.format(entry)
		const outputFn = entry.level === 'ERROR' ? console.error : console.log
		outputFn(formatted)
		if (this.logFile !== undefined) {
			void fs.appendFile(this.logFile, `${formatted}\n`).catch(() => {})
		}
	}
	log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!this.shouldLog(level)) return
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			...(context !== undefined
				? { context: Object.freeze({ ...context }) as Readonly<Record<string, unknown>> }
				: {}),
		}
		this.record(entry)
		this.output(entry)
	}
	debug(message: string, context?: Record<string, unknown>): void {
		this.log('DEBUG', message, context)
	}
	info(message: string, context?: Record<string, unknown>): void {
		this.log('INFO', message, context)
	}
	warn(message: string, context?: Record<string, unknown>): void {
		this.log('WARN', message, context)
	}
	error(message: string, context?: Record<string, unknown>): void {
		this.log('ERROR', message, context)
	}
	getEntries(level?: LogLevel): readonly LogEntry[] {
		if (level === undefined) return [...this.entries]
		return this.entries.filter((e) => e.level === level)
	}
}
interface CliFlags {
	readonly help: boolean
	readonly debug: boolean
	readonly headless: boolean
	readonly proxy?: string
	readonly logFile?: string
	readonly json: boolean
	readonly batch?: string
	readonly concurrency: number
	readonly retry: number
	readonly timeout: number
}
interface CliArgs {
	readonly url?: string
	readonly saveDir?: string
	readonly flags: CliFlags
	readonly errors: readonly string[]
}
class CliFlagsBuilder implements CliFlags {
	help = false
	debug = false
	headless = true
	proxy?: string
	logFile?: string
	json = false
	batch?: string
	concurrency = 1
	retry = 3
	timeout = 60000
	build(): CliFlags {
		const flags: CliFlags = {
			help: this.help,
			debug: this.debug,
			headless: this.headless,
			json: this.json,
			concurrency: this.concurrency,
			retry: this.retry,
			timeout: this.timeout,
			...(this.proxy !== undefined && { proxy: this.proxy }),
			...(this.logFile !== undefined && { logFile: this.logFile }),
			...(this.batch !== undefined && { batch: this.batch }),
		}
		return Object.freeze(flags)
	}
}
class CliParser {
	static parse(argv: readonly string[]): CliArgs {
		const args = argv.slice(2)
		const flags = new CliFlagsBuilder()
		const positional: string[] = []
		const errors: string[] = []
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]
			if (arg === undefined || arg === null) continue
			if (arg === '--') {
				positional.push(
					...args.slice(i + 1).filter((a): a is string => a !== undefined && a !== null),
				)
				break
			}
			if (arg.startsWith('--')) {
				const [key, ...valueParts] = arg.slice(2).split('=')
				if (key === undefined || key === '') continue
				let value: string
				if (valueParts.length > 0) {
					value = valueParts.join('=')
				} else if (i + 1 < args.length) {
					const nextArg = args[i + 1]
					if (
						nextArg !== undefined &&
						typeof nextArg === 'string' &&
						!nextArg.startsWith('-')
					) {
						value = nextArg
						i++
					} else {
						value = 'true'
					}
				} else {
					value = 'true'
				}
				CliParser.setFlag(flags, key, value ?? 'true', errors)
			} else if (typeof arg === 'string' && arg.startsWith('-') && arg.length === 2) {
				const key = arg[1]
				if (key === undefined || key === '') continue
				const next = args[i + 1]
				const value =
					next !== undefined &&
					typeof next === 'string' &&
					next !== '-' &&
					!next.startsWith('-')
						? args[++i]
						: 'true'
				CliParser.setFlag(flags, key, value ?? 'true', errors)
			} else if (typeof arg === 'string' && arg.startsWith('-') && arg.length > 2) {
				for (let j = 1; j < arg.length; j++) {
					const char = arg[j]
					if (char !== undefined && char !== '') {
						CliParser.setFlag(flags, char, 'true', errors)
					}
				}
			} else if (typeof arg === 'string') {
				positional.push(arg)
			}
		}
		const url = positional[0]
		const saveDir = positional[1]
		if (flags.concurrency < 1 || flags.concurrency > 20) {
			errors.push('--concurrency must be 1-20')
		}
		if (flags.retry < 1 || flags.retry > 10) {
			errors.push('--retry must be 1-10')
		}
		if (flags.timeout < 1000) {
			errors.push('--timeout must be >= 1000ms')
		}
		return {
			url,
			saveDir,
			flags: flags.build(),
			errors: Object.freeze(errors),
		} as unknown as CliArgs
	}
	private static setFlag(
		flags: CliFlagsBuilder,
		key: string,
		value: string,
		errors: string[],
	): void {
		const normalized = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
		switch (normalized) {
			case 'help':
			case 'h':
				flags.help = value === 'true'
				break
			case 'debug':
				flags.debug = value === 'true'
				break
			case 'headless':
				flags.headless = value !== 'false'
				break
			case 'proxy':
				flags.proxy = value
				break
			case 'logfile':
			case 'log-file':
				flags.logFile = value
				break
			case 'json':
				flags.json = value === 'true'
				break
			case 'batch':
				flags.batch = value
				break
			case 'concurrency': {
				const num = Number(value)
				if (Number.isFinite(num)) flags.concurrency = num
				else errors.push(`Invalid concurrency: ${value}`)
				break
			}
			case 'retry': {
				const num = Number(value)
				if (Number.isFinite(num)) flags.retry = num
				else errors.push(`Invalid retry: ${value}`)
				break
			}
			case 'timeout': {
				const num = Number(value)
				if (Number.isFinite(num)) flags.timeout = num
				else errors.push(`Invalid timeout: ${value}`)
				break
			}
			default:
				errors.push(`Unknown flag: --${key}`)
				break
		}
	}
}
interface BrowserConfig {
	readonly headless: boolean
	readonly userAgent: string
	readonly viewport?: {
		readonly width: number
		readonly height: number
	}
	readonly proxy?: {
		readonly server: string
		readonly username?: string
		readonly password?: string
	}
	readonly acceptDownloads: true
}
interface DownloadResult {
	readonly filename: string
	readonly savePath: string
	readonly size: number
	readonly method: 'direct' | 'fallback'
}
class BrowserManager implements AsyncDisposable {
	private browser: Browser | null = null
	private context: BrowserContext | null = null
	private page: Page | null = null
	private readonly logger: Logger
	private readonly config: BrowserConfig
	constructor(logger: Logger, config: Partial<BrowserConfig>) {
		this.logger = logger
		const maybeViewport = config.viewport
		const maybeProxy = config.proxy
		const browserConfig: BrowserConfig = {
			headless: config.headless ?? true,
			userAgent:
				config.userAgent ??
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
			acceptDownloads: true,
			...(maybeViewport !== undefined && { viewport: maybeViewport }),
			...(maybeProxy !== undefined && { proxy: maybeProxy }),
		}
		this.config = Object.freeze(browserConfig)
	}
	async launch(): Promise<Result<void, BrowserError>> {
		try {
			this.logger.debug('Launching browser', { headless: this.config.headless })
			const launchOptions: LaunchOptions = {
				headless: this.config.headless,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--disable-blink-features=AutomationControlled',
				],
			}
			if (this.config.proxy !== undefined) {
				const proxyOpts: LaunchOptions['proxy'] = {
					server: this.config.proxy.server,
				}
				if (this.config.proxy.username !== undefined) {
					;(proxyOpts as any).username = this.config.proxy.username
				}
				if (this.config.proxy.password !== undefined) {
					;(proxyOpts as any).password = this.config.proxy.password
				}
				launchOptions.proxy = proxyOpts
			}
			this.browser = await chromium.launch(launchOptions)
			const contextOptions: BrowserContextOptions = {
				userAgent: this.config.userAgent,
				acceptDownloads: this.config.acceptDownloads,
				locale: 'en-US',
				timezoneId: 'UTC',
			}
			if (this.config.viewport !== undefined) {
				contextOptions.viewport = this.config.viewport
			}
			this.context = await this.browser.newContext(contextOptions)
			await this.context.addCookies([
				{
					name: 'safe_link_counter',
					value: '1',
					domain: '.sfile.co',
					path: '/',
					expires: Math.floor(Date.now() / 1000) + 3600,
				},
			])
			this.page = await this.context.newPage()
			this.setupListeners()
			this.logger.info('Browser launched successfully')
			return { success: true, value: undefined }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.logger.error('Browser launch failed', { error: error.message })
			await this.cleanup()
			return {
				success: false,
				error: new BrowserError(`Launch failed: ${error.message}`, {
					original: error.name,
				}),
			}
		}
	}
	private setupListeners(): void {
		if (this.page === null) return
		this.page.on('console', (msg) => {
			const type = msg.type()
			if (type === 'error' || type === 'warning') {
				const level: LogLevel = type === 'error' ? 'ERROR' : 'WARN'
				this.logger.log(level, `[CONSOLE] ${msg.text()}`, { location: msg.location().url })
			}
		})
		this.page.on('pageerror', (err) => {
			this.logger.error('[PAGE ERROR]', { message: err.message })
		})
	}
	async navigate(
		url: string,
		options?: {
			readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
			readonly timeout?: number
		},
	): Promise<Result<void, NetworkError>> {
		if (this.page === null) {
			return { success: false, error: new NetworkError('Page not initialized') }
		}
		try {
			await this.page.goto(url, {
				waitUntil: options?.waitUntil ?? 'networkidle',
				timeout: options?.timeout ?? 60000,
			})
			return { success: true, value: undefined }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return {
				success: false,
				error: new NetworkError(`Navigation failed: ${error.message}`),
			}
		}
	}
	async waitForDownloadButton(timeout = 30000): Promise<Result<void, Error>> {
		if (this.page === null) {
			return { success: false, error: new Error('Page not initialized') }
		}
		try {
			const button = this.page.locator('#download')
			await button.waitFor({ state: 'visible', timeout })
			await this.page.waitForFunction(
				() => {
					const btn = document.querySelector('#download') as HTMLAnchorElement | null
					if (btn === null) return false
					const href = btn.getAttribute('href')
					const style = window.getComputedStyle(btn)
					return href !== null && href !== '#' && style.pointerEvents !== 'none'
				},
				{ timeout },
			)
			return { success: true, value: undefined }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return { success: false, error }
		}
	}
	async extractDownloadUrl(): Promise<Result<string, Error>> {
		if (this.page === null) {
			return { success: false, error: new Error('Page not initialized') }
		}
		try {
			const href = await this.page.$eval('#download', (el: Element) => {
				const anchor = el as HTMLAnchorElement
				return anchor.href
			})
			if (href === null || href === '' || href === '#') {
				return { success: false, error: new Error('Invalid download href') }
			}
			return { success: true, value: href }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return { success: false, error }
		}
	}
	async waitForDownload(timeout = 60000): Promise<Result<Download, Error>> {
		if (this.page === null) {
			return { success: false, error: new Error('Page not initialized') }
		}
		try {
			const download = await this.page.waitForEvent('download', { timeout })
			return { success: true, value: download }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return { success: false, error }
		}
	}
	async collectResponses(waitMs = 3000): Promise<readonly Response[]> {
		if (this.page === null) return []
		const responses: Response[] = []
		const handler = (res: Response) => {
			responses.push(res)
		}
		this.page.on('response', handler)
		await sleep(waitMs)
		this.page.off('response', handler)
		return Object.freeze(responses)
	}
	findFileResponse(responses: readonly Response[]): Response | undefined {
		return responses
			.slice()
			.reverse()
			.find((r) => {
				const headers = r.headers()
				const disposition = headers['content-disposition']
				return (
					(disposition !== undefined && disposition.includes('attachment')) ||
					r.url().includes('/downloadfile/')
				)
			})
	}
	async saveDebugArtifacts(errorMessage: string): Promise<Result<string, Error>> {
		if (this.page === null) {
			return { success: false, error: new Error('Page not available') }
		}
		try {
			const debugDir = join(tmpdir(), `sfile_debug_${Date.now()}`)
			await fs.mkdir(debugDir, { recursive: true })
			await Promise.all([
				this.page.screenshot({ path: join(debugDir, 'error.png'), fullPage: true }),
				fs.writeFile(join(debugDir, 'error.html'), await this.page.content()),
				fs.writeFile(join(debugDir, 'error.txt'), errorMessage),
			])
			return { success: true, value: debugDir }
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return {
				success: false,
				error: new FileError(`Failed to save artifacts: ${error.message}`),
			}
		}
	}
	private async cleanup(): Promise<void> {
		if (this.page !== null) {
			await this.page.close().catch(() => {})
			this.page = null
		}
		if (this.context !== null) {
			await this.context.close().catch(() => {})
			this.context = null
		}
		if (this.browser !== null) {
			await this.browser.close().catch(() => {})
			this.browser = null
		}
	}
	async [Symbol.asyncDispose](): Promise<void> {
		this.logger.debug('Closing browser resources...')
		await this.cleanup()
		this.logger.info('Browser resources closed')
	}
	[Symbol.dispose](): void {
		void this[Symbol.asyncDispose]()
	}
}
interface DownloaderConfig {
	readonly saveDir: string
	readonly timeout: number
	readonly retryAttempts: number
}
class Downloader {
	private readonly logger: Logger
	private readonly config: DownloaderConfig
	constructor(logger: Logger, config: DownloaderConfig) {
		this.logger = logger
		this.config = Object.freeze(config)
	}
	async download(url: string): Promise<Result<DownloadResult, AppError>> {
		if (!url.includes('sfile.co')) {
			return { success: false, error: new ValidationError('Invalid sfile.co URL', { url }) }
		}
		try {
			await fs.mkdir(this.config.saveDir, { recursive: true })
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return {
				success: false,
				error: new FileError(`Failed to create save dir: ${error.message}`),
			}
		}
		let lastError: AppError | undefined
		for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
			this.logger.info(`Download attempt ${attempt}/${this.config.retryAttempts}`, { url })
			const result = await this.executeDownload(url)
			if (isOk(result)) {
				return result
			}
			lastError = result.error
			if (!lastError.retryable || attempt === this.config.retryAttempts) {
				break
			}
			const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
			this.logger.info(`Retrying in ${delay}ms...`)
			await sleep(delay)
		}
		if (lastError === undefined) {
			return { success: false, error: new Error('Unknown error') as AppError }
		}
		return { success: false, error: lastError }
	}
	private async executeDownload(url: string): Promise<Result<DownloadResult, AppError>> {
		const browserMgr = new BrowserManager(this.logger, {
			headless: true,
			userAgent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		})
		try {
			const launchResult = await browserMgr.launch()
			if (isErr(launchResult)) {
				return { success: false, error: launchResult.error }
			}
			const navResult = await browserMgr.navigate(url)
			if (isErr(navResult)) {
				return { success: false, error: navResult.error }
			}
			const buttonResult = await browserMgr.waitForDownloadButton()
			if (isErr(buttonResult)) {
				return {
					success: false,
					error: new NetworkError(`Button wait failed: ${buttonResult.error.message}`),
				}
			}
			const urlResult = await browserMgr.extractDownloadUrl()
			if (isErr(urlResult)) {
				return {
					success: false,
					error: new NetworkError(`URL extract failed: ${urlResult.error.message}`),
				}
			}
			const intermediateUrl = urlResult.value
			const autoUrl = intermediateUrl.includes('?')
				? `${intermediateUrl}&auto=1`
				: `${intermediateUrl}?auto=1`
			this.logger.debug('Auto URL', { url: autoUrl })
			const downloadPromise = browserMgr.waitForDownload(this.config.timeout)
			const autoNavResult = await browserMgr.navigate(autoUrl, {
				waitUntil: 'commit',
				timeout: this.config.timeout,
			})
			if (isErr(autoNavResult)) {
				return { success: false, error: autoNavResult.error }
			}
			const downloadResult = await downloadPromise
			if (isOk(downloadResult)) {
				return await this.handleDirectDownload(downloadResult.value, this.config.saveDir)
			} else {
				this.logger.warn('Download event failed, trying fallback')
				const responses = await browserMgr.collectResponses(3000)
				const fileResponse = browserMgr.findFileResponse(responses)
				if (fileResponse === undefined) {
					return {
						success: false,
						error: new NetworkError('No file response found in fallback'),
					}
				}
				return await this.handleFallbackDownload(fileResponse, this.config.saveDir)
			}
		} finally {
			await browserMgr[Symbol.asyncDispose]()
		}
	}
	private async handleDirectDownload(
		download: Download,
		saveDir: string,
	): Promise<Result<DownloadResult, AppError>> {
		try {
			const suggested = download.suggestedFilename()
			const filename = sanitizeFilename(suggested !== undefined ? suggested : 'file.bin')
			const savePath = join(saveDir, filename)
			this.logger.info('Saving via direct download', { filename })
			await download.saveAs(savePath)
			const stats = await fs.stat(savePath)
			return {
				success: true,
				value: {
					filename,
					savePath,
					size: stats.size,
					method: 'direct',
				},
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return {
				success: false,
				error: new FileError(`Direct download failed: ${error.message}`),
			}
		}
	}
	private async handleFallbackDownload(
		response: Response,
		saveDir: string,
	): Promise<Result<DownloadResult, AppError>> {
		try {
			const buffer = await response.body()
			const urlPath = response.url().split('?')[0] ?? 'unknown'
			const base = basename(urlPath)
			const filename = sanitizeFilename(base !== '' ? base : 'file.bin')
			const savePath = join(saveDir, filename)
			await fs.writeFile(savePath, buffer)
			this.logger.info('Saved via fallback', { filename, size: buffer.length })
			return {
				success: true,
				value: {
					filename,
					savePath,
					size: buffer.length,
					method: 'fallback',
				},
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			return {
				success: false,
				error: new FileError(`Fallback download failed: ${error.message}`),
			}
		}
	}
}
class App {
	private readonly logger: Logger
	constructor() {
		this.logger = new Logger('INFO')
	}
	async run(): Promise<number> {
		const args = CliParser.parse(process.argv)
		if (args.errors.length > 0) {
			for (const err of args.errors) {
				this.logger.error(`CLI error: ${err}`)
			}
			this.showHelp()
			return 2
		}
		if (args.flags.help || args.url === undefined) {
			this.showHelp()
			return 0
		}
		this.logger.info('Starting Sfile Downloader', {
			url: args.url,
			saveDir: args.saveDir ?? process.cwd(),
			headless: args.flags.headless,
		})
		const downloader = new Downloader(this.logger, {
			saveDir: args.saveDir ?? process.cwd(),
			timeout: args.flags.timeout,
			retryAttempts: args.flags.retry,
		})
		const result = await downloader.download(args.url)
		if (isOk(result)) {
			this.logger.info('✅ Download complete', {
				file: result.value.filename,
				size: `${Math.round(result.value.size / 1024)} KB`,
				method: result.value.method,
			})
			console.log(`Saved: ${result.value.savePath}`)
			return 0
		} else {
			this.logger.error('❌ Download failed', {
				error: result.error.message,
				code: result.error.code,
				retryable: result.error.retryable,
			})
			return 1
		}
	}
	showHelp(): void {
		console.log(`
🚀 Sfile Downloader - Strict TypeScript CLI
Usage:
  bun run src/index.ts <url> [saveDir] [options]
Arguments:
  url          sfile.co URL to download (required)
  saveDir      Directory to save files (default: current directory)
Options:
  --help, -h           Show this help message
  --debug              Enable debug logging
  --headless=BOOL      Run browser headless (default: true)
  --proxy=URL          Proxy server URL
  --log-file=PATH      Write logs to file
  --json               Output logs as JSON
  --batch=FILE         Download URLs from file (one per line)
  --concurrency=N      Parallel downloads (1-20, default: 1)
  --retry=N            Max retry attempts (1-10, default: 3)
  --timeout=MS         Operation timeout in ms (default: 60000)
Examples:
  bun run src/index.ts https://sfile.co/xyz ./downloads
  bun run src/index.ts --batch=urls.txt --concurrency=3
  bun run src/index.ts https://sfile.co/abc --debug --headless=false
Exit Codes:
  0  Success
  1  Download/operation error
  2  CLI/validation error
`)
	}
}
const main = async (): Promise<void> => {
	const app = new App()
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		console.error(`\nReceived ${signal}, shutting down...`)
		exit(130)
	}
	process.once('SIGINT', () => {
		void shutdown('SIGINT')
	})
	process.once('SIGTERM', () => {
		void shutdown('SIGTERM')
	})
	try {
		const exitCode = await app.run()
		exit(exitCode)
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		console.error(`[FATAL] Unhandled error: ${error.message}`)
		if (process.env['NODE_ENV'] === 'development' && error.stack !== undefined) {
			console.error(error.stack)
		}
		exit(1)
	}
}
if (require.main === module) {
	void main()
}
export { App, Downloader, BrowserManager, Logger, CliParser }
export type {
	Result,
	AppError,
	ValidationError,
	NetworkError,
	FileError,
	BrowserError,
	CliFlags,
	CliArgs,
	DownloadResult,
	BrowserConfig,
	DownloaderConfig,
	LogLevel,
	LogEntry,
}
