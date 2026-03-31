import { readFileSync, existsSync, watch } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(join(__dirname, '..'))
const CONFIG_SCHEMA = {
	browser: {
		_type: 'object',
		_required: true,
		headless: { _type: 'boolean', default: true },
		userAgent: {
			_type: 'string',
			default:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
			_validate: (v) => typeof v === 'string' && v.length > 0,
		},
		viewport: {
			_type: 'object',
			width: { _type: 'number', default: 1280, _min: 100, _max: 7680 },
			height: { _type: 'number', default: 720, _min: 100, _max: 4320 },
		},
		proxy: {
			_type: 'object',
			_nullable: true,
			_validate: (v) => {
				if (v == null) return true
				if (typeof v !== 'object') return false
				return typeof v.server === 'string' && v.server.length > 0
			},
			_onInvalid: () => {
				globalLogger.warn(
					"Invalid proxy config: must be { server: 'url' } or null/undefined",
				)
				return undefined
			},
			server: { _type: 'string' },
			username: { _type: 'string', _nullable: true },
			password: { _type: 'string', _nullable: true },
			bypass: { _type: 'string', _nullable: true },
		},
	},
	timeouts: {
		_type: 'object',
		_required: true,
		pageLoad: { _type: 'number', default: 60000, _min: 1000, _max: 300000 },
		buttonWait: { _type: 'number', default: 30000, _min: 1000, _max: 120000 },
		download: { _type: 'number', default: 120000, _min: 10000, _max: 600000 },
		fallback: { _type: 'number', default: 10000, _min: 1000, _max: 60000 },
	},
	retry: {
		_type: 'object',
		_required: true,
		maxAttempts: { _type: 'number', default: 3, _min: 1, _max: 10 },
		initialDelay: { _type: 'number', default: 1000, _min: 100, _max: 10000 },
		maxDelay: { _type: 'number', default: 10000, _min: 1000, _max: 60000 },
		backoffFactor: { _type: 'number', default: 2, _min: 1, _max: 5 },
	},
	rateLimit: {
		_type: 'object',
		_required: true,
		enabled: { _type: 'boolean', default: true },
		minDelay: { _type: 'number', default: 2000, _min: 0, _max: 30000 },
	},
	download: {
		_type: 'object',
		_required: true,
		chunkSize: {
			_type: 'number',
			default: 1024 * 1024,
			_min: 1024,
			_max: 100 * 1024 * 1024,
		},
		validateChecksum: { _type: 'boolean', default: false },
		resumeEnabled: { _type: 'boolean', default: false },
	},
	logging: {
		_type: 'object',
		_required: true,
		level: {
			_type: 'string',
			default: 'INFO',
			_enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
			_transform: (v) => String(v).toUpperCase(),
		},
		file: {
			_type: 'string',
			_nullable: true,
			_transform: (v) => (v ? resolve(v) : null),
		},
		json: { _type: 'boolean', default: false },
	},
	debug: {
		_type: 'object',
		_required: true,
		enabled: { _type: 'boolean', default: false },
		saveArtifacts: { _type: 'boolean', default: true },
		artifactsDir: {
			_type: 'string',
			_nullable: true,
			_transform: (v) => (v ? resolve(v) : null),
		},
	},
	batch: {
		_type: 'object',
		_required: true,
		concurrency: { _type: 'number', default: 1, _min: 1, _max: 10 },
		stopOnError: { _type: 'boolean', default: true },
	},
	notifications: {
		_type: 'object',
		_required: true,
		webhook: {
			_type: 'string',
			_nullable: true,
			_validate: (v) => !v || /^https?:\/\//.test(v),
		},
		onSuccess: { _type: 'boolean', default: false },
		onError: { _type: 'boolean', default: true },
	},
}
const DEFAULT_CONFIG = buildDefaultsFromSchema(CONFIG_SCHEMA)
function buildDefaultsFromSchema(schema, path = '') {
	const result = {}
	for (const [key, definition] of Object.entries(schema)) {
		if (key.startsWith('_')) continue
		const currentPath = path ? `${path}.${key}` : key
		if (definition._type === 'object' && !definition._validate) {
			result[key] = buildDefaultsFromSchema(definition, currentPath)
		} else {
			result[key] = definition.default ?? null
		}
	}
	return result
}
function loadConfigFile(configPath) {
	if (!existsSync(configPath)) {
		console.debug('Config file not found, using defaults', { path: configPath })
		return {}
	}
	try {
		const content = readFileSync(configPath, 'utf-8')
		const userConfig = JSON.parse(content)
		console.info('Configuration loaded from file', { path: configPath })
		return userConfig
	} catch (error) {
		console.error('Failed to load config file', {
			path: configPath,
			error: error.message,
		})
		throw new Error(`Config file error: ${error.message}`)
	}
}
function loadEnvConfig() {
	const envConfig = {}
	const prefix = 'SFILEDL_'
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(prefix)) continue
		const configPath = key.slice(prefix.length).toLowerCase().split('_').join('.')
		let parsedValue
		if (value.toLowerCase() === 'true') parsedValue = true
		else if (value.toLowerCase() === 'false') parsedValue = false
		else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10)
		else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value)
		else if (value.toLowerCase() === 'null') parsedValue = null
		else if (value.toLowerCase() === 'undefined') parsedValue = undefined
		else parsedValue = value
		setNestedValue(envConfig, configPath, parsedValue)
	}
	return envConfig
}
function setNestedValue(obj, path, value) {
	const keys = path.split('.')
	let current = obj
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i]
		if (!(key in current) || typeof current[key] !== 'object') {
			current[key] = {}
		}
		current = current[key]
	}
	current[keys[keys.length - 1]] = value
}
function deepMerge(target, source) {
	const result = { ...target }
	for (const [key, sourceValue] of Object.entries(source)) {
		const targetValue = result[key]
		if (key.startsWith('_')) continue
		if (sourceValue === null || sourceValue === undefined) {
			result[key] = sourceValue
			continue
		}
		if (Array.isArray(sourceValue)) {
			result[key] = [...sourceValue]
			continue
		}
		if (
			typeof sourceValue === 'object' &&
			typeof targetValue === 'object' &&
			targetValue !== null
		) {
			result[key] = deepMerge(targetValue, sourceValue)
			continue
		}
		result[key] = sourceValue
	}
	return result
}
function validateValue(value, definition, path) {
	if (value == null) {
		return definition._nullable !== false
	}
	if (definition._type && typeof value !== definition._type) {
		console.error(
			`Config validation failed at "${path}": expected ${definition._type}, got ${typeof value}`,
		)
		return false
	}
	if (definition._enum && !definition._enum.includes(value)) {
		console.error(
			`Config validation failed at "${path}": value must be one of [${definition._enum.join(', ')}]`,
		)
		return false
	}
	if (typeof value === 'number') {
		if (definition._min !== undefined && value < definition._min) {
			console.error(
				`Config validation failed at "${path}": value ${value} is below minimum ${definition._min}`,
			)
			return false
		}
		if (definition._max !== undefined && value > definition._max) {
			console.error(
				`Config validation failed at "${path}": value ${value} is above maximum ${definition._max}`,
			)
			return false
		}
	}
	if (definition._validate && typeof definition._validate === 'function') {
		if (!definition._validate(value)) {
			if (definition._onInvalid && typeof definition._onInvalid === 'function') {
				return definition._onInvalid(value)
			}
			console.error(`Config validation failed at "${path}": custom validation failed`)
			return false
		}
	}
	return true
}
function validateConfig(config, schema = CONFIG_SCHEMA, path = '') {
	for (const [key, definition] of Object.entries(schema)) {
		if (key.startsWith('_')) continue
		const currentPath = path ? `${path}.${key}` : key
		const value = config[key]
		if (definition._required && (value === undefined || value === null)) {
			console.error(`Config validation failed: required field "${currentPath}" is missing`)
			return false
		}
		if (value === undefined) continue
		if (definition._type === 'object' && !definition._validate && typeof value === 'object') {
			if (!validateConfig(value, definition, currentPath)) {
				return false
			}
			continue
		}
		if (!validateValue(value, definition, currentPath)) {
			return false
		}
	}
	return true
}
function applyTransformations(config, schema = CONFIG_SCHEMA, path = '') {
	const result = { ...config }
	for (const [key, definition] of Object.entries(schema)) {
		if (key.startsWith('_')) continue
		const currentPath = path ? `${path}.${key}` : key
		const value = result[key]
		if (value === undefined) continue
		if (definition._transform && typeof definition._transform === 'function') {
			result[key] = definition._transform(value)
		}
		if (definition._type === 'object' && !definition._validate && typeof value === 'object') {
			result[key] = applyTransformations(value, definition, currentPath)
		}
	}
	return result
}
function freezeConfig(obj) {
	for (const key of Object.keys(obj)) {
		if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
			freezeConfig(obj[key])
		}
	}
	return Object.freeze(obj)
}
function get(path, defaultValue = undefined) {
	const keys = path.split('.')
	let current = CONFIG
	for (const key of keys) {
		if (current && typeof current === 'object' && key in current) {
			current = current[key]
		} else {
			return defaultValue
		}
	}
	return current
}
function has(path) {
	return get(path) !== undefined
}
function getAll() {
	return { ...CONFIG }
}
function initializeConfig() {
	console.debug('Initializing configuration...')
	const fileConfig = loadConfigFile(join(rootDir, 'sfiledljs.config.json'))
	const envConfig = loadEnvConfig()
	let merged = deepMerge(DEFAULT_CONFIG, fileConfig)
	merged = deepMerge(merged, envConfig)
	merged = applyTransformations(merged)
	if (!validateConfig(merged)) {
		throw new Error('Configuration validation failed. Check logs for details.')
	}
	const frozenConfig = freezeConfig(merged)
	console.info('Configuration initialized', {
		headless: frozenConfig.browser.headless,
		logLevel: frozenConfig.logging.level,
		retryAttempts: frozenConfig.retry.maxAttempts,
	})
	return frozenConfig
}
export const CONFIG = initializeConfig()
export const ConfigHelper = {
	get,
	has,
	getAll,
	async reloadFromFile() {
		console.warn("Config reload requested - note: ENV vars won't be re-read")
		const fileConfig = loadConfigFile(join(rootDir, 'sfiledl.config.json'))
		return deepMerge(CONFIG, fileConfig)
	},
}
if (process.env.NODE_ENV === 'development' && process.env.SFILEDL_WATCH_CONFIG === 'true') {
	const configPath = join(rootDir, 'sfiledl.config.json')
	if (existsSync(configPath)) {
		watch(configPath, (eventType) => {
			if (eventType === 'change') {
				console.info('Config file changed - reload recommended')
			}
		})
		console.debug('Config file watch enabled (development mode)')
	}
}
