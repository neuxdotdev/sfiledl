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

// Library metadata constant
export const LIB_INFO = {
  name: "MySuperFramework",
  currentVersion: "2.0.0-dev",
  previousVersion: "1.0.2",
  status: "UNDER_CONSTRUCTION" as const,
  isDeprecated: true,
  message: "This version represents a complete architectural refactor from CLI to framework. Not stable.",
} as const;

/**
 * Primary class for library status management and developer notifications.
 * Provides programmatic access to version information and stability checks.
 */
export class LibStatus {
  private static instance: LibStatus | undefined;

  private constructor() {
    this.displayDeveloperWarning();
  }

  public static getInstance(): LibStatus {
    if (!LibStatus.instance) {
      LibStatus.instance = new LibStatus();
    }
    return LibStatus.instance;
  }

  /**
   * Outputs formatted warning message to console upon library initialization.
   * Uses ANSI color codes for enhanced visibility in terminal environments.
   */
  private displayDeveloperWarning(): void {
    if (typeof console === "undefined" || typeof console.warn !== "function") {
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
    console.warn(`${border}\n`);
  }

  /**
   * Validates library stability status.
   * @throws Error if library is marked as unstable or under construction.
   */
  public ensureStable(): void {
    if (LIB_INFO.status === "UNDER_CONSTRUCTION") {
      const errorMessage = `${COLORS.RED}${COLORS.BRIGHT}[${LIB_INFO.name}] Stability Check Failed${COLORS.RESET}\n` +
        `${COLORS.GRAY}Library version ${LIB_INFO.currentVersion} is under active development.${COLORS.RESET}\n` +
        `${COLORS.GRAY}Current status: ${LIB_INFO.status}${COLORS.RESET}`;
      
      throw new Error(this.stripAnsi(errorMessage));
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

  /**
   * Utility method to strip ANSI codes for clean error messages.
   * @param text - Text containing ANSI escape sequences.
   * @returns Plain text without ANSI formatting.
   */
  private stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
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

  throw new Error(new LibStatus().stripAnsi(message));
}

/**
 * Type guard to check if current version is stable.
 * @returns false if library is under construction.
 */
export function isStable(): boolean {
  return LIB_INFO.status !== "UNDER_CONSTRUCTION";
}

// Immediate execution block: displays warning upon module import
// Does not throw to allow type-checking and development workflows
(() => {
  if (LIB_INFO.status === "UNDER_CONSTRUCTION") {
    console.warn(
      `${COLORS.YELLOW}${COLORS.BRIGHT}[${LIB_INFO.name}]${COLORS.RESET} ` +
      `${COLORS.GRAY}v${LIB_INFO.currentVersion} - Under active development${COLORS.RESET}`
    );
  }
})();