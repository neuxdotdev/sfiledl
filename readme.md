# sfiledl

> Automate file downloads from [sfile.co](https://sfile.co/) — reliable, retry‑aware, and fully typed.

[![npm version](https://img.shields.io/npm/v/sfiledl.svg?style=flat-square&logo=npm)](https://www.npmjs.com/package/sfiledl)
[![npm downloads](https://img.shields.io/npm/dm/sfiledl?style=flat-square&logo=npm)](https://www.npmjs.com/package/sfiledl)
[![license](https://img.shields.io/github/license/neuxdotdev/sfiledl?style=flat-square)](https://github.com/neuxdotdev/sfiledl/blob/main/license)
[![build](https://img.shields.io/github/actions/workflow/status/neuxdotdev/sfiledl/build.yml?branch=main&style=flat-square&logo=github)](https://github.com/neuxdotdev/sfiledl/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.59-green?style=flat-square&logo=playwright)](https://playwright.dev)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black?style=flat-square&logo=bun)](https://bun.sh)
[![Node](https://img.shields.io/badge/Node-%3E%3D24-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![code style](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square&logo=prettier)](https://prettier.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
    - [downloadSfile](#downloadsfile)
    - [downloadSfileSafe](#downloadsfilesafe)
    - [createDownloader](#createdownloader)
    - [DownloadOptions](#downloadoptions)
    - [DownloadResult](#downloadresult)
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

# Install Playwright browser (required)
bunx playwright install chromium   # or npx playwright install chromium
```

**Prerequisites:** Node.js >=24 or Bun >=1.3.

---

## Quick Start

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

---

## API Reference

### `downloadSfile(url, saveDir, options?)`

Main download function. Throws errors on failure (see [Error Handling](#error-handling)).

| Param     | Type              | Description                            |
| --------- | ----------------- | -------------------------------------- |
| `url`     | `string`          | sfile.co URL (must contain the domain) |
| `saveDir` | `string`          | Directory where the file will be saved |
| `options` | `DownloadOptions` | Optional configuration                 |

**Returns:** `Promise<DownloadResult>`

### `downloadSfileSafe(url, saveDir, options?)`

Same as `downloadSfile` but never throws. Returns a `Result` object.

```typescript
import { downloadSfileSafe, isSuccess } from 'sfiledl'

const res = await downloadSfileSafe(url, './out')
if (isSuccess(res)) {
	console.log('OK:', res.value.filePath)
} else {
	console.error('Error:', res.error.message)
}
```

### `createDownloader(defaultOptions?)`

Creates a reusable downloader with preset options.

```typescript
const dl = createDownloader({ headless: false, debug: true })
const result = await dl.download('https://sfile.co/file/xyz', './out')

// safe variant
const safeResult = await dl.downloadSafe(url, './out')

// chain new defaults
const quietDl = dl.withOptions({ debug: false })
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

All errors extend `AppError` and include:

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

# Full rebuild (clean, typecheck, build, format)
bun run rebuild

# Run tests (if available)
bun run test
```

### Project Structure

```
.
├── lib
│   ├── browser
│   │   ├── browser-manager.ts
│   │   └── page-interactions.ts
│   ├── config
│   │   ├── defaults.ts
│   │   └── schema.ts
│   ├── core
│   │   ├── downloader.ts
│   │   └── validator.ts
│   ├── errors
│   │   ├── base.ts
│   │   ├── errors.ts
│   │   └── index.ts
│   ├── utils
│   │   ├── helpers.ts
│   │   ├── logger.ts
│   │   └── result.ts
│   └── lib.ts
├── build               # generated output (CJS, ESM, types)
├── package.json
└── tsconfig.json
```

### Scripts

| Command                | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `bun run clean`        | Remove `build/` and cache                           |
| `bun run typecheck`    | Run `tsc --noEmit`                                  |
| `bun run build:ts`     | Compile TypeScript to `build/`                      |
| `bun run build:bundle` | Bundle with Rollup                                  |
| `bun run build`        | Clean + typecheck + build:ts + build:bundle         |
| `bun run rebuild`      | Full rebuild pipeline (clean-code + build + format) |
| `bun run format`       | Format all files with Prettier                      |
| `bun run test`         | Run tests (requires test files)                     |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit changes using [Conventional Commits](https://www.conventionalcommits.org/)
4. Push and open a Pull Request

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
