#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
const __dirname: string = path.dirname(fileURLToPath(import.meta.url))
const projectRoot: string = path.join(__dirname, '..')
const buildDir: string = path.join(projectRoot, 'build')
const tmpDir: string = path.join(projectRoot, 'tmp-build')
const safeRename = (from: string, to: string): boolean => {
	if (!fs.existsSync(from)) return false
	if (fs.existsSync(to)) {
		fs.rmSync(to, { recursive: true, force: true })
	}
	fs.renameSync(from, to)
	return true
}
function formatMapFiles(dir: string): void {
	if (!fs.existsSync(dir)) return
	const entries = fs.readdirSync(dir)
	for (const entry of entries) {
		const fullPath = path.join(dir, entry)
		const stat = fs.statSync(fullPath)
		if (stat.isDirectory()) {
			formatMapFiles(fullPath)
		} else if (entry.endsWith('.map')) {
			try {
				const content: string = fs.readFileSync(fullPath, 'utf8')
				const parsed: unknown = JSON.parse(content)
				if (parsed !== null && typeof parsed === 'object') {
					fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2))
					console.log(`  Formatted: ${path.relative(projectRoot, fullPath)}`)
				}
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				console.warn(`   Skip map: ${path.relative(projectRoot, fullPath)} - ${message}`)
			}
		}
	}
}
console.log('Starting build formatter...')
console.log('Backing up build folder...')
const buildWasMoved: boolean = safeRename(buildDir, tmpDir)
if (!buildWasMoved) {
	console.warn(' Build folder not found. Skipping format step.')
	console.log('Done! (Nothing to format)')
	process.exit(0)
}
console.log('Running npm format...')
try {
	execSync('npm run format', { stdio: 'inherit', cwd: projectRoot })
} catch {
	console.warn(' npm format had issues, continuing...')
}
console.log('Force formatting all build files...')
try {
	const prettierCmd = `npx prettier --write "${path.relative(projectRoot, tmpDir)}/**/*" --ignore-unknown`
	execSync(prettierCmd, { stdio: 'inherit', cwd: projectRoot })
} catch {
	console.warn(' Prettier on build files had issues, continuing...')
}
console.log(' Ensuring source maps are formatted...')
formatMapFiles(tmpDir)
console.log('Restoring build folder...')
if (fs.existsSync(buildDir)) {
	fs.rmSync(buildDir, { recursive: true, force: true })
}
safeRename(tmpDir, buildDir)
console.log('Done! Build folder has been formatted.')
