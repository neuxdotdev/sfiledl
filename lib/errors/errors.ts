import { AppError } from './base.js'
export class ValidationError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'VALIDATION_ERROR', false, context)
		Object.freeze(this)
	}
}
export class NetworkError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'NETWORK_ERROR', true, context)
		Object.freeze(this)
	}
}
export class FileError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'FILE_ERROR', false, context)
		Object.freeze(this)
	}
}
export class BrowserError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'BROWSER_ERROR', true, context)
		Object.freeze(this)
	}
}
export function isAppError(err: unknown): err is AppError {
	return err instanceof AppError
}
export function isRetryableError(err: unknown): boolean {
	return isAppError(err) && err.retryable
}
export function isErrorWithCode(err: unknown, code: string): boolean {
	return isAppError(err) && err.code === code
}
