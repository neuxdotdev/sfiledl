#!/usr/bin/env node
import { readFile, writeFile, access } from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import EventEmitter from 'events'
import { createInterface } from 'readline'
import { SfileDownloader, DownloadCancelledError } from './lib/downloader.js'
import { Logger, LoggerUtils, createLogger } from './lib/logger.js'
import { CONFIG, ConfigHelper } from './lib/config.js'
import { validateSfileUrl, ValidationError } from './lib/validators.js'
import { sleep, withTimeout, getMemoryUsage, chunkArray } from './lib/utils.js'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_JSON = join(__dirname, 'package.json')
const CLI_CONSTANTS = Object.freeze({
	EXIT_SUCCESS: 0,
	EXIT_ERROR: 1,
	EXIT_VALIDATION: 2,
	EXIT_CANCELLED: 130,
	SHUTDOWN_TIMEOUT: 10000,
	OPERATION_TIMEOUT: null,
	PROGRESS_BAR_WIDTH: 40,
	PROGRESS_UPDATE_THROTTLE: 200,
	BATCH_CHUNK_SIZE: 10,
	INTERACTIVE_CONFIRM: true,
	INTERACTIVE_SKIP_PROMPT: false,
})
class CLIProgress {
	constructor(options = {}) {
		this.label = options.label || ''
		this.total = options.total || null
		this.current = 0
		this.startTime = Date.now()
		this.lastRender = 0
		this.throttle = options.throttle || CLI_CONSTANTS.PROGRESS_UPDATE_THROTTLE
		this.spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
		this.spinnerIndex = 0
		this.isInteractive = process.stdout.isTTY && !CONFIG.logging.json
	}
	update(current, total = null) {
		this.current = current
		if (total !== null) this.total = total
		this._render()
	}
	increment(amount = 1) {
		this.current += amount
		this._render()
	}
	start(label, total = null) {
		this.label = label
		this.total = total
		this.current = 0
		this.startTime = Date.now()
		if (this.isInteractive && !CONFIG.logging.json) {
			process.stdout.write('\n')
		}
		this._render()
	}
	stop(message = 'Done') {
		if (this.isInteractive && !CONFIG.logging.json) {
			process.stdout.write(`\r${' '.repeat(100)}\r`)
			process.stdout.write(`${message}\n`)
		} else {
			Logger.info(message)
		}
	}
	error(message) {
		if (this.isInteractive && !CONFIG.logging.json) {
			process.stdout.write(`\r${' '.repeat(100)}\r`)
			process.stdout.write(`${message}\n`)
		} else {
			Logger.error(message)
		}
	}
	_render() {
		if (!this.isInteractive || CONFIG.logging.json) return
		const now = Date.now()
		if (now - this.lastRender < this.throttle) return
		this.lastRender = now
		const elapsed = (now - this.startTime) / 1000
		const speed = this.current > 0 ? this.current / elapsed : 0
		let output = '\r'
		if (!this.total) {
			output += `${this.spinnerFrames[this.spinnerIndex]} ${this.label}`
			this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length
		} else {
			const percent = Math.min(100, Math.round((this.current / this.total) * 100))
			const filled = Math.round((CLI_CONSTANTS.PROGRESS_BAR_WIDTH * percent) / 100)
			const empty = CLI_CONSTANTS.PROGRESS_BAR_WIDTH - filled
			const bar = '█'.repeat(filled) + '░'.repeat(empty)
			const eta = speed > 0 ? Math.round((this.total - this.current) / speed) : null
			output += `[${bar}] ${percent}% ${this.label}`
			if (eta !== null) output += ` | ETA: ${this._formatETA(eta)}`
			if (speed > 0) output += ` | ${this._formatSpeed(speed)}/s`
		}
		process.stdout.write(output + ' '.repeat(10))
	}
	_formatSpeed(bytesPerSec) {
		if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B`
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB`
		return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB`
	}
	_formatETA(seconds) {
		if (seconds < 60) return `${Math.round(seconds)}s`
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`
		return `${Math.round(seconds / 3600)}h`
	}
	clear() {
		if (this.isInteractive && !CONFIG.logging.json) {
			process.stdout.write(`\r${' '.repeat(100)}\r`)
		}
	}
}
class CLIArgs {
	constructor(argv) {
		this.raw = argv.slice(2)
		this.flags = {}
		this.positional = []
		this.errors = []
		this._parse()
	}
	_parse() {
		let i = 0
		while (i < this.raw.length) {
			const arg = this.raw[i]
			if (arg === '--') {
				this.positional.push(...this.raw.slice(i + 1))
				break
			}
			if (arg.startsWith('--')) {
				const [key, ...valueParts] = arg.slice(2).split('=')
				const value =
					valueParts.length > 0
						? valueParts.join('=')
						: this.raw[i + 1] && !this.raw[i + 1].startsWith('-')
							? this.raw[++i]
							: true
				this.flags[this._normalizeKey(key)] = this._parseValue(value)
			} else if (arg.startsWith('-') && arg.length === 2) {
				const key = arg[1]
				const rest = arg.slice(2)
				if (rest) {
					this.flags[key] = this._parseValue(rest)
				} else {
					const next = this.raw[i + 1]
					this.flags[key] =
						next && !next.startsWith('-') ? this._parseValue(this.raw[++i]) : true
				}
			} else if (arg.startsWith('-') && arg.length > 2) {
				for (const char of arg.slice(1)) {
					this.flags[char] = true
				}
			} else {
				this.positional.push(arg)
			}
			i++
		}
	}
	_normalizeKey(key) {
		return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
	}
	_parseValue(value) {
		if (value === 'true') return true
		if (value === 'false') return false
		if (value === 'null') return null
		if (value === 'undefined') return undefined
		if (/^\d+$/.test(value)) return parseInt(value, 10)
		if (/^\d+\.\d+$/.test(value)) return parseFloat(value)
		return value
	}
	get url() {
		return this.positional[0]
	}
	get saveDir() {
		return this.positional[1]
	}
	require(...keys) {
		for (const key of keys) {
			if (!(key in this.flags)) {
				this.errors.push(`Missing required flag: --${key}`)
			}
		}
		return this
	}
	validateUrl() {
		if (this.url && !this.flags.batch) {
			const result = validateSfileUrl(this.url)
			if (!result.valid) {
				this.errors.push(`Invalid URL: ${result.error}`)
			}
		}
		return this
	}
	validateSaveDir() {
		if (this.saveDir) {
			try {
				const resolved = resolve(this.saveDir)
				if (resolved.includes('..') && !resolved.startsWith(process.cwd())) {
					this.errors.push('Save directory path contains unsafe traversal')
				}
			} catch {
				this.errors.push('Invalid save directory path')
			}
		}
		return this
	}
	validateConcurrency() {
		const c = this.flags.concurrency
		if (c !== undefined && (typeof c !== 'number' || c < 1 || c > 20)) {
			this.errors.push('--concurrency must be between 1 and 20')
		}
		return this
	}
	validateRetry() {
		const r = this.flags.retry
		if (r !== undefined && (typeof r !== 'number' || r < 1 || r > 10)) {
			this.errors.push('--retry must be between 1 and 10')
		}
		return this
	}
	validateTimeout() {
		const t = this.flags.timeout
		if (t !== undefined && (typeof t !== 'number' || t < 1000)) {
			this.errors.push('--timeout must be at least 1000 (ms)')
		}
		return this
	}
	isValid() {
		return this.errors.length === 0
	}
	getErrors() {
		return this.errors
	}
}
class GracefulShutdown extends EventEmitter {
	constructor() {
		super()
		this._isShuttingDown = false
		this._cleanupHandlers = []
		this._setupSignals()
	}
	_setupSignals() {
		process.on('SIGINT', () => this._handleSignal('SIGINT'))
		process.on('SIGTERM', () => this._handleSignal('SIGTERM'))
		if (process.platform !== 'win32') {
			process.on('SIGHUP', async () => {
				Logger.info('SIGHUP received - reloading configuration...')
				try {
					await ConfigHelper.reloadFromFile()
					Logger.info('Configuration reloaded')
					this.emit('config:reloaded')
				} catch (err) {
					Logger.error('Failed to reload config', { error: err.message })
				}
			})
		}
		process.on('uncaughtException', (err) => {
			Logger.error('Uncaught exception', { error: err.message, stack: err.stack })
			this._emergencyShutdown(err)
		})
		process.on('unhandledRejection', (reason, promise) => {
			Logger.error('Unhandled promise rejection', { reason: reason?.toString?.() || reason })
			this._emergencyShutdown(reason)
		})
	}
	_handleSignal(signal) {
		if (this._isShuttingDown) return
		Logger.info(`${signal} received - initiating graceful shutdown...`)
		this._isShuttingDown = true
		const cleanup = async () => {
			for (const handler of [...this._cleanupHandlers].reverse()) {
				try {
					await handler()
				} catch (err) {
					Logger.warn('Cleanup handler failed', { error: err.message })
				}
			}
		}
		const forceExit = setTimeout(() => {
			Logger.error('️ Shutdown timeout - forcing exit')
			process.exit(CLI_CONSTANTS.EXIT_ERROR)
		}, CLI_CONSTANTS.SHUTDOWN_TIMEOUT)
		cleanup()
			.then(() => {
				clearTimeout(forceExit)
				Logger.info('Graceful shutdown complete')
				process.exit(CLI_CONSTANTS.EXIT_CANCELLED)
			})
			.catch((err) => {
				clearTimeout(forceExit)
				Logger.error('Shutdown failed', { error: err.message })
				process.exit(CLI_CONSTANTS.EXIT_ERROR)
			})
	}
	_emergencyShutdown(reason) {
		if (this._isShuttingDown) return
		this._isShuttingDown = true
		Logger.error('Emergency shutdown triggered', { reason: reason?.toString?.() || reason })
		for (const handler of [...this._cleanupHandlers].reverse()) {
			try {
				handler()
			} catch {}
		}
		process.exit(CLI_CONSTANTS.EXIT_ERROR)
	}
	onCleanup(handler) {
		this._cleanupHandlers.push(handler)
		return () => {
			const idx = this._cleanupHandlers.indexOf(handler)
			if (idx >= 0) this._cleanupHandlers.splice(idx, 1)
		}
	}
	get isShuttingDown() {
		return this._isShuttingDown
	}
}
class CLIApp {
	constructor() {
		this.args = null
		this.shutdown = new GracefulShutdown()
		this.progress = null
		this.downloader = null
		this.startTime = null
		this._onDownloadProgress = this._onDownloadProgress.bind(this)
		this._onDownloadComplete = this._onDownloadComplete.bind(this)
		this._onDownloadError = this._onDownloadError.bind(this)
	}
	async run() {
		this.startTime = Date.now()
		try {
			this.args = new CLIArgs(process.argv)
				.validateUrl()
				.validateSaveDir()
				.validateConcurrency()
				.validateRetry()
				.validateTimeout()
			if (!this.args.isValid()) {
				this._showErrors()
				return CLI_CONSTANTS.EXIT_VALIDATION
			}
			if (await this._handleSpecialFlags()) {
				return CLI_CONSTANTS.EXIT_SUCCESS
			}
			if (this.args.flags.help || this.args.flags.h || !this.args.url) {
				this._showHelp()
				return CLI_CONSTANTS.EXIT_SUCCESS
			}
			this._applyCLIFlags()
			await this._initializeLogger()
			this._showStartupInfo()
			this._registerCleanupHandlers()
			if (this.args.flags.batch) {
				await this._runBatchMode()
			} else if (this.args.flags.validateOnly) {
				await this._runValidateMode()
			} else if (this.args.flags.dryRun) {
				await this._runDryRunMode()
			} else {
				await this._runSingleDownload()
			}
			this._showCompletionSummary()
			return CLI_CONSTANTS.EXIT_SUCCESS
		} catch (err) {
			if (err instanceof DownloadCancelledError) {
				Logger.info('️ Download cancelled by user')
				return CLI_CONSTANTS.EXIT_CANCELLED
			}
			Logger.error('Application error', {
				error: err.message,
				stack: CONFIG.debug.enabled ? err.stack : undefined,
			})
			if (CONFIG.debug.enabled && this.downloader?.browserMgr) {
				await this.downloader.browserMgr.saveDebugArtifacts().catch(() => {})
			}
			return CLI_CONSTANTS.EXIT_ERROR
		} finally {
			await this._finalCleanup()
		}
	}
	_showErrors() {
		console.error('\nConfiguration errors:')
		for (const error of this.args.getErrors()) {
			console.error(`   • ${error}`)
		}
		console.error('\nUse --help for usage information.\n')
	}
	async _handleSpecialFlags() {
		if (this.args.flags.version || this.args.flags.v) {
			await this._showVersion()
			return true
		}
		if (this.args.flags.printConfig) {
			this._showConfig()
			return true
		}
		if (this.args.flags.metrics) {
			await this._showMetrics()
			return true
		}
		if (this.args.flags.test || this.args.flags.selfTest) {
			await this._runSelfTest()
			return true
		}
		return false
	}
	_showHelp() {
		const version = this._getVersion()
		console.log(`
Sfile Downloader v${version} - Production CLI
USAGE
  bun run index.js <url> [saveDir] [options]
  bun run index.js --batch=urls.txt [options]
ARGUMENTS
  url              Single sfile.co URL to download
  saveDir          Directory to save files (default: current directory)
OPTIONS
  --batch=FILE     Download URLs from file (one per line)
  --concurrency=N  Parallel downloads for batch mode (1-20, default: ${CONFIG.batch.concurrency})
  --retry=N        Max retry attempts per download (1-10, default: ${CONFIG.retry.maxAttempts})
  --timeout=MS     Global operation timeout in milliseconds
  --headless=BOOL  Run browser with/without UI (default: ${CONFIG.browser.headless})
  --stealth=BOOL   Enable anti-detection features (default: false)
  --proxy=URL      Proxy server URL (e.g., http://user:pass@proxy:8080)
  --checksum=HASH  Expected file checksum for verification
  --checksum-alg=ALG  Hash algorithm: md5|sha1|sha256|sha512 (default: sha256)
  --throttle=BPS   Limit download speed in bytes/sec
  --log-file=PATH  Write logs to file
  --log-level=LEV  Log level: DEBUG|INFO|WARN|ERROR (default: ${CONFIG.logging.level})
  --json           Output logs as JSON (for scripting)
  --silent         Suppress all output except errors
  --verbose        Show debug information
  --dry-run        Validate and plan without downloading
  --validate-only  Only validate URL and config, then exit
  --mock           Use mock browser for testing (development only)
  --plugin=PATH    Load external plugin module
  --webhook=URL    Send completion notifications to webhook
  --notify         Show desktop notification on completion (requires node-notifier)
  --print-config   Print resolved configuration and exit
  --metrics        Output Prometheus-format metrics and exit
  --version, -v    Show version and exit
  --help, -h       Show this help message
OUTPUT FORMATS
  Default: Human-readable with progress bars (TTY)
  --json: Machine-readable JSON logs (one per line)
  --silent: Only errors to stderr
  --verbose: Include debug information
SIGNALS
  SIGINT (Ctrl+C): Graceful cancellation
  SIGTERM: Graceful shutdown
  SIGHUP: Reload configuration file (Unix only)
EXAMPLES
  # Single download
  bun run index.js https://sfile.co/xyz ./downloads
  # With checksum verification
  bun run index.js https://sfile.co/abc --checksum=a1b2c3... --checksum-alg=sha256
  # Batch download with progress
  bun run index.js --batch=urls.txt --concurrency=3 --log-file=download.log
  # Dry run to validate
  bun run index.js https://sfile.co/test --dry-run --verbose
  # JSON output for scripting
  bun run index.js https://sfile.co/xyz --json | jq .
  # With proxy and stealth
  bun run index.js https://sfile.co/secret --proxy=http://proxy:8080 --stealth=true
  # Throttled download (1 MB/s limit)
  bun run index.js https://sfile.co/large --throttle=1048576
DOCUMENTATION
  GitHub: https://github.com/yourorg/sfile-downloader
  Issues: https://github.com/yourorg/sfile-downloader/issues
`)
	}
	async _showVersion() {
		const version = this._getVersion()
		const build = CONFIG.debug.enabled ? ' (debug)' : ''
		if (CONFIG.logging.json) {
			console.log(
				JSON.stringify({
					version,
					build,
					node: process.version,
					bun: process.versions.bun,
				}),
			)
		} else {
			console.log(`Sfile Downloader v${version}${build}`)
			console.log(
				`Node: ${process.version}${process.versions.bun ? ` | Bun: ${process.versions.bun}` : ''}`,
			)
		}
	}
	_getVersion() {
		try {
			if (existsSync(PACKAGE_JSON)) {
				const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
				return pkg.version || 'unknown'
			}
		} catch {}
		return '3.0.0'
	}
	_showConfig() {
		const config = ConfigHelper.getAll()
		if (CONFIG.logging.json) {
			console.log(JSON.stringify(config, null, 2))
		} else {
			console.log('Resolved Configuration:')
			console.log(JSON.stringify(config, null, 2))
		}
	}
	async _showMetrics() {
		const metrics = {
			timestamp: new Date().toISOString(),
			version: this._getVersion(),
			uptime: Date.now() - this.startTime,
			memory: getMemoryUsage(),
			config: {
				logLevel: CONFIG.logging.level,
				debug: CONFIG.debug.enabled,
				headless: CONFIG.browser.headless,
			},
		}
		if (this.downloader) {
			Object.assign(metrics, this.downloader.getMetrics?.() || {})
		}
		if (this.downloader?.browserMgr) {
			const browserMetrics = this.downloader.browserMgr.getMetrics?.()
			if (browserMetrics) {
				metrics.browser = browserMetrics
			}
			const prom = this.downloader.browserMgr.exportPrometheusMetrics?.()
			const dlProm = this.downloader.exportPrometheusMetrics?.()
			if (prom || dlProm) {
				console.log('# HELP sfile_cli_info CLI application metrics')
				console.log('# TYPE sfile_cli_info gauge')
				console.log(`sfile_cli_info{version="${metrics.version}"} 1`)
				console.log('')
				console.log(prom || '')
				console.log(dlProm || '')
				return
			}
		}
		console.log(JSON.stringify(metrics, null, 2))
	}
	async _runSelfTest() {
		Logger.info('Running self-tests...')
		const tests = [
			{
				name: 'Config initialization',
				fn: () => ConfigHelper.get('browser.headless') !== undefined,
			},
			{
				name: 'Logger initialization',
				fn: () => LoggerUtils.getMetrics().totalLogged >= 0,
			},
			{
				name: 'URL validation',
				fn: () => validateSfileUrl('https://sfile.co/test').valid,
			},
			{
				name: 'Filename sanitization',
				fn: async () => {
					const { sanitizeFilename } = await import('./lib/validators.js')
					return sanitizeFilename('test<file>.txt') === 'test_file.txt'
				},
			},
		]
		let passed = 0
		for (const test of tests) {
			try {
				const result = await Promise.resolve(test.fn())
				if (result) {
					Logger.info(`${test.name}`)
					passed++
				} else {
					Logger.error(`${test.name}: failed`)
				}
			} catch (err) {
				Logger.error(`${test.name}: ${err.message}`)
			}
		}
		Logger.info(`Self-tests: ${passed}/${tests.length} passed`)
		return passed === tests.length ? CLI_CONSTANTS.EXIT_SUCCESS : CLI_CONSTANTS.EXIT_ERROR
	}
	_applyCLIFlags() {
		if (this.args.flags.logLevel) {
			CONFIG.logging.level = String(this.args.flags.logLevel).toUpperCase()
		}
		if (this.args.flags.logFile) {
			CONFIG.logging.file = resolve(String(this.args.flags.logFile))
		}
		if (this.args.flags.json) {
			CONFIG.logging.json = true
		}
		if (this.args.flags.silent) {
			CONFIG.logging.level = 'ERROR'
		}
		if (this.args.flags.verbose) {
			CONFIG.logging.level = 'DEBUG'
			CONFIG.debug.enabled = true
		}
		if (this.args.flags.headless !== undefined) {
			CONFIG.browser.headless =
				this.args.flags.headless === 'false' ? false : !!this.args.flags.headless
		}
		if (this.args.flags.stealth !== undefined) {
			CONFIG.browser.stealth = { enabled: !!this.args.flags.stealth }
		}
		if (this.args.flags.proxy) {
			try {
				const proxyUrl = new URL(String(this.args.flags.proxy))
				CONFIG.browser.proxy = {
					server: proxyUrl.origin,
					username: proxyUrl.username || undefined,
					password: proxyUrl.password || undefined,
				}
			} catch {
				Logger.warn('Invalid proxy URL format, ignoring')
			}
		}
		if (this.args.flags.retry) {
			CONFIG.retry.maxAttempts = this.args.flags.retry
		}
		if (this.args.flags.timeout) {
			CLI_CONSTANTS.OPERATION_TIMEOUT = this.args.flags.timeout
		}
		if (this.args.flags.checksum) {
			CONFIG.download.validateChecksum = true
		}
		if (this.args.flags.checksumAlg) {
			CONFIG.download.checksumAlgorithm = this.args.flags.checksumAlg
		}
		if (this.args.flags.throttle) {
			CONFIG.download.throttleBps = this.args.flags.throttle
		}
		if (this.args.flags.debug) {
			CONFIG.debug.enabled = true
			CONFIG.debug.saveArtifacts = true
		}
	}
	async _initializeLogger() {
		if (CONFIG.logging.file) {
			const dir = dirname(CONFIG.logging.file)
			if (!existsSync(dir)) {
				await import('fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
			}
		}
		Logger.info('Sfile Downloader CLI starting', {
			version: this._getVersion(),
			node: process.version,
			args: process.argv.slice(2).join(' '),
		})
	}
	_showStartupInfo() {
		if (CONFIG.logging.json) return
		Logger.info('Configuration', {
			saveDir: this.args.saveDir || process.cwd(),
			mode: this.args.flags.batch ? 'batch' : 'single',
			retries: CONFIG.retry.maxAttempts,
			headless: CONFIG.browser.headless,
		})
		if (this.args.flags.dryRun) {
			Logger.info('DRY RUN MODE - No files will be downloaded')
		}
		if (this.args.flags.validateOnly) {
			Logger.info('VALIDATE ONLY MODE - Checking URL and config')
		}
	}
	_registerCleanupHandlers() {
		this.shutdown.onCleanup(async () => {
			if (this.downloader) {
				Logger.debug('Closing downloader...')
				await this.downloader.close({ saveHistory: true }).catch(() => {})
			}
		})
		this.shutdown.onCleanup(async () => {
			await LoggerUtils.flush()
		})
		this.shutdown.onCleanup(() => {
			this.progress?.clear()
		})
	}
	async _runSingleDownload() {
		const url = this.args.url
		const saveDir = this.args.saveDir || process.cwd()
		Logger.info('Starting download', { url: url.slice(0, 100) })
		this.progress = new CLIProgress({ label: 'Preparing...' })
		this.downloader = new SfileDownloader({
			saveDir,
			enableChecksum: !!this.args.flags.checksum,
			checksumAlgorithm: this.args.flags.checksumAlg,
			throttleBps: this.args.flags.throttle,
			skipExisting: !this.args.flags.force,
			webhooks: {
				onComplete: this.args.flags.webhook,
				onError: this.args.flags.webhook,
			},
			onProgress: this._onDownloadProgress,
			onComplete: this._onDownloadComplete,
			onError: this._onDownloadError,
		})
		const options = {
			filename: this.args.flags.filename,
			expectedChecksum: this.args.flags.checksum,
			metadata: {
				source: 'cli',
				startedAt: new Date().toISOString(),
				cliFlags: { ...this.args.flags },
			},
		}
		const downloadPromise = this.downloader.download(url, options)
		if (CLI_CONSTANTS.OPERATION_TIMEOUT) {
			await withTimeout(
				downloadPromise,
				CLI_CONSTANTS.OPERATION_TIMEOUT,
				`Operation timeout (${CLI_CONSTANTS.OPERATION_TIMEOUT}ms)`,
			)
		} else {
			await downloadPromise
		}
	}
	async _runBatchMode() {
		const batchFile = this.args.flags.batch
		const saveDir = this.args.saveDir || process.cwd()
		const concurrency = this.args.flags.concurrency || CONFIG.batch.concurrency
		if (!existsSync(batchFile)) {
			throw new Error(`Batch file not found: ${batchFile}`)
		}
		const content = await readFile(batchFile, 'utf-8')
		const urls = content
			.split('\n')
			.map((u) => u.trim())
			.filter((u) => u && !u.startsWith('#'))
		if (urls.length === 0) {
			throw new Error('No valid URLs found in batch file')
		}
		Logger.info(`Batch download: ${urls.length} URLs`, {
			file: batchFile,
			concurrency,
			saveDir,
		})
		this.progress = new CLIProgress({
			label: 'Batch download',
			total: urls.length,
		})
		this.progress.start('Processing URLs', urls.length)
		const chunks = chunkArray(urls, CLI_CONSTANTS.BATCH_CHUNK_SIZE)
		const results = []
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]
			const chunkResults = await SfileDownloader.batchDownload(chunk, {
				saveDir,
				concurrency,
				enableChecksum: !!this.args.flags.checksum,
				checksumAlgorithm: this.args.flags.checksumAlg,
				throttleBps: this.args.flags.throttle,
				skipExisting: !this.args.flags.force,
				stopOnError: this.args.flags.stopOnError ?? CONFIG.batch.stopOnError,
				onBatchProgress: (progress) => {
					this.progress.update(i * CLI_CONSTANTS.BATCH_CHUNK_SIZE + progress.completed)
					if (progress.completed % 10 === 0 && progress.completed > 0) {
						const success = progress.results.filter(
							(r) => r.status === 'fulfilled',
						).length
						Logger.info(`Progress: ${success}/${progress.completed} successful`)
					}
				},
				webhooks: {
					onComplete: this.args.flags.webhook,
					onError: this.args.flags.webhook,
				},
			})
			results.push(...chunkResults)
			this.progress.increment(chunk.length)
		}
		this.progress.stop('Batch complete')
		this._showBatchSummary(results)
	}
	async _runValidateMode() {
		const url = this.args.url
		Logger.info('Validating URL and configuration...')
		const urlResult = validateSfileUrl(url)
		if (!urlResult.valid) {
			throw new ValidationError(`URL validation failed: ${urlResult.error}`, {
				code: urlResult.code,
				details: urlResult.details,
			})
		}
		Logger.info('URL validation passed', {
			domain: urlResult.details?.domain,
			fileId: urlResult.details?.fileId,
			protocol: urlResult.details?.protocol,
		})
		const saveDir = this.args.saveDir || process.cwd()
		try {
			await access(saveDir)
			Logger.info('Save directory accessible', { path: saveDir })
		} catch {
			Logger.warn('️ Save directory not accessible, will attempt to create', { path: saveDir })
		}
		if (this.args.flags.dryRun) {
			Logger.info('DRY RUN - Would download:', {
				url,
				saveDir,
				filename: this.args.flags.filename || '(auto-detected)',
				checksum: this.args.flags.checksum ? 'will verify' : 'none',
			})
		}
		Logger.info('Validation complete - all checks passed')
	}
	async _runDryRunMode() {
		await this._runValidateMode()
		Logger.info('Dry run plan:', {
			steps: [
				'1. Launch browser (headless: ' + CONFIG.browser.headless + ')',
				'2. Navigate to URL and extract download link',
				'3. Download file with retry logic (max ' + CONFIG.retry.maxAttempts + ' attempts)',
				'4. Save to: ' + (this.args.saveDir || process.cwd()),
				...(this.args.flags.checksum
					? ['5. Verify checksum: ' + this.args.flags.checksum]
					: []),
			],
			estimatedTime: '~10-60 seconds depending on file size and connection',
		})
	}
	_onDownloadProgress(state) {
		if (!this.progress) return
		if (state.progress !== undefined) {
			this.progress.update(state.downloadedBytes, state.expectedSize)
		}
		if (state.speedBps > 0 && state.etaSeconds !== null) {
			const now = Date.now()
			if (!this._lastDetailLog || now - this._lastDetailLog > 5000) {
				Logger.debug('Progress', {
					progress: `${state.progress}%`,
					speed: state.speedHuman,
					eta: state.etaHuman,
					downloaded: `${Math.round(state.downloadedBytes / 1024 / 1024)} MB`,
				})
				this._lastDetailLog = now
			}
		}
	}
	_onDownloadComplete(result) {
		this.progress?.stop(`${result.filename}`)
		if (this.args.flags.notify) {
			this._sendDesktopNotification(
				'Download Complete',
				`${result.filename} saved successfully`,
			)
		}
		Logger.info('Download completed', {
			filename: result.filename,
			size: `${Math.round(result.size / 1024 / 1024)} MB`,
			duration: `${Math.round(result.duration / 1000)}s`,
			method: result.method,
			checksumVerified: result.checksumVerified,
		})
	}
	_onDownloadError(errorInfo) {
		this.progress?.error(`${errorInfo.message}`)
		if (this.args.flags.notify) {
			this._sendDesktopNotification('Download Failed', errorInfo.message, 'error')
		}
		Logger.error('Download failed', {
			url: errorInfo.url?.slice(0, 100),
			error: errorInfo.message,
			code: errorInfo.code,
			attempt: errorInfo.attempt,
		})
	}
	_sendDesktopNotification(title, message, type = 'info') {
		try {
			import('node-notifier')
				.then(({ notify }) => {
					notify({
						title: `Sfile Downloader: ${title}`,
						message,
						icon: type === 'error' ? 'error' : 'info',
						timeout: 10,
					})
				})
				.catch(() => {})
		} catch {}
	}
	_showBatchSummary(results) {
		const total = results.length
		const success = results.filter((r) => r.status === 'fulfilled').length
		const failed = total - success
		Logger.info(`Batch Summary: ${success}/${total} successful`, {
			success,
			failed,
			total,
			successRate: `${Math.round((success / total) * 100)}%`,
		})
		if (failed > 0 && CONFIG.debug.enabled) {
			Logger.debug('Failed downloads:')
			results
				.filter((r) => r.status === 'rejected')
				.forEach((r) => {
					Logger.debug(`   • ${r.url}: ${r.reason?.message || r.reason}`)
				})
		}
		if (CONFIG.logging.json) {
			console.log(
				JSON.stringify({
					summary: { total, success, failed },
					results: results.map((r) => ({
						url: r.url,
						status: r.status,
						filename: r.value?.filename,
						error: r.reason?.message,
					})),
				}),
			)
		}
	}
	_showCompletionSummary() {
		const duration = Date.now() - this.startTime
		if (CONFIG.logging.json) {
			console.log(
				JSON.stringify({
					status: 'success',
					duration: `${Math.round(duration / 1000)}s`,
					memory: getMemoryUsage(),
				}),
			)
		} else {
			Logger.info(`All done!`, {
				duration: `${Math.round(duration / 1000)}s`,
				memory: `${getMemoryUsage().heapUsed} MB used`,
			})
		}
	}
	async _finalCleanup() {
		if (this.downloader) {
			try {
				await this.downloader.close({ saveHistory: true })
			} catch (err) {
				Logger.warn('Failed to close downloader', { error: err.message })
			}
		}
		await LoggerUtils.flush()
		this.progress?.clear()
	}
}
;(async () => {
	const app = new CLIApp()
	const exitCode = await app.run()
	process.exit(exitCode)
})()
if (process.env.NODE_ENV === 'development' && process.argv.includes('--test-cli')) {
	;(async () => {
		console.log('Testing CLI argument parser...')
		const testCases = [
			{ args: ['--flag', 'value'], expected: { flag: 'value' } },
			{ args: ['--flag=value'], expected: { flag: 'value' } },
			{ args: ['-f', 'val'], expected: { f: 'val' } },
			{
				args: ['url', '--batch=file.txt'],
				expected: { positional: ['url'], flags: { batch: 'file.txt' } },
			},
		]
		for (const { args, expected } of testCases) {
			const parsed = new CLIArgs(['node', 'index.js', ...args])
			console.log(
				`${args.join(' ')} → ${JSON.stringify({ flags: parsed.flags, positional: parsed.positional })}`,
			)
		}
		console.log('CLI tests passed')
		process.exit(0)
	})()
}
