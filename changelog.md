# Changelog

All significant changes to this project will be recorded in this file.

This format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.3] - 2026-04-02

### Docs

- Improved web documentation and README.
- Updated badges on README (npm version, downloads, license, build status, TypeScript, Playwright, Bun, Node, code style, PRs).
- Minor documentation fixes.

### Chore

- Patch update +1.

## [2.2.2] - 2026-04-02

### Fixed

- Fixed validator to handle `undefined`/`null` options (prevents runtime errors).

- Validation for string fields (`correlationId`, `logFile`, `userAgent`).
- Validation of `onProgress` as a function if provided.
- Use bracket notation to avoid TS4111 errors.
- Improved error messages with accepted types and values.
- Closed issue [#1](https://github.com/neuxdotdev/sfiledl/issues/1).

### Docs

- Updated changelog.
- Improved README.

### Chore

- Updated version to v2.2.2.

## [2.2.0] - 2026-04-02

### Added

- Implementation of the `downloadSfile` function with immediate/fallback download strategies.
- `BrowserManager` for Playwright lifecycle management.
- `SfilePageInteractions` for URL extraction after button waits.
- `DownloadOptions`, `DownloadResult` types, and `normalizeOptions` function.
- `DEFAULTS` constants for browser settings and timeouts.
- Error classes: `ValidationError`, `NetworkError`, `FileError`, `BrowserError`, and `AppError` (abstract).
- Utilities: `Result` type, `ok`/`err` helpers, `Logger` with level filtering, `sanitizeFilename` and `sleep` functions.

### Changed

- Simplified entry point to only re-export core modules.
- Removed `rollup.config.mjs` and `scripts/format-build.js` – simplified build system.
- Updated all dependencies to the latest versions.

### Docs

- Added documentation using `docsify-cli`.
- Updated license, homepage, and email.
- README and changelog improvements.

### Chore

- Added `@types/rollup-plugin-peer-deps-external` for type safety.
- Removed the `--forced` flag in the CI workflow.
- Synced `bun.lock` with the latest dependencies.

## [2.1.1] - 2026-04-02

### Added

- Initial implementation of `downloadSfile` with direct/fallback download strategies.
- `BrowserManager` for managing Playwright.
- `SfilePageInteractions` for page interactions.

### Refactor

- Simplified entry point: just re-export the core module.
- Improved type safety and error handling.

## [2.0.1] - 2026-04-02

### Changed

- Improved `prepublish` script.
- Temporarily disabled auto-publish in CI.

## [2.0.0] - 2026-04-02

### ⚠ BREAKING CHANGES

- **Architecture**: Library changed from CLI to Framework. API stability is not guaranteed until the stable v2.0.0 release.
- **Node.js**: Minimum version now **>=24**.
- **Export**: Path changed from `index.*` to `lib.*`.
- **CLI**: `bin` entry point removed. Tools are now purely library-based.

### Added

- Library status system with `LibraryStatus` enum (`UNDER_CONSTRUCTION`, `STABLE`, `DEPRECATED`).
- `assertStable()` function to ensure stable versions in production.
- Suppress warnings via the `MY_SUPER_FRAMEWORK_SUPPRESS_WARNING` environment variable or the `suppressWarning()` method.
- Licensed under **GNU Affero General Public License v3**.

### Refactoring

- Migrated code structure from `src/lib` to `lib`.
- Removed legacy modules (`result.ts`, `logger.ts`, `helpers.ts`, `errors/*`, `core/*`, `config/*`, `browser/*`).
- Updated `tsconfig.json` (rootDir, include).
- Updated `rollup.config.mjs` to reflect the new path.
- Updated `package.json` (exports, engines, main, module, types, scripts).

### Docs

- Updated README to reflect architectural changes.
- Added license documentation.

### Chore

- New CI workflows: `build.yml` and `publish.yml` (separating build and publish).
- Reusable workflow `rmcm-install.yml`.
- Implemented caching for Cargo binaries and Bun dependencies.

## [1.0.2] - 2026-03-31

### Chore

- Minor fixes and adjustments.

## [1.0.1] - 2026-03-31

### Chore

- Improved CI workflow.

## [1.0.0] - 2026-03-31

### Added

- Initial release: CLI tool for downloading files from sfile.mobi.
- Features: download using Playwright, JSON file configuration, logging.
- Input validation and basic error handling.
