# lean4.js

Run Lean 4 in the browser via WebAssembly.

## Install

```bash
npm install lean4.js
```

## Usage

```js
import { Lean4 } from 'lean4.js'

const lean = new Lean4()
await lean.init()

const result = await lean.run('#eval 2 + 2')
console.log(result.stdout)   // "4"
console.log(result.exitCode) // 0

lean.dispose()
```

WASM assets are loaded from cloudflare R2 automatically. No extra setup needed.

> **Note:** Your page must be served with COOP/COEP headers for SharedArrayBuffer support. See [COOP/COEP setup](#coopcoep-headers) below.

## API

### `new Lean4(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `basePath` | `string` | cloudflare R2 | URL where WASM assets are served. Override for self-hosting |
| `onProgress` | `(msg: string) => void` | — | Progress callback during init |
| `timeout` | `number` | `120000` | Execution timeout in ms |

### `lean.init(): Promise<void>`

Downloads and caches the `.olean` library bundle. Must be called before `run()`. Uses IndexedDB to cache for subsequent visits.

### `lean.run(code, options?): Promise<RunResult>`

Runs Lean 4 code in an isolated iframe.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `flags` | `string[]` | `['--json']` | Lean CLI flags |

Returns `{ stdout: string, stderr: string, exitCode: number }`.

### `lean.dispose(): void`

Cleans up resources.

## COOP/COEP Headers

SharedArrayBuffer requires these server headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Vite

```ts
import { lean4Plugin } from 'lean4.js/vite'

export default defineConfig({
  plugins: [lean4Plugin()],
})
```

### Other frameworks

Add headers in your server/hosting config (Nginx, Vercel, Netlify, etc.).

## Self-hosting WASM assets

If you prefer not to use the CDN:

```bash
npx lean4-wasm-copy public/lean4-wasm
```

```js
const lean = new Lean4({ basePath: '/lean4-wasm' })
```

## License

MIT

## Thanks
