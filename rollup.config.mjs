import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import resolvePlugin from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import json from '@rollup/plugin-json'
import replace from '@rollup/plugin-replace'
import { visualizer } from 'rollup-plugin-visualizer'
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = __dirname
const isProduction = process.env.NODE_ENV === 'production'
let packageJson
try {
	const packagePath = resolve(projectRoot, 'package.json')
	if (!existsSync(packagePath)) {
		throw new Error(`package.json tidak ditemukan di: ${packagePath}`)
	}
	packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
} catch (err) {
	console.error('❌ Failed to read package.json:', err.message)
	process.exit(1)
}
const createExternal = (isDts = false) => {
	const externals = [
		...Object.keys(packageJson.dependencies || {}),
		...Object.keys(packageJson.peerDependencies || {}),
		...Object.keys(packageJson.optionalDependencies || {}),
		/^node:.*/,
		/^(?!\.\/|\.\.\/|\/)/,
	]
	if (isDts) {
		externals.push(/^@types\/.*/)
	}
	return externals
}
const getBasePlugins = (outputDir) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	return [
		peerDepsExternal({
			includeDependencies: true,
		}),
		json({
			compact: true,
			preferConst: true,
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
			sourceMap: true,
			inlineSources: true,
			outDir: absoluteOutputDir,
			rootDir: resolve(projectRoot, 'src'),
			noEmitOnError: isProduction,
			skipLibCheck: true,
		}),
		replace({
			preventAssignment: true,
			values: {
				'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
				'__VERSION__': JSON.stringify(packageJson.version),
			},
			include: ['src/**/*'],
			delimiters: ['', ''],
		}),
	]
}
const getMinificationPlugins = () => [
	terser({
		ecma: 2022,
		module: true,
		compress: {
			drop_console: true,
			drop_debugger: true,
			pure_funcs: ['console.log', 'console.info', 'console.debug', 'console.trace'],
			dead_code: true,
			unused: true,
			passes: 2,
			pure_getters: true,
			keep_fargs: false,
			ecma: 2022,
			module: true,
			keep_classnames: /Error$/,
			keep_fnames: /Error$/,
		},
		format: {
			comments: false,
			ascii_only: false,
			ecma: 2022,
			wrap_iife: false,
		},
		sourceMap: {
			filename: 'index.[format].js.map',
			url: 'inline',
		},
		mangle: {
			toplevel: true,
			keep_fnames: /Error$/,
		},
	}),
]
const createWarningHandler = (isDts = false) => {
	const ignoredCodes = new Set([
		'CIRCULAR_DEPENDENCY',
		'THIS_IS_UNDEFINED',
		'SOURCEMAP_ERROR',
		'EVAL',
		'MIXED_EXPORTS',
		'NON_EXISTENT_EXPORT',
		'EMPTY_BUNDLE',
	])
	const knownQuirkyTypes = new Set(['ms', 'node', 'jsonwebtoken'])
	return (warning, warn) => {
		if (ignoredCodes.has(warning.code)) {
			return
		}
		if (
			isDts &&
			warning.code === 'MISSING_EXPORT' &&
			warning.id &&
			knownQuirkyTypes.some(
				(pkg) =>
					warning.id.includes(`/node_modules/${pkg}`) ||
					warning.id.includes(`@types/${pkg}`),
			)
		) {
			return
		}
		if (isDts && warning.code === 'TYPE_CONFLICT' && warning.id?.includes('@types/')) {
			return
		}
		if (
			warning.code === 'UNUSED_EXTERNAL_IMPORT' &&
			warning.names &&
			packageJson.peerDependencies &&
			Object.keys(packageJson.peerDependencies).some((dep) => warning.names.includes(dep))
		) {
			return
		}
		warn(warning)
	}
}
const createLibConfig = ({ input, outputDir, minify = false }) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	const absoluteInput = resolve(projectRoot, input)
	if (!existsSync(absoluteInput)) {
		console.error(`❌ Entry file not found: ${absoluteInput}`)
		process.exit(1)
	}
	if (!existsSync(absoluteOutputDir)) {
		console.log(`📁 Output directory: ${relative(projectRoot, absoluteOutputDir)}`)
	}
	return {
		input: absoluteInput,
		external: createExternal(false),
		plugins: [
			...getBasePlugins(outputDir),
			...(minify ? getMinificationPlugins() : []),
			...(isProduction
				? [
						visualizer({
							filename: resolve(absoluteOutputDir, 'stats.html'),
							open: false,
							gzipSize: true,
							brotliSize: true,
							template: 'treemap',
						}),
					]
				: []),
		],
		output: [
			{
				file: resolve(absoluteOutputDir, 'index.mjs'),
				format: 'esm',
				sourcemap: true,
				exports: 'named',
				indent: false,
				strict: true,
				freeze: false,
				esModule: true,
				interop: 'auto',
				generatedCode: {
					constBindings: true,
					objectShorthand: true,
					arrowFunctions: true,
				},
			},
			{
				file: resolve(absoluteOutputDir, 'index.cjs'),
				format: 'cjs',
				sourcemap: true,
				exports: 'named',
				indent: false,
				strict: true,
				freeze: false,
				esModule: true,
				interop: 'auto',
				generatedCode: {
					constBindings: true,
					objectShorthand: true,
				},
			},
		],
		treeshake: {
			preset: 'recommended',
			moduleSideEffects: false,
			propertyReadSideEffects: false,
			tryCatchDeoptimization: false,
			unknownGlobalSideEffects: false,
			annotations: true,
		},
		onwarn: createWarningHandler(false),
		context: 'globalThis',
		preserveEntrySignatures: 'strict',
		makeAbsoluteExternalsRelative: false,
		shimMissingExports: false,
		cache: !isProduction,
		perf: isProduction,
	}
}
const createDtsConfig = ({ input, outputDir }) => {
	const absoluteOutputDir = resolve(projectRoot, outputDir)
	const absoluteInput = resolve(projectRoot, input)
	return {
		input: absoluteInput,
		external: createExternal(true),
		plugins: [
			dts({
				respectExternal: true,
				compilerOptions: {
					skipLibCheck: true,
					declaration: true,
					declarationMap: false,
					emitDeclarationOnly: true,
					rootDir: resolve(projectRoot, 'src'),
					outDir: absoluteOutputDir,
				},
			}),
		],
		output: {
			file: resolve(absoluteOutputDir, 'index.d.ts'),
			format: 'es',
			sourcemap: false,
		},
		treeshake: false,
		onwarn: createWarningHandler(true),
		preserveEntrySignatures: 'strict',
		makeAbsoluteExternalsRelative: false,
	}
}
export default [
	createLibConfig({
		input: 'src/index.ts',
		outputDir: 'build',
		minify: isProduction,
	}),
	createDtsConfig({
		input: 'src/index.ts',
		outputDir: 'build',
	}),
]
