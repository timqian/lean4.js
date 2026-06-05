// Node harness to run the Lean wasm build locally (no browser).
// Mounts the real olean dir via NODEFS so Lean can import from disk.
//
// Usage:
//   node scripts/lean-node-harness.cjs --version
//   LEAN_CODE='#check 2+2' node scripts/lean-node-harness.cjs --json input.lean
const path = require('path');

const LEAN_DIR = path.join(__dirname, '..', 'public', 'lean-wasm');
const LIB = path.join(LEAN_DIR, 'lean-4.28.0-pre-linux_wasm32', 'lib', 'lean');
const LEAN_CJS = path.join(LEAN_DIR, 'lean.cjs');

const args = process.argv.slice(2);
const code = process.env.LEAN_FILE
  ? require('fs').readFileSync(process.env.LEAN_FILE, 'utf8')
  : (process.env.LEAN_CODE || '');
const codePath = '/workspace/input.lean';
let exitCode = 0;

const T_START = Date.now();
const ts = () => ((Date.now() - T_START) / 1000).toFixed(2);
const M = {
  noInitialRun: true,
  locateFile: (p) => path.join(LEAN_DIR, p),
  print: (t) => console.log(process.env.TS ? `[+${ts()}s] ${t}` : t),
  printErr: (t) => console.error(process.env.TS ? `[+${ts()}s] ${t}` : t),
  preRun: [function () {
    const FS = M.FS;
    const NODEFS = (M.NODEFS) || (FS.filesystems && FS.filesystems.NODEFS);
    const mkdirp = (p) => {
      let cur = '';
      for (const seg of p.split('/').filter(Boolean)) { cur += '/' + seg; try { FS.mkdir(cur); } catch (e) {} }
    };
    mkdirp('/lib/lean');
    FS.mount(NODEFS, { root: LIB }, '/lib/lean');
    M.ENV['LEAN_PATH'] = '/lib/lean';
    // Lean (under Node) chdir's to the host process cwd at startup; create it
    // in MEMFS so that doesn't abort.
    mkdirp(process.cwd());
    // Lean derives its sysroot from the (host) exe dir and stats it; make the
    // path exist in MEMFS so init_search_path() doesn't abort.
    mkdirp(LEAN_DIR);
    mkdirp('/workspace');
    if (code) FS.writeFile(codePath, code);
    try { FS.chdir('/workspace'); } catch (e) {}

    if (process.env.TRACE_FS) {
      for (const fn of ['open', 'stat', 'lstat', 'readlink', 'lookupPath', 'mmap', 'readdir', 'chdir', 'readFile']) {
        if (typeof FS[fn] !== 'function') continue;
        const orig = FS[fn].bind(FS);
        FS[fn] = function (...a) {
          try { return orig(...a); }
          catch (e) { console.error(`[FS.${fn} FAIL]`, JSON.stringify(a[0]), 'errno=' + e.errno); throw e; }
        };
      }
    }
  }],
  onRuntimeInitialized: function () {
    const full = ['lean'].concat(args);
    const argc = full.length;
    const ptrs = full.map((a) => M.stringToNewUTF8(a));
    const ptrSize = 4;
    const argv = M._malloc(ptrSize * (argc + 1));
    for (let i = 0; i < argc; i++) M.setValue(argv + i * ptrSize, ptrs[i], 'i32');
    M.setValue(argv + argc * ptrSize, 0, 'i32');

    const t0 = Date.now();
    try {
      M.ccall('main', 'number', ['number', 'number'], [argc, argv]);
    } catch (e) {
      if (e && (e.name === 'ExitStatus' || typeof e.status === 'number')) exitCode = e.status || 0;
      else { console.error('[harness] error:', e); exitCode = 1; }
    }
    console.error(`[harness] main() done in ${((Date.now() - t0) / 1000).toFixed(2)}s, exit=${exitCode}`);
    process.exit(exitCode);
  },
};

globalThis.LEAN_MODULE = M;
require(LEAN_CJS);
