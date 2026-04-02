export function sanitizeFilename(name: string, replacement = '_'): string {
	const sanitized = name
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement)
		.replace(new RegExp(`${replacement}+`, 'g'), replacement)
		.trim()
		.slice(0, 255)
	return sanitized || 'file.bin'
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return '[unserializable]'
	}
}
