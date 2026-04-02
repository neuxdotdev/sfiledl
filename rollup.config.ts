#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RollupOptions, OutputOptions, Plugin, LoggingFunction, RollupLog } from 'rollup'
import resolvePlugin from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'
import json from '@rollup/plugin-json'
import replace from '@rollup/plugin-replace'
import { visualizer } from 'rollup-plugin-visualizer'

const __dirname: string = dirname(fileURLToPath(import.meta.url))
const projectRoot: string = __dirname
const isProduction: boolean = process.env.NODE_ENV === 'production'

interface PackageJson {
	name?: string
	version?: string
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

let packageJson: PackageJson

try {
	const packagePath: string = resolve(projectRoot, 'package.json')
	if (!existsSync(packagePath)) {
		throw new Error(`package.json tidak ditemukan di: ${packagePath}`)
	}
	const rawContent: string = readFileSync(packagePath, 'utf8')
	const parsed: unknown = JSON.parse(rawContent)
	if (parsed === null || typeof parsed !== 'object') {
		throw new Error('package.json harus berupa object')
	}
	packageJson = parsed as PackageJson
} catch (err: unknown) {
	const message: string = err instanceof Error ? err.message : String(err)
	console.error('Failed to read package.json:', message)
	process.exit(1)
}

type SimpleExternal = (string | RegExp)[]

const createExternal = (isDts: boolean = false): SimpleExternal => {
	const externals: SimpleExternal = [
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
		...Object.keys(packageJson.optionalDependencies ?? {}),
		/^node:.*/,
		/^(?!\.\/|\.\.\/|\/)/,
	]
	if (isDts) {
		externals.push(/^@types\/.*/)
	}
	return externals
}

interface BasePluginOptions {
	outputDir: string
}

const getBasePlugins = ({ outputDir }: BasePluginOptions): Plugin[] => {
	const absoluteOutputDir: string = resolve(projectRoot, outputDir)
	return [
		peerDepsExternal({ includeDependencies: true }),
		json({ compact: true, preferConst: true }),
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
			rootDir: resolve(projectRoot, 'lib'),
			noEmitOnError: isProduction,
			skipLibCheck: true,
		}),
		replace({
			preventAssignment: true,
			values: {
				'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
				'__VERSION__': JSON.stringify(packageJson.version),
			},
			include: ['lib/**/*'],
			delimiters: ['', ''],
		}),
	]
}

const getMinificationPlugins = (): Plugin[] => {
	const terserOptions = {
		ecma: 2020 as const,
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
			ecma: 2020 as const,
			module: true,
			keep_classnames: /Error$/,
			keep_fnames: /Error$/,
		},
		format: {
			comments: false,
			ascii_only: false,
			ecma: 2020 as const,
			wrap_iife: false,
		},
		sourceMap: {
			filename: 'lib.[format].js.map',
			url: 'inline',
		},
		mangle: {
			toplevel: true,
			keep_fnames: /Error$/,
		},
	}
	return [terser(terserOptions)]
}

const createWarningHandler = (
	isDts: boolean = false,
): ((warning: RollupLog, warn: LoggingFunction) => void) => {
	const ignoredCodes: readonly string[] = [
		'CIRCULAR_DEPENDENCY',
		'THIS_IS_UNDEFINED',
		'SOURCEMAP_ERROR',
		'EVAL',
		'MIXED_EXPORTS',
		'NON_EXISTENT_EXPORT',
		'EMPTY_BUNDLE',
	]
	const knownQuirkyTypes: readonly string[] = ['ms', 'node', 'jsonwebtoken']
	return (warning: RollupLog, warn: LoggingFunction): void => {
		if (!warning.code) {
			warn(warning)
			return
		}
		if (ignoredCodes.includes(warning.code)) {
			return
		}
		if (
			isDts &&
			warning.code === 'MISSING_EXPORT' &&
			warning.id &&
			knownQuirkyTypes.some(
				(pkg: string): boolean =>
					(warning.id?.includes(`/node_modules/${pkg}`) ||
						warning.id?.includes(`@types/${pkg}`)) ??
					false,
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
			Object.keys(packageJson.peerDependencies).some(
				(dep: string): boolean => warning.names?.includes(dep) ?? false,
			)
		) {
			return
		}
		warn(warning)
	}
}

interface LibConfigOptions {
	input: string
	outputDir: string
	minify?: boolean
}

const createLibConfig = ({ input, outputDir, minify = false }: LibConfigOptions): RollupOptions => {
	const absoluteOutputDir: string = resolve(projectRoot, outputDir)
	const absoluteInput: string = resolve(projectRoot, input)
	if (!existsSync(absoluteInput)) {
		console.error(`Entry file not found: ${absoluteInput}`)
		process.exit(1)
	}
	if (!existsSync(absoluteOutputDir)) {
		console.log(`Output directory: ${relative(projectRoot, absoluteOutputDir)}`)
	}
	const basePlugins: Plugin[] = getBasePlugins({ outputDir })
	const productionPlugins: Plugin[] = isProduction
		? [
				visualizer({
					filename: resolve(absoluteOutputDir, 'stats.html'),
					open: false,
					gzipSize: true,
					brotliSize: true,
					template: 'treemap',
				}),
			]
		: []
	const minifyPlugins: Plugin[] = minify ? getMinificationPlugins() : []
	const outputConfig: OutputOptions[] = [
		{
			file: resolve(absoluteOutputDir, 'lib.mjs'),
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
			file: resolve(absoluteOutputDir, 'lib.cjs'),
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
	]
	return {
		input: absoluteInput,
		external: createExternal(false),
		plugins: [...basePlugins, ...minifyPlugins, ...productionPlugins],
		output: outputConfig,
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

interface DtsConfigOptions {
	input: string
	outputDir: string
}

const createDtsConfig = ({ input, outputDir }: DtsConfigOptions): RollupOptions => {
	const absoluteOutputDir: string = resolve(projectRoot, outputDir)
	const absoluteInput: string = resolve(projectRoot, input)
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
					rootDir: resolve(projectRoot, 'lib'),
					outDir: absoluteOutputDir,
				},
			}),
		],
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

const configs: RollupOptions[] = [
	createLibConfig({
		input: 'lib/lib.ts',
		outputDir: 'build',
		minify: isProduction,
	}),
	createDtsConfig({
		input: 'lib/lib.ts',
		outputDir: 'build',
	}),
]

export default configs
