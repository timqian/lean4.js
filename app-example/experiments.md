# Lean 4 WASM — Performance Experiments & Findings

Investigation into why running Lean code in the browser is slow (~50–66s for even
`#check 2+2`) and what architecture fixes it. All measurements were taken by
running the real `lean.wasm` build under **Node** (no browser) via a custom
harness ([scripts/lean-node-harness.cjs](scripts/lean-node-harness.cjs)) that
mounts the oleans through NODEFS.

Build under test: `lean-4.28.0-pre, wasm32-unknown-emscripten` (a debug build with
`[DEBUG:*]` prints baked in). `lean.js` ≈ 89 MB, `lean.wasm` ≈ 137 MB.

## TL;DR

- The per-run cost is **100% the one-time `import Init`**, not elaboration.
- `import Init` ≈ **63s**, split **~16s deserialize olean regions + ~47s
  `finalizeImport`** (rebuild constant maps / replay extension state /
  initializers). Elaboration of user code is **~0ms**.
- Shrinking the olean bundle does **not** help run time (simple code only ever
  imports Init either way). It only helps download size.
- "Compiling oleans into the wasm" does **not** help: embedding the *files* skips
  at most the ~16s; the ~47s finalize is recomputation that happens regardless.
  Only a full memory-image snapshot (wizer-style) would skip it — at a 100s-of-MB
  binary-size cost.
- **Fix: a warm `lean --worker` process** — pay the ~63s import once, then every
  edit/run is a `didChange` → near-instant.

## Measurements

### Cold start is cheap; import is the wall
| run | time |
|---|---|
| `lean --version` | 0.19s |
| `#check 2+2` (`--json`, batch) | 66s |

### Elaboration is effectively free (warm-env proof)
Same imported environment, N commands in one process:
| input | total | elaborations |
|---|---|---|
| 1 command | 66.2s | 1 |
| **500 commands** | **63.6s** | 500 |

500 elaborations cost the same as 1 ⇒ per-command elaboration ≈ 0ms; the whole
time is the one-time import.

### Where the 63s import goes (timestamped `[DEBUG:*]` timeline)
| phase | window | duration |
|---|---|---|
| wasm compile + startup | 0 → 3.4s | ~3.4s |
| `importModulesCore` (read + deserialize olean regions) | 3.4 → 19.3s | **~16s** |
| `finalizeImport` (constant maps + extension replay + initializers) | 19.3 → 66.5s | **~47s** |
| elaborate `#check 2+2` | 66.5s | ~0s |

`finalizeImport` is the dominant cost. In `Lean/Environment.lean` it is
Emscripten-special-cased (IR files omitted) and loops over every module × every
constant to build `HashMap`s, then replays env-extension entries / runs
initializers. ~16s to deserialize 66MB also shows **mmap is not effective in
wasm** (native import is <1s); but fixing mmap would only address the 16s.

## Bundle size (uncompressed olean by top module)
| module | files | size | needed when running `lean file.lean` |
|---|---|---|---|
| Init | 577 | ~68 MB | always (implicit prelude) |
| Lean | 1117 | ~90 MB | only if user code `import Lean` (metaprogramming) |
| Std | 470 | ~73 MB | only if user code `import Std` |
| Lake | 168 | ~13 MB | basically never (build tool) |

`closure(Init)` = essentially all of Init, so Init is both the floor and exactly
what every run loads. The slim bundle = Init only (`lean-lib.tar.gz`: 94 MB → 27 MB).

## Architecture decision

### `lean --server` does NOT work in wasm
`--server` is a **watchdog** that `fork`s a `lean --worker` per file. wasm has no
`fork`/`exec`, so the watchdog can't run. (It also needs `/etc/localtime`; set
`TZ=UTC` + stub the file.)

### `lean --worker` DOES work in wasm — this is the unit to run
- Boots and speaks LSP. Handshake for direct (no-watchdog) use:
  `initialize` → **`textDocument/didOpen`** (NO `initialized` notification — the
  watchdog normally absorbs it) → `didChange` …
- Elaboration is dispatched to **pthreads**; diagnostics come back async via
  `textDocument/publishDiagnostics`.
- The build is **pthread + SharedArrayBuffer enabled** (`Atomics.wait`,
  `spawnThread`, `worker_threads`).

