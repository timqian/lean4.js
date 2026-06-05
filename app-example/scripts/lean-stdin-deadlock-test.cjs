// Decisive test for architecture (a): with a BLOCKING SharedArrayBuffer stdin,
// does `lean --worker` flush publishDiagnostics for an already-sent didOpen while
// main() is blocked waiting (Atomics.wait) for the next message?
//
//   - diagnostics at ~65s (BEFORE the t=90s feed)  => no deadlock, NO rebuild needed
//   - diagnostics only at ~90s (when the feed unblocks main) => deadlock => need
//     -sPROXY_TO_PTHREAD (or ASYNCIFY) rebuild
//
// Lean runs on the (node) main thread; a worker_thread feeder shares the SAB and
// injects a didChange on a timer. Run: node scripts/lean-stdin-deadlock-test.cjs
const { Worker, isMainThread, workerData } = require('worker_threads');
const path = require('path');

// ---- shared SAB layout: control Int32[ready,len,eof] + data bytes ----
const CAP = 1 << 16;
function mkViews(sab) { return { control: new Int32Array(sab, 0, 4), data: new Uint8Array(sab, 16, CAP) }; }
function frame(obj) { const j = JSON.stringify(obj); return Buffer.from(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`, 'utf8'); }
const uri = 'file:///doc1.lean';

if (!isMainThread) {
  // ---- feeder thread: inject didChange messages on a timer ----
  const { control, data } = mkViews(workerData.sab);
  const send = (buf) => {
    while (Atomics.load(control, 0) !== 0) { /* wait for reader to consume */ }
    data.set(buf, 0); control[1] = buf.length; Atomics.store(control, 0, 1); Atomics.notify(control, 0);
  };
  setTimeout(() => send(frame({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '#check 2 + 2\n#check 3 + 3\n' }] } })), 90000);
  setTimeout(() => send(frame({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: '#check 2 + 2\n#check 3 + 3\n#check Nat.succ\n' }] } })), 130000);
  setTimeout(() => { while (Atomics.load(control, 0) !== 0) {} control[2] = 1; control[1] = 0; Atomics.store(control, 0, 1); Atomics.notify(control, 0); }, 165000);
  return;
}

// ---- main thread: run lean --worker with blocking SAB stdin ----
const LEAN_DIR = path.join(__dirname, '..', 'public', 'lean-wasm');
const LIB = path.join(LEAN_DIR, 'lean-4.28.0-pre-linux_wasm32', 'lib', 'lean');
const LEAN_CJS = path.join(LEAN_DIR, 'lean.cjs');

const sab = new SharedArrayBuffer(16 + CAP);
const { control, data } = mkViews(sab);
console.error('[dbg] __filename =', __filename, '| cwd =', process.cwd());
const SELF = path.resolve(__filename);
new Worker(SELF, { workerData: { sab } });

const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(2);

// stdin: initialize + didOpen buffered; then block on SAB for more
let local = Buffer.concat([
  frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } }),
  frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'lean', version: 1, text: '#check 2 + 2\n' } } }),
]);
let pos = 0, eof = false;

const M = {
  // PROXY_TO_PTHREAD build: let Emscripten auto-run main (it proxies to a pthread,
  // leaving this host thread free to drive the scheduler + flush proxied stdout).
  arguments: ['--worker'],
  locateFile: (p) => path.join(LEAN_DIR, p),
  stdin: () => {
    if (eof) return null;
    if (pos >= local.length) {
      console.error(`[t=${ts()}s] stdin: blocking for next message...`);
      Atomics.wait(control, 0, 0);
      if (control[2] === 1) { eof = true; Atomics.store(control, 0, 0); Atomics.notify(control, 0); return null; }
      local = Buffer.from(data.subarray(0, control[1])); pos = 0;
      Atomics.store(control, 0, 0); Atomics.notify(control, 0);
      console.error(`[t=${ts()}s] stdin: got ${local.length} bytes, unblocked`);
    }
    return local[pos++];
  },
  print: (t) => { if (t.includes('publishDiagnostics')) { const m = t.match(/"version":(\d+)/); console.error(`[t=${ts()}s] >>> publishDiagnostics${m ? ' v' + m[1] : ''}`); } },
  printErr: () => {},
  preRun: [function () {
    const FS = M.FS;
    const NODEFS = (M.NODEFS) || (FS.filesystems && FS.filesystems.NODEFS);
    const mkdirp = (p) => { let c = ''; for (const s of p.split('/').filter(Boolean)) { c += '/' + s; try { FS.mkdir(c); } catch (e) {} } };
    mkdirp('/lib/lean'); FS.mount(NODEFS, { root: LIB }, '/lib/lean');
    M.ENV['LEAN_PATH'] = '/lib/lean'; M.ENV['TZ'] = 'UTC';
    mkdirp(process.cwd()); mkdirp(LEAN_DIR); mkdirp('/workspace'); mkdirp('/etc');
    try { FS.writeFile('/etc/localtime', new Uint8Array(0)); } catch (e) {}
    try { FS.chdir('/workspace'); } catch (e) {}
    const chk = (p) => { try { FS.stat(p); return 'OK'; } catch (e) { return 'ENOENT(' + e.errno + ')'; } };
    console.error(`[preRun host] cwd=${process.cwd()} -> ${chk(process.cwd())}`);
    console.error(`[preRun host] LEAN_DIR=${LEAN_DIR} -> ${chk(LEAN_DIR)}`);
    console.error(`[preRun host] /lib/lean -> ${chk('/lib/lean')} | /workspace -> ${chk('/workspace')} | FS.cwd=${FS.cwd()}`);
  }],
  onRuntimeInitialized: function () {
    console.error(`[t=${ts()}s] runtime initialized; main proxied to pthread, host thread free`);
  },
  onExit: function (code) {
    console.error(`[t=${ts()}s] main() returned (exit ${code})`);
    process.exit(typeof code === 'number' ? code : 0);
  },
};
globalThis.LEAN_MODULE = M;
require(LEAN_CJS);
