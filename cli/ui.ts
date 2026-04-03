import chalk from 'chalk'
import ora from 'ora'
export interface SpinnerHandle {
	setText: (msg: string) => void
	succeed: (msg?: string) => void
	fail: (msg?: string) => void
	stop: () => void
}
export interface PrintResultInput {
	filePath: string
	size: number
	method: 'direct' | 'fallback'
	durationMs?: number | undefined
	attempts?: number | undefined
}
const ICON = {
	success: '✅',
	error: '❌',
	warn: '⚠️',
	info: 'ℹ️',
	download: '📥',
} as const
const SEP = chalk.dim('─'.repeat(45))
export function createSpinner(text: string): SpinnerHandle {
	const instance = ora({ text, color: 'cyan', spinner: 'dots' }).start()
	return {
		setText: (msg: string) => {
			instance.text = msg
		},
		succeed: (msg?: string) => instance.succeed(msg),
		fail: (msg?: string) => instance.fail(msg),
		stop: () => instance.stop(),
	}
}
export function formatBytes(bytes: number): string {
	if (bytes <= 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(1024))
	return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
export function formatDuration(ms: number): string {
	if (ms <= 0) return '0ms'
	if (ms < 1000) return `${Math.round(ms)}ms`
	const sec = ms / 1000
	if (sec < 60) return `${sec.toFixed(1)}s`
	const min = Math.floor(sec / 60)
	const rem = Math.round(sec % 60)
	return `${min}m ${rem}s`
}
export function printResult(result: PrintResultInput): void {
	const size = formatBytes(result.size)
	const duration = formatDuration(result.durationMs ?? 0)
	const methodIcon = result.method === 'direct' ? ICON.success : ICON.warn
	const methodColored =
		result.method === 'direct'
			? chalk.green.bold(`${methodIcon} direct`)
			: chalk.yellow.bold(`${methodIcon} fallback`)
	const lines = [
		'',
		`${chalk.cyan(`${ICON.download} Download Summary`)}`,
		SEP,
		` ${chalk.bold('File:')}     ${chalk.whiteBright(result.filePath)}`,
		` ${chalk.bold('Size:')}     ${chalk.magenta(size)}`,
		` ${chalk.bold('Method:')}   ${methodColored}`,
		` ${chalk.bold('Duration:')} ${chalk.blue(duration)}`,
	]
	if ((result.attempts ?? 1) > 1) {
		lines.push(` ${chalk.bold('Attempts:')} ${chalk.yellow(String(result.attempts))}`)
	}
	if (result.durationMs !== undefined && result.durationMs > 0 && result.size > 0) {
		const speed = result.size / (result.durationMs / 1000)
		lines.push(` ${chalk.bold('Speed:')}    ${chalk.cyan(`${formatBytes(speed)}/s`)}`)
	}
	lines.push(SEP, '')
	console.log(lines.join('\n'))
}
export const log = {
	info: (msg: string): void => console.log(`${chalk.blue(ICON.info)} ${msg}`),
	success: (msg: string): void => console.log(`${chalk.green(ICON.success)} ${msg}`),
	warn: (msg: string): void => console.log(`${chalk.yellow(ICON.warn)} ${msg}`),
	error: (msg: string): void => console.error(`${chalk.red(ICON.error)} ${msg}`),
	debug: (msg: string): void => {
		if (process.env['DEBUG'] === 'true') {
			console.log(`${chalk.gray('[DEBUG]')} ${msg}`)
		}
	},
}