#### ⛔ BLOCKER: this build is NOT `PROXY_TO_PTHREAD` — warm worker can't run on it
`main()` runs on the thread that starts it (no `_emscripten_proxy_main`). Tested
directly ([scripts/lean-stdin-deadlock-test.cjs](scripts/lean-stdin-deadlock-test.cjs)):
run `lean --worker`, feed `initialize`+`didOpen`, then **block** stdin on a SAB
(`Atomics.wait`) and inject `didChange` only at t=90s.

Result — **zero progress while stdin is blocked**:
```
[t=3.15s] stdin: blocking for next message...   ← right after didOpen
(no IMPORT / GO / FINALIZE markers, no publishDiagnostics, for 87s)
[t=90.17s] stdin: got 199 bytes, unblocked      ← didChange injected
[t=130.17s] ...                                  ← still no diagnostics
[t=165.20s] main() returned
```
The ~64s import never even starts. **The LSP read-loop and the elaboration
scheduler share one thread; blocking stdin starves all work.** So a persistent,
warm `--worker` (which requires non-exiting stdin) is impossible on this binary.

**Required fix: rebuild `lean.wasm`** with one of:
1. **`-sPROXY_TO_PTHREAD`** (preferred) — `main` on its own pthread; the worker's
   host thread stays free to drive the scheduler and flush proxied I/O, so stdin
   can block on the main-pthread via `Atomics.wait`.
2. **`-sASYNCIFY`** — stdin read yields instead of blocking (larger/slower binary).

Note: this `lean.wasm` is a **custom debug build** (has `[DEBUG:*]` prints). Before
rebuilding ourselves, check how lean4web / live.lean-lang.org build theirs — a
suitable prebuilt may already exist.

→ (a) is **blocked on a wasm rebuild**. The batch model on the current binary
always pays the full ~63s import per run; there is no warm path without rebuilding.

#### Rebuild in progress
Build pipeline: `timqian/lean4` fork, CI `.github/workflows/ci.yml` "Web Assembly"
matrix job (Emscripten toolchain; note CI uses `MMAP=OFF` → the ~16s no-mmap
deserialize, and `src/CMakeLists.txt:141` sets `-sALLOW_MEMORY_GROWTH=0` → fixed
heap / OOM risk). Emscripten link flags for the `lean` exe are at
`src/CMakeLists.txt:703`.

Change made on branch **`proxy-to-pthread`** (commit `e2ba1a3`):
`-sPTHREAD_POOL_SIZE=4` → `-sPTHREAD_POOL_SIZE=8 -sPROXY_TO_PTHREAD=1`.

CI triggers only on push-to-`master` / tags / **PRs** — so building requires
opening a PR for that branch (fires the full matrix, ~90 min wasm job). Risks to
watch in the build: PROXY_TO_PTHREAD interacting with `MAIN_MODULE=1`; fixed heap
size. Fallback if it fails: `-sASYNCIFY` instead.

Post-build JS work (once the new wasm lands):
- The batch path (`callMain`/`ccall('main')`) changes under PROXY_TO_PTHREAD (main
  is proxied to a pthread) — the existing iframe/batch flow + the node harness need
  to start main via the normal Emscripten run, not a direct `ccall`.
- Then build the real worker: Web Worker hosting `lean.wasm`, blocking SAB stdin
  (`Atomics.wait`), JS watchdog speaking minimal LSP (`initialize`→`didOpen`→
  `didChange`), parse `publishDiagnostics`. Re-run the deadlock test first to
  confirm diagnostics now flush while stdin blocks.

### PROXY_TO_PTHREAD build tested in-browser (headless Chrome via CDP) — NEW FINDINGS
Built `timqian/lean4` branch `proxy-to-pthread`; `--version` runs in-browser. Drove
the worker test ([public/worker-test.html](public/worker-test.html) +
[public/lean-worker-test.js](public/lean-worker-test.js)) via
[scripts/cdp-run.cjs](scripts/cdp-run.cjs) (headless Chrome, no extra deps).

Pitfalls found & fixed along the way:
- Wrapper-worker + `importScripts(lean.js)` ⇒ pthreads spawn from `_scriptName`
  (the wrapper) and never bootstrap. Fix: `Module.mainScriptUrlOrBlob = lean.js`.
