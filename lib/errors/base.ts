export abstract class AppError extends Error {
	public readonly timestamp: string
	public readonly context: Record<string, unknown> | undefined
	constructor(
		message: string,
		public readonly code: string,
		public readonly retryable: boolean = false,
		context?: Record<string, unknown>,
	) {
		super(message)
		this.name = this.constructor.name
		this.timestamp = new Date().toISOString()
		this.context = context ? { ...context } : undefined
		Error.captureStackTrace?.(this, this.constructor)
	}
	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			retryable: this.retryable,
			timestamp: this.timestamp,
			context: this.context,
		}
	}
}
