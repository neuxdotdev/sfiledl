# sfiledl

> Implement and automate downloading of any file from https://sfile.co/ with javascripts library, written entirely in typescripts

[![npm version](https://img.shields.io/npm/v/sfiledl)](https://www.npmjs.com/package/sfiledl)
[![License](https://img.shields.io/npm/l/sfiledl)](https://github.com/neuxdotdev/sfiledl/blob/main/license)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org)

---

## Installation

```bash
# Using Bun (recommended)
bun add sfiledl

# Using npm
npm install sfiledl

# Install Playwright browser (required)
bunx playwright install chromium
```

---

## Quick Start

```typescript
import { downloadSfile } from 'sfiledl'

const result = await downloadSfile(
	'https://sfile.co/file/abc123', // sfile.co URL
	'./downloads', // Save directory
	{ headless: true, debug: false }, // Optional options
)

console.log(result)
// {
//   filePath: './downloads/file.zip',
//   size: 1048576,
//   method: 'direct' | 'fallback'
// }
```

---

## API Reference

### `downloadSfile(url, saveDir, options?)`

| Parameter | Type              | Required | Description                |
| --------- | ----------------- | -------- | -------------------------- |
| `url`     | `string`          |          | sfile.co URL to download   |
| `saveDir` | `string`          |          | Directory to save the file |
| `options` | `DownloadOptions` |          | Optional configuration     |

### `DownloadOptions`

```typescript
interface DownloadOptions {
	headless?: boolean // Run browser headless (default: true)
	debug?: boolean // Enable debug logging (default: false)
	userAgent?: string // Custom user agent string
	timeout?: number // Operation timeout in ms (default: 100000)
}
```

### `DownloadResult`

```typescript
interface DownloadResult {
	filePath: string // Full path to saved file
	size: number // File size in bytes
	method: 'direct' | 'fallback' // Download strategy used
}
```

---

## Error Handling

```typescript
import { downloadSfile, ValidationError, NetworkError } from 'sfiledl'

try {
	await downloadSfile('https://sfile.co/file/xyz', './out')
} catch (err) {
	if (err instanceof ValidationError) {
		console.error('Invalid input:', err.message)
	}
	if (err instanceof NetworkError && err.retryable) {
		console.log('Network issue, retry possible')
	}
	// All errors include: code, timestamp, context, retryable flag
}
```

### Error Types

| Error             | Code               | Retryable | When                       |
| ----------------- | ------------------ | --------- | -------------------------- |
| `ValidationError` | `VALIDATION_ERROR` |           | Invalid URL or input       |
| `NetworkError`    | `NETWORK_ERROR`    |           | Navigation/fetch failures  |
| `FileError`       | `FILE_ERROR`       |           | File system issues         |
| `BrowserError`    | `BROWSER_ERROR`    |           | Playwright launch failures |

---

## Debug Mode

Enable `debug: true` for verbose logging:

```typescript
await downloadSfile(url, './out', { debug: true })
```

On error, debug artifacts are auto-saved to `/tmp/sfile_debug_<timestamp>/`:

- `error.png` — Full page screenshot
- `error.html` — Page source at failure
- `error.txt` — Error message

---

## Development

```bash
# Clone & install
git clone https://github.com/neuxdotdev/sfiledl.git
cd sfiledl
bun install
bunx playwright install chromium
# Rebuild (clean + lint + build + format)
bun run rebuild

# Run tests
bun run test
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit changes (`git commit -m 'feat: add your feature'`)
4. Push to branch (`git push origin feat/your-feature`)
5. Open a Pull Request

---

## License

**AGPL-3.0-only** — See [LICENSE](license.md) for details.

> This license ensures that any network-distributed modifications remain open source.

---

## Credits

- Built with [Playwright](https://playwright.dev) for reliable automation
- Optimized for [Bun](https://bun.sh) runtime performance
- Inspired by the need for simple, scriptable file downloads

---

> **Repository**: https://github.com/neuxdotdev/sfiledl  
> **Issues**: https://github.com/neuxdotdev/sfiledl/issues  
> **npm**: https://www.npmjs.com/package/sfiledl
