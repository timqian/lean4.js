// Spike: does `lean --server` (LSP) work under wasm, and does it hold the
// imported environment warm across edits?
//
// Emscripten stdin is a synchronous callback, so we pre-load a full LSP session
// into a byte queue; the whole server run then executes synchronously inside
// main(). We timestamp each `publishDiagnostics` on stdout to separate the
// one-time import cost from warm re-elaboration.
//
//   node scripts/lean-server-spike.cjs
const path = require('path');

const LEAN_DIR = path.join(__dirname, '..', 'public', 'lean-wasm');
const LIB = path.join(LEAN_DIR, 'lean-4.28.0-pre-linux_wasm32', 'lib', 'lean');
const LEAN_CJS = path.join(LEAN_DIR, 'lean.cjs');

// ---- Build the LSP session (JSON-RPC framed with Content-Length) ----
function frame(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}
const uri = 'file:///doc1.lean';
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } },
  { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'lean', version: 1, text: '#check 2 + 2\n' } } },
  // edit the SAME document -> should reuse the warm import
  { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '#check 2 + 2\n#check 3 + 3\n' }] } },
  { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: '#check 2 + 2\n#check 3 + 3\n#check Nat.succ\n' }] } },
];
const stdinBytes = Buffer.from(messages.map(frame).join(''), 'utf8');
let stdinPos = 0;

let t0 = 0;
let stdoutBuf = '';
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2);

const M = {
  noInitialRun: true,
  locateFile: (p) => path.join(LEAN_DIR, p),
  // stdin: synchronous byte dispenser; null == EOF
  stdin: () => (stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : null),
  print: (t) => {
    stdoutBuf += t + '\n';
    if (t.includes('publishDiagnostics')) {
      // pull the version out if present
      const m = t.match(/"version":(\d+)/);
      console.error(`[server] publishDiagnostics${m ? ' v' + m[1] : ''} @ ${stamp()}s`);
    }
  },
  printErr: (t) => { if (process.env.VERBOSE) console.error('[stderr]', t); },
  preRun: [function () {
    const FS = M.FS;
    const NODEFS = (M.NODEFS) || (FS.filesystems && FS.filesystems.NODEFS);
    const mkdirp = (p) => { let c = ''; for (const s of p.split('/').filter(Boolean)) { c += '/' + s; try { FS.mkdir(c); } catch (e) {} } };
    mkdirp('/lib/lean');
    FS.mount(NODEFS, { root: LIB }, '/lib/lean');
    M.ENV['LEAN_PATH'] = '/lib/lean';
    M.ENV['TZ'] = 'UTC';
    mkdirp(process.cwd());
    mkdirp(LEAN_DIR);
    mkdirp('/workspace');
    mkdirp('/etc');
    try { FS.writeFile('/etc/localtime', new Uint8Array(0)); } catch (e) {}
    try { FS.chdir('/workspace'); } catch (e) {}
  }],
  onRuntimeInitialized: function () {
    const args = ['--worker'];
    const full = ['lean'].concat(args);
    const argc = full.length;
    const ptrs = full.map((a) => M.stringToNewUTF8(a));
    const argv = M._malloc(4 * (argc + 1));
    for (let i = 0; i < argc; i++) M.setValue(argv + i * 4, ptrs[i], 'i32');
    M.setValue(argv + argc * 4, 0, 'i32');
    t0 = Date.now();
    console.error('[server] starting lean --server, feeding', messages.length, 'LSP messages');
    let exitCode = 0;
    try {
      M.ccall('main', 'number', ['number', 'number'], [argc, argv]);
    } catch (e) {
      if (e && (e.name === 'ExitStatus' || typeof e.status === 'number')) exitCode = e.status || 0;
      else { console.error('[server] error:', e && (e.stack || e.message || e)); exitCode = 1; }
    }
    console.error(`[server] main() returned in ${stamp()}s, exit=${exitCode}`);
    console.error('[server] total stdout bytes:', stdoutBuf.length);
    process.exit(exitCode);
  },
};

globalThis.LEAN_MODULE = M;
require(LEAN_CJS);
