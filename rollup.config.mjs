import { readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import resolvePlugin from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import json from '@rollup/plugin-json'
import replace from '@rollup/plugin-replace'
import { visualizer } from 'rollup-plugin-visualizer'
import copy from 'rollup-plugin-copy'
import filesize from 'rollup-plugin-filesize'
import license from 'rollup-plugin-license'
import { nodeExternals } from 'rollup-plugin-node-externals'
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = __dirname
const isProduction = process.env.NODE_ENV === 'production'
const isDevelopment = !isProduction
const target = process.env.TARGET
const analyze = process.env.ANALYZE === 'true'
const profile = process.env.PROFILE || 'default'
let packageJson
try {
	const packagePath = resolve(projectRoot, 'package.json')
	if (!existsSync(packagePath)) throw new Error(`package.json not found at: ${packagePath}`)
	packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
} catch (err) {
	console.error('Failed to read package.json:', err instanceof Error ? err.message : String(err))
	process.exit(1)
}
const profileConfig = {
	default: {
		compress: true,
		mangle: true,
		dropConsole: false,
		dropDebugger: false,
		sourcemap: true,
		treeshake: 'recommended',
		passes: 2,
	},
	performance: {
		compress: true,
		mangle: true,
		dropConsole: true,
		dropDebugger: true,
		sourcemap: false,
		treeshake: 'smallest',
		passes: 3,
	},
	small: {
		compress: true,
		mangle: { toplevel: true },
		dropConsole: true,
		dropDebugger: true,
		sourcemap: false,
		treeshake: 'smallest',
		passes: 4,
	},
	debug: {
		compress: false,
		mangle: false,
		dropConsole: false,
		dropDebugger: false,
		sourcemap: true,
		treeshake: false,
		passes: 1,
	},
}
const activeProfile = profileConfig[profile] || profileConfig.default
const createExternal = (isDts = false) => {
	const externals = [
		...Object.keys(packageJson.dependencies || {}),
		...Object.keys(packageJson.peerDependencies || {}),
		...Object.keys(packageJson.optionalDependencies || {}),
		/^node:.*/,
		/^(?!\.{0,2}\/).*$/,
	]
	if (isDts) externals.push(/^@types\/.*/)
	return externals
}
const CLI_NODE_BUILTINS = [
	'fs',
	'path',
	'crypto',
	'os',
	'url',
	'stream',
	'util',
	'events',
	'buffer',
	'http',
	'https',
	'net',
	'tls',
	'child_process',
	'worker_threads',
	'assert',
	'string_decoder',
]
const createCliExternal = () => ['playwright', 'playwright-core', /^node:.*/, ...CLI_NODE_BUILTINS]
const getBasePlugins = (outputDir, rootDir) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	const plugins = [
		json({ compact: true, preferConst: true }),
		nodeExternals({
			deps: true,
			devDeps: false,
			peerDeps: true,
			optDeps: true,
		}),
		resolvePlugin({
			preferBuiltins: true,
			extensions: ['.js', '.ts', '.json', '.mjs', '.cjs'],
			browser: false,
			moduleDirectories: ['node_modules'],
		}),
		commonjs({
			include: /node_modules/,
			requireReturnsDefault: 'auto',
			transformMixedEsModules: true,
			ignoreDynamicRequires: false,
			extensions: ['.js', '.ts'],
		}),
		typescript({
			tsconfig: resolve(projectRoot, 'tsconfig.json'),
			declaration: false,
			declarationMap: false,
			sourceMap: activeProfile.sourcemap,
			inlineSources: true,
			outDir: absoluteOutputDir,
			rootDir: resolve(projectRoot, rootDir),
			noEmitOnError: isProduction,
			skipLibCheck: true,
		}),
		replace({
			preventAssignment: true,
			values: {
				'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
				'process.env.PROFILE': JSON.stringify(profile),
				'__VERSION__': JSON.stringify(packageJson.version),
				'__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
				'__TARGET__': JSON.stringify(target || 'lib'),
			},
			include: ['lib/**/*', 'cli/**/*'],
			delimiters: ['', ''],
		}),
	]
	if (existsSync(resolve(projectRoot, 'assets'))) {
		plugins.push(
			copy({
				targets: [{ src: 'assets/*', dest: resolve(absoluteOutputDir, 'assets') }],
				verbose: false,
			}),
		)
	}
	return plugins
}
const getMinificationPlugins = (mapFilename = 'lib.[format].js.map') => {
	const terserOptions = {
		ecma: 2022,
		module: true,
		compress: {
			drop_console: activeProfile.dropConsole,
			drop_debugger: activeProfile.dropDebugger,
			pure_funcs: activeProfile.dropConsole
				? ['console.log', 'console.info', 'console.debug', 'console.trace']
				: [],
			dead_code: true,
			unused: true,
			passes: activeProfile.passes || 2,
			pure_getters: true,
			keep_fargs: false,
			keep_classnames: /Error$/,
			keep_fnames: /Error$/,
		},
		format: {
			comments: false,
			ascii_only: false,
			wrap_iife: false,
		},
		sourceMap: activeProfile.sourcemap ? { filename: mapFilename, url: 'inline' } : false,
		mangle: activeProfile.mangle,
	}
	return [terser(terserOptions)]
}
const createWarningHandler = (isDts = false) => {
	const ignoredCodes = new Set([
		'CIRCULAR_DEPENDENCY',
		'THIS_IS_UNDEFINED',
		'SOURCEMAP_ERROR',
		'EVAL',
		'MIXED_EXPORTS',
		'NON_EXISTENT_EXPORT',
		'EMPTY_BUNDLE',
		'MISSING_GLOBAL_NAME',
		'UNRESOLVED_IMPORT',
	])
	const knownQuirkyTypes = ['ms', 'node', 'jsonwebtoken']
	return (warning, warn) => {
		if (!warning.code || ignoredCodes.has(warning.code)) return
		if (
			isDts &&
			warning.code === 'MISSING_EXPORT' &&
			warning.id &&
			knownQuirkyTypes.some(
				(pkg) =>
					warning.id.includes(`/node_modules/${pkg}`) ||
					warning.id.includes(`@types/${pkg}`),
			)
		)
			return
		if (isDts && warning.code === 'TYPE_CONFLICT' && warning.id?.includes('@types/')) return
		if (
			warning.code === 'UNUSED_EXTERNAL_IMPORT' &&
			warning.names &&
			packageJson.peerDependencies &&
			Object.keys(packageJson.peerDependencies).some((dep) => warning.names.includes(dep))
		)
			return
		warn(warning)
	}
}
const postBuildHook = (outputFile, isCli = false) => ({
	name: 'post-build-hook',
	async writeBundle() {
		if (isCli && outputFile) {
			try {
				chmodSync(outputFile, 0o755)
				console.log(`✅ Made executable: ${outputFile}`)
			} catch (e) {}
		}
		if (!isCli && process.env.GENERATE_PKG === 'true') {
			const pkgCopy = { ...packageJson }
			delete pkgCopy.devDependencies
			delete pkgCopy.scripts
			pkgCopy.main = './lib.cjs'
			pkgCopy.module = './lib.mjs'
			pkgCopy.types = './lib.d.ts'
			writeFileSync(
				resolve(projectRoot, 'build/package.json'),
				JSON.stringify(pkgCopy, null, 2),
			)
			console.log('📦 Generated build/package.json')
		}
	},
})
const createLibConfig = ({ input, outputDir, minify = false, formats = ['esm', 'cjs'] }) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	const absoluteInput = resolve(projectRoot, input)
	if (!existsSync(absoluteInput)) {
		console.error(`Entry file not found: ${absoluteInput}`)
		process.exit(1)
	}
	const outputMap = {
		esm: {
			file: resolve(absoluteOutputDir, 'lib.mjs'),
			format: 'esm',
			sourcemap: activeProfile.sourcemap,
			exports: 'named',
			indent: false,
			strict: true,
			freeze: false,
			esModule: true,
			interop: 'auto',
			generatedCode: { constBindings: true, objectShorthand: true, arrowFunctions: true },
		},
		cjs: {
			file: resolve(absoluteOutputDir, 'lib.cjs'),
			format: 'cjs',
			sourcemap: activeProfile.sourcemap,
			exports: 'named',
			indent: false,
			strict: true,
			freeze: false,
			esModule: true,
			interop: 'auto',
			generatedCode: { constBindings: true, objectShorthand: true },
		},
		umd: {
			file: resolve(absoluteOutputDir, 'lib.umd.js'),
			format: 'umd',
			name: 'SfileDl',
			sourcemap: activeProfile.sourcemap,
			exports: 'named',
			globals: { playwright: 'playwright', chalk: 'chalk' },
		},
		iife: {
			file: resolve(absoluteOutputDir, 'lib.browser.js'),
			format: 'iife',
			name: 'SfileDl',
			sourcemap: activeProfile.sourcemap,
			exports: 'named',
		},
	}
	const outputs = formats.map((f) => outputMap[f]).filter(Boolean)
	if (outputs.length === 0) outputs.push(outputMap.esm)
	const plugins = [
		...getBasePlugins(outputDir, 'lib'),
		...(minify && activeProfile.compress ? getMinificationPlugins() : []),
		filesize({ showBeforeSizes: 'gzip' }),
		postBuildHook(resolve(absoluteOutputDir, 'lib.mjs'), false),
	]
	if (analyze) {
		plugins.push(
			visualizer({
				filename: resolve(absoluteOutputDir, 'stats-lib.html'),
				open: true,
				gzipSize: true,
				brotliSize: true,
				template: 'treemap',
			}),
		)
	}
	if (isProduction) {
		plugins.push(
			license({
				thirdParty: {
					output: resolve(absoluteOutputDir, 'licenses.txt'),
					includePrivate: true,
				},
			}),
		)
	}
	return {
		input: absoluteInput,
		external: createExternal(false),
		plugins,
		output: outputs,
		treeshake:
			activeProfile.treeshake !== false
				? { preset: activeProfile.treeshake, moduleSideEffects: false }
				: false,
		onwarn: createWarningHandler(false),
		context: 'globalThis',
		preserveEntrySignatures: 'strict',
		makeAbsoluteExternalsRelative: false,
		shimMissingExports: false,
		cache: isDevelopment,
		perf: isProduction,
	}
}
const createDtsConfig = ({ input, outputDir }) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	return {
		input: resolve(projectRoot, input),
		external: createExternal(true),
		plugins: [dts({ respectExternal: true })],
		output: {
			file: resolve(absoluteOutputDir, 'lib.d.ts'),
			format: 'es',
			sourcemap: false,
		},
		treeshake: false,
		onwarn: createWarningHandler(true),
		preserveEntrySignatures: 'strict',
		makeAbsoluteExternalsRelative: false,
	}
}
const createCliConfig = ({ input, outputDir, minify = false }) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	const absoluteInput = resolve(projectRoot, input)
	if (!existsSync(absoluteInput)) {
		console.error(`CLI entry file not found: ${absoluteInput}`)
		process.exit(1)
	}
	const plugins = [
		...getBasePlugins(outputDir, '.'),
		...(minify && process.env.FORCE_MINIFY_CLI === 'true' && activeProfile.compress
			? getMinificationPlugins('cli.mjs.map')
			: []),
		postBuildHook(resolve(absoluteOutputDir, 'cli.mjs'), true),
	]
	if (analyze) {
		plugins.push(
			visualizer({
				filename: resolve(absoluteOutputDir, 'stats-cli.html'),
				open: true,
				gzipSize: true,
				brotliSize: true,
				template: 'treemap',
			}),
		)
	}
	return {
		input: absoluteInput,
		external: createCliExternal(),
		plugins,
		output: {
			file: resolve(absoluteOutputDir, 'cli.mjs'),
			format: 'esm',
			sourcemap: activeProfile.sourcemap,
			banner: '#!/usr/bin/env node',
			exports: 'none',
			indent: false,
			strict: true,
			freeze: false,
			esModule: true,
			interop: 'auto',
			generatedCode: { constBindings: true, objectShorthand: true, arrowFunctions: true },
		},
		treeshake: activeProfile.treeshake !== false ? { preset: activeProfile.treeshake } : false,
		onwarn: createWarningHandler(false),
		context: 'globalThis',
		preserveEntrySignatures: 'strict',
		makeAbsoluteExternalsRelative: false,
		shimMissingExports: false,
		cache: isDevelopment,
		perf: isProduction,
	}
}
const libConfigs = [
	createLibConfig({
		input: 'lib/lib.ts',
		outputDir: 'build',
		minify: isProduction,
		formats: ['esm', 'cjs'],
	}),
	createDtsConfig({ input: 'lib/lib.ts', outputDir: 'build' }),
]
if (process.env.BROWSER === 'true') {
	libConfigs.push(
		createLibConfig({
			input: 'lib/lib.ts',
			outputDir: 'build',
			minify: isProduction,
			formats: ['umd', 'iife'],
		}),
	)
}
const cliConfigs = [
	createCliConfig({ input: 'cli/main.ts', outputDir: 'build', minify: isProduction }),
]
let config
if (target === 'all') {
	config = [...libConfigs, ...cliConfigs]
} else if (target === 'cli') {
	config = cliConfigs
} else {
	config = libConfigs
}
export default config
