import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import { join, parse, basename, extname, resolve, normalize } from 'path'
import { fileURLToPath } from 'url'
import { Logger } from './logger.js'
export class ValidationError extends Error {
	constructor(message, code, details = {}) {
		super(message)
		this.name = 'ValidationError'
		this.code = code
		this.details = details
		this.timestamp = new Date().toISOString()
	}
	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			details: this.details,
			timestamp: this.timestamp,
			stack: this.stack,
		}
	}
}
export class SecurityError extends ValidationError {
	constructor(message, code, details = {}) {
		super(message, code, details)
		this.name = 'SecurityError'
		this.severity = 'HIGH'
	}
}
const valid = (value, extra = {}) => ({
	valid: true,
	error: null,
	code: null,
	value,
	...extra,
})
const invalid = (message, code, details = {}) => ({
	valid: false,
	error: message,
	code,
	value: null,
	details,
})
const ALLOWED_PROTOCOLS = Object.freeze(['https:', 'http:'])
const SFILE_DOMAINS = Object.freeze(['sfile.co', 'sfile.mobi', 'www.sfile.co', 'www.sfile.mobi'])
const MALICIOUS_PATTERNS = [/javascript:/i, /data:/i, /vbscript:/i, /file:/i, /ftp:/i, /\/\/.*@/i]
export const validateSfileUrl = (url, options = {}) => {
	const { requireHttps = true, allowSubdomains = true, allowedPaths = null } = options
	if (typeof url !== 'string' || !url.trim()) {
		return invalid('URL must be a non-empty string', 'INVALID_TYPE', {
			received: typeof url,
		})
	}
	const trimmed = url.trim()
	for (const pattern of MALICIOUS_PATTERNS) {
		if (pattern.test(trimmed)) {
			return invalid('URL contains potentially malicious content', 'SECURITY_BLOCKED', {
				pattern: pattern.toString(),
				severity: 'HIGH',
			})
		}
	}
	let parsed
	try {
		parsed = new URL(trimmed)
	} catch (err) {
		return invalid(`Invalid URL format: ${err.message}`, 'PARSE_ERROR', {
			original: trimmed.slice(0, 100),
		})
	}
	if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
		return invalid(
			`Protocol "${parsed.protocol}" not allowed. Use: ${ALLOWED_PROTOCOLS.join(', ')}`,
			'INVALID_PROTOCOL',
			{ allowed: ALLOWED_PROTOCOLS },
		)
	}
	if (requireHttps && parsed.protocol !== 'https:') {
		return invalid('HTTPS required for security', 'HTTP_NOT_ALLOWED', {
			suggestion: trimmed.replace('http:', 'https:'),
		})
	}
	const hostname = parsed.hostname.toLowerCase()
	const isKnownDomain = SFILE_DOMAINS.includes(hostname)
	const isSubdomain =
		allowSubdomains && (hostname.endsWith('.sfile.co') || hostname.endsWith('.sfile.mobi'))
	if (!isKnownDomain && !isSubdomain) {
		return invalid(
			`Hostname "${hostname}" is not a recognized sfile domain`,
			'INVALID_DOMAIN',
			{
				received: hostname,
				allowed: SFILE_DOMAINS,
				allowSubdomains,
			},
		)
	}
	if (allowedPaths?.length > 0) {
		const pathMatch = allowedPaths.some((pattern) => {
			if (pattern instanceof RegExp) return pattern.test(parsed.pathname)
			return parsed.pathname.startsWith(pattern)
		})
		if (!pathMatch) {
			return invalid('URL path not in allowed list', 'PATH_NOT_ALLOWED', {
				received: parsed.pathname,
				allowed: allowedPaths,
			})
		}
	}
	const fileId = extractSfileId(parsed.pathname)
	if (!fileId) {
		return invalid('Could not extract valid file ID from URL path', 'INVALID_FILE_ID', {
			pathname: parsed.pathname,
			expectedFormat: '/<file-id> or /download/<file-id>',
		})
	}
	return valid(trimmed, {
		parsed,
		fileId,
		domain: hostname,
		protocol: parsed.protocol,
		isSecure: parsed.protocol === 'https:',
	})
}
const extractSfileId = (pathname) => {
	const patterns = [/^\/(?:download|file)?\/?([A-Za-z0-9_-]{8,})$/, /^\/([A-Za-z0-9_-]{8,})$/]
	for (const pattern of patterns) {
		const match = pathname.match(pattern)
		if (match?.[1]) {
			return match[1]
		}
	}
	return null
}
export const isSfileUrl = (url) => {
	return validateSfileUrl(url).valid
}
const RESERVED_NAMES = Object.freeze([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
])
const DANGEROUS_EXTENSIONS = Object.freeze([
	'.exe',
	'.bat',
	'.cmd',
	'.scr',
	'.vbs',
	'.js',
	'.jse',
	'.wsf',
	'.wsh',
	'.msi',
	'.msp',
	'.com',
	'.pif',
	'.application',
	'.gadget',
	'.reg',
	'.scf',
	'.lnk',
	'.inf',
	'.ins',
	'.iso',
	'.img',
])
const SAFE_EXTENSIONS = Object.freeze([
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.txt',
	'.rtf',
	'.odt',
	'.mp3',
	'.mp4',
	'.avi',
	'.mkv',
	'.mov',
	'.wmv',
	'.flv',
	'.webm',
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.webp',
	'.svg',
	'.zip',
	'.rar',
	'.7z',
	'.tar',
	'.gz',
	'.bz2',
	'.xz',
	'.json',
	'.xml',
	'.csv',
	'.sql',
	'.log',
	'.md',
	'.html',
	'.css',
	'.js',
	'.apk',
	'.ipa',
	'.dmg',
	'.pkg',
	'.deb',
	'.rpm',
])
export const validateFilename = (name, options = {}) => {
	const {
		allowDangerousExtensions = false,
		allowedExtensions = null,
		checkReserved = true,
		maxLength = 255,
		replacement = '_',
		preserveExtension = true,
		unique = false,
	} = options
	if (typeof name !== 'string' || !name.trim()) {
		return invalid('Filename must be a non-empty string', 'INVALID_TYPE', {
			received: typeof name,
		})
	}
	let filename = name.trim()
	const original = filename
	const { name: baseName, ext } = parse(filename)
	const extension = ext.toLowerCase()
	if (checkReserved && RESERVED_NAMES.includes(baseName.toUpperCase())) {
		return invalid(
			`Filename "${baseName}" is reserved by the operating system`,
			'RESERVED_NAME',
			{
				reserved: RESERVED_NAMES,
				suggestion: `${baseName}_file${extension}`,
			},
		)
	}
	if (extension) {
		if (!allowDangerousExtensions && DANGEROUS_EXTENSIONS.includes(extension)) {
			return invalid(
				`Extension "${extension}" is blocked for security reasons`,
				'DANGEROUS_EXTENSION',
				{
					blocked: DANGEROUS_EXTENSIONS,
					suggestion: 'Use a safe archive format like .zip instead',
					severity: 'HIGH',
				},
			)
		}
		if (allowedExtensions?.length > 0 && !allowedExtensions.includes(extension)) {
			return invalid(
				`Extension "${extension}" not in allowed list`,
				'EXTENSION_NOT_ALLOWED',
				{
					received: extension,
					allowed: allowedExtensions,
				},
			)
		}
		if (!allowedExtensions && !SAFE_EXTENSIONS.includes(extension)) {
			Logger.debug(`Extension "${extension}" not in safe list (allowing with warning)`, {
				safeList: SAFE_EXTENSIONS,
			})
		}
	}
	let sanitized = baseName
	sanitized = sanitized.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement)
	sanitized = sanitized.replace(new RegExp(`${replacement}+`, 'g'), replacement).trim()
	if (!sanitized) {
		sanitized = 'unnamed'
	}
	if (preserveExtension && extension) {
		sanitized += extension
	}
	if (sanitized.length > maxLength) {
		const namePart = sanitized.slice(0, maxLength - extension.length)
		sanitized = namePart.trim() + extension
	}
	if (unique) {
		const { name: finalName, ext: finalExt } = parse(sanitized)
		sanitized = `${finalName}_${Date.now()}${finalExt}`
	}
	if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
		return invalid(
			'Sanitized filename still contains path traversal characters',
			'SECURITY_SANITIZATION_FAILED',
			{ original, sanitized },
		)
	}
	const wasModified = sanitized !== original
	return valid(sanitized, {
		original,
		sanitized: wasModified,
		extension,
		baseName: parse(sanitized).name,
		length: sanitized.length,
		...(wasModified && {
			changes: 'Removed invalid characters, trimmed, length-limited',
		}),
	})
}
export const sanitizeFilename = (name) => {
	const result = validateFilename(name)
	if (!result.valid) {
		Logger.warn(`sanitizeFilename fallback: ${result.error}`, {
			code: result.code,
		})
		return (
			name
				.replace(/[<>:"/\\|?*]/g, '_')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 255) || 'file.bin'
		)
	}
	return result.value
}
export const validateDirectory = async (dirPath, options = {}) => {
	const { requireExists = false, requireWritable = true, baseDir = null } = options
	if (typeof dirPath !== 'string' || !dirPath.trim()) {
		return invalid('Directory path must be a non-empty string', 'INVALID_TYPE')
	}
	let path = resolve(dirPath.trim())
	if (baseDir) {
		const resolvedBase = resolve(baseDir)
		if (!path.startsWith(resolvedBase)) {
			return invalid(`Path escapes base directory restriction`, 'PATH_TRAVERSAL_BLOCKED', {
				attempted: path,
				allowedBase: resolvedBase,
				severity: 'HIGH',
			})
		}
	}
	if (/[\x00]/.test(path)) {
		return invalid('Path contains null bytes', 'SECURITY_NULL_BYTE', {
			severity: 'CRITICAL',
		})
	}
	if (requireExists) {
		try {
			await access(path, constants.F_OK)
		} catch {
			return invalid('Directory does not exist', 'DIR_NOT_FOUND', {
				path,
				suggestion: 'Create the directory first or use a different path',
			})
		}
	}
	if (requireWritable) {
		try {
			await access(path, constants.W_OK)
		} catch {
			return invalid('Directory is not writable', 'DIR_NOT_WRITABLE', {
				path,
				suggestion: 'Check permissions or choose a different location',
			})
		}
	}
	return valid(path, {
		absolute: path,
		exists: requireExists,
		writable: requireWritable,
	})
}
export const validateFilePath = async (filePath, options = {}) => {
	if (typeof filePath !== 'string' || !filePath.trim()) {
		return invalid('File path must be a non-empty string', 'INVALID_TYPE')
	}
	const { dir, base } = parse(resolve(filePath))
	const dirResult = await validateDirectory(dir, options)
	if (!dirResult.valid) {
		return dirResult
	}
	const fileResult = validateFilename(base, options)
	if (!fileResult.valid) {
		return fileResult
	}
	const fullPath = join(dirResult.value, fileResult.value)
	return valid(fullPath, {
		directory: dirResult.value,
		filename: fileResult.value,
		...fileResult,
	})
}
export const validateAll = (value, validators, options = {}) => {
	const { stopOnFirstError = true } = options
	const results = []
	for (const validator of validators) {
		if (typeof validator !== 'function') {
			continue
		}
		const result = validator(value)
		results.push(result)
		if (!result.valid && stopOnFirstError) {
			return result
		}
	}
	const allValid = results.every((r) => r.valid)
	if (allValid) {
		return valid(value, { validations: results.length })
	}
	return invalid('Multiple validation errors', 'MULTIPLE_ERRORS', {
		errors: results.filter((r) => !r.valid).map((r) => ({ code: r.code, error: r.error })),
	})
}
export const createValidator = (validatorFn, defaultOptions = {}) => {
	return (value, overrideOptions = {}) => {
		const options = { ...defaultOptions, ...overrideOptions }
		return validatorFn(value, options)
	}
}
export const strictSfileUrl = createValidator(validateSfileUrl, {
	requireHttps: true,
	allowSubdomains: false,
})
export const safeFilename = createValidator(validateFilename, {
	allowDangerousExtensions: false,
	checkReserved: true,
	maxLength: 200,
})
export const detectsPathTraversal = (input) => {
	if (typeof input !== 'string') return false
	const normalized = normalize(input).toLowerCase()
	return normalized.includes('..') || normalized.includes('//') || /[\x00\x01\x02]/.test(input)
}
export const sanitizeInput = (input, options = {}) => {
	const { allowHtml = false, trim = true, maxLength = 1000 } = options
	if (typeof input !== 'string') {
		return ''
	}
	let sanitized = input
	if (trim) {
		sanitized = sanitized.trim()
	}
	sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
	if (!allowHtml) {
		sanitized = sanitized.replace(/<[^>]*>/g, '')
	}
	sanitized = sanitized.replace(/on\w+\s*=/gi, '')
	if (sanitized.length > maxLength) {
		sanitized = sanitized.slice(0, maxLength)
	}
	return sanitized
}
export const validateNoSSRF = (url) => {
	try {
		const parsed = new URL(url)
		const hostname = parsed.hostname.toLowerCase()
		const internalPatterns = [
			/^localhost$/i,
			/^127\.\d+\.\d+\.\d+$/,
			/^10\.\d+\.\d+\.\d+$/,
			/^192\.168\.\d+\.\d+$/,
			/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/,
			/^::1$/,
			/^fe80:/,
			/^fc00:/,
		]
		for (const pattern of internalPatterns) {
			if (pattern.test(hostname)) {
				return invalid(
					'URL points to internal/private network (SSRF prevention)',
					'SSRF_BLOCKED',
					{ hostname, severity: 'CRITICAL' },
				)
			}
		}
		return valid(url, { hostname, isExternal: true })
	} catch (err) {
		return invalid(`Failed to parse URL for SSRF check: ${err.message}`, 'PARSE_ERROR')
	}
}
if (process.env.NODE_ENV === 'development' && process.argv.includes('--test-validators')) {
	;(async () => {
		Logger.info('Running validator self-tests...')
		const tests = [
			{
				name: 'Valid sfile URL',
				fn: () => validateSfileUrl('https://sfile.co/abc123'),
				expect: true,
			},
			{
				name: 'Invalid protocol',
				fn: () => validateSfileUrl('javascript:alert(1)'),
				expect: false,
			},
			{
				name: 'Non-sfile domain',
				fn: () => validateSfileUrl('https://evil.com/file'),
				expect: false,
			},
			{
				name: 'Normal filename',
				fn: () => validateFilename('document.pdf'),
				expect: true,
			},
			{
				name: 'Dangerous extension',
				fn: () => validateFilename('malware.exe'),
				expect: false,
			},
			{
				name: 'Reserved name',
				fn: () => validateFilename('CON.txt'),
				expect: false,
			},
			{
				name: 'Path traversal',
				fn: () => validateFilename('../../etc/passwd'),
				expect: false,
			},
			{
				name: 'Path traversal detection',
				fn: () => detectsPathTraversal('../etc'),
				expect: true,
			},
			{
				name: 'Input sanitization',
				fn: () => sanitizeInput('<script>alert(1)</script>'),
				expect: '',
			},
		]
		let passed = 0
		for (const test of tests) {
			try {
				const result = test.fn()
				const success = result.valid === test.expect
				if (success) {
					Logger.debug(`${test.name}`)
					passed++
				} else {
					Logger.error(`${test.name}: expected ${test.expect}, got ${result.valid}`, {
						result,
					})
				}
			} catch (err) {
				Logger.error(`${test.name}: threw error`, { error: err.message })
			}
		}
		Logger.info(`Tests: ${passed}/${tests.length} passed`)
		process.exit(passed === tests.length ? 0 : 1)
	})()
}
export { valid, invalid };
