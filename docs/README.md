# sfiledl

> **Automate file downloads from [sfile.co](https://sfile.co) — reliable, retry‑aware, and fully typed.**

<p align="center">
  <a href="https://www.npmjs.com/package/sfiledl"><img src="https://img.shields.io/npm/v/sfiledl.svg?style=flat-square&logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/sfiledl"><img src="https://img.shields.io/npm/dm/sfiledl?style=flat-square&logo=npm" alt="npm downloads"></a>
  <a href="https://github.com/neuxdotdev/sfiledl/blob/main/license"><img src="https://img.shields.io/github/license/neuxdotdev/sfiledl?style=flat-square" alt="license"></a>
  <a href="https://github.com/neuxdotdev/sfiledl/actions"><img src="https://img.shields.io/github/actions/workflow/status/neuxdotdev/sfiledl/build.yml?branch=main&style=flat-square&logo=github" alt="build"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript" alt="TypeScript"></a>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Playwright-1.59-green?style=flat-square&logo=playwright" alt="Playwright"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.3+-black?style=flat-square&logo=bun" alt="Bun"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-%3E%3D18-green?style=flat-square&logo=node.js" alt="Node"></a>
  <a href="https://prettier.io"><img src="https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square&logo=prettier" alt="code style"></a>
  <a href="http://makeapullrequest.com"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs welcome"></a>
</p>

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Usage](#cli-usage)
    - [Command Line Options](#command-line-options)
    - [Configuration File](#configuration-file)
- [Library API](#library-api)
    - [`downloadSfile`](#downloadsfile)
    - [`downloadSfileSafe`](#downloadsfilesafe)
    - [`createDownloader`](#createdownloader)
    - [`DownloadOptions`](#downloadoptions)
    - [`DownloadResult`](#downloadresult)
- [Error Handling](#error-handling)
    - [Error Types](#error-types)
    - [Retryable Errors](#retryable-errors)
- [Debug Mode & Artifacts](#debug-mode--artifacts)
- [Logging & Correlation](#logging--correlation)
- [Progress Tracking](#progress-tracking)
- [Development](#development)
    - [Project Structure](#project-structure)
    - [Scripts](#scripts)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
# Using Bun (recommended)
bun add sfiledl

# Using npm
npm install sfiledl

# Install Playwright browser (required once)
bunx playwright install chromium   # or npx playwright install chromium
```

**Prerequisites:** Node.js >=18 or Bun >=1.3.

---

## Quick Start

### As a library

```typescript
import { downloadSfile } from 'sfiledl'

const result = await downloadSfile('https://sfile.co/file/abc123', './downloads')

console.log(result)
// {
//   filePath: './downloads/document.pdf',
//   size: 1048576,
//   method: 'direct',
//   correlationId: '550e8400-e29b-41d4-a716-446655440000',
//   durationMs: 1234,
//   attempts: 1
// }
```

### As a CLI tool

```bash
# Basic usage
sfiledl https://sfile.co/abc123

# Specify output directory
sfiledl https://sfile.co/abc123 -o ~/Downloads

# Show browser window and enable debug
sfiledl https://sfile.co/abc123 --headed --debug

# Adjust retries and delays
sfiledl https://sfile.co/abc123 -r 5 -d 2000

# See help
sfiledl --help
```

---

## CLI Usage

The CLI provides a fully featured interface to the downloader.

```bash
sfiledl [options] <url>
```

### Command Line Options

| Option                     | Alias | Type     | Default           | Description                            |
| -------------------------- | ----- | -------- | ----------------- | -------------------------------------- |
| `<url>`                    | –     | required | –                 | sfile.co download URL                  |
| `--output <dir>`           | `-o`  | string   | `./downloads`     | Save directory                         |
| `--headed`                 | –     | boolean  | `false`           | Show browser window (disable headless) |
| `--timeout <ms>`           | `-t`  | number   | `60000`           | Navigation timeout (ms, ≥1000)         |
| `--button-timeout <ms>`    | –     | number   | `30000`           | Download button wait timeout (ms)      |
| `--retries <n>`            | `-r`  | number   | `3`               | Maximum retry attempts                 |
| `--retry-delay <ms>`       | `-d`  | number   | `1000`            | Base retry delay (exponential backoff) |
| `--debug`                  | –     | boolean  | `false`           | Enable debug logs and artifacts        |
| `--ua, --user-agent <str>` | –     | string   | Chrome on Windows | Custom User‑Agent header               |
| `--no-progress`            | –     | boolean  | `false`           | Disable progress spinner               |
| `--log-file <path>`        | –     | string   | –                 | Write structured logs to file          |
| `--no-artifacts`           | –     | boolean  | `true`            | Skip saving debug artifacts on error   |
| `-v, --version`            | –     | –        | –                 | Show version                           |
| `-h, --help`               | –     | –        | –                 | Show help                              |

### Configuration File

You can set default options using a JSON configuration file in the current working directory.  
Supported files: `.sfiledlrc.json` or `.sfiledlrc` (`.json` takes precedence).

Example `.sfiledlrc.json`:

```json
{
	"output": "./downloads",
	"retries": 5,
	"debug": true,
	"headless": false,
	"timeout": 120000,
	"userAgent": "MyCustomAgent/1.0"
}
```

CLI options always override file configuration.

---

## Library API

The library exports several functions and types for programmatic usage.

### `downloadSfile`

Main download function. Throws errors on failure.

```typescript
function downloadSfile(
	url: string,
	saveDir: string,
	options?: DownloadOptions,
): Promise<DownloadResult>
```

**Example:**

```typescript
import { downloadSfile } from 'sfiledl'

try {
	const result = await downloadSfile('https://sfile.co/file/xyz', './out', {
		headless: true,
		retries: 2,
		onProgress: (percent) => console.log(`${percent}%`),
	})
	console.log('Downloaded:', result.filePath)
} catch (err) {
	console.error('Failed:', err.message)
}
```

### `downloadSfileSafe`

Same as `downloadSfile` but never throws – returns a `Result` object.

```typescript
function downloadSfileSafe(
	url: string,
	saveDir: string,
	options?: DownloadOptions,
): Promise<Result<DownloadResult, Error>>
```

**Example:**

```typescript
import { downloadSfileSafe, isSuccess } from 'sfiledl'

const res = await downloadSfileSafe(url, './out')
if (isSuccess(res)) {
	console.log('OK:', res.value.filePath)
} else {
	console.error('Error:', res.error.message)
}
```

### `createDownloader`

Creates a reusable downloader with preset options.

```typescript
function createDownloader(defaultOptions?: DownloadOptions): {
	download: (url: string, saveDir: string, options?: DownloadOptions) => Promise<DownloadResult>
	downloadSafe: (
		url: string,
		saveDir: string,
		options?: DownloadOptions,
	) => Promise<Result<DownloadResult, Error>>
	withOptions: (newDefaults: Partial<DownloadOptions>) => ReturnType<typeof createDownloader>
}
```

**Example:**

```typescript
const dl = createDownloader({ headless: false, debug: true })
const result = await dl.download('https://sfile.co/file/abc', './downloads')

const quietDl = dl.withOptions({ debug: false })
await quietDl.download('https://sfile.co/file/xyz', './downloads')
```

### `DownloadOptions`

All options are optional.

| Option                  | Type                             | Default              | Description                                                     |
| ----------------------- | -------------------------------- | -------------------- | --------------------------------------------------------------- |
| `headless`              | `boolean`                        | `true`               | Run browser in headless mode.                                   |
| `debug`                 | `boolean`                        | `false`              | Enable verbose logging and debug artifacts.                     |
| `userAgent`             | `string`                         | Chrome on Windows UA | Custom user agent string.                                       |
| `timeout`               | `number` (ms)                    | `60000`              | Navigation and download timeout.                                |
| `downloadButtonTimeout` | `number` (ms)                    | `30000`              | Timeout for download button to appear.                          |
| `retries`               | `number`                         | `3`                  | Total attempts (including first).                               |
| `retryDelay`            | `number` (ms)                    | `1000`               | Base delay before exponential backoff.                          |
| `onProgress`            | `(percent, total, meta) => void` | `undefined`          | Progress callback. See [Progress Tracking](#progress-tracking). |
| `correlationId`         | `string`                         | auto-generated UUID  | ID for tracing across logs.                                     |
| `saveDebugArtifacts`    | `boolean`                        | `true`               | Save screenshot and HTML on error.                              |
| `logFile`               | `string`                         | `undefined`          | Write structured logs to file.                                  |

### `DownloadResult`

| Property        | Type                       | Description                                  |
| --------------- | -------------------------- | -------------------------------------------- |
| `filePath`      | `string`                   | Absolute path to saved file.                 |
| `size`          | `number` (bytes)           | File size.                                   |
| `method`        | `'direct'` or `'fallback'` | How the file was captured.                   |
| `correlationId` | `string` (optional)        | The ID used for logging.                     |
| `durationMs`    | `number` (optional)        | Total time from start to finish.             |
| `attempts`      | `number` (optional)        | Number of attempts made (including retries). |

---

## Error Handling

All errors thrown by the library extend `AppError` and include:

- `code` – unique string identifier
- `retryable` – `true` for network/browser issues, `false` for validation/file errors
- `context` – frozen object with debugging info
- `timestamp` – ISO string
- `toJSON()` – serialisable for logging

```typescript
import { downloadSfile, isRetryableError, NetworkError } from 'sfiledl'

try {
	await downloadSfile(url, './out')
} catch (err) {
	if (isRetryableError(err)) {
		console.log('Will be retried automatically by the library')
	}
	if (err instanceof NetworkError) {
		console.error('Network issue:', err.context)
	}
	// All errors have .code, .retryable, .context
}
```

### Error Types

| Class             | Code               | Retryable | When                                                           |
| ----------------- | ------------------ | --------- | -------------------------------------------------------------- |
| `ValidationError` | `VALIDATION_ERROR` | `false`   | Invalid URL, save directory, or options                        |
| `NetworkError`    | `NETWORK_ERROR`    | `true`    | Navigation failures, missing download button, request timeouts |
| `BrowserError`    | `BROWSER_ERROR`    | `true`    | Playwright launch or page initialisation errors                |
| `FileError`       | `FILE_ERROR`       | `false`   | Filesystem write errors, missing permissions                   |

---

## Debug Mode & Artifacts

Set `debug: true` in options to enable:

- Detailed console logging (including Playwright console/request failures)
- Automatic debug artifacts when an error occurs (saved to `/tmp/sfile_debug_<timestamp>/`):
    - `error.png` – full page screenshot
    - `error.html` – page source at failure
    - `error.txt` – error message and stack
    - `stages.json` – timeline of internal steps (launch, navigation, button wait, etc.)

```typescript
await downloadSfile(url, './out', { debug: true, saveDebugArtifacts: true })
```

In the CLI, use `--debug` and `--no-artifacts` to control behavior.

---

## Logging & Correlation

The library exports its own `Logger` class. You can create a logger with a correlation ID that will be automatically attached to every log line.

```typescript
import { Logger } from 'sfiledl'

const logger = new Logger({
	debugMode: true,
	correlationId: 'my-session-123',
	logFile: './app.log',
	prefix: 'downloader',
})
logger.info('Starting download')
```

The main download function also accepts a `correlationId` in `DownloadOptions`. That ID is used for all internal log messages and attached to the final `DownloadResult`.

---

## Progress Tracking

```typescript
await downloadSfile(url, './out', {
	onProgress: (percent, total, meta) => {
		console.log(`${meta.stage}: ${meta.message} – ${percent}%`)
		if (meta.attempt) console.log(`Retry attempt ${meta.attempt}`)
	},
})
```

Stages emitted:

- `launch` (10%) – browser launching
- `navigation` (30%) – page loaded
- `button` (50%) – download button ready
- `trigger` (70%) – download triggered
- `complete` (100%) – file saved
- `retry` (0%) – before a retry

---

## Development

```bash
git clone https://github.com/neuxdotdev/sfiledl.git
cd sfiledl
bun install
bunx playwright install chromium

# Full rebuild (clean, typecheck, bundle, format)
bun run rebuild

# Run tests
bun run test

# Build only library (CJS, ESM, types)
bun run build:lib

# Build only CLI bundle
bun run build:cli

# Build everything (library + CLI)
bun run build:all
```

### Project Structure

```
.
├── cli/                    # CLI entry point and utilities
│   ├── cmd.ts              # Commander setup and action
│   ├── config.ts           # Config file loading + CLI/merge logic
│   ├── error.ts            # Exit codes and pretty error formatting
│   ├── logger.ts           # File logger for CLI
│   ├── main.ts             # Entry shim
│   └── ui.ts               # Spinner, result printing, formatting
├── lib/                    # Core library
│   ├── browser/            # Playwright management & page interactions
│   ├── config/             # Defaults and schema validation
│   ├── core/               # Downloader logic & input validation
│   ├── errors/             # Custom error classes and guards
│   ├── utils/              # Helpers, logger, Result type
│   └── lib.ts              # Public API barrel export
├── build/                  # Generated output (CJS, ESM, types, CLI bundle)
├── scripts/                # Build helper scripts
├── docs/                   # Documentation site (docsify)
├── package.json
├── tsconfig.json
└── rollup.config.mjs
```

### Scripts

| Command                  | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `bun run clean`          | Remove `build/` and cache                                   |
| `bun run typecheck`      | Run `tsc --noEmit`                                          |
| `bun run format`         | Format all files with Prettier                              |
| `bun run clean-code`     | Run `rmcm` to clean comments and format                     |
| `bun run build:ts`       | Compile TypeScript to `build/` (without bundling)           |
| `bun run build:bundle`   | Bundle library with Rollup (development)                    |
| `bun run build:lib:prod` | Bundle library for production (minified)                    |
| `bun run build:cli:prod` | Bundle CLI executable for production                        |
| `bun run build:all:prod` | Bundle both library and CLI for production                  |
| `bun run rebuild`        | Full rebuild pipeline (clean → clean-code → build → format) |
| `bun run test`           | Run tests with Bun                                          |
| `bun run version:patch`  | Bump patch version                                          |
| `bun run release`        | Publish to npm (runs prepublishOnly)                        |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit changes using [Conventional Commits](https://www.conventionalcommits.org/)
4. Run `bun run rebuild` to ensure everything builds and is formatted
5. Push and open a Pull Request

Please ensure your code passes type checking, formatting, and all tests.

---

## License

**AGPL-3.0-only** – see [LICENSE](license) for details.  
This license ensures that any network‑distributed modifications remain open source.

---

## Credits

- Built with [Playwright](https://playwright.dev) for reliable browser automation
- Optimised for [Bun](https://bun.sh) runtime performance
- Inspired by the need for simple, scriptable file downloads from sfile.co

---

> **Repository**: https://github.com/neuxdotdev/sfiledl  
> **Issues**: https://github.com/neuxdotdev/sfiledl/issues  
> **npm**: https://www.npmjs.com/package/sfiledl  
> **Documentation**: https://neuxdotdev.github.io/sfiledl/
