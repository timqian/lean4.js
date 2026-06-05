# lean4.js

Run Lean 4 in the browser via WebAssembly.

<sub>This project is mainly based on <a href="https://github.com/cauli">@cauli</a>'s work to compile Lean 4 to WASM: <a href="https://github.com/cauli/lean4">cauli/lean4</a>, with a web playground reference from <a href="https://github.com/cauli/lean4-wasm-in-browser">cauli/lean4-wasm-in-browser</a>.</sub>


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

## What This Project Contributes

1. Reduced unnecessary `.olean` artifacts in `lean-lib` (for example, private artifacts such as `olean.private`), bringing the `lean-lib` size down to about 90+ MB and the full bundle to about 300+ MB. This is acceptable for now, and there is still room for further size optimization.
2. Published `lean4.js` to npm for easier integration and reuse.
3. Deployed a web playground so people can try it directly in the browser.

## Current Limits and Future Work

1. Even running a minimal Lean file still takes close to 1 minute, which is hard to use in production today.
2. We tried to support `--server`/`--worker` mode in the browser, but this attempt failed. If startup can be paid only once (instead of per run), the project would become much more practical.

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
