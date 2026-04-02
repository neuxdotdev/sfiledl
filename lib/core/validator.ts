import { ValidationError } from '../errors/index.js'
import { sanitizeFilename } from '../utils/helpers.js'
import { DEFAULTS } from '../config/defaults.js'
export class InputValidator {
	static validateUrl(
		url: unknown,
		allowedDomains: readonly string[] = ['sfile.co', 'sfile.mobi'],
	): asserts url is string {
		if (!url || typeof url !== 'string') {
			throw new ValidationError('URL must be a non-empty string', {
				received: typeof url,
				url,
			})
		}
		const hasAllowedDomain = allowedDomains.some((domain) => url.includes(domain))
		if (!hasAllowedDomain) {
			throw new ValidationError(`URL must contain one of: ${allowedDomains.join(', ')}`, {
				url,
				allowedDomains,
			})
		}
		try {
			const parsed = new URL(url)
			if (!['http:', 'https:'].includes(parsed.protocol)) {
				throw new ValidationError('URL must use http or https protocol', {
					url,
					protocol: parsed.protocol,
				})
			}
		} catch (parseErr) {
			throw new ValidationError('Invalid URL format', {
				url,
				parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
			})
		}
	}
	static validateSaveDir(dir: unknown): asserts dir is string {
		if (!dir || typeof dir !== 'string') {
			throw new ValidationError('Save directory must be a non-empty string', {
				received: typeof dir,
				dir,
			})
		}
	}
	static sanitizeFilename(name: string): string {
		const replacement = DEFAULTS.sanitizeReplacement
		const maxLength = DEFAULTS.maxFilenameLength
		const sanitized = sanitizeFilename(name, replacement)
		if (!sanitized || sanitized.length === 0) {
			const ext = name.includes('.') ? name.split('.').pop() : 'bin'
			return `downloaded_file${ext ? '.' + ext : ''}`.slice(0, maxLength)
		}
		return sanitized.slice(0, maxLength)
	}
	static validateOptions(options: unknown): void {
		if (options && typeof options !== 'object') {
			throw new ValidationError('Options must be an object or undefined', {
				received: typeof options,
			})
		}
		const opts = options as Record<string, unknown>
		const numericFields = ['timeout', 'retries', 'retryDelay', 'downloadButtonTimeout'] as const
		for (const field of numericFields) {
			if (field in opts && typeof opts[field] !== 'number') {
				throw new ValidationError(`Option '${field}' must be a number`, {
					field,
					received: typeof opts[field],
					value: opts[field],
				})
			}
		}
		const booleanFields = ['headless', 'debug', 'saveDebugArtifacts'] as const
		for (const field of booleanFields) {
			if (field in opts && typeof opts[field] !== 'boolean') {
				throw new ValidationError(`Option '${field}' must be a boolean`, {
					field,
					received: typeof opts[field],
					value: opts[field],
				})
			}
		}
	}
}
