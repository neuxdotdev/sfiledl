import { Page } from 'playwright'
import { Logger } from '../utils/logger.js'
import { NetworkError } from '../errors/index.js'
export class SfilePageInteractions {
	constructor(
		private page: Page,
		private logger: Logger,
	) {}
	async waitForDownloadButton(timeout: number): Promise<void> {
		this.logger.debug('Waiting for #download button', { timeout })
		const button = this.page.locator('#download')
		await button.waitFor({ state: 'visible', timeout })
		this.logger.debug('Button is visible, checking if active')
		await this.page.waitForFunction(
			() => {
				const btn = document.querySelector('#download') as HTMLAnchorElement | null
				if (!btn) return false
				const href = btn.getAttribute('href')
				const style = window.getComputedStyle(btn)
				const isDisabled =
					btn.hasAttribute('disabled') ||
					btn.getAttribute('aria-disabled') === 'true' ||
					btn.classList.contains('disabled')
				return !!(
					href &&
					href !== '#' &&
					href.trim() !== '' &&
					style.pointerEvents !== 'none' &&
					!isDisabled
				)
			},
			{ timeout },
		)
		this.logger.debug('Download button is active and ready')
	}
	async extractIntermediateUrl(): Promise<string> {
		this.logger.debug('Extracting href from #download button')
		try {
			const href = await this.page.$eval('#download', (el) => {
				const anchor = el as HTMLAnchorElement
				return anchor.href
			})
			if (!href || href === '#' || href.trim() === '') {
				throw new NetworkError('Download button href is empty or invalid', { href })
			}
			return href
		} catch (err: unknown) {
			if (err instanceof Error && err.message?.includes('Element not found')) {
				throw new NetworkError('Download button (#download) not found in page', {
					selector: '#download',
					originalError: err.message,
				})
			}
			throw err
		}
	}
}
