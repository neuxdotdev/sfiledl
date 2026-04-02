import { createWriteStream, type WriteStream } from 'fs'
import { safeStringify } from './helpers.js'
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LoggerOptions {
	debugMode?: boolean
	correlationId?: string
	logFile?: string
	prefix?: string
}
export class Logger {
	private minLevel: LogLevel
	private correlationId: string | undefined
	private fileStream: WriteStream | null = null
	private prefix: string
	constructor(options: LoggerOptions = {}) {
		this.minLevel = options.debugMode ? 'debug' : 'info'
		this.correlationId = options.correlationId
		this.prefix = options.prefix || ''
		if (options.logFile) {
			this.fileStream = createWriteStream(options.logFile, { flags: 'a' })
		}
	}
	setCorrelationId(id: string): void {
		this.correlationId = id
	}
	setDebug(enabled: boolean): void {
		this.minLevel = enabled ? 'debug' : 'info'
	}
	private levelPriority(level: LogLevel): number {
		return { debug: 0, info: 1, warn: 2, error: 3 }[level]
	}
	private shouldLog(level: LogLevel): boolean {
		return this.levelPriority(level) >= this.levelPriority(this.minLevel)
	}
	private format(level: LogLevel, message: string, context?: unknown): string {
		const ts = new Date().toISOString()
		const corr = this.correlationId ? ` [${this.correlationId}]` : ''
		const prefix = this.prefix ? ` [${this.prefix}]` : ''
		const ctx = context ? ` | ${safeStringify(context)}` : ''
		return `[${ts}]${corr}${prefix} ${level.toUpperCase()}: ${message}${ctx}`
	}
	private write(level: LogLevel, message: string, context?: unknown): void {
		if (!this.shouldLog(level)) return
		const formatted = this.format(level, message, context)
		const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
		console[consoleMethod](formatted)
		if (this.fileStream?.writable) {
			this.fileStream.write(formatted + '\n')
		}
	}
	debug(msg: string, ctx?: unknown): void {
		this.write('debug', msg, ctx)
	}
	info(msg: string, ctx?: unknown): void {
		this.write('info', msg, ctx)
	}
	warn(msg: string, ctx?: unknown): void {
		this.write('warn', msg, ctx)
	}
	error(msg: string, ctx?: unknown, err?: Error): void {
		let errorCtx: unknown
		if (err) {
			const baseObj =
				ctx && typeof ctx === 'object' && ctx !== null
					? { ...(ctx as Record<string, unknown>) }
					: {}
			errorCtx = {
				...baseObj,
				error: { name: err.name, message: err.message },
			}
		} else {
			errorCtx = ctx
		}
		this.write('error', msg, errorCtx)
	}
	child(prefix: string): Logger {
		const childOptions: LoggerOptions = {
			debugMode: this.minLevel === 'debug',
			...(this.correlationId !== undefined && { correlationId: this.correlationId }),
			prefix: this.prefix ? `${this.prefix}:${prefix}` : prefix,
		}
		const child = new Logger(childOptions)
		if (this.fileStream) {
			;(child as any).fileStream = this.fileStream
		}
		return child
	}
	async close(): Promise<void> {
		if (this.fileStream && !this.fileStream.closed) {
			return new Promise((resolve) => this.fileStream?.end(resolve))
		}
	}
}
