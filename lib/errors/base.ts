export abstract class AppError extends Error {
	public readonly timestamp: string
	public readonly context: Readonly<Record<string, unknown>>
	public readonly code: string
	public readonly retryable: boolean
	constructor(
		message: string,
		code: string,
		retryable: boolean = false,
		context?: Record<string, unknown>,
	) {
		super(message)
		this.name = this.constructor.name
		this.code = code
		this.retryable = retryable
		this.timestamp = new Date().toISOString()
		this.context = context ? Object.freeze({ ...context }) : Object.freeze({})
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor)
		}
		Object.freeze(this)
	}
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			timestamp: this.timestamp,
			context: this.context,
			stack: process.env['NODE_ENV'] === 'development' ? this.stack : undefined,
		}
	}
	toString(): string {
		return `${this.name} [${this.code}]: ${this.message}`
	}
	isCode(code: string): boolean {
		return this.code === code
	}
	isRetryable(): boolean {
		return this.retryable
	}
}
