import { chromium } from 'playwright'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { join, dirname } from 'path'
import EventEmitter from 'events'
import { Logger, createLogger } from './logger.js'
import { CONFIG, ConfigHelper } from './config.js'
import { sleep, withTimeout, withRetry, createRateLimiter, getMemoryUsage } from './utils.js'
import { SecurityError, ValidationError } from './validators.js'
const BROWSER_CONSTANTS = Object.freeze({
	LAUNCH_RETRIES: 3,
	LAUNCH_RETRY_DELAY: 1000,
	PAGE_CRASH_RECOVERY_ATTEMPTS: 2,
	GRACEFUL_SHUTDOWN_TIMEOUT: 10000,
	HEALTH_CHECK_INTERVAL: 30000,
	MEMORY_WARNING_THRESHOLD_MB: 1024,
	MEMORY_CRITICAL_THRESHOLD_MB: 2048,
	CPU_WARNING_THRESHOLD: 80,
	MAX_PAGES_PER_CONTEXT: 5,
	PAGE_IDLE_TIMEOUT: 300000,
	RESOURCE_BLOCK_TIMEOUT: 5000,
	FINGERPRINT_RANDOMIZATION: true,
	CANVAS_NOISE_LEVEL: 0.02,
	TIMEZONE_SPOOFING: true,
	REQUEST_TIMEOUT: 30000,
	MAX_REDIRECTS: 5,
	BLOCKED_RESOURCE_TYPES: ['image', 'font', 'stylesheet', 'media'],
	BLOCKED_DOMAIN_PATTERNS: [
		/ads\.?/i,
		/analytics\.?/i,
		/tracking\.?/i,
		/doubleclick\.net/i,
		/googletagmanager\.com/i,
		/facebook\.com\/plugins/i,
		/twitter\.com\/widgets/i,
	],
})
export class BrowserError extends Error {
	constructor(message, code, details = {}) {
		super(message)
		this.name = 'BrowserError'
		this.code = code
		this.details = details
		this.timestamp = new Date().toISOString()
		this.retryable = details.retryable ?? true
	}
	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			details: this.details,
			timestamp: this.timestamp,
			stack: process.env.NODE_ENV === 'development' ? this.stack : undefined,
		}
	}
}
export class BrowserLaunchError extends BrowserError {
	constructor(message, details = {}) {
		super(message, 'LAUNCH_FAILED', { ...details, retryable: true })
		this.name = 'BrowserLaunchError'
	}
}
export class PageCrashError extends BrowserError {
	constructor(message, details = {}) {
		super(message, 'PAGE_CRASHED', { ...details, retryable: true })
		this.name = 'PageCrashError'
	}
}
export class StealthDetectionError extends BrowserError {
	constructor(message, details = {}) {
		super(message, 'STEALTH_DETECTED', {
			...details,
			retryable: false,
			severity: 'HIGH',
		})
		this.name = 'StealthDetectionError'
	}
}
class BrowserStateMachine {
	constructor(initialState = 'idle') {
		this._state = initialState
		this._transitions = new Map([
			['idle', ['launching', 'closed']],
			['launching', ['ready', 'error', 'closed']],
			['ready', ['error', 'closing', 'idle']],
			['error', ['launching', 'closed', 'idle']],
			['closing', ['closed', 'error']],
			['closed', ['launching', 'idle']],
		])
		this._history = []
	}
	get state() {
		return this._state
	}
	get history() {
		return [...this._history]
	}
	canTransition(to) {
		const allowed = this._transitions.get(this._state) || []
		return allowed.includes(to)
	}
	transition(to, metadata = {}) {
		if (!this.canTransition(to)) {
			throw new Error(`Invalid transition: ${this._state} → ${to}`)
		}
		const from = this._state
		this._state = to
		this._history.push({
			from,
			to,
			timestamp: Date.now(),
			...metadata,
		})
		if (this._history.length > 100) {
			this._history.shift()
		}
		return { from, to, ...metadata }
	}
	reset(state = 'idle') {
		this._state = state
		this._history = []
	}
}
export class BrowserPlugin {
	constructor(name) {
		this.name = name
		this._hooks = new Map()
	}
	hook(hookName, handler, options = {}) {
		if (!this._hooks.has(hookName)) {
			this._hooks.set(hookName, [])
		}
		this._hooks.get(hookName).push({
			handler,
			priority: options.priority ?? 0,
			once: options.once ?? false,
			active: true,
		})
		this._hooks.get(hookName).sort((a, b) => b.priority - a.priority)
		return this
	}
	async execute(hookName, context) {
		const hooks = this._hooks.get(hookName) || []
		const results = []
		for (const hook of hooks) {
			if (!hook.active) continue
			try {
				const result = await hook.handler(context)
				results.push(result)
				if (hook.once) hook.active = false
			} catch (err) {
				Logger.warn(`Plugin ${this.name} hook ${hookName} failed`, {
					plugin: this.name,
					error: err.message,
				})
			}
		}
		return results
	}
	disable() {
		for (const hooks of this._hooks.values()) {
			for (const hook of hooks) hook.active = false
		}
	}
	enable() {
		for (const hooks of this._hooks.values()) {
			for (const hook of hooks) hook.active = true
		}
	}
}
export class BrowserManager extends EventEmitter {
	constructor(options = {}) {
		super()
		this.browser = null
		this.context = null
		this.page = null
		this._state = new BrowserStateMachine('idle')
		this._isClosed = false
		this._pages = new Set()
		this._pagePool = []
		this._rateLimiter = null
		this._healthCheckTimer = null
		this._metrics = {
			launches: 0,
			failures: 0,
			pageCreations: 0,
			pageCrashes: 0,
			requestsBlocked: 0,
			downloadsCompleted: 0,
			startTime: null,
			lastActivity: null,
		}
		this.logger = options.logger?.child?.('browser') || createLogger('browser')
		this._consoleLogs = []
		this._networkLogs = []
		this._errorLogs = []
		this._plugins = new Map()
		this._middleware = {
			beforeLaunch: [],
			afterLaunch: [],
			beforeNavigate: [],
			afterNavigate: [],
			onRequest: [],
			onResponse: [],
			beforeClose: [],
		}
		this.config = {
			enableStealth:
				options.enableStealth ?? ConfigHelper.get('browser.stealth.enabled', false),
			blockResources:
				options.blockResources ?? ConfigHelper.get('browser.blockResources', true),
			enableProxy: options.enableProxy ?? ConfigHelper.get('browser.proxy.enabled', true),
			enablePersistence: options.enablePersistence ?? false,
			persistencePath: options.persistencePath ?? join(process.cwd(), '.browser_sessions'),
			enableMetrics: options.enableMetrics ?? ConfigHelper.get('debug.metrics', false),
			...options,
		}
		this._onPageCrash = this._onPageCrash.bind(this)
		this._onPageClose = this._onPageClose.bind(this)
		this._onConsoleMessage = this._onConsoleMessage.bind(this)
		this._onPageError = this._onPageError.bind(this)
		this._onRequest = this._onRequest.bind(this)
		this._onResponse = this._onResponse.bind(this)
		this._onRequestFailed = this._onRequestFailed.bind(this)
	}
	async launch() {
		if (this._state.state !== 'idle' && this._state.state !== 'closed') {
			throw new BrowserError(
				`Cannot launch from state: ${this._state.state}`,
				'INVALID_STATE_TRANSITION',
			)
		}
		this._state.transition('launching')
		this._metrics.startTime = Date.now()
		let lastError
		for (let attempt = 1; attempt <= BROWSER_CONSTANTS.LAUNCH_RETRIES; attempt++) {
			try {
				this.logger.debug(`Launch attempt ${attempt}/${BROWSER_CONSTANTS.LAUNCH_RETRIES}`)
				await this._executeMiddleware('beforeLaunch', { attempt })
				const launchOptions = await this._prepareLaunchOptions()
				await this._validateLaunchOptions(launchOptions)
				this.browser = await withTimeout(
					chromium.launch(launchOptions),
					CONFIG.timeouts.pageLoad,
					'Browser launch timeout',
				)
				await this._verifyBrowserHealth()
				await this._createContext()
				await this._setupProtections()
				await this._executeMiddleware('afterLaunch', { browser: this.browser })
				this._state.transition('ready')
				this._metrics.launches++
				this._metrics.lastActivity = Date.now()
				this.logger.info('Browser launched successfully', {
					headless: CONFIG.browser.headless,
					proxy: !!launchOptions.proxy,
					stealth: this.config.enableStealth,
					version: await this.browser.version(),
				})
				this._startHealthMonitoring()
				if (this.config.enablePersistence) {
					await this._loadPersistedSession()
				}
				return this
			} catch (err) {
				lastError = err
				this._metrics.failures++
				this.logger.warn(`Launch attempt ${attempt} failed: ${err.message}`, {
					error: err.name,
					code: err.code,
					retryable: err.retryable ?? true,
				})
				await this._safeCleanup()
				if (!err.retryable || attempt >= BROWSER_CONSTANTS.LAUNCH_RETRIES) {
					break
				}
				const delay = BROWSER_CONSTANTS.LAUNCH_RETRY_DELAY * Math.pow(2, attempt - 1)
				this.logger.info(`Retrying in ${delay}ms...`)
				await sleep(delay)
			}
		}
		this._state.transition('error', { lastError: lastError?.message })
		this.logger.error('Browser launch failed after all retries', {
			attempts: BROWSER_CONSTANTS.LAUNCH_RETRIES,
			error: lastError?.message,
			code: lastError?.code,
		})
		throw new BrowserLaunchError(`Failed to launch browser: ${lastError?.message}`, {
			originalError: lastError,
			attempts: BROWSER_CONSTANTS.LAUNCH_RETRIES,
		})
	}
	async _prepareLaunchOptions() {
		const options = {
			headless: CONFIG.browser.headless,
			args: this._buildChromiumArgs(),
			env: this._buildEnvironmentVars(),
		}
		if (this.config.enableProxy) {
			const proxy = await this._resolveProxyConfig()
			if (proxy) {
				options.proxy = proxy
				this.logger.debug('Proxy configured', {
					server: proxy.server,
					hasAuth: !!proxy.username,
				})
			}
		}
		if (this.config.enableStealth) {
			await this._applyStealthEnhancements(options)
		}
		if (CONFIG.debug.enabled) {
			options.args.push('--remote-debugging-port=9222')
			options.slowMo = CONFIG.debug.slowMo ?? 0
		}
		return options
	}
	_buildChromiumArgs() {
		const args = [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-accelerated-2d-canvas',
			'--disable-gpu',
			'--disable-software-rasterizer',
			'--disable-extensions',
			'--disable-background-networking',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			'--disable-features=IsolateOrigins,site-per-process,TranslateUI',
			'--disable-blink-features=AutomationControlled',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-infobars',
			'--window-position=0,0',
			'--ignore-certificate-errors',
			'--ignore-certificate-errors-spki-list',
			'--disable-web-security',
			'--allow-running-insecure-content',
			'--disable-features=VizDisplayCompositor',
			'--force-color-profile=srgb',
		]
		if (CONFIG.browser.viewport) {
			args.push(
				`--window-size=${CONFIG.browser.viewport.width},${CONFIG.browser.viewport.height}`,
			)
		}
		return args
	}
	_buildEnvironmentVars() {
		const env = { ...process.env }
		if (this.config.enableStealth) {
			env.CHROME_DISABLE_DEV_MODE = '1'
			env.DISABLE_AUTO_ATTACH = '1'
		}
		if (this.config.enableProxy && CONFIG.browser.proxy?.server) {
			env.HTTP_PROXY = CONFIG.browser.proxy.server
			env.HTTPS_PROXY = CONFIG.browser.proxy.server
		}
		return env
	}
	async _validateLaunchOptions(options) {
		if (options.proxy) {
			if (typeof options.proxy.server !== 'string' || !options.proxy.server) {
				throw new ValidationError(
					'Proxy server must be a non-empty string',
					'INVALID_PROXY',
				)
			}
			try {
				new URL(options.proxy.server.replace(/^(http|https):\/\//, ''))
			} catch {
				throw new ValidationError('Invalid proxy server URL format', 'INVALID_PROXY_URL')
			}
		}
		if (options.headless && this.config.enableStealth) {
			this.logger.warn('Stealth mode may be less effective in headless mode')
		}
	}
	async _applyStealthEnhancements(options) {
		try {
			const { chromium: stealthChromium } = await import('playwright-extra')
			const stealthPlugin = await import('puppeteer-extra-plugin-stealth')
			stealthChromium.use(
				stealthPlugin.default({
					enabledEvasions: new Set([
						'chrome.app',
						'chrome.runtime',
						'defaultArgs',
						'navigator.hardwareConcurrency',
						'navigator.languages',
						'navigator.permissions',
						'navigator.plugins',
						'navigator.webdriver',
						'sourceurl',
						'user-agent-override',
						'webgl.vendor',
						'window.outerdimensions',
					]),
				}),
			)
			options._stealthChromium = stealthChromium
			this.logger.debug('Stealth plugin applied via playwright-extra')
		} catch (err) {
			this.logger.warn(
				'playwright-extra not available, applying manual stealth enhancements',
				{
					error: err.message,
				},
			)
			options._manualStealth = true
		}
	}
	async _resolveProxyConfig() {
		const proxy = CONFIG.browser.proxy
		if (!proxy?.server) return null
		const config = {
			server: proxy.server,
			username: proxy.username,
			password: proxy.password,
			bypass: proxy.bypass,
		}
		if (proxy.rotation?.enabled) {
			const { pool, strategy, interval } = proxy.rotation
			if (Array.isArray(pool) && pool.length > 0) {
				let selected
				if (strategy === 'random') {
					selected = pool[Math.floor(Math.random() * pool.length)]
				} else if (strategy === 'round-robin') {
					const index = this._metrics.launches % pool.length
					selected = pool[index]
				}
				if (selected) {
					config.server = selected.server || selected
					config.username = selected.username
					config.password = selected.password
					this.logger.debug('Proxy selected from rotation pool', {
						strategy,
						server: config.server,
					})
				}
			}
		}
		return config
	}
	async _verifyBrowserHealth() {
		try {
			const version = await this.browser.version()
			const userAgent = await this.browser.userAgent?.()
			if (!version) {
				throw new Error('Browser version check returned empty')
			}
			this.logger.debug('Browser health check passed', { version, userAgent })
			return true
		} catch (err) {
			this.logger.error('Browser health check failed', { error: err.message })
			throw new BrowserError('Health check failed', 'HEALTH_CHECK_FAILED', {
				originalError: err.message,
				retryable: true,
			})
		}
	}
	async _createContext() {
		const contextOptions = {
			userAgent: this._generateUserAgent(),
			viewport: CONFIG.browser.viewport,
			locale: 'en-US',
			timezoneId: this.config.enableStealth ? this._spoofTimezone() : 'UTC',
			colorScheme: 'no-preference',
			acceptDownloads: true,
			extraHTTPHeaders: {
				'Accept-Language': 'en-US,en;q=0.9',
				'Accept-Encoding': 'gzip, deflate, br',
				'Sec-Ch-Ua': this._generateSecChUa(),
				'Sec-Ch-Ua-Mobile': '?0',
				'Sec-Ch-Ua-Platform': '"Windows"',
			},
			permissions: [],
			...(this.config.enablePersistence && {
				storageState: await this._loadStorageState(),
			}),
		}
		this.context = await this.browser.newContext(contextOptions)
		await this._injectAntiDetectionCookies()
		this._setupContextListeners()
		this.logger.debug('Browser context created with anti-detection settings', {
			userAgent: contextOptions.userAgent.slice(0, 50) + '...',
			timezone: contextOptions.timezoneId,
		})
	}
	_generateUserAgent() {
		if (!this.config.enableStealth) {
			return CONFIG.browser.userAgent
		}
		const chromeVersions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0']
		const version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)]
		return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
	}
	_generateSecChUa() {
		const brands = [
			{ brand: 'Not_A Brand', version: '8' },
			{ brand: 'Chromium', version: '120' },
			{ brand: 'Google Chrome', version: '120' },
		]
		return JSON.stringify(brands)
	}
	_spoofTimezone() {
		if (!BROWSER_CONSTANTS.TIMEZONE_SPOOFING) return 'UTC'
		const timezones = [
			'America/New_York',
			'America/Chicago',
			'America/Denver',
			'America/Los_Angeles',
			'Europe/London',
			'Europe/Paris',
			'Europe/Berlin',
			'Asia/Tokyo',
			'Asia/Singapore',
			'Australia/Sydney',
		]
		return timezones[Math.floor(Math.random() * timezones.length)]
	}
	async _injectAntiDetectionCookies() {
		const cookies = [
			{
				name: 'safe_link_counter',
				value: '1',
				domain: '.sfile.co',
				path: '/',
				expires: Math.floor(Date.now() / 1000) + 3600,
				httpOnly: false,
				secure: true,
			},
			{
				name: 'session_pref',
				value: 'default',
				domain: '.sfile.co',
				path: '/',
				expires: Math.floor(Date.now() / 1000) + 86400,
			},
		]
		await this.context.addCookies(cookies)
		this.logger.debug('Anti-detection cookies injected')
	}
	_setupContextListeners() {
		this.context.on('page', (page) => {
			this._pages.add(page)
			this.logger.debug('New page created in context', {
				total: this._pages.size,
				max: BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT,
			})
			if (this._pages.size > BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT) {
				this.logger.warn('Page limit exceeded, closing oldest page')
				const oldest = this._pages.values().next().value
				oldest.close().catch(() => {})
				this._pages.delete(oldest)
			}
		})
		this.context.on('close', () => {
			this.logger.debug('Browser context closed')
			for (const p of this._pages) {
				this._pages.delete(p)
			}
		})
	}
	async _setupProtections() {
		this.page = await this.context.newPage()
		this._pages.add(this.page)
		this._metrics.pageCreations++
		this.page.on('crash', this._onPageCrash)
		this.page.on('close', this._onPageClose)
		this.page.on('console', this._onConsoleMessage)
		this.page.on('pageerror', this._onPageError)
		this.page.on('request', this._onRequest)
		this.page.on('response', this._onResponse)
		this.page.on('requestfailed', this._onRequestFailed)
		this._trackedListeners = new Map([
			['crash', { target: this.page, handler: this._onPageCrash }],
			['close', { target: this.page, handler: this._onPageClose }],
			['console', { target: this.page, handler: this._onConsoleMessage }],
			['pageerror', { target: this.page, handler: this._onPageError }],
			['request', { target: this.page, handler: this._onRequest }],
			['response', { target: this.page, handler: this._onResponse }],
			['requestfailed', { target: this.page, handler: this._onRequestFailed }],
		])
		if (this.config.blockResources) {
			await this._setupResourceBlocking()
		}
		if (this.config.enableStealth) {
			await this._injectStealthScripts()
		}
		if (CONFIG.rateLimit.enabled) {
			this._rateLimiter = createRateLimiter({
				tokensPerInterval: 10,
				interval: 1000,
			})
		}
		this.logger.debug('Page protections enabled', {
			blockResources: this.config.blockResources,
			enableStealth: this.config.enableStealth,
			rateLimit: CONFIG.rateLimit.enabled,
		})
	}
	async _setupResourceBlocking() {
		await this.page.route(
			`**/*.{${['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico'].join(',')}}`,
			(route) => route.abort('blockedbyclient'),
		)
		for (const pattern of BROWSER_CONSTANTS.BLOCKED_DOMAIN_PATTERNS) {
			await this.page.route(
				(request) => pattern.test(request.url()),
				(route) => {
					this._metrics.requestsBlocked++
					return route.abort('blockedbyclient')
				},
			)
		}
		await this.page.route('**/*', (route, request) => {
			const type = request.resourceType()
			if (BROWSER_CONSTANTS.BLOCKED_RESOURCE_TYPES.includes(type)) {
				this._metrics.requestsBlocked++
				return route.abort('blockedbyclient')
			}
			return route.continue()
		})
		this.logger.debug('Resource blocking configured', {
			patterns: BROWSER_CONSTANTS.BLOCKED_DOMAIN_PATTERNS.length,
			types: BROWSER_CONSTANTS.BLOCKED_RESOURCE_TYPES.length,
		})
	}
	async _injectStealthScripts() {
		await this.page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, 'webdriver', {
				get: () => undefined,
			})
		})
		await this.page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, 'languages', {
				get: () => ['en-US', 'en', 'id-ID', 'id'],
			})
		})
		if (BROWSER_CONSTANTS.FINGERPRINT_RANDOMIZATION) {
			await this.page.evaluateOnNewDocument((noiseLevel) => {
				const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
				HTMLCanvasElement.prototype.toDataURL = function (...args) {
					const result = originalToDataURL.apply(this, args)
					if (Math.random() < noiseLevel) {
						return result.replace(
							/(data:image\/\w+;base64,)(.+)/,
							(match, prefix, data) => {
								return (
									prefix +
									data.slice(0, -1) +
									(data.slice(-1) === 'A' ? 'B' : 'A')
								)
							},
						)
					}
					return result
				}
			}, BROWSER_CONSTANTS.CANVAS_NOISE_LEVEL)
		}
		this.logger.debug('Stealth scripts injected')
	}
	async newPage(options = {}) {
		if (this._isClosed || this._state.state !== 'ready') {
			throw new BrowserError('Browser not ready', 'NOT_READY')
		}
		if (options.isolated) {
			const isolatedContext = await this.browser.newContext({
				userAgent: this._generateUserAgent(),
				viewport: CONFIG.browser.viewport,
				acceptDownloads: true,
			})
			await this._injectAntiDetectionCookiesToContext(isolatedContext)
			const newPage = await isolatedContext.newPage()
			await this._setupPageProtectionsOnly(newPage)
			newPage._isolatedContext = isolatedContext
			return newPage
		}
		const newPage = await this.context.newPage()
		await this._setupPageProtectionsOnly(newPage)
		return newPage
	}
	async _setupPageProtectionsOnly(page) {
		this._pages.add(page)
		page.on('crash', this._onPageCrash)
		page.on('close', () => {
			this._pages.delete(page)
			this._onPageClose()
		})
		page.on('console', this._onConsoleMessage)
		page.on('pageerror', this._onPageError)
		if (this.config.blockResources) {
			await page.route(
				`**/*.{${['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico'].join(',')}}`,
				(route) => route.abort('blockedbyclient'),
			)
		}
		if (this.config.enableStealth) {
			await page.evaluateOnNewDocument(() => {
				Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
			})
		}
		this.logger.debug('Page protections applied', {
			pageId: page.guid?.slice(0, 8),
		})
		return page
	}
	async goto(url, options = {}) {
		const {
			timeout = CONFIG.timeouts.pageLoad,
			waitUntil = 'networkidle',
			retryOnFailure = true,
			...navOptions
		} = options
		await this._executeMiddleware('beforeNavigate', { url, options })
		const navigate = async () => {
			if (this._rateLimiter) {
				await this._rateLimiter()
			}
			const response = await withTimeout(
				this.page.goto(url, { ...navOptions, waitUntil, timeout }),
				timeout,
				`Navigation timeout: ${url}`,
			)
			await this._executeMiddleware('afterNavigate', {
				url,
				response,
				options,
			})
			return response
		}
		if (retryOnFailure) {
			return withRetry(navigate, {
				maxAttempts: CONFIG.retry.maxAttempts,
				initialDelay: CONFIG.retry.initialDelay,
				shouldRetry: (err) => {
					return (
						err.name === 'TimeoutError' ||
						err.message?.includes('net::') ||
						err.retryable
					)
				},
				onRetry: (attempt, err, delay) => {
					this.logger.debug(`Navigation retry ${attempt}: ${err.message}`, {
						url: url.slice(0, 100),
						delay,
					})
				},
			})
		}
		return navigate()
	}
	_onPageCrash() {
		this._metrics.pageCrashes++
		this.logger.error('Page crashed! Attempting recovery...', {
			crashes: this._metrics.pageCrashes,
		})
		this._handlePageCrash().catch((err) => {
			this.logger.error('Page crash recovery failed', { error: err.message })
		})
	}
	async _handlePageCrash() {
		for (
			let attempt = 1;
			attempt <= BROWSER_CONSTANTS.PAGE_CRASH_RECOVERY_ATTEMPTS;
			attempt++
		) {
			try {
				this.logger.info(
					`Recovery attempt ${attempt}/${BROWSER_CONSTANTS.PAGE_CRASH_RECOVERY_ATTEMPTS}`,
				)
				if (this.context && !this._isClosed) {
					this.page = await this.context.newPage()
					await this._setupPageProtectionsOnly(this.page)
					this.logger.info('Page recovered successfully')
					this.emit('page:recovered', { attempt, timestamp: Date.now() })
					return true
				}
			} catch (err) {
				this.logger.warn(`Recovery attempt ${attempt} failed: ${err.message}`)
				if (attempt === BROWSER_CONSTANTS.PAGE_CRASH_RECOVERY_ATTEMPTS) {
					this.logger.error('Page recovery failed, browser restart required')
					this.emit('page:recovery-failed', { error: err.message })
					this.emit('browser:restart-required')
					return false
				}
				await sleep(1000 * attempt)
			}
		}
		return false
	}
	_onPageClose() {
		this._pages.delete(this.page)
		this.logger.debug('Page closed', { remaining: this._pages.size })
		if (this.page === this._mainPage && this._state.state === 'ready' && !this._isClosed) {
			this.logger.debug('Main page closed, recreating...')
			this.newPage()
				.then((newPage) => {
					this.page = newPage
					this._mainPage = newPage
				})
				.catch((err) => {
					this.logger.error('Failed to recreate main page', {
						error: err.message,
					})
				})
		}
	}
	_onConsoleMessage(msg) {
		const entry = {
			type: msg.type(),
			text: msg.text(),
			location: msg.location(),
			timestamp: Date.now(),
		}
		this._consoleLogs.push(entry)
		if (this._consoleLogs.length > 1000) {
			this._consoleLogs.shift()
		}
		if (CONFIG.debug.enabled || entry.type === 'error' || entry.type === 'warning') {
			const logger =
				entry.type === 'error'
					? this.logger.error
					: entry.type === 'warning'
						? this.logger.warn
						: this.logger.debug
			logger(`[CONSOLE] ${entry.type}: ${entry.text}`, {
				location: entry.location?.url?.slice(0, 80),
			})
		}
	}
	_onPageError(err) {
		const entry = {
			message: err.message,
			stack: err.stack,
			timestamp: Date.now(),
		}
		this._errorLogs.push(entry)
		if (this._errorLogs.length > 100) this._errorLogs.shift()
		this.logger.error(`[PAGE ERROR] ${err.message}`, { stack: err.stack })
		this.emit('page:error', entry)
	}
	_onRequest(request) {
		if (this._rateLimiter && request.isNavigationRequest()) {
			this._rateLimiter().catch(() => {})
		}
		if (CONFIG.debug.enabled) {
			this._networkLogs.push({
				type: 'request',
				url: request.url(),
				method: request.method(),
				resourceType: request.resourceType(),
				timestamp: Date.now(),
			})
			if (this._networkLogs.length > 500) this._networkLogs.shift()
			this.logger.debug(`[REQ] ${request.method()} ${request.url().slice(0, 80)}`)
		}
		this._executeMiddleware('onRequest', { request }).catch((err) => {
			this.logger.warn('onRequest middleware failed', { error: err.message })
		})
	}
	_onResponse(response) {
		if (CONFIG.debug.enabled) {
			this._networkLogs.push({
				type: 'response',
				url: response.url(),
				status: response.status(),
				statusText: response.statusText(),
				timestamp: Date.now(),
			})
			if (this._networkLogs.length > 500) this._networkLogs.shift()
			this.logger.debug(`[RES] ${response.status()} ${response.url().slice(0, 80)}`)
		}
		if (response.headers()['content-disposition']?.includes('attachment')) {
			this.logger.debug('Download response detected', {
				url: response.url().slice(0, 100),
				disposition: response.headers()['content-disposition'],
			})
			this.emit('download:detected', { response })
		}
		this._executeMiddleware('onResponse', { response }).catch((err) => {
			this.logger.warn('onResponse middleware failed', { error: err.message })
		})
	}
	_onRequestFailed(request) {
		const failure = request.failure()
		this.logger.warn(
			`[REQ FAILED] ${failure?.errorText || 'unknown'} - ${request.url().slice(0, 80)}`,
			{
				method: request.method(),
				resourceType: request.resourceType(),
			},
		)
	}
	async _executeMiddleware(hookName, context) {
		const hooks = this._middleware[hookName] || []
		const sorted = [...hooks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
		for (const { handler, once } of sorted) {
			try {
				await handler(context)
				if (once) {
					const idx = this._middleware[hookName].indexOf({ handler, once })
					if (idx >= 0) this._middleware[hookName].splice(idx, 1)
				}
			} catch (err) {
				this.logger.warn(`Middleware ${hookName} failed`, {
					error: err.message,
					handler: handler.name,
				})
			}
		}
	}
	use(hookName, handler, options = {}) {
		if (!this._middleware[hookName]) {
			throw new Error(`Unknown hook: ${hookName}`)
		}
		const entry = {
			handler,
			priority: options.priority ?? 0,
			once: options.once ?? false,
		}
		this._middleware[hookName].push(entry)
		return () => {
			const idx = this._middleware[hookName].indexOf(entry)
			if (idx >= 0) this._middleware[hookName].splice(idx, 1)
		}
	}
	registerPlugin(plugin) {
		if (!(plugin instanceof BrowserPlugin)) {
			throw new TypeError('Plugin must be instance of BrowserPlugin')
		}
		this._plugins.set(plugin.name, plugin)
		for (const hookName of [
			'beforeLaunch',
			'afterLaunch',
			'beforeNavigate',
			'afterNavigate',
			'onRequest',
			'onResponse',
			'beforeClose',
		]) {
			if (plugin._hooks.has(hookName)) {
				for (const { handler, priority, once } of plugin._hooks.get(hookName)) {
					this.use(hookName, handler, { priority, once })
				}
			}
		}
		this.logger.debug(`Plugin registered: ${plugin.name}`)
		this.emit('plugin:registered', { name: plugin.name })
		return () => {
			plugin.disable()
			this._plugins.delete(plugin.name)
			this.emit('plugin:unregistered', { name: plugin.name })
		}
	}
	getMetrics() {
		const memory = getMemoryUsage()
		return {
			...this._metrics,
			state: this._state.state,
			stateHistory: this._state.history.slice(-10),
			pages: {
				active: this._pages.size,
				max: BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT,
			},
			logs: {
				console: this._consoleLogs.length,
				network: this._networkLogs.length,
				errors: this._errorLogs.length,
			},
			memory,
			uptime: this._metrics.startTime ? Date.now() - this._metrics.startTime : 0,
			plugins: Array.from(this._plugins.keys()),
		}
	}
	exportPrometheusMetrics() {
		if (!this.config.enableMetrics) return null
		const m = this.getMetrics()
		const lines = [
			'# HELP sfile_browser_launches_total Total browser launch attempts',
			'# TYPE sfile_browser_launches_total counter',
			`sfile_browser_launches_total ${m.launches}`,
			'',
			'# HELP sfile_browser_failures_total Total launch failures',
			'# TYPE sfile_browser_failures_total counter',
			`sfile_browser_failures_total ${m.failures}`,
			'',
			'# HELP sfile_pages_created_total Total pages created',
			'# TYPE sfile_pages_created_total counter',
			`sfile_pages_created_total ${m.pageCreations}`,
			'',
			'# HELP sfile_requests_blocked_total Total blocked requests',
			'# TYPE sfile_requests_blocked_total counter',
			`sfile_requests_blocked_total ${m.requestsBlocked}`,
			'',
			'# HELP sfile_memory_heap_used_bytes JavaScript heap used (bytes)',
			'# TYPE sfile_memory_heap_used_bytes gauge',
			`sfile_memory_heap_used_bytes ${m.memory.heapUsed * 1024 * 1024}`,
			'',
			'# HELP sfile_uptime_seconds Browser manager uptime',
			'# TYPE sfile_uptime_seconds counter',
			`sfile_uptime_seconds ${Math.floor(m.uptime / 1000)}`,
		]
		return lines.join('\n') + '\n'
	}
	async saveDebugArtifacts(dir = null) {
		if (this._isClosed || !CONFIG.debug.saveArtifacts) {
			return null
		}
		try {
			const artifactsDir =
				dir ||
				CONFIG.debug.artifactsDir ||
				join(process.cwd(), 'debug_artifacts', `browser_${Date.now()}`)
			await mkdir(artifactsDir, { recursive: true })
			const tasks = []
			if (this.page && !this.page.isClosed?.()) {
				tasks.push(
					this.page
						.screenshot({
							path: join(artifactsDir, 'screenshot.png'),
							fullPage: true,
							timeout: 10000,
						})
						.catch((err) =>
							this.logger.warn('Screenshot failed', { error: err.message }),
						),
				)
				tasks.push(
					this.page
						.content()
						.then((html) => writeFile(join(artifactsDir, 'page.html'), html))
						.catch((err) =>
							this.logger.warn('HTML save failed', { error: err.message }),
						),
				)
			}
			tasks.push(
				writeFile(
					join(artifactsDir, 'console.json'),
					JSON.stringify(this._consoleLogs.slice(-100), null, 2),
				).catch((err) =>
					this.logger.warn('Console log save failed', { error: err.message }),
				),
			)
			if (CONFIG.debug.enabled) {
				tasks.push(
					writeFile(
						join(artifactsDir, 'network.json'),
						JSON.stringify(this._networkLogs.slice(-200), null, 2),
					).catch((err) =>
						this.logger.warn('Network log save failed', { error: err.message }),
					),
				)
			}
			tasks.push(
				writeFile(
					join(artifactsDir, 'errors.json'),
					JSON.stringify(this._errorLogs.slice(-50), null, 2),
				).catch((err) => this.logger.warn('Error log save failed', { error: err.message })),
			)
			tasks.push(
				writeFile(
					join(artifactsDir, 'state.json'),
					JSON.stringify(
						{
							state: this._state.state,
							history: this._state.history.slice(-20),
							metrics: this.getMetrics(),
							config: {
								enableStealth: this.config.enableStealth,
								blockResources: this.config.blockResources,
								enableProxy: this.config.enableProxy,
							},
						},
						null,
						2,
					),
				).catch((err) => this.logger.warn('State save failed', { error: err.message })),
			)
			await Promise.allSettled(tasks)
			this.logger.info(`Debug artifacts saved to ${artifactsDir}`)
			this.emit('debug:artifacts-saved', { path: artifactsDir })
			return artifactsDir
		} catch (err) {
			this.logger.error(`Failed to save artifacts: ${err.message}`, {
				error: err.stack,
			})
			return null
		}
	}
	getDiagnostics() {
		return {
			version: '2.0.0',
			state: this._state.state,
			browser: {
				version: this.browser?.version?.() || null,
				contexts: this.browser?._contexts?.length || 0,
			},
			context: {
				pages: this.context?._pages?.length || 0,
				cookies: 'injected',
			},
			page: {
				url: this.page?.url?.() || null,
				title: this.page?.title?.() || null,
				isClosed: this.page?.isClosed?.() ?? true,
			},
			resources: {
				pagesActive: this._pages.size,
				pagesMax: BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT,
				memory: getMemoryUsage(),
			},
			config: {
				stealth: this.config.enableStealth,
				blockResources: this.config.blockResources,
				proxy: this.config.enableProxy ? 'enabled' : 'disabled',
				persistence: this.config.enablePersistence,
			},
			plugins: Array.from(this._plugins.values()).map((p) => p.name),
			recentErrors: this._errorLogs.slice(-10),
		}
	}
	async saveSession(sessionName = 'default') {
		if (!this.config.enablePersistence || !this.context) {
			return false
		}
		try {
			const sessionPath = join(this.config.persistencePath, `${sessionName}.json`)
			await mkdir(dirname(sessionPath), { recursive: true })
			const storageState = await this.context.storageState()
			await writeFile(
				sessionPath,
				JSON.stringify(
					{
						version: 1,
						timestamp: Date.now(),
						userAgent: CONFIG.browser.userAgent,
						storageState,
						metadata: {
							downloadsCompleted: this._metrics.downloadsCompleted,
							lastUrl: this.page?.url?.() || null,
						},
					},
					null,
					2,
				),
			)
			this.logger.debug('Session saved', {
				path: sessionPath,
				name: sessionName,
			})
			return true
		} catch (err) {
			this.logger.error('Failed to save session', {
				error: err.message,
				sessionName,
			})
			return false
		}
	}
	async loadSession(sessionName = 'default') {
		if (!this.config.enablePersistence) {
			return null
		}
		try {
			const sessionPath = join(this.config.persistencePath, `${sessionName}.json`)
			if (
				!(await import('fs').promises
					.access(sessionPath)
					.then(() => true)
					.catch(() => false))
			) {
				this.logger.debug('No saved session found', { sessionName })
				return null
			}
			const content = await readFile(sessionPath, 'utf-8')
			const session = JSON.parse(content)
			this.logger.debug('Session loaded', {
				sessionName,
				timestamp: session.timestamp,
				downloads: session.metadata?.downloadsCompleted,
			})
			return session
		} catch (err) {
			this.logger.warn('Failed to load session', {
				error: err.message,
				sessionName,
			})
			return null
		}
	}
	async _loadPersistedSession() {
		const session = await this.loadSession()
		if (!session?.storageState) return
		try {
			if (session.storageState.cookies?.length) {
				await this.context.addCookies(session.storageState.cookies)
				this.logger.debug(`Restored ${session.storageState.cookies.length} cookies`)
			}
		} catch (err) {
			this.logger.warn('Failed to restore session state', {
				error: err.message,
			})
		}
	}
	async _loadStorageState() {
		if (!this.config.enablePersistence) return undefined
		const session = await this.loadSession()
		return session?.storageState
	}
	async _injectAntiDetectionCookiesToContext(context) {
		await context.addCookies([
			{
				name: 'safe_link_counter',
				value: '1',
				domain: '.sfile.co',
				path: '/',
				expires: Math.floor(Date.now() / 1000) + 3600,
			},
		])
	}
	async _safeCleanup() {
		try {
			if (this.page && !this.page.isClosed?.()) {
				await this.page.close().catch(() => {})
			}
			if (this.context) {
				await this.context.close().catch(() => {})
			}
			if (this.browser) {
				await this.browser.close().catch(() => {})
			}
		} catch (err) {
			this.logger.warn('Cleanup encountered error', { error: err.message })
		}
	}
	_startHealthMonitoring() {
		if (this._healthCheckTimer) return
		this._healthCheckTimer = setInterval(async () => {
			if (this._isClosed || this._state.state !== 'ready') {
				clearInterval(this._healthCheckTimer)
				this._healthCheckTimer = null
				return
			}
			try {
				if (this.browser) {
					await this.browser.version().catch((err) => {
						this.logger.error('Browser health check failed', {
							error: err.message,
						})
						this.emit('browser:unhealthy', { error: err.message })
					})
				}
				const memory = getMemoryUsage()
				if (memory.heapUsed > BROWSER_CONSTANTS.MEMORY_CRITICAL_THRESHOLD_MB) {
					this.logger.error('CRITICAL: Memory usage too high', {
						heapUsed: memory.heapUsed,
						threshold: BROWSER_CONSTANTS.MEMORY_CRITICAL_THRESHOLD_MB,
					})
					this.emit('browser:memory-critical', memory)
				} else if (memory.heapUsed > BROWSER_CONSTANTS.MEMORY_WARNING_THRESHOLD_MB) {
					this.logger.warn('️ Memory usage elevated', {
						heapUsed: memory.heapUsed,
						threshold: BROWSER_CONSTANTS.MEMORY_WARNING_THRESHOLD_MB,
					})
					this.emit('browser:memory-warning', memory)
				}
				if (this._pages.size > BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT) {
					this.logger.warn('Too many pages active', {
						active: this._pages.size,
						max: BROWSER_CONSTANTS.MAX_PAGES_PER_CONTEXT,
					})
				}
				this._metrics.lastActivity = Date.now()
			} catch (err) {
				this.logger.debug('Health check iteration error', {
					error: err.message,
				})
			}
		}, BROWSER_CONSTANTS.HEALTH_CHECK_INTERVAL)
		if (this._healthCheckTimer.unref) {
			this._healthCheckTimer.unref()
		}
		this.logger.debug('Health monitoring started', {
			interval: BROWSER_CONSTANTS.HEALTH_CHECK_INTERVAL,
		})
	}
	async close(options = {}) {
		const {
			timeout = BROWSER_CONSTANTS.GRACEFUL_SHUTDOWN_TIMEOUT,
			saveSession = this.config.enablePersistence,
		} = options
		if (this._isClosed) {
			this.logger.debug('BrowserManager already closed')
			return
		}
		this._isClosed = true
		this.logger.debug('Starting graceful shutdown...', {
			timeout,
			saveSession,
		})
		if (this._state.canTransition('closing')) {
			this._state.transition('closing')
		}
		await this._executeMiddleware('beforeClose', {
			metrics: this.getMetrics(),
			reason: 'graceful-shutdown',
		})
		if (this._healthCheckTimer) {
			clearInterval(this._healthCheckTimer)
			this._healthCheckTimer = null
			this.logger.debug('Health monitoring stopped')
		}
		if (saveSession) {
			await this.saveSession().catch((err) => {
				this.logger.warn('Failed to save session during shutdown', {
					error: err.message,
				})
			})
		}
		for (const [event, { target, handler }] of this._trackedListeners || new Map()) {
			try {
				target?.off?.(event, handler)
			} catch (err) {
				this.logger.debug('Failed to remove listener', {
					event,
					error: err.message,
				})
			}
		}
		this._trackedListeners?.clear()
		this._consoleLogs = []
		this._networkLogs = []
		this._errorLogs = []
		const closePromises = []
		for (const p of this._pages) {
			if (!p.isClosed?.()) {
				closePromises.push(
					p
						.close()
						.catch((err) =>
							this.logger.debug('Page close error', { error: err.message }),
						),
				)
			}
		}
		for (const p of this._pages) {
			if (p._isolatedContext) {
				closePromises.push(
					p._isolatedContext.close().catch((err) =>
						this.logger.debug('Isolated context close error', {
							error: err.message,
						}),
					),
				)
			}
		}
		if (closePromises.length > 0) {
			await withTimeout(
				Promise.allSettled(closePromises),
				timeout / 2,
				'Page cleanup timeout',
			).catch((err) => {
				this.logger.warn('Page cleanup timed out', { error: err.message })
			})
		}
		this._pages.clear()
		if (this.context) {
			try {
				await withTimeout(this.context.close(), timeout / 4, 'Context close timeout')
				this.logger.debug('Context closed')
			} catch (err) {
				this.logger.warn('Context close error', { error: err.message })
			}
			this.context = null
		}
		if (this.browser) {
			try {
				await withTimeout(this.browser.close(), timeout / 4, 'Browser close timeout')
				this.logger.debug('Browser closed')
			} catch (err) {
				this.logger.warn('Browser close error', { error: err.message })
			}
			this.browser = null
		}
		for (const plugin of this._plugins.values()) {
			plugin.disable()
		}
		if (this._state.canTransition('closed')) {
			this._state.transition('closed')
		}
		this._state.reset('closed')
		this._metrics.lastActivity = Date.now()
		this.logger.info('BrowserManager shutdown complete', {
			uptime: this._metrics.startTime ? Date.now() - this._metrics.startTime : 0,
			totalLaunches: this._metrics.launches,
			totalFailures: this._metrics.failures,
		})
		this.emit('browser:closed', {
			metrics: this.getMetrics(),
			timestamp: Date.now(),
		})
	}
	async shutdown(options) {
		return this.close(options)
	}
	get state() {
		return this._state.state
	}
	get isReady() {
		return this._state.state === 'ready' && !this._isClosed
	}
	get mainPage() {
		return this.page
	}
	async getVersion() {
		return this.browser?.version?.() || null
	}
	get isStealthEnabled() {
		return this.config.enableStealth
	}
	updateConfig(updates) {
		const allowed = ['enableStealth', 'blockResources', 'enableProxy']
		for (const key of allowed) {
			if (key in updates) {
				const old = this.config[key]
				this.config[key] = updates[key]
				this.logger.debug(`Config updated: ${key}`, {
					from: old,
					to: updates[key],
				})
				this.emit('config:updated', { key, old, new: updates[key] })
			}
		}
	}
	static create(options) {
		return new BrowserManager(options)
	}
}
export const createBrowserManager = (options) => {
	return new BrowserManager(options)
}
export const launchBrowser = async (options) => {
	const manager = createBrowserManager(options)
	await manager.launch()
	return manager
}
if (process.env.NODE_ENV === 'development' && process.argv.includes('--test-browser')) {
	;(async () => {
		Logger.info('Running BrowserManager self-tests...')
		const tests = [
			{
				name: 'State machine transitions',
				fn: () => {
					const sm = new BrowserStateMachine('idle')
					sm.transition('launching')
					sm.transition('ready')
					return sm.state === 'ready'
				},
			},
			{
				name: 'User agent generation',
				fn: () => {
					const bm = new BrowserManager({ enableStealth: true })
					const ua1 = bm._generateUserAgent()
					const ua2 = bm._generateUserAgent()
					return ua1.startsWith('Mozilla/5.0') && ua2.startsWith('Mozilla/5.0')
				},
			},
			{
				name: 'Filename sanitization via validators',
				fn: () => {
					const { validateFilename } = require('./validators.js')
					const result = validateFilename('test<file>.txt')
					return result.valid && result.value === 'test_file.txt'
				},
			},
		]
		let passed = 0
		for (const test of tests) {
			try {
				const success = await Promise.resolve(test.fn())
				if (success) {
					Logger.debug(`${test.name}`)
					passed++
				} else {
					Logger.error(`${test.name}: returned false`)
				}
			} catch (err) {
				Logger.error(`${test.name}: ${err.message}`)
			}
		}
		Logger.info(`Browser tests: ${passed}/${tests.length} passed`)
		process.exit(passed === tests.length ? 0 : 1)
	})()
}
export default BrowserManager
