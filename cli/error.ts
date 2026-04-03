import chalk from 'chalk'
import { isAppError, isRetryableError } from '../lib/lib.js'
import { ConfigFileError } from './config.js'
export enum ExitCode {
	Success = 0,
	Generic = 1,
	Validation = 2,
	Config = 3,
}
const SUGGESTIONS: Record<string, string> = {
	VALIDATION_ERROR: 'Check the URL format — it must point to sfile.co or sfile.mobi',
	NETWORK_ERROR: 'Check your internet connection and ensure sfile.co is reachable',
	BROWSER_ERROR: 'Ensure Chromium/Chrome is installed. Try --headed to diagnose',
	FILE_ERROR: 'Verify the output directory exists and is writable',
}
export function formatError(err: unknown): string {
	if (err instanceof ConfigFileError) {
		return [chalk.red.bold('Config Error'), '', chalk.white(err.message)].join('\n')
	}
	if (isAppError(err)) {
		const lines: string[] = [
			chalk.red.bold(`${err.name} [${err.code}]`),
			'',
			chalk.white(err.message),
		]
		const ctx = err.context as Record<string, unknown> | undefined
		if (ctx && Object.keys(ctx).length > 0) {
			lines.push('', chalk.dim('Context:'))
			for (const [key, value] of Object.entries(ctx)) {
				const display =
					typeof value === 'string' ? value : JSON.stringify(value)?.slice(0, 120)
				lines.push(`  ${chalk.dim(`${key}:`)} ${chalk.gray(display ?? 'undefined')}`)
			}
		}
		if (isRetryableError(err)) {
			lines.push('', chalk.yellow('⚠  This error may resolve on retry'))
		}
		const tip = SUGGESTIONS[err.code]
		if (tip) {
			lines.push('', chalk.dim('💡 Tip:'), `  ${chalk.cyan(tip)}`)
		}
		return lines.join('\n')
	}
	if (err instanceof Error) {
		return chalk.red(`${err.name}: ${err.message}`)
	}
	return chalk.red(String(err))
}
export function getExitCode(err: unknown): ExitCode {
	if (err instanceof ConfigFileError) return ExitCode.Config
	if (isAppError(err) && err.code === 'VALIDATION_ERROR') return ExitCode.Validation
	return ExitCode.Generic
}
