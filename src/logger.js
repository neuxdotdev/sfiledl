import { createWriteStream, existsSync, statSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { CONFIG } from './config.js'
const MAX_BUFFER_SIZE = 1000
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_BACKUPS = 5
const FLUSH_INTERVAL = 5000
const WEBHOOK_TIMEOUT = 3000
const LEVELS = Object.freeze({
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
})
const COLORS = Object.freeze({
	DEBUG: '\x1b[36m',
	INFO: '\x1b[32m',
	WARN: '\x1b[33m',
	ERROR: '\x1b[31m',
	RESET: '\x1b[0m',
	BOLD: '\x1b[1m',
	DIM: '\x1b[2m',
})
let _logStream = null
let _flushTimer = null
let _isShuttingDown = false
let _buffer = []
let _metrics = {
	totalLogged: 0,
	byLevel: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 },
	fileWrites: 0,
	webhookSent: 0,
	errors: 0,
}
function supportsColor() {
	if (CONFIG.logging.json || CONFIG.logging.file) return false
	if (process.env.CI) return false
	return process.stdout?.isTTY ?? false
}
const _hasColors = supportsColor()
function sanitizeMeta(meta) {
	if (!meta || typeof meta !== 'object') return meta
	const seen = new WeakSet()
	return JSON.parse(
		JSON.stringify(meta, (key, value) => {
			if (typeof value === 'symbol') return value.toString()
			if (typeof value === 'object' && value !== null) {
				if (seen.has(value)) return '[Circular]'
				seen.add(value)
			}
			if (value instanceof Error) {
				return {
					name: value.name,
					message: value.message,
					stack: value.stack?.split('\n').slice(0, 5).join('\n'),
				}
			}
			return value
		}),
	)
}
function formatTimestamp() {
	return new Date().toISOString()
}
function formatConsole(message, level, meta = {}, context = '') {
	const timestamp = formatTimestamp()
	const levelColor = COLORS[level] || ''
	const contextStr = context ? `${COLORS.DIM}[${context}]${COLORS.RESET} ` : ''
	let metaStr = ''
	if (meta && Object.keys(meta).length > 0) {
		const sanitized = sanitizeMeta(meta)
		metaStr = ` ${COLORS.DIM}${JSON.stringify(sanitized)}${COLORS.RESET}`
	}
	const parts = [
		_hasColors ? `${COLORS.DIM}[${timestamp}]${COLORS.RESET}` : `[${timestamp}]`,
		_hasColors ? `${levelColor}${COLORS.BOLD}${level}${COLORS.RESET}` : level,
		contextStr,
		message,
		metaStr,
	]
	return parts.filter(Boolean).join(' ')
}
function formatFile(message, level, meta = {}, context = '') {
	const entry = {
		timestamp: formatTimestamp(),
		level,
		message,
		...(context && { context }),
		...(meta && Object.keys(meta).length > 0 && { meta: sanitizeMeta(meta) }),
	}
	return CONFIG.logging.json
		? JSON.stringify(entry) + '\n'
		: `[${entry.timestamp}] ${entry.level}${context ? ` [${context}]` : ''}: ${entry.message}${meta ? ` ${JSON.stringify(sanitizeMeta(meta))}` : ''}\n`
}
function rotateLogFile(filePath) {
	try {
		if (!existsSync(filePath)) return
		const stats = statSync(filePath)
		if (stats.size < MAX_FILE_SIZE) return
		Logger.debug('Rotating log file', { path: filePath, size: stats.size })
		for (let i = MAX_BACKUPS; i >= 1; i--) {
			const oldPath = i === MAX_BACKUPS ? `${filePath}.${i}` : `${filePath}.${i}`
			const newPath = `${filePath}.${i + 1}`
			if (existsSync(oldPath)) {
				if (i === MAX_BACKUPS) {
					try {
						require('fs').unlinkSync(oldPath)
					} catch {}
				} else {
					try {
						renameSync(oldPath, newPath)
					} catch {}
				}
			}
		}
		renameSync(filePath, `${filePath}.1`)
		_logStream?.end()
		_logStream = createWriteStream(filePath, { flags: 'a' })
		Logger.info('Log file rotated', { path: filePath })
	} catch (err) {
		console.error('[Logger] Rotation failed:', err.message)
		_metrics.errors++
	}
}
async function flushBuffer() {
	if (!_logStream || _buffer.length === 0 || _isShuttingDown) return
	const toWrite = _buffer.splice(0, _buffer.length)
	for (const entry of toWrite) {
		_logStream.write(entry, (err) => {
			if (err) {
				console.error('[Logger] File write error:', err.message)
				_metrics.errors++
			} else {
				_metrics.fileWrites++
			}
		})
	}
	if (CONFIG.logging.file) {
		rotateLogFile(CONFIG.logging.file)
	}
}
async function sendWebhook(level, message, meta, context) {
	if (!CONFIG.notifications.webhook || level !== 'ERROR') return
	if (!CONFIG.notifications.onError) return
	try {
		const payload = {
			timestamp: formatTimestamp(),
			level,
			message,
			context,
			meta: sanitizeMeta(meta),
			service: 'sfile-downloader',
		}
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT)
		await fetch(CONFIG.notifications.webhook, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		}).catch(() => {})
		clearTimeout(timeout)
		_metrics.webhookSent++
	} catch (err) {
		_metrics.errors++
	}
}
function _log(message, level = 'INFO', meta = {}, context = '') {
	const threshold = LEVELS[CONFIG.logging.level] ?? LEVELS.INFO
	if (LEVELS[level] < threshold) return
	_metrics.totalLogged++
	_metrics.byLevel[level] = (_metrics.byLevel[level] || 0) + 1
	const consoleMsg = formatConsole(message, level, meta, context)
	const fileMsg = formatFile(message, level, meta, context)
	if (level !== 'DEBUG' || CONFIG.debug.enabled) {
		const outputFn = level === 'ERROR' ? console.error : console.log
		outputFn(consoleMsg)
	}
	if (_logStream && !_isShuttingDown) {
		_buffer.push(fileMsg)
		if (_buffer.length >= 50) {
			flushBuffer()
		}
	}
	if (level === 'ERROR') {
		sendWebhook(level, message, meta, context)
	}
	if (_buffer.length > MAX_BUFFER_SIZE) {
		_buffer = _buffer.slice(-MAX_BUFFER_SIZE)
	}
}
class LoggerInstance {
	constructor(context = '') {
		this.context = context
	}
	debug(message, meta = {}) {
		_log(message, 'DEBUG', meta, this.context)
		return this
	}
	info(message, meta = {}) {
		_log(message, 'INFO', meta, this.context)
		return this
	}
	warn(message, meta = {}) {
		_log(message, 'WARN', meta, this.context)
		return this
	}
	error(message, meta = {}) {
		_log(message, 'ERROR', meta, this.context)
		return this
	}
	progress(current, total, label = '') {
		if (total <= 0) return this
		const percent = Math.min(100, Math.round((current / total) * 100))
		const filled = Math.floor(percent / 5)
		const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
		this.info(`[${bar}] ${percent}% ${label}`, { current, total })
		return this
	}
	withContext(newContext) {
		const fullContext = this.context ? `${this.context}:${newContext}` : newContext
		return new LoggerInstance(fullContext)
	}
	getMetrics() {
		return { ..._metrics, bufferLength: _buffer.length }
	}
}
function initializeLogger() {
	Logger.debug('Initializing logger...', {
		level: CONFIG.logging.level,
		file: CONFIG.logging.file,
		json: CONFIG.logging.json,
	})
	if (CONFIG.logging.file) {
		try {
			const dir = dirname(CONFIG.logging.file)
			if (!existsSync(dir)) {
				require('fs').mkdirSync(dir, { recursive: true })
			}
			_logStream = createWriteStream(CONFIG.logging.file, { flags: 'a' })
			_flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL)
			Logger.info('File logging enabled', { path: CONFIG.logging.file })
		} catch (err) {
			console.error('[Logger] Failed to setup file output:', err.message)
			_metrics.errors++
		}
	}
	Logger.info('Logger initialized', {
		level: CONFIG.logging.level,
		hasColors: _hasColors,
		context: 'global',
	})
}
async function shutdown() {
	if (_isShuttingDown) return
	_isShuttingDown = true
	Logger.info('Shutting down logger...')
	if (_flushTimer) {
		clearInterval(_flushTimer)
		_flushTimer = null
	}
	if (_buffer.length > 0) {
		Logger.debug(`Flushing ${_buffer.length} pending log entries...`)
		await flushBuffer()
	}
	if (_logStream) {
		await new Promise((resolve) => {
			_logStream.end(() => {
				Logger.debug('Log file stream closed')
				resolve()
			})
		})
		_logStream = null
	}
	Logger.debug('Logger shutdown complete', { metrics: _metrics })
}
const globalLogger = new LoggerInstance()
initializeLogger()
export const Logger = globalLogger
export const createLogger = (context) => new LoggerInstance(context)
export const LoggerUtils = {
	flush: () => flushBuffer(),
	shutdown: () => shutdown(),
	getMetrics: () => globalLogger.getMetrics(),
	withLevel: (level, callback) => {
		const original = CONFIG.logging.level
		CONFIG.logging.level = level
		try {
			return callback()
		} finally {
			CONFIG.logging.level = original
		}
	},
}
process.on('SIGINT', async () => {
	await shutdown()
	process.exit(0)
})
process.on('SIGTERM', async () => {
	await shutdown()
	process.exit(0)
})
process.on('uncaughtException', (err) => {
	Logger.error('Uncaught exception', {
		error: err,
		fatal: true,
	})
})
process.on('unhandledRejection', (reason, promise) => {
	Logger.error('Unhandled promise rejection', {
		reason: reason?.toString?.() || reason,
		fatal: true,
	})
})
