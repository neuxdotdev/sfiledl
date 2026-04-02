import { chromium, Browser, BrowserContext, Page, Download, Response } from 'playwright'
import * as fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { Logger } from '../utils/logger.js'
import { BrowserError, NetworkError } from '../errors/index.js'
import { DEFAULTS } from '../config/defaults.js'
import { SfilePageInteractions } from './page-interactions.js'
import { sleep } from '../utils/helpers.js'
export interface BrowserManagerOptions {
	headless: boolean
	userAgent: string
	timeout: number
	debug: boolean
}
export class BrowserManager {
	private browser: Browser | null = null
	private context: BrowserContext | null = null
	private page: Page | null = null
	private interactions: SfilePageInteractions | null = null
	private debugDir: string | null = null
	constructor(
		private logger: Logger,
		private opts: BrowserManagerOptions,
	) {}
	async launch(): Promise<void> {
		try {
			this.logger.info('Launching browser', { headless: this.opts.headless })
			this.browser = await chromium.launch({
				headless: this.opts.headless,
				args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
			})
			this.context = await this.browser.newContext({
				userAgent: this.opts.userAgent,
				acceptDownloads: true,
				locale: 'en-US',
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
				this.page.on('console', (msg) => {
					if (msg.type() === 'error') this.logger.error(`[console] ${msg.text()}`)
					else if (msg.type() === 'warning') this.logger.warn(`[console] ${msg.text()}`)
				})
				this.page.on('pageerror', (err) => this.logger.error(`[pageerror] ${err.message}`))
			}
			this.logger.info('Browser ready')
		} catch (err: any) {
			throw new BrowserError(`Failed to launch browser: ${err.message}`)
		}
	}
	async goto(
		url: string,
		waitUntil: 'load' | 'networkidle' | 'commit' = 'networkidle',
	): Promise<void> {
		if (!this.page) throw new BrowserError('Page not initialized')
		try {
			this.logger.debug(`Navigating to ${url} (waitUntil=${waitUntil})`)
			await this.page.goto(url, { waitUntil, timeout: this.opts.timeout })
		} catch (err: any) {
			throw new NetworkError(`Navigation failed: ${err.message}`, { url })
		}
	}
	async waitForDownloadButton(): Promise<void> {
		if (!this.interactions) throw new BrowserError('Interactions not ready')
		await this.interactions.waitForDownloadButton(DEFAULTS.downloadButtonTimeout)
	}
	async getIntermediateUrl(): Promise<string> {
		if (!this.interactions) throw new BrowserError('Interactions not ready')
		return this.interactions.extractIntermediateUrl()
	}
	async startDownloadAndWait(autoUrl: string): Promise<Download | null> {
		if (!this.page) throw new BrowserError('Page not initialized')
		const downloadPromise = this.page
			.waitForEvent('download', { timeout: this.opts.timeout })
			.catch((err) => {
				this.logger.warn(`Download event wait failed: ${err.message}`)
				return null
			})
		this.logger.debug(`Navigating to auto URL: ${autoUrl}`)
		await this.page.goto(autoUrl, { waitUntil: 'commit', timeout: this.opts.timeout })
		const download = await downloadPromise
		if (download) {
			this.logger.info('Download event captured')
			return download
		}
		return null
	}
	async fallbackCollectFileResponse(): Promise<{ buffer: Buffer; filename: string } | null> {
		if (!this.page) throw new BrowserError('Page not initialized')
		this.logger.warn('Falling back to response interception')
		const responses: Response[] = []
		const handler = (res: Response) => responses.push(res)
		this.page.on('response', handler)
		await sleep(DEFAULTS.fallbackWaitMs)
		this.page.off('response', handler)
		const fileResponse = [...responses].reverse().find((r) => {
			const disposition = r.headers()['content-disposition']
			return (
				(disposition && disposition.includes('attachment')) ||
				r.url().includes('/downloadfile/')
			)
		})
		if (!fileResponse) return null
		const buffer = await fileResponse.body()
		let filename = fileResponse.url().split('/').pop()?.split('?')[0] || 'file.bin'
		filename = filename.replace(/[<>:"/\\|?*]/g, '_')
		return { buffer, filename }
	}
	async saveDebugArtifacts(errorMessage: string): Promise<void> {
		if (!this.page) return
		try {
			this.debugDir = path.join(os.tmpdir(), `sfile_debug_${Date.now()}`)
			await fs.mkdir(this.debugDir, { recursive: true })
			await Promise.all([
				this.page.screenshot({
					path: path.join(this.debugDir, 'error.png'),
					fullPage: true,
				}),
				fs.writeFile(path.join(this.debugDir, 'error.html'), await this.page.content()),
				fs.writeFile(path.join(this.debugDir, 'error.txt'), errorMessage),
			])
			this.logger.info(`Debug artifacts saved to ${this.debugDir}`)
		} catch (e: any) {
			this.logger.error(`Failed to save debug artifacts: ${e.message}`)
		}
	}
	async close(): Promise<void> {
		if (this.page) await this.page.close().catch(() => {})
		if (this.context) await this.context.close().catch(() => {})
		if (this.browser) await this.browser.close().catch(() => {})
		this.logger.debug('Browser closed')
	}
}
