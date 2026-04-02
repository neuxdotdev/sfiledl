# Example Usage

> Real‑world patterns for downloading, error handling, and automation.

---

## Basic Download

```typescript
import { downloadSfile } from 'sfiledl'

const result = await downloadSfile('https://sfile.co/file/abc123', './downloads')

console.log(` Saved: ${result.filePath} (${result.size} bytes)`)
```

---

## Safe Mode (No Throws)

```typescript
import { downloadSfileSafe, isSuccess } from 'sfiledl'

const res = await downloadSfileSafe('https://sfile.co/file/xyz', './out')

if (isSuccess(res)) {
	console.log('Success:', res.value.filePath)
} else {
	console.error('Failed:', res.error.code, res.error.message)
	// Access debug info: res.error.context, res.error.retryable
}
```

---

## Retry Logic (Built‑in)

```typescript
await downloadSfile(url, './out', {
	retries: 5, // 1 initial + 4 retries
	retryDelay: 2000, // Start with 2s delay
	onProgress: (p, _, m) => {
		if (m.stage === 'retry') {
			console.log(`↻ Retry ${m.attempt}/5...`)
		}
	},
})
```

> Retries only trigger for `retryable: true` errors (`NetworkError`, `BrowserError`).

---

## Progress Tracking

```typescript
await downloadSfile(url, './downloads', {
	onProgress: (percent, total, meta) => {
		const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5))
		console.log(`[${bar}] ${percent}% — ${meta.stage}: ${meta.message}`)
	},
})
```

**Sample output:**

```
[███░░░░░░░░░░░░░░░░░] 10% — launch: Launching browser
[███████░░░░░░░░░░░░░] 30% — navigation: Page loaded
[███████████░░░░░░░░░] 50% — button: Download button ready
[███████████████░░░░░] 70% — trigger: Download triggered
[████████████████████] 100% — complete: Download finished
```

---

## Debug Mode + Artifacts

```typescript
await downloadSfile(url, './out', {
	debug: true,
	saveDebugArtifacts: true,
	headless: false, // Optional: watch browser in action
})
```

On error, artifacts auto‑save to `/tmp/sfile_debug_<timestamp>/`:

- `error.png` — full‑page screenshot
- `error.html` — DOM snapshot
- `error.txt` — error message + stack
- `stages.json` — timeline of internal steps

---

## Custom Logging

```typescript
import { Logger, downloadSfile } from 'sfiledl'

const logger = new Logger({
	debugMode: true,
	correlationId: 'job-789',
	logFile: './logs/sfiledl.log',
	prefix: 'worker-1',
})

// Use logger independently
logger.info('Starting batch download')

// Or let downloadSfile inherit correlationId
await downloadSfile(url, './out', {
	correlationId: 'job-789',
	debug: true,
})
```

Log format:

```
[2026-04-02T10:30:45.123Z] [job-789] [worker-1] INFO: Starting download workflow | {"url":"https://..."}
```

---

## Batch Download Pattern

```typescript
import { createDownloader, isRetryableError } from 'sfiledl'

const urls = ['https://sfile.co/file/a1', 'https://sfile.co/file/b2', 'https://sfile.co/file/c3']

const dl = createDownloader({
	retries: 3,
	onProgress: (p, _, m) => process.stdout.write(`\r${m.stage} ${p}%`),
})

for (const [i, url] of urls.entries()) {
	try {
		console.log(`\n[${i + 1}/${urls.length}] Downloading ${url}`)
		const res = await dl.download(url, './batch')
		console.log(` ${res.filePath}`)
	} catch (err) {
		if (isRetryableError(err)) {
			console.warn(` Retryable error, skipping: ${err.message}`)
		} else {
			console.error(` Fatal: ${err.code} — ${err.message}`)
			break // or continue, depending on policy
		}
	}
}
```

---

## Testing with Mocks (Vitest Example)

```typescript
import { describe, it, expect, vi } from 'vitest'
import { downloadSfileSafe } from 'sfiledl'

vi.mock('playwright', () => ({
	chromium: {
		launch: vi.fn(() =>
			Promise.resolve({
				newContext: vi.fn(() =>
					Promise.resolve({
						addCookies: vi.fn(),
						newPage: vi.fn(() =>
							Promise.resolve({
								goto: vi.fn(),
								locator: vi.fn(() => ({ waitFor: vi.fn() })),
								waitForFunction: vi.fn(),
								$eval: vi.fn(() =>
									Promise.resolve('https://sfile.co/download/real'),
								),
								waitForEvent: vi.fn(() =>
									Promise.resolve({
										suggestedFilename: vi.fn(() => 'test.pdf'),
										saveAs: vi.fn(),
									}),
								),
								close: vi.fn(),
							}),
						),
					}),
				),
			}),
		),
	},
}))

describe('downloadSfileSafe', () => {
	it('returns success result for valid input', async () => {
		const res = await downloadSfileSafe('https://sfile.co/file/mock', './tmp')
		expect(res.success).toBe(true)
		if (res.success) {
			expect(res.value.method).toMatch(/direct|fallback/)
		}
	})
})
```

---

## Cleanup & Resource Management

```typescript
import { downloadSfile } from 'sfiledl'

// Always wrap in try/finally if you need guaranteed cleanup
try {
	await downloadSfile(url, './out', { debug: true })
} finally {
	// Browser, context, page auto‑close in library
	// But you can manually clear temp artifacts if needed:
	// await fs.rm(debugDir, { recursive: true, force: true })
}
```

---

## Proxy Support (Advanced)

```typescript
import { chromium } from 'playwright'
import { BrowserManager } from 'sfiledl/lib/browser/browser-manager.js'

// Not exposed in public API yet — extend via subclass if needed:
class ProxyBrowserManager extends BrowserManager {
	async launch() {
		this.browser = await chromium.launch({
			headless: this.opts.headless,
			proxy: { server: 'http://proxy.example.com:8080' },
			args: ['--no-sandbox', '--disable-dev-shm-usage'],
		})
		// ... rest of launch logic
	}
}
```

> Proxy support may be added to `DownloadOptions` in a future release.

---

## Next Steps

→ [Configuration Deep Dive](./config.md)  
→ [Error Handling Guide](../README.md#error-handling)  
→ [Contributing](../README.md#contributing)
