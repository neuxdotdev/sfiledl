import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { DEFAULTS } from '../lib/lib.js'
import type { DownloadOptions } from '../lib/lib.js'
export interface FileConfig {
	output?: string
	headless?: boolean
	timeout?: number
	buttonTimeout?: number
	retries?: number
	retryDelay?: number
	debug?: boolean
	userAgent?: string
	logFile?: string
	debugArtifacts?: boolean
	progress?: boolean
}
export interface CliOptions {
	output: string
	headed?: boolean
	timeout?: number
	buttonTimeout?: number
	retries?: number
	retryDelay?: number
	debug?: boolean
	userAgent?: string
	progress: boolean
	logFile?: string
	artifacts: boolean
}
export interface ResolvedConfig {
	output: string
	headless: boolean
	timeout: number
	buttonTimeout: number
	retries: number
	retryDelay: number
	debug: boolean
	userAgent: string
	progress: boolean
	logFile: string | undefined
	debugArtifacts: boolean
}
export class ConfigFileError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ConfigFileError'
	}
}
const CONFIG_FILES = ['.sfiledlrc.json', '.sfiledlrc'] as const
function isStr(v: unknown): v is string {
	return typeof v === 'string'
}
function isPosNum(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0
}
function isBool(v: unknown): v is boolean {
	return typeof v === 'boolean'
}
function validateFileConfig(raw: Record<string, unknown>, source: string): FileConfig {
	const out: FileConfig = {}
	function check<T>(
		key: string,
		value: unknown,
		label: string,
		guard: (v: unknown) => v is T,
	): T {
		if (!guard(value)) {
			throw new ConfigFileError(`"${source}": "${key}" must be ${label}, got ${typeof value}`)
		}
		return value
	}
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue
		switch (key) {
			case 'output':
				out.output = check(key, value, 'a string', isStr)
				break
			case 'userAgent':
				out.userAgent = check(key, value, 'a string', isStr)
				break
			case 'logFile':
				out.logFile = check(key, value, 'a string', isStr)
				break
			case 'timeout':
				out.timeout = check(key, value, 'a positive number', isPosNum)
				break
			case 'buttonTimeout':
				out.buttonTimeout = check(key, value, 'a positive number', isPosNum)
				break
			case 'retries':
				out.retries = check(key, value, 'a positive number', isPosNum)
				break
			case 'retryDelay':
				out.retryDelay = check(key, value, 'a positive number', isPosNum)
				break
			case 'headless':
				out.headless = check(key, value, 'a boolean', isBool)
				break
			case 'debug':
				out.debug = check(key, value, 'a boolean', isBool)
				break
			case 'debugArtifacts':
				out.debugArtifacts = check(key, value, 'a boolean', isBool)
				break
			case 'progress':
				out.progress = check(key, value, 'a boolean', isBool)
				break
		}
	}
	return out
}
export function loadFileConfig(): FileConfig {
	for (const filename of CONFIG_FILES) {
		const filePath = resolve(filename)
		if (!existsSync(filePath)) continue
		try {
			const raw = readFileSync(filePath, 'utf-8')
			const parsed = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null) {
				throw new ConfigFileError(`"${filename}" must contain a JSON object`)
			}
			return validateFileConfig(parsed as Record<string, unknown>, filename)
		} catch (err) {
			if (err instanceof ConfigFileError) throw err
			if (err instanceof SyntaxError) {
				throw new ConfigFileError(`Invalid JSON in "${filename}": ${err.message}`)
			}
			throw new ConfigFileError(`Failed to read "${filename}": ${(err as Error).message}`)
		}
	}
	return {}
}
export function resolveConfig(file: FileConfig, args: CliOptions): ResolvedConfig {
	return {
		output: args.output.trim() || './downloads',
		headless: args.headed ? false : (file.headless ?? DEFAULTS.headless),
		timeout: args.timeout ?? file.timeout ?? DEFAULTS.timeout,
		buttonTimeout: args.buttonTimeout ?? file.buttonTimeout ?? DEFAULTS.downloadButtonTimeout,
		retries: args.retries ?? file.retries ?? DEFAULTS.retries,
		retryDelay: args.retryDelay ?? file.retryDelay ?? DEFAULTS.retryDelay,
		debug: args.debug === true ? true : file.debug === true,
		userAgent: args.userAgent ?? file.userAgent ?? DEFAULTS.userAgent,
		progress: args.progress === false ? false : file.progress !== false,
		logFile: args.logFile ?? file.logFile,
		debugArtifacts:
			args.artifacts === false ? false : (file.debugArtifacts ?? DEFAULTS.saveDebugArtifacts),
	}
}
export function toDownloadOptions(config: ResolvedConfig): DownloadOptions {
	return {
		headless: config.headless,
		userAgent: config.userAgent,
		timeout: config.timeout,
		downloadButtonTimeout: config.buttonTimeout,
		retries: config.retries,
		retryDelay: config.retryDelay,
		debug: config.debug,
		saveDebugArtifacts: config.debugArtifacts,
		...(config.logFile !== undefined && { logFile: config.logFile }),
	}
}
