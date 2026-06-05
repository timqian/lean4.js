export interface Lean4Options {
  /**
   * Base URL to load `lean.js`, `lean.wasm` and `lean-lib.tar.gz` from.
   * Defaults to the public CDN.
   */
  basePath?: string
  /** Called with human-readable progress messages during {@link Lean4.init}. */
  onProgress?: ((message: string) => void) | null
  /** Per-run timeout in milliseconds. Defaults to 120000. */
  timeout?: number
}

export interface RunOptions {
  /** Command-line flags passed to Lean. Defaults to `['--json']`. */
  flags?: string[]
}

export interface RunResult {
  /** Captured stdout, trailing whitespace trimmed. */
  stdout: string
  /** Captured stderr, trailing whitespace trimmed. */
  stderr: string
  /** Process exit code (0 on success). */
  exitCode: number
}

/**
 * Run Lean 4 in the browser via WebAssembly.
 *
 * Requires the page to be served with COOP/COEP headers so that
 * `SharedArrayBuffer` is available.
 */
export class Lean4 {
  constructor(options?: Lean4Options)

  /**
   * Download and cache the Lean library bundle and WASM module.
   * Must be called (and awaited) before {@link run}.
   */
  init(): Promise<void>

  /** Run Lean 4 `code` and resolve with the result. */
  run(code: string, options?: RunOptions): Promise<RunResult>

  /** Release the iframe, blob URLs and cached library files. */
  dispose(): void
}
