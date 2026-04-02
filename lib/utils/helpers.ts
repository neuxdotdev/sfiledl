export function sanitizeFilename(name: string, replacement = '_'): string {
	const safeName = name.replace(/\.\.[\\/]/g, '')
	const sanitized = safeName
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement)
		.replace(new RegExp(`${replacement}+`, 'g'), replacement)
		.trim()
	const maxLength = 255
	const trimmed = sanitized.slice(0, maxLength)
	return trimmed || `file${replacement}bin`
}
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))
export function safeStringify(value: unknown, indent = 0): string {
	try {
		const seen = new WeakSet()
		return JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === 'object' && val !== null) {
					if (seen.has(val)) return '[Circular]'
					seen.add(val)
				}
				if (typeof val === 'bigint') return val.toString() + 'n'
				if (val instanceof Error) {
					return { name: val.name, message: val.message, stack: val.stack }
				}
				return val
			},
			indent,
		)
	} catch {
		return '[unserializable]'
	}
}
export function extractFilenameFromContentDisposition(header: string | undefined): string | null {
	if (!header) return null
	const encodedMatch = header.match(/filename\*=UTF-8''([^;\n"]+)/i)
	if (encodedMatch?.[1]) {
		try {
			return decodeURIComponent(encodedMatch[1])
		} catch {}
	}
	const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i)
	if (quotedMatch?.[1]) return quotedMatch[1]
	const plainMatch = header.match(/filename\s*=\s*([^;,\n"]+)/i)
	if (plainMatch?.[1]) return plainMatch[1].trim()
	return null
}
export function calculateRetryDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs = 30000,
): number {
	const exponential = baseDelayMs * Math.pow(2, attempt - 1)
	const jitter = Math.random() * 0.3 * exponential
	return Math.min(exponential + jitter, maxDelayMs)
}
export function isError(value: unknown): value is Error {
	return (
		value instanceof Error ||
		(typeof value === 'object' && value !== null && 'message' in value)
	)
}
