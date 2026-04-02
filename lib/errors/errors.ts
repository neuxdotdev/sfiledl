import { AppError } from './base.js'
export class ValidationError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'VALIDATION_ERROR', false, context)
	}
}
export class NetworkError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'NETWORK_ERROR', true, context)
	}
}
export class FileError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'FILE_ERROR', false, context)
	}
}
export class BrowserError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'BROWSER_ERROR', true, context)
	}
}
