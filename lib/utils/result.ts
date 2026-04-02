export type Result<T, E = Error> = { success: true; value: T } | { success: false; error: E }
export function ok<T, E = never>(value: T): Result<T, E> {
	return { success: true, value }
}
export function err<E, T = never>(error: E): Result<T, E> {
	return { success: false, error }
}
export function isSuccess<T, E>(result: Result<T, E>): result is { success: true; value: T } {
	return result.success === true
}
export function isFailure<T, E>(result: Result<T, E>): result is { success: false; error: E } {
	return result.success === false
}
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
	if (result.success) {
		return { success: true, value: fn(result.value) }
	}
	return result
}
export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
	if (!result.success) {
		return { success: false, error: fn(result.error) }
	}
	return result
}
export function getOrThrow<T, E>(result: Result<T, E>): T {
	if (result.success) return result.value
	throw result.error
}
