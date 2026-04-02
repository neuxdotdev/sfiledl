# Installation

> Get `sfiledl` up and running in minutes.

---

## Prerequisites

| Requirement    | Version    | Notes                              |
| -------------- | ---------- | ---------------------------------- |
| **Node.js**    | `>=24`     | LTS recommended                    |
| **Bun**        | `>=1.3`    | Optional but recommended for speed |
| **Playwright** | `chromium` | Browser engine for automation      |

---

## Install Package

### Using Bun (Recommended)

```bash
bun add sfiledl
```

### Using npm

```bash
npm install sfiledl
```

### Using yarn

```bash
yarn add sfiledl
```

### Using pnpm

```bash
pnpm add sfiledl
```

---

## Install Playwright Browser

`sfiledl` uses Playwright for browser automation. You must install the Chromium browser:

```bash
# With Bun
bunx playwright install chromium

# With npm/npx
npx playwright install chromium

# With yarn
yarn playwright install chromium

# With pnpm
pnpm exec playwright install chromium
```

> **Tip:** For CI/CD environments, consider installing system dependencies:
>
> ```bash
> npx playwright install-deps chromium
> ```

---

## Verify Installation

```typescript
import { downloadSfile } from 'sfiledl'

console.log('sfiledl version:', await import('sfiledl').then((m) => m?.VERSION || 'unknown'))
```

---

## Troubleshooting

### Playwright browser not found

```bash
# Reinstall Chromium
npx playwright install chromium --force
```

### Permission errors on Linux

```bash
# Install system dependencies
npx playwright install-deps
```

### Headless mode fails in Docker

Ensure your container has:

- `libgbm1`, `libx11-xcb1`, `libxcomposite1`, `libxcursor1`, `libxdamage1`, `libxext6`, `libxi6`, `libxtst6`
- Or use the official Playwright Docker image

### Slow downloads or timeouts

Increase timeout values in `DownloadOptions`:

```typescript
{
  timeout: 120000,           // 2 minutes
  downloadButtonTimeout: 60000
}
```

---

## Next Steps

→ [Configuration Guide](./config.md)  
→ [Example Usage](./example-usage.md)
