#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { downloadSfile } from '../lib/lib.js'
import { loadFileConfig, resolveConfig, toDownloadOptions, type CliOptions } from './config.js'
import { formatError, getExitCode, ExitCode } from './error.js'
import { createSpinner, printResult, log as uiLog, type PrintResultInput } from './ui.js'
import { createFileLogger, type FileLogger } from './logger.js'
function findPackageJson(startDir: string): string | null {
	let current = startDir
	const root = dirname(process.cwd())
	while (current !== root) {
		const pkgPath = join(current, 'package.json')
		if (existsSync(pkgPath)) return pkgPath
		current = dirname(current)
	}
	const fallbackPath = join(process.cwd(), 'package.json')
	if (existsSync(fallbackPath)) return fallbackPath
	return null
}
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = findPackageJson(__dirname)
if (!pkgPath) throw new Error('package.json not found!')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
function parsePositiveInt(value: string): number {
	const n = parseInt(value, 10)
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`expected a positive integer, got "${value}"`)
	}
	return n
}
function parseTimeout(value: string): number {
	const ms = parsePositiveInt(value)
	if (ms < 1000) throw new Error('timeout must be at least 1000ms')
	return ms
}
function buildHelpFooter(): string {
	const dim = chalk.dim
	const gray = chalk.gray
	const cyan = chalk.cyan
	const bold = chalk.bold
	return `
 ${dim('─'.repeat(44))}
 ${bold('Examples:')}
  ${gray('$')} sfiledl https://sfile.co/abc123
  ${gray('$')} sfiledl https://sfile.co/abc123 ${cyan('-o ~/Downloads')}
  ${gray('$')} sfiledl https://sfile.co/abc123 ${cyan('--headed --debug')}
  ${gray('$')} sfiledl https://sfile.co/abc123 ${cyan('-r 5 -d 2000')}
 ${bold('Config')} ${gray('.sfiledlrc.json')}
  ${cyan('{')}
  ${cyan('  "output":') + ' "./downloads",'}
  ${cyan('  "retries":') + ' 3,'}
  ${cyan('  "debug":') + ' false'}
  ${cyan('}')}
`
}
class SfileCli {
	private program: Command
	private fileLogger: FileLogger | null = null
	constructor() {
		this.program = new Command()
		this.setupProgram()
	}
	private setupProgram(): void {
		this.program
			.name('sfiledl')
			.description('Download files from sfile.co')
			.version(pkg.version, '-v, --version')
			.helpOption('-h, --help')
			.argument('<url>', 'sfile.co download URL')
			.option('-o, --output <dir>', 'Save to directory', './downloads')
			.option('--headed', 'Show browser window (disable headless)')
			.option('-t, --timeout <ms>', 'Navigation timeout in milliseconds', parseTimeout)
			.option(
				'--button-timeout <ms>',
				'Download button wait timeout in milliseconds',
				parsePositiveInt,
			)
			.option('-r, --retries <n>', 'Maximum retry attempts', parsePositiveInt)
			.option('-d, --retry-delay <ms>', 'Base retry delay in milliseconds', parsePositiveInt)
			.option('--debug', 'Enable debug mode')
			.option('--ua, --user-agent <string>', 'Custom User-Agent header')
			.option('--no-progress', 'Disable progress spinner')
			.option('--log-file <path>', 'Write logs to file')
			.option('--no-artifacts', 'Skip saving debug artifacts on error')
			.addHelpText('after', buildHelpFooter())
			.configureOutput({
				outputError: (str, write) => write(chalk.red(str)),
			})
			.action(async (url: string, opts: CliOptions) => {
				await this.run(url, opts)
			})
	}
	private async run(url: string, opts: CliOptions): Promise<void> {
		if (opts.logFile) {
			this.fileLogger = createFileLogger(opts.logFile)
			this.fileLogger.info(`CLI started with URL: ${url}`)
		}
		let spinner: SpinnerHandle | null = null
		try {
			const fileConfig = loadFileConfig()
			const config = resolveConfig(fileConfig, opts)
			const dlOpts = toDownloadOptions(config)
			if (config.progress) {
				spinner = createSpinner('Initializing...')
				dlOpts.onProgress = (_pct, _total, meta) => {
					spinner?.setText(meta.message)
					this.fileLogger?.debug(`Progress: ${meta.message}`)
				}
			}
			if (config.debug) {
				uiLog.debug(`Output directory: ${config.output}`)
				uiLog.debug(`Headless: ${config.headless}, Timeout: ${config.timeout}ms`)
				uiLog.debug(`Retries: ${config.retries}, Retry delay: ${config.retryDelay}ms`)
				this.fileLogger?.debug('Download options', dlOpts)
			}
			const result = await downloadSfile(url, config.output, dlOpts)
			spinner?.succeed(chalk.green('Download complete'))
			const printData: PrintResultInput = {
				filePath: result.filePath,
				size: result.size,
				method: result.method,
				...(result.durationMs !== undefined && { durationMs: result.durationMs }),
				...(result.attempts !== undefined && { attempts: result.attempts }),
			}
			printResult(printData)
			this.fileLogger?.info(
				`Download successful: ${result.filePath} (${result.size} bytes, ${result.method})`,
			)
			process.exit(ExitCode.Success)
		} catch (err) {
			spinner?.fail(chalk.red('Download failed'))
			const errorMsg = formatError(err)
			console.error()
			console.error(errorMsg)
			console.error()
			this.fileLogger?.error(`Download failed: ${errorMsg}`)
			if (err instanceof Error && err.stack !== undefined && opts.debug) {
				this.fileLogger?.debug(`Stack trace: ${err.stack}`)
			}
			process.exit(getExitCode(err))
		}
	}
	public parse(): void {
		this.program.parse()
	}
}
import type { SpinnerHandle } from './ui.js'
const cli = new SfileCli()
cli.parse()
