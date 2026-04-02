import path from 'path'
import fs from 'fs/promises'
import { BrowserManager } from '../browser/browser-manager.js'
import { Logger } from '../utils/logger.js'
import { ValidationError, NetworkError } from '../errors/index.js'
import { DownloadOptions, DownloadResult, normalizeOptions } from '../config/schema.js'
import { sanitizeFilename } from '../utils/helpers.js'
export async function downloadSfile(
	url: string,
	saveDir: string,
	options?: DownloadOptions,
): Promise<DownloadResult> {
	const opts = normalizeOptions(options)
	const logger = new Logger(opts.debug)
	if (!url || !url.includes('sfile.co')) {
		throw new ValidationError('URL must contain sfile.co', { url })
	}
	await fs.mkdir(saveDir, { recursive: true })
	const browserMgr = new BrowserManager(logger, {
		headless: opts.headless,
		userAgent: opts.userAgent,
		timeout: opts.timeout,
		debug: opts.debug,
	})
	try {
		await browserMgr.launch()
		await browserMgr.goto(url, 'networkidle')
		await browserMgr.waitForDownloadButton()
		const intermediateUrl = await browserMgr.getIntermediateUrl()
		const autoUrl = intermediateUrl.includes('?')
			? `${intermediateUrl}&auto=1`
			: `${intermediateUrl}?auto=1`
		let download = await browserMgr.startDownloadAndWait(autoUrl)
		let finalPath: string
		let fileSize: number
		let method: 'direct' | 'fallback'
		if (download) {
			const suggested = download.suggestedFilename() || 'file.bin'
			const filename = sanitizeFilename(suggested)
			finalPath = path.join(saveDir, filename)
			await download.saveAs(finalPath)
			const stat = await fs.stat(finalPath)
			fileSize = stat.size
			method = 'direct'
			logger.info(`Saved via direct download: ${finalPath} (${fileSize} bytes)`)
		} else {
			const fallback = await browserMgr.fallbackCollectFileResponse()
			if (!fallback) {
				throw new NetworkError('No download event and no file response found')
			}
			const { buffer, filename: rawName } = fallback
			const filename = sanitizeFilename(rawName)
			finalPath = path.join(saveDir, filename)
			await fs.writeFile(finalPath, buffer)
			fileSize = buffer.length
			method = 'fallback'
			logger.info(`Saved via fallback: ${finalPath} (${fileSize} bytes)`)
		}
		return { filePath: finalPath, size: fileSize, method }
	} catch (err: any) {
		await browserMgr.saveDebugArtifacts(err.message)
		throw err
	} finally {
		await browserMgr.close()
	}
}
