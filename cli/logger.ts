import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
export interface FileLogger {
	info: (msg: string, data?: unknown) => void
	warn: (msg: string, data?: unknown) => void
	error: (msg: string, data?: unknown) => void
	debug: (msg: string, data?: unknown) => void
}
export function createFileLogger(filePath: string): FileLogger {
	const dir = dirname(filePath)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	const write = (level: string, msg: string, data?: unknown): void => {
		const timestamp = new Date().toISOString()
		let line = `[${timestamp}] [${level.toUpperCase()}] ${msg}`
		if (data !== undefined) {
			line += ` ${JSON.stringify(data)}`
		}
		appendFileSync(filePath, line + '\n')
	}
	return {
		info: (msg, data) => write('info', msg, data),
		warn: (msg, data) => write('warn', msg, data),
		error: (msg, data) => write('error', msg, data),
		debug: (msg, data) => {
			if (process.env['DEBUG'] === 'true') write('debug', msg, data)
		},
	}
}
