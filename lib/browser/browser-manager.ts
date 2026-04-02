import { chromium, Browser, BrowserContext, Page, Download, Response } from 'playwright'
import * as fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { Logger } from '../utils/logger.js'
import { BrowserError, NetworkError } from '../errors/index.js'
import { DEFAULTS } from '../config/defaults.js'
import { SfilePageInteractions } from './page-interactions.js'
import { sleep, extractFilenameFromContentDisposition } from '../utils/helpers.js'
export interface BrowserManagerOptions {
	headless: boolean
	userAgent: string
	timeout: number
	debug: boolean
	downloadButtonTimeout?: number
}
export class BrowserManager {
	private browser: Browser | null = null
	private context: BrowserContext | null = null
	private page: Page | null = null
	private interactions: SfilePageInteractions | null = null
	private debugDir: string | null = null
	private readonly stageHistory: Array<{ stage: string; ts: number }> = []
	constructor(
		private logger: Logger,
		private opts: BrowserManagerOptions,
	) {}
	private trackStage(stage: string): void {
		this.stageHistory.push({ stage, ts: Date.now() })
	}
	async launch(): Promise<void> {
		const stage = 'launch'
		this.trackStage(stage)
		try {
			this.logger.info('Launching browser', { headless: this.opts.headless })
			this.browser = await chromium.launch({
				headless: this.opts.headless,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-accelerated-2d-canvas',
					'--no-first-run',
					'--no-zygote',
				],
			})
			this.context = await this.browser.newContext({
				userAgent: this.opts.userAgent,
				acceptDownloads: true,
				locale: 'en-US',
				timezoneId: 'UTC',
				viewport: { width: 1280, height: 720 },
			})
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
			this.interactions = new SfilePageInteractions(this.page, this.logger)
			if (this.opts.debug) {
				this.setupDebugListeners()
			}
			this.logger.info('Browser ready')
		} catch (err: any) {
			await this.handleStageError(stage, err)
			throw new BrowserError(`Failed to launch browser: ${err.message}`, {
				stage,
				originalError: err.message,
				userAgent: this.opts.userAgent,
			})
		}
	}
	private setupDebugListeners(): void {
		if (!this.page) return
		this.page.on('console', (msg) => {
			const type = msg.type()
			const text = msg.text()
			if (type === 'error') {
				this.logger.error(`[console] ${text}`, { location: msg.location() })
			} else if (type === 'warning') {
				this.logger.warn(`[console] ${text}`)
			} else if (type === 'debug') {
				this.logger.debug(`[console] ${text}`)
			}
		})
		this.page.on('pageerror', (err) => {
			this.logger.error('[pageerror]', undefined, err)
		})
		this.page.on('requestfailed', (req) => {
			const failure = req.failure()
			this.logger.warn('[requestfailed]', {
				url: req.url(),
				method: req.method(),
				error: failure?.errorText,
			})
		})
	}
	async goto(
		url: string,
		waitUntil: 'load' | 'networkidle' | 'commit' | 'domcontentloaded' = 'networkidle',
	): Promise<void> {
		const stage = 'navigation'
		this.trackStage(stage)
		if (!this.page) {
			throw new BrowserError('Page not initialized', { stage })
		}
		try {
			this.logger.debug(`Navigating to ${url}`, { waitUntil, timeout: this.opts.timeout })
			await this.page.goto(url, { waitUntil, timeout: this.opts.timeout })
		} catch (err: any) {
			await this.handleStageError(stage, err)
			throw new NetworkError(`Navigation failed: ${err.message}`, {
				url,
				stage,
				waitUntil,
				timeout: this.opts.timeout,
				originalError: err.message,
			})
		}
	}
	async waitForDownloadButton(): Promise<void> {
		const stage = 'waitForButton'
		this.trackStage(stage)
		if (!this.interactions) {
			throw new BrowserError('Interactions not ready', { stage })
		}
		const timeout = this.opts.downloadButtonTimeout ?? DEFAULTS.downloadButtonTimeout
		try {
			await this.interactions.waitForDownloadButton(timeout)
		} catch (err: any) {
			await this.handleStageError(stage, err)
			throw new NetworkError(`Failed to wait for download button: ${err.message}`, {
				stage,
				timeout,
				originalError: err.message,
			})
		}
	}
	async getIntermediateUrl(): Promise<string> {
		const stage = 'extractUrl'
		this.trackStage(stage)
		if (!this.interactions) {
			throw new BrowserError('Interactions not ready', { stage })
		}
		try {
			const url = await this.interactions.extractIntermediateUrl()
			this.logger.debug('Intermediate URL extracted', { url })
			return url
		} catch (err: any) {
			await this.handleStageError(stage, err)
			throw new NetworkError(`Failed to extract intermediate URL: ${err.message}`, {
				stage,
				originalError: err.message,
			})
		}
	}
	async startDownloadAndWait(autoUrl: string): Promise<Download | null> {
		const stage = 'downloadWait'
		this.trackStage(stage)
		if (!this.page) {
			throw new BrowserError('Page not initialized', { stage })
		}
		const downloadPromise = this.page
			.waitForEvent('download', { timeout: this.opts.timeout })
			.catch((err) => {
				this.logger.debug('Download event timeout', {
					timeout: this.opts.timeout,
					error: err.message,
				})
				return null
			})
		this.logger.debug('Navigating to auto download URL', { url: autoUrl })
		await this.page
			.goto(autoUrl, { waitUntil: 'commit', timeout: this.opts.timeout })
			.catch((err) => {
				this.logger.warn('Navigation to auto URL failed, continuing anyway', {
					error: err.message,
				})
			})
		const download = await downloadPromise
		if (download) {
			this.logger.info('Download event captured')
			return download
		}
		this.logger.debug('No download event captured within timeout')
		return null
	}
	async fallbackCollectFileResponse(): Promise<{ buffer: Buffer; filename: string } | null> {
		const stage = 'fallbackIntercept'
		this.trackStage(stage)
		if (!this.page) {
			throw new BrowserError('Page not initialized', { stage })
		}
		this.logger.info('Falling back to response interception')
		const responses: Response[] = []
		const handler = (res: Response) => responses.push(res)
		this.page.on('response', handler)
		await sleep(DEFAULTS.fallbackWaitMs)
		this.page.off('response', handler)
		const fileResponse = [...responses].reverse().find((r) => {
			const headers = r.headers()
			const disposition = headers['content-disposition']
			const contentType = headers['content-type']
			const url = r.url()
			return (
				(disposition && disposition.includes('attachment')) ||
				url.includes('/downloadfile/') ||
				(contentType &&
					!contentType.startsWith('text/html') &&
					!contentType.startsWith('application/json'))
			)
		})
		if (!fileResponse) {
			this.logger.debug('No suitable file response found in fallback', {
				responseCount: responses.length,
				sampleUrls: responses.slice(0, 3).map((r) => r.url()),
			})
			return null
		}
		try {
			const buffer = await fileResponse.body()
			let filename = extractFilenameFromContentDisposition(
				fileResponse.headers()['content-disposition'],
			)
			if (!filename) {
				const urlParts = fileResponse.url().split('/')
				filename = urlParts[urlParts.length - 1]?.split('?')[0] || 'file.bin'
			}
			filename = filename.replace(/[<>:"/\\|?*]/g, '_')
			this.logger.info('Fallback response captured', {
				filename,
				size: buffer.length,
				contentType: fileResponse.headers()['content-type'],
			})
			return { buffer, filename }
		} catch (err: any) {
			this.logger.error('Failed to read fallback response body', { error: err.message })
			return null
		}
	}
	async saveDebugArtifacts(errorMessage: string): Promise<string | null> {
		if (!this.opts.debug || !this.page) return null
		try {
			this.debugDir = path.join(
				os.tmpdir(),
				`sfile_debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			)
			await fs.mkdir(this.debugDir, { recursive: true })
			const tasks: Promise<void>[] = [
				this.page
					.screenshot({
						path: path.join(this.debugDir, 'error.png'),
						fullPage: true,
					})
					.then(() => {}),
				fs.writeFile(path.join(this.debugDir, 'error.html'), await this.page.content()),
				fs.writeFile(path.join(this.debugDir, 'error.txt'), errorMessage),
				fs.writeFile(
					path.join(this.debugDir, 'stages.json'),
					JSON.stringify(this.stageHistory, null, 2),
				),
			]
			await Promise.all(tasks)
			this.logger.info('Debug artifacts saved', { debugDir: this.debugDir })
			return this.debugDir
		} catch (e: any) {
			this.logger.error('Failed to save debug artifacts', { error: e.message })
			return null
		}
	}
	private async handleStageError(stage: string, error: any): Promise<void> {
		if (this.opts.debug) {
			await this.saveDebugArtifacts(
				`Error at stage "${stage}": ${error?.message || 'Unknown error'}`,
			)
		}
	}
	async close(): Promise<void> {
		const closePromises = [
			this.page?.close().catch(() => {}),
			this.context?.close().catch(() => {}),
			this.browser?.close().catch(() => {}),
		].filter(Boolean) as Promise<void>[]
		await Promise.all(closePromises)
		this.logger.debug('Browser closed', { stages: this.stageHistory.length })
	}
	async getPage(): Promise<Page | null> {
		return this.page
	}
	getDebugDir(): string | null {
		return this.debugDir
	}
	getStageHistory(): ReadonlyArray<{ stage: string; ts: number }> {
		return [...this.stageHistory]
	}
}
