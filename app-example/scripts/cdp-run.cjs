// Drive headless Chrome over the DevTools Protocol (no npm deps; Node 24 has a
// global WebSocket) to open the worker test page and stream its console.
// Exits when it sees the WARM line or times out.
const { spawn } = require('child_process');
const http = require('http');

const URL = process.argv[2] || 'http://localhost:5173/worker-test.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222;
const DEADLINE_MS = 200000;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-prof-leanworker',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  // wait for the browser endpoint
  let ver;
  for (let i = 0; i < 50; i++) { try { ver = await getJSON('/json/version'); break; } catch { await sleep(200); } }
  if (!ver) { console.error('chrome did not start'); chrome.kill(); process.exit(1); }

  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params, sessionId) => { bws.send(JSON.stringify({ id: ++id, method, params: params || {}, sessionId })); };

  const t0 = Date.now();
  let done = false;
  const finish = (code) => { if (done) return; done = true; try { bws.close(); } catch {} chrome.kill(); process.exit(code); };

  bws.onopen = () => send('Target.createTarget', { url: URL });
  bws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && m.result && m.result.targetId && !m._a) {
      send('Target.attachToTarget', { targetId: m.result.targetId, flatten: true });
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Log.enable', {}, sid);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || '')).join(' ');
      console.log(text);
      if (/WARM re-elaborate/.test(text)) { console.log('\n=== WARM result captured; success ==='); setTimeout(() => finish(0), 500); }
      return;
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry; console.log(`[browser:${e.level}] ${e.text}`.slice(0, 300));
    }
  };
  bws.onerror = (e) => { console.error('ws error', e.message || e); };
  bws.onclose = () => { console.error('[browser ws closed]'); };
  process.on('uncaughtException', (e) => { console.error('[driver exception]', e && (e.stack || e.message || e)); });

  setTimeout(() => { console.log(`\n=== timeout after ${DEADLINE_MS / 1000}s ===`); finish(2); }, DEADLINE_MS);
})();
