# Configuration

> Fine‑tune `sfiledl` behavior with flexible, typed options.

---

## DownloadOptions Reference

All fields are **optional**. Unspecified values fall back to `DEFAULTS`.

| Option                  | Type                             | Default           | Description                                                  |
| ----------------------- | -------------------------------- | ----------------- | ------------------------------------------------------------ |
| `headless`              | `boolean`                        | `true`            | Run browser without UI. Set `false` for debugging.           |
| `debug`                 | `boolean`                        | `false`           | Enable verbose logging + auto‑save debug artifacts on error. |
| `userAgent`             | `string`                         | Chrome/Windows UA | Custom User‑Agent string sent with requests.                 |
| `timeout`               | `number` (ms)                    | `60000`           | Max time for navigation & download operations.               |
| `downloadButtonTimeout` | `number` (ms)                    | `30000`           | Max time to wait for `#download` button to become active.    |
| `retries`               | `number`                         | `3`               | Total attempts (1 initial + N retries).                      |
| `retryDelay`            | `number` (ms)                    | `1000`            | Base delay for exponential backoff between retries.          |
| `onProgress`            | `(percent, total, meta) => void` | `undefined`       | Callback for real‑time progress updates.                     |
| `correlationId`         | `string`                         | auto‑UUID         | Unique ID to trace logs across async operations.             |
| `saveDebugArtifacts`    | `boolean`                        | `true`            | Auto‑save screenshot/HTML on failure when `debug: true`.     |
| `logFile`               | `string`                         | `undefined`       | Path to append structured JSON logs.                         |

---

## DEFAULTS Export

```typescript
import { DEFAULTS } from 'sfiledl'

console.log(DEFAULTS)
// {
//   userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
//   headless: true,
//   timeout: 60000,
//   downloadButtonTimeout: 30000,
//   fallbackWaitMs: 3000,
//   retries: 3,
//   retryDelay: 1000,
//   maxRetryDelay: 30000,
//   saveDebugArtifacts: true,
//   maxFilenameLength: 255,
//   sanitizeReplacement: '_'
// }
```

---

## Advanced Patterns

### Reusable Downloader with Presets

```typescript
import { createDownloader } from 'sfiledl'

const dl = createDownloader({
	headless: true,
	retries: 5,
	retryDelay: 2000,
	debug: false,
})

// Use anywhere
const result = await dl.download('https://sfile.co/file/xyz', './out')

// Chain new defaults without mutating original
const verboseDl = dl.withOptions({ debug: true, saveDebugArtifacts: true })
```

### Progress Callback Meta Structure

```typescript
onProgress: (percent, total, meta) => {
	// meta.stage: 'launch' | 'navigation' | 'button' | 'trigger' | 'complete' | 'retry'
	// meta.message: human‑readable status
	// meta.attempt?: current retry number (only in 'retry' stage)
}
```

### Correlation ID for Distributed Tracing

```typescript
import { randomUUID } from 'crypto'
import { downloadSfile } from 'sfiledl'

const traceId = randomUUID()
await downloadSfile(url, './out', { correlationId: traceId })
// All internal logs now include [traceId] for easy grep/filter
```

---

## Validation Rules

`sfiledl` validates inputs early with clear errors:

| Input      | Rule                                                                             | Error Code         |
| ---------- | -------------------------------------------------------------------------------- | ------------------ |
| `url`      | Must be string, non‑empty, contain `sfile.co` or `sfile.mobi`, valid http(s) URL | `VALIDATION_ERROR` |
| `saveDir`  | Must be non‑empty string                                                         | `VALIDATION_ERROR` |
| `options`  | Must be object or undefined; numeric/boolean/string fields type‑checked          | `VALIDATION_ERROR` |
| `filename` | Sanitized: removes `../`, invalid chars, truncates to 255 chars                  | Auto‑fixed         |

---

## Environment Overrides (Optional)

You can set defaults via environment variables (parsed at runtime):

```bash
export SFILEDL_HEADLESS=false
export SFILEDL_TIMEOUT=120000
export SFILEDL_DEBUG=true
```

> Programmatic options always override env vars.

---

## Next Steps

→ [Example Usage](./example-usage.md)  
→ [API Reference (README)](../README.md#api-reference)
