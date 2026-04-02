import { safeStringify } from './helpers.js'
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export class Logger {
	private minLevel: LogLevel
	constructor(debugMode = false) {
		this.minLevel = debugMode ? 'debug' : 'info'
	}
	setDebug(enabled: boolean) {
		this.minLevel = enabled ? 'debug' : 'info'
	}
	private shouldLog(level: LogLevel): boolean {
		const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
		return levels[level] >= levels[this.minLevel]
	}
	private log(level: LogLevel, message: string, context?: any) {
		if (!this.shouldLog(level)) return
		const ts = new Date().toISOString()
		const ctx = context ? ` ${safeStringify(context)}` : ''
		console.log(`[${ts}] ${level.toUpperCase()}: ${message}${ctx}`)
	}
	debug(msg: string, ctx?: any) {
		this.log('debug', msg, ctx)
	}
	info(msg: string, ctx?: any) {
		this.log('info', msg, ctx)
	}
	warn(msg: string, ctx?: any) {
		this.log('warn', msg, ctx)
	}
	error(msg: string, ctx?: any) {
		this.log('error', msg, ctx)
	}
}
