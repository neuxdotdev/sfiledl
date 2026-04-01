/**
 * ====================================================================================================
 *  WARNING: LIBRARY UNDER ACTIVE DEVELOPMENT - NOT FOR PRODUCTION USE
 * ====================================================================================================
 * 
 *  Status: DEPRECATED / UNSTABLE
 *  Previous Version: 1.0.2 (CLI-based architecture)
 *  Target Version: 2.0.0 (Full framework architecture)
 * 
 *  BREAKING CHANGES NOTICE:
 *  - This library is undergoing a complete rewrite and architectural refactor.
 *  - Legacy CLI-based implementation has been entirely removed.
 *  - New framework-based architecture is currently under active development.
 * 
 *  PRODUCTION USE PROHIBITED:
 *  - API surface is subject to change without notice.
 *  - No backward compatibility guarantees.
 *  - Use exclusively for development and testing purposes.
 * 
 * ====================================================================================================
 */

// ANSI color codes for terminal output
const COLORS = {
  RESET: "\x1b[0m",
  BRIGHT: "\x1b[1m",
  YELLOW: "\x1b[33m",
  RED: "\x1b[31m",
  CYAN: "\x1b[36m",
  GRAY: "\x1b[90m",
} as const;

/**
 * Development status of the library.
 */
export enum LibraryStatus {
  /** Library is under active construction, not ready for production. */
  UNDER_CONSTRUCTION = "UNDER_CONSTRUCTION",
  /** Library is stable and ready for production. (Future use) */
  STABLE = "STABLE",
  /** Library is deprecated. (Future use) */
  DEPRECATED = "DEPRECATED",
}

/**
 * Library metadata.
 */
export const LIB_INFO = {
  name: "MySuperFramework",
  currentVersion: "2.0.0-dev",
  previousVersion: "1.0.2",
  status: LibraryStatus.UNDER_CONSTRUCTION,
  isDeprecated: true,
  message: "This version represents a complete architectural refactor from CLI to framework. Not stable.",
} as const;

// Flag to ensure warning is displayed only once
let warningDisplayed = false;

/**
 * Utility function to strip ANSI escape codes from a string.
 * Supports common ANSI sequences (colors, styles, etc.).
 * @param text - Text containing ANSI escape sequences.
 * @returns Plain text without ANSI formatting.
 */
