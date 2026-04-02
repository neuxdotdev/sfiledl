import { Page } from 'playwright'
import { Logger } from '../utils/logger.js'
import { NetworkError } from '../errors/index.js'
export class SfilePageInteractions {
	constructor(
		private page: Page,
		private logger: Logger,
	) {}
	async waitForDownloadButton(timeout: number): Promise<void> {
		this.logger.debug('Waiting for #download button to be visible')
		const button = this.page.locator('#download')
		await button.waitFor({ state: 'visible', timeout })
		this.logger.debug(
			'Waiting for button to become active (href != "#" and pointerEvents != "none")',
		)
		await this.page.waitForFunction(
			() => {
				const btn = document.querySelector('#download') as HTMLAnchorElement | null
				if (!btn) return false
				const href = btn.getAttribute('href')
				const style = window.getComputedStyle(btn)
				return href && href !== '#' && style.pointerEvents !== 'none'
			},
			{ timeout },
		)
	}
	async extractIntermediateUrl(): Promise<string> {
		this.logger.debug('Extracting href from #download')
		const href = await this.page.$eval('#download', (el) => (el as HTMLAnchorElement).href)
		if (!href || href === '#') {
			throw new NetworkError('Download button href is invalid', { href })
		}
		return href
	}
}