- Dev server sends `Content-Encoding: gzip`, so the page already gets the raw tar;
  only gunzip if the gzip magic (`1f 8b`) is present.
- Fork browser-mode (`src/util/shell.cpp`, an `EM_ASM` inside `lean_main`) defaults
  `LEAN_PATH=/lib/lean/library`, `mkdir`s `/bin`, `/lib/lean/library`.

**The wall (definitive):** with PROXY_TO_PTHREAD, `main` runs on pthread P and gets
into `lean_shell_main` (the `--worker` LSP loop), then **hangs**.
- `[DEBUG:B] Init.olean not found` is a **false alarm** — that check is `EM_ASM` JS
  reading P's *local* `FS` object; real C-level olean reads proxy to the launcher
  thread W (where our `preRun` wrote them), so the import could actually read them.
- Root cause of the hang: **stdin reads from P proxy back to W**, and our blocking
  `Atomics.wait` SAB reader runs *on W* → W can no longer service P's proxied
  syscalls → the import never runs. PROXY_TO_PTHREAD just relocated the same
  single-thread starvation onto the stdin-proxy path. A SAB stdin only works if the
  blocking read happens **on P**, not proxied to W — which the wrapper/Module.stdin
  approach can't do.

**Key discovery — the fork already has the right interface, but it isn't compiled.**
`src/shell/lean_js.cpp` exposes a *synchronous function-call* API:
`initialize_emscripten()` (warm `emscripten_shell` with a **single-threaded
`st_task_queue`**) + `emscripten_process_request(ptr)`. This is the intended browser
model: no stdin, no pthread proxying, elaboration runs synchronously on the calling
thread → no deadlock (likely doesn't even need PROXY_TO_PTHREAD). But
`src/shell/CMakeLists.txt` only builds `lean.cpp` (`leanmain`); `lean_js.cpp` is NOT
compiled, so `_emscripten_process_request` / `_initialize_emscripten` are absent
from the wasm.

**Recommended path:** compile+link `lean_js.cpp` into the emscripten build and use
the function-call API (`EXPORT_ALL=1` is already set, so linking it should export
it). Drive it: load wasm with `noInitialRun`, write Init oleans to FS (same thread,
no proxy issue), `_initialize_emscripten()` once (warm), then
`_emscripten_process_request(jsonPtr)` per request. Open question to resolve: how
the `server` reports diagnostics back through that API (it currently has no stdout
notification sink wired) — may need a small fork tweak to return/emit them.

### Target architecture (a)
- One persistent `lean --worker` in a **Web Worker** (COOP/COEP already set ⇒ SAB
  available).
- **JS plays the watchdog**: routes LSP over a SAB ring buffer; the worker's stdin
  read **blocks on `Atomics.wait`** so the process doesn't exit between messages.
- **One document**: `didOpen` once → pay the ~63s Init import a single time; every
  Run/edit is a `didChange` → instant. Diagnostics via `publishDiagnostics`.
- **Bundle**: Init + the `.olean.server` files (hover/goals). No `Lean.*` 90 MB.
- Bonus: real IDE features (hover types, goal view, live diagnostics), not just
  Run output.
- (Matches what lean4web / live.lean-lang.org do.)

This is why the **REPL-program** route was rejected: that program does
`import Lean` → drags in the 90 MB `Lean.*` (and OOM'd wasm32's 4 GB when also
re-importing Init).

## Harness notes (how to reproduce)
- `lean.js` is CommonJS but the repo is `type: module`; use a `.cjs` copy with the
  first `var Module=…` swapped to read `globalThis.LEAN_MODULE` so config can be
  injected.
- Under Node, Lean `chdir`s to the host cwd and derives a sysroot from the exe dir;
  create both paths in MEMFS so init doesn't abort. Set `LEAN_PATH=/lib/lean`.
- Run code: `LEAN_CODE='#check 2+2' node scripts/lean-node-harness.cjs --json /workspace/input.lean`
- Phase timing: prefix `TS=1` to timestamp every stdout/stderr line.

## Open follow-ups
- The ~47s `finalizeImport` is the real long-term target; only engine-level
  changes (serialize finalized maps, real mmap) or a wizer snapshot would cut it.
- `.sh` must include `.olean.server` in the browser bundle for `--worker` hover/goals.