function stripAnsi(text: string): string {
  // Matches ANSI escape sequences: \x1b[ (or \u001b[) followed by any number of parameters and ending with a letter
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Checks if the library is currently in development mode.
 * @returns `true` if the library status is `UNDER_CONSTRUCTION`.
 */
export function isDevelopmentVersion(): boolean {
  return LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION;
}

/**
 * Primary class for library status management and developer notifications.
 * Provides programmatic access to version information and stability checks.
 */
export class LibStatus {
  private static instance: LibStatus | undefined;

  private constructor() {
    this.displayDeveloperWarning();
  }

  /**
   * Gets the singleton instance of LibStatus.
   * @returns The LibStatus instance.
   */
  public static getInstance(): LibStatus {
    if (!LibStatus.instance) {
      LibStatus.instance = new LibStatus();
    }
    return LibStatus.instance;
  }

  /**
   * Outputs formatted warning message to console upon library initialization.
   * Uses ANSI color codes for enhanced visibility in terminal environments.
   * The warning is displayed only once per process, unless suppressed.
   */
  private displayDeveloperWarning(): void {
    // Skip if console is not available or warning already displayed
    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }
    if (warningDisplayed) {
      return;
    }
    // Check environment variable to suppress warning (e.g., for testing)
    // Use bracket notation to avoid TypeScript index signature error
    if (typeof process !== "undefined" && process.env && process.env['MY_SUPER_FRAMEWORK_SUPPRESS_WARNING'] === "true") {
      return;
    }

    const border = `${COLORS.GRAY}${"=".repeat(80)}${COLORS.RESET}`;
    const label = `${COLORS.YELLOW}${COLORS.BRIGHT}[WARNING]${COLORS.RESET}`;
    const highlight = `${COLORS.CYAN}`;

    console.warn(`\n${border}`);
    console.warn(`${label} DEVELOPMENT VERSION IN USE`);
    console.warn(`${COLORS.GRAY}Library: ${COLORS.RESET}${highlight}${LIB_INFO.name}${COLORS.RESET}`);
    console.warn(`${COLORS.GRAY}Current Version: ${COLORS.RESET}${highlight}${LIB_INFO.currentVersion}${COLORS.RESET}`);
    console.warn(`${COLORS.GRAY}Previous Version: ${COLORS.RESET}${highlight}${LIB_INFO.previousVersion}${COLORS.RESET}`);
    console.warn(`${COLORS.GRAY}Architecture: ${COLORS.RESET}${highlight}CLI -> Framework (Full Refactor)${COLORS.RESET}`);
    console.warn(`\n${COLORS.RED}${COLORS.BRIGHT}DO NOT USE IN PRODUCTION ENVIRONMENTS${COLORS.RESET}`);
    console.warn(`${COLORS.GRAY}API stability is not guaranteed. Breaking changes may occur without notice.${COLORS.RESET}`);
    console.warn(`${COLORS.GRAY}To suppress this warning, set env MY_SUPER_FRAMEWORK_SUPPRESS_WARNING=true${COLORS.RESET}`);
    console.warn(`${border}\n`);

    warningDisplayed = true;
  }

  /**
   * Suppresses the development warning for this instance.
   * Useful when you need to programmatically disable the warning (e.g., in tests).
   */
  public suppressWarning(): void {
    warningDisplayed = true;
  }

  /**
   * Validates library stability status.
   * @throws Error if library is marked as unstable or under construction.
   */
  public ensureStable(): void {
    if (LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION) {
      const errorMessage = `${COLORS.RED}${COLORS.BRIGHT}[${LIB_INFO.name}] Stability Check Failed${COLORS.RESET}\n` +
        `${COLORS.GRAY}Library version ${LIB_INFO.currentVersion} is under active development.${COLORS.RESET}\n` +
        `${COLORS.GRAY}Current status: ${LIB_INFO.status}${COLORS.RESET}`;

      throw new Error(stripAnsi(errorMessage));
    }
  }

  /**
   * Returns the current library version string.
   * @returns Version identifier in semver format.
   */
  public getVersion(): string {
    return LIB_INFO.currentVersion;
  }

  /**
   * Returns detailed library metadata.
   * @returns Readonly object containing library information.
   */
  public getInfo(): Readonly<typeof LIB_INFO> {
    return LIB_INFO;
  }
}

/**
 * Placeholder entry point for framework initialization.
 * Intentionally throws error to prevent usage during development phase.
 * @throws Error indicating framework is not ready for use.
 */
export function initFramework(): never {
  const message = `${COLORS.RED}${COLORS.BRIGHT}[${LIB_INFO.name}] Initialization Blocked${COLORS.RESET}\n` +
    `${COLORS.GRAY}Framework is undergoing complete architectural refactor.${COLORS.RESET}\n` +
    `${COLORS.GRAY}Migration path: v${LIB_INFO.previousVersion} (CLI) -> v${LIB_INFO.currentVersion} (Framework)${COLORS.RESET}\n` +
    `${COLORS.GRAY}Status: ${LIB_INFO.status}${COLORS.RESET}`;

  throw new Error(stripAnsi(message));
}

/**
 * Type guard to check if current version is stable.
 * @returns `false` if library is under construction, `true` otherwise.
 */
export function isStable(): boolean {
  return LIB_INFO.status !== LibraryStatus.UNDER_CONSTRUCTION;
}

/**
 * Throws an error if the library is not stable.
 * Use this at the start of your application to ensure you're not using an unstable version.
 * @throws Error when library is under construction.
 */
export function assertStable(): void {
  if (LIB_INFO.status === LibraryStatus.UNDER_CONSTRUCTION) {
    throw new Error(
      `[${LIB_INFO.name}] Cannot use unstable version ${LIB_INFO.currentVersion} in production. ` +
      `Status: ${LIB_INFO.status}`
    );
  }
}

// Immediate execution block: displays warning upon module import (only once)
// Does not throw to allow type-checking and development workflows
if (isDevelopmentVersion()) {
  // Trigger singleton instantiation which displays the warning
  LibStatus.getInstance();
}