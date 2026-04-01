const COLORS = {
	RESET: '\x1b[0m',
	BRIGHT: '\x1b[1m',
	YELLOW: '\x1b[33m',
	RED: '\x1b[31m',
	CYAN: '\x1b[36m',
	GRAY: '\x1b[90m',
} as const
export enum LibraryStatus {
	UNDER_CONSTRUCTION = 'UNDER_CONSTRUCTION',
	STABLE = 'STABLE',
	DEPRECATED = 'DEPRECATED',
}
export const LIB_INFO = {
	name: 'MySuperFramework',
	currentVersion: '2.0.0-dev',
	previousVersion: '1.0.2',
	status: LibraryStatus.UNDER_CONSTRUCTION,
	isDeprecated: true,
	message:
		'This version represents a complete architectural refactor from CLI to framework. Not stable.',
} as const
let warningDisplayed = false
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}
export function isDevelopmentVersion(): boolean {
	return LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION
}
export class LibStatus {
	private static instance: LibStatus | undefined
	private constructor() {
		this.displayDeveloperWarning()
	}
	public static getInstance(): LibStatus {
		if (!LibStatus.instance) {
			LibStatus.instance = new LibStatus()
		}
		return LibStatus.instance
	}
	private displayDeveloperWarning(): void {
		if (typeof console === 'undefined' || typeof console.warn !== 'function') {
			return
		}
		if (warningDisplayed) {
			return
		}
		if (
			typeof process !== 'undefined' &&
			process.env &&
			process.env['MY_SUPER_FRAMEWORK_SUPPRESS_WARNING'] === 'true'
		) {
			return
		}
		const border = `${COLORS.GRAY}${'='.repeat(80)}${COLORS.RESET}`
		const label = `${COLORS.YELLOW}${COLORS.BRIGHT}[WARNING]${COLORS.RESET}`
		const highlight = `${COLORS.CYAN}`
		console.warn(`\n${border}`)
		console.warn(`${label} DEVELOPMENT VERSION IN USE`)
		console.warn(
			`${COLORS.GRAY}Library: ${COLORS.RESET}${highlight}${LIB_INFO.name}${COLORS.RESET}`,
		)
		console.warn(
			`${COLORS.GRAY}Current Version: ${COLORS.RESET}${highlight}${LIB_INFO.currentVersion}${COLORS.RESET}`,
		)
		console.warn(
			`${COLORS.GRAY}Previous Version: ${COLORS.RESET}${highlight}${LIB_INFO.previousVersion}${COLORS.RESET}`,
		)
		console.warn(
			`${COLORS.GRAY}Architecture: ${COLORS.RESET}${highlight}CLI -> Framework (Full Refactor)${COLORS.RESET}`,
		)
		console.warn(
			`\n${COLORS.RED}${COLORS.BRIGHT}DO NOT USE IN PRODUCTION ENVIRONMENTS${COLORS.RESET}`,
		)
		console.warn(
			`${COLORS.GRAY}API stability is not guaranteed. Breaking changes may occur without notice.${COLORS.RESET}`,
		)
		console.warn(
			`${COLORS.GRAY}To suppress this warning, set env MY_SUPER_FRAMEWORK_SUPPRESS_WARNING=true${COLORS.RESET}`,
		)
		console.warn(`${border}\n`)
		warningDisplayed = true
	}
	public suppressWarning(): void {
		warningDisplayed = true
	}
	public ensureStable(): void {
		if (LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION) {
			const errorMessage =
				`${COLORS.RED}${COLORS.BRIGHT}[${LIB_INFO.name}] Stability Check Failed${COLORS.RESET}\n` +
				`${COLORS.GRAY}Library version ${LIB_INFO.currentVersion} is under active development.${COLORS.RESET}\n` +
				`${COLORS.GRAY}Current status: ${LIB_INFO.status}${COLORS.RESET}`
			throw new Error(stripAnsi(errorMessage))
		}
	}
	public getVersion(): string {
		return LIB_INFO.currentVersion
	}
	public getInfo(): Readonly<typeof LIB_INFO> {
		return LIB_INFO
	}
}
export function initFramework(): never {
	const message =
		`${COLORS.RED}${COLORS.BRIGHT}[${LIB_INFO.name}] Initialization Blocked${COLORS.RESET}\n` +
		`${COLORS.GRAY}Framework is undergoing complete architectural refactor.${COLORS.RESET}\n` +
		`${COLORS.GRAY}Migration path: v${LIB_INFO.previousVersion} (CLI) -> v${LIB_INFO.currentVersion} (Framework)${COLORS.RESET}\n` +
		`${COLORS.GRAY}Status: ${LIB_INFO.status}${COLORS.RESET}`
	throw new Error(stripAnsi(message))
}
export function isStable(): boolean {
	return LIB_INFO.status !== LibraryStatus.UNDER_CONSTRUCTION
}
export function assertStable(): void {
	if (LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION) {
		throw new Error(
			`[${LIB_INFO.name}] Cannot use unstable version ${LIB_INFO.currentVersion} in production. ` +
				`Status: ${LIB_INFO.status}`,
		)
	}
}
if (isDevelopmentVersion()) {
	LibStatus.getInstance()
}
