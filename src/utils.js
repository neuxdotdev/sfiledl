import { createHash } from 'crypto'
import { createReadStream, createWriteStream, stat, access, constants, rename, unlink } from 'fs'
import { promisify } from 'util'
import { join, dirname, basename, extname } from 'path'
import { Logger } from './logger.js'
const statAsync = promisify(stat)
const accessAsync = promisify(access)
const renameAsync = promisify(rename)
const unlinkAsync = promisify(unlink)
export const sleep = (ms, signal = null) => {
	if (typeof ms !== 'number' || ms < 0 || !Number.isFinite(ms)) {
		throw new TypeError(`sleep: expected positive finite number, got ${typeof ms}`)
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms)
		if (signal) {
			const onAbort = () => {
				clearTimeout(timeout)
				const error = new Error('Sleep aborted')
				error.name = 'AbortError'
				reject(error)
			}
			if (signal.aborted) {
				onAbort()
			} else {
				signal.addEventListener('abort', onAbort, { once: true })
			}
		}
	})
}
export const exponentialBackoff = (attempt, config = {}) => {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new TypeError(`exponentialBackoff: attempt must be integer >= 1, got ${attempt}`)
	}
	const {
		initialDelay = 1000,
		maxDelay = 30000,
		backoffFactor = 2,
		jitter = 0.3,
		fullJitter = true,
	} = config
	if (initialDelay < 0 || maxDelay < initialDelay || backoffFactor < 1) {
		throw new RangeError('Invalid backoff configuration')
	}
	const exponentialDelay = initialDelay * Math.pow(backoffFactor, attempt - 1)
	const cappedDelay = Math.min(exponentialDelay, maxDelay)
	if (fullJitter) {
		return Math.floor(Math.random() * cappedDelay)
	} else {
		const jitterRange = cappedDelay * jitter
		return cappedDelay + (Math.random() * 2 - 1) * jitterRange
	}
}
export const withTimeout = async (promise, timeout, message = 'Operation timed out') => {
	if (typeof timeout !== 'number' || timeout <= 0) {
		throw new TypeError('withTimeout: timeout must be positive number')
	}
	let timeoutId
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			const error = new Error(message)
			error.name = 'TimeoutError'
			reject(error)
		}, timeout)
	})
	try {
		return await Promise.race([promise, timeoutPromise])
	} finally {
		clearTimeout(timeoutId)
	}
}
export const withRetry = async (fn, options = {}) => {
	const {
		maxAttempts = 3,
		initialDelay = 1000,
		maxDelay = 30000,
		backoffFactor = 2,
		onRetry,
		shouldRetry = (err) => true,
	} = options
	if (typeof fn !== 'function') {
		throw new TypeError('withRetry: first argument must be a function')
	}
	let lastError
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err
			if (!shouldRetry(err)) {
				Logger.debug('Not retrying based on shouldRetry predicate', {
					error: err.message,
				})
				throw err
			}
			if (attempt === maxAttempts) {
				Logger.debug('Max retry attempts reached', { attempts: maxAttempts })
				break
			}
			const delay = exponentialBackoff(attempt, {
				initialDelay,
				maxDelay,
				backoffFactor,
			})
			if (onRetry) {
				onRetry(attempt, err, delay)
			}
			Logger.debug(`Retry attempt ${attempt}/${maxAttempts} failed, waiting ${delay}ms`, {
				error: err.message,
			})
			await sleep(delay)
		}
	}
	throw lastError
}
export const createRateLimiter = ({ tokensPerInterval, interval, maxTokens = null }) => {
	if (tokensPerInterval < 1 || interval < 1) {
		throw new RangeError('Rate limiter: tokensPerInterval and interval must be >= 1')
	}
	let tokens = maxTokens ?? tokensPerInterval
	let lastRefill = Date.now()
	const refill = () => {
		const now = Date.now()
		const elapsed = now - lastRefill
		const tokensToAdd = (elapsed / interval) * tokensPerInterval
		tokens = Math.min(maxTokens ?? tokensPerInterval, tokens + tokensToAdd)
		lastRefill = now
	}
	return async () => {
		refill()
		if (tokens >= 1) {
			tokens -= 1
			return
		}
		const waitTime = ((1 - tokens) / tokensPerInterval) * interval
		await sleep(waitTime)
		tokens = 0
	}
}
export const debounce = (fn, wait, options = {}) => {
	let timeout = null
	let lastArgs = null
	let lastThis = null
	return function (...args) {
		lastArgs = args
		lastThis = this
		const callNow = options.immediate && !timeout
		clearTimeout(timeout)
		timeout = setTimeout(() => {
			timeout = null
			if (!options.immediate) {
				fn.apply(lastThis, lastArgs)
			}
		}, wait)
		if (callNow) {
			fn.apply(lastThis, args)
		}
	}
}
export const throttle = (fn, wait, options = {}) => {
	const { leading = true, trailing = true } = options
	let lastCall = 0
	let timeout = null
	let lastArgs = null
	let lastThis = null
	return function (...args) {
		const now = Date.now()
		const remaining = wait - (now - lastCall)
		lastArgs = args
		lastThis = this
		if (remaining <= 0) {
			if (timeout) {
				clearTimeout(timeout)
				timeout = null
			}
			lastCall = now
			fn.apply(this, args)
		} else if (trailing && !timeout) {
			timeout = setTimeout(() => {
				lastCall = leading ? Date.now() : 0
				timeout = null
				fn.apply(lastThis, lastArgs)
			}, remaining)
		}
	}
}
export const calculateFileHash = async (filePath, options = {}) => {
	const { algorithm = 'md5', chunkSize = 1024 * 1024, onProgress } = options
	const supportedAlgorithms = ['md5', 'sha1', 'sha256', 'sha512']
	if (!supportedAlgorithms.includes(algorithm)) {
		throw new Error(
			`Unsupported hash algorithm: ${algorithm}. Supported: ${supportedAlgorithms.join(', ')}`,
		)
	}
	try {
		await accessAsync(filePath, constants.R_OK)
	} catch (err) {
		throw new Error(`Cannot read file for hashing: ${filePath} - ${err.message}`)
	}
	const { size: totalSize } = await statAsync(filePath)
	return new Promise((resolve, reject) => {
		const hash = createHash(algorithm)
		const stream = createReadStream(filePath, { highWaterMark: chunkSize })
		let bytesRead = 0
		stream.on('data', (chunk) => {
			hash.update(chunk)
			bytesRead += chunk.length
			if (onProgress && typeof onProgress === 'function') {
				onProgress(bytesRead, totalSize)
			}
		})
		stream.on('end', () => {
			resolve(hash.digest('hex'))
		})
		stream.on('error', (err) => {
			reject(new Error(`Error reading file for hash: ${err.message}`))
		})
	})
}
export const calculateMD5 = (filePath, options = {}) => {
	Logger.warn("calculateMD5 is deprecated, use calculateFileHash with algorithm: 'md5'")
	return calculateFileHash(filePath, { ...options, algorithm: 'md5' })
}
export const hashString = (data, algorithm = 'md5') => {
	return createHash(algorithm).update(data).digest('hex')
}
export const allSettledFiltered = async (promises, options = {}) => {
	const { onlySuccess = false, onlyErrors = false } = options
	const results = await Promise.allSettled(promises)
	if (onlySuccess) {
		return results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
	}
	if (onlyErrors) {
		return results.filter((r) => r.status === 'rejected').map((r) => r.reason)
	}
	return results
}
export const raceWithTimeouts = async (entries, defaultTimeout = null) => {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new TypeError('raceWithTimeouts: entries must be non-empty array')
	}
	const wrapped = entries.map((entry, index) => {
		const { promise, timeout, label } = entry
		const effectiveTimeout = timeout ?? defaultTimeout
		const timedPromise = effectiveTimeout
			? withTimeout(promise, effectiveTimeout, `Timeout: ${label || `entry[${index}]`}`)
			: promise
		return timedPromise
			.then((value) => ({ value, index, label, status: 'fulfilled' }))
			.catch((reason) => ({ reason, index, label, status: 'rejected' }))
	})
	const first = await Promise.race(wrapped)
	if (first.status === 'rejected') {
		throw first.reason
	}
	return {
		winner: first.value,
		index: first.index,
		label: first.label,
	}
}
export const promisifyCallback = (fn) => {
	return (...args) => {
		return new Promise((resolve, reject) => {
			fn(...args, (err, result) => {
				if (err) reject(err)
				else resolve(result)
			})
		})
	}
}
export async function* asyncMapBatch(iterable, processor, options = {}) {
	const { concurrency = 1, batchSize = null, onProgress } = options
	const iterator =
		Symbol.asyncIterator in iterable
			? iterable[Symbol.asyncIterator]()
			: (async function* () {
					yield* iterable
				})()
	const queue = []
	let index = 0
	let processed = 0
	let total = null
	if (Array.isArray(iterable) || iterable?.length !== undefined) {
		total = iterable.length
	}
	const worker = async function* () {
		while (queue.length > 0) {
			const { item, idx } = queue.shift()
			try {
				const result = await processor(item, idx)
				processed++
				if (onProgress) onProgress(processed, total)
				yield result
			} catch (err) {
				processed++
				if (onProgress) onProgress(processed, total)
				throw err
			}
		}
	}
	while (true) {
		const { done, value } = await iterator.next()
		if (done) break
		queue.push({ item: value, index: index++ })
		if (queue.length >= concurrency || (batchSize && queue.length >= batchSize)) {
			const workers = Array(Math.min(concurrency, queue.length))
				.fill(null)
				.map(() => worker())
			const results = await Promise.all(workers)
			for (const result of results.flat()) {
				if (result !== undefined) yield result
			}
		}
	}
	if (queue.length > 0) {
		const workers = Array(Math.min(concurrency, queue.length))
			.fill(null)
			.map(() => worker())
		const results = await Promise.all(workers)
		for (const result of results.flat()) {
			if (result !== undefined) yield result
		}
	}
}
export const asyncMap = async (items, mapper, concurrency = 1) => {
	const results = new Array(items.length)
	const queue = [...items.entries()]
	const inFlight = new Set()
	return new Promise((resolve, reject) => {
		const processNext = async () => {
			if (queue.length === 0 && inFlight.size === 0) {
				resolve(results)
				return
			}
			while (inFlight.size < concurrency && queue.length > 0) {
				const [index, item] = queue.shift()
				const promise = Promise.resolve()
					.then(() => mapper(item, index))
					.then((result) => {
						results[index] = result
					})
					.catch(reject)
					.finally(() => {
						inFlight.delete(promise)
						processNext()
					})
				inFlight.add(promise)
			}
		}
		processNext()
	})
}
export const fileExists = async (filePath) => {
	try {
		await accessAsync(filePath, constants.F_OK)
		return true
	} catch {
		return false
	}
}
export const getFileSize = async (filePath) => {
	try {
		const stats = await statAsync(filePath)
		return stats.size
	} catch {
		return -1
	}
}
export const atomicWrite = async (filePath, data, options = {}) => {
	const { encoding = 'utf8', mode = 0o666 } = options
	const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
	try {
		const stream = createWriteStream(tempPath, { mode, encoding })
		await new Promise((resolve, reject) => {
			stream.write(data, (err) => {
				if (err) reject(err)
				else {
					stream.end(resolve)
				}
			})
			stream.on('error', reject)
		})
		await renameAsync(tempPath, filePath)
	} catch (err) {
		try {
			await unlinkAsync(tempPath)
		} catch {}
		throw err
	}
}
export const safeRead = async (filePath, options = {}) => {
	const { timeout = 30000, maxSize = 10 * 1024 * 1024, encoding = 'utf8' } = options
	const size = await getFileSize(filePath)
	if (size > maxSize) {
		throw new Error(`File too large: ${size} bytes > ${maxSize} limit`)
	}
	const { readFile } = await import('fs/promises')
	return withTimeout(
		readFile(filePath, encoding ? { encoding } : null),
		timeout,
		`Read timeout: ${filePath}`,
	)
}
export const sanitizeUrl = (url, options = {}) => {
	const { defaultProtocol = 'https:', removeFragment = true, encode = true } = options
	if (!url || typeof url !== 'string') {
		throw new TypeError('sanitizeUrl: url must be non-empty string')
	}
	let sanitized = url.trim()
	if (!/^[a-z]+:\/\//i.test(sanitized)) {
		sanitized = `${defaultProtocol}//${sanitized}`
	}
	try {
		const parsed = new URL(sanitized)
		if (removeFragment) {
			parsed.hash = ''
		}
		if (encode) {
			parsed.pathname = encodeURI(parsed.pathname)
		}
		return parsed.toString()
	} catch (err) {
		throw new Error(`Invalid URL: ${url} - ${err.message}`)
	}
}
export const extractFilename = (url, options = {}) => {
	const { fallback = 'file.bin' } = options
	if (!url) return fallback
	const dispMatch = url.match(/filename[^;=\n]*=["']?([^"'\n;]+)/i)
	if (dispMatch?.[1]) {
		return dispMatch[1].trim()
	}
	try {
		const pathname = new URL(url).pathname
		const name = basename(pathname)
		if (name && name !== '/') {
			return decodeURIComponent(name)
		}
	} catch {}
	return fallback
}
export const sanitizeFilename = (name, options = {}) => {
	const { replacement = '_', maxLength = 255, preserveExtension = true } = options
	if (!name || typeof name !== 'string') {
		return `unnamed${preserveExtension ? '.bin' : ''}`
	}
	let sanitized = name.trim()
	let extension = ''
	if (preserveExtension) {
		const ext = extname(sanitized)
		if (ext) {
			extension = ext
			sanitized = sanitized.slice(0, -extension.length)
		}
	}
	sanitized = sanitized.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement)
	sanitized = sanitized.replace(new RegExp(`${replacement}+`, 'g'), replacement)
	sanitized = sanitized.slice(0, maxLength - extension.length).trim()
	if (!sanitized) {
		sanitized = `file${extension || '.bin'}`
	} else {
		sanitized += extension
	}
	return sanitized
}
export const getMemoryUsage = () => {
	const usage = process.memoryUsage()
	return {
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
		heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
		rss: Math.round(usage.rss / 1024 / 1024),
		external: Math.round(usage.external / 1024 / 1024),
	}
}
export const chunkArray = (array, size) => {
	if (!Array.isArray(array) || size < 1) {
		throw new TypeError('chunkArray: invalid input')
	}
	const chunks = []
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size))
	}
	return chunks
}
export async function* withDelay(items, delayMs) {
	for (const item of items) {
		yield item
		if (delayMs > 0) {
			await sleep(delayMs)
		}
	}
}
export { calculateFileHash as calculateHash }
if (process.env.NODE_ENV === 'development' && process.argv.includes('--test-utils')) {
	;(async () => {
		Logger.info('Running utils self-tests...')
		const start = Date.now()
		await sleep(100)
		console.assert(Date.now() - start >= 90, 'sleep test failed')
		const delay = exponentialBackoff(3, { initialDelay: 100, maxDelay: 5000 })
		console.assert(delay >= 100 && delay <= 5000, 'backoff test failed')
		console.assert(sanitizeFilename('test<file>.txt') === 'test_file.txt')
		Logger.info('Utils self-tests passed')
	})()
}
