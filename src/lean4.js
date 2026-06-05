/**
 * Lean 4 WASM — standalone browser SDK
 *
 * Usage:
 *   import { Lean4 } from 'lean4.js'
 *   const lean = new Lean4()
 *   await lean.init()
 *   const result = await lean.run('#eval 2 + 2')
 *   console.log(result.stdout) // "4"
 *   lean.dispose()
 *
 * Requirements:
 *   - Page must be served with COOP/COEP headers for SharedArrayBuffer
 */

import { gunzipSync } from 'fflate'

const VERSION = '0.0.0'
const CDN_BASE = `https://lean4-wasm.timqian.com/v${VERSION}`
const DEFAULT_LEAN_JS_URL = `${CDN_BASE}/lean.js`
const DEFAULT_LEAN_WASM_URL = `${CDN_BASE}/lean.wasm`
const DEFAULT_LEAN_LIB_URL = `${CDN_BASE}/lean-lib.tar.gz`

// ---- Tar parser ----

function parseTar(data) {
  const files = new Map()
  let offset = 0
  const decoder = new TextDecoder()

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break

    const nameRaw = header.subarray(0, 100)
    const nameEnd = nameRaw.indexOf(0)
    let name = decoder.decode(nameRaw.subarray(0, nameEnd > 0 ? nameEnd : 100))

    const prefixRaw = header.subarray(345, 500)
    const prefixEnd = prefixRaw.indexOf(0)
    const prefix = decoder.decode(prefixRaw.subarray(0, prefixEnd > 0 ? prefixEnd : 0))
    if (prefix) name = prefix + '/' + name
    if (name.startsWith('./')) name = name.substring(2)

    const sizeStr = decoder.decode(header.subarray(124, 136)).replace(/\0/g, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeFlag = header[156]

    offset += 512

    if ((typeFlag === 0x30 || typeFlag === 0) && size > 0 && name) {
      files.set(name, data.slice(offset, offset + size))
    }

    offset += Math.ceil(size / 512) * 512
  }

  return files
}

// ---- IndexedDB cache ----

const DB_NAME = 'lean-lib-cache'
const DB_VERSION = 1
const STORE_NAME = 'files'
// Bind the cache key to VERSION so a new bundle invalidates the old cache
// instead of users being stuck on a stale download.
const CACHE_KEY = `lean-lib-${VERSION}`

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getCached() {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(CACHE_KEY)
      req.onsuccess = () => {
        db.close()
        if (!req.result) { resolve(null); return }
        const entries = req.result
        const map = new Map()
        for (const [name, buf] of entries) map.set(name, new Uint8Array(buf))
        resolve(map)
      }
      req.onerror = () => { db.close(); resolve(null) }
    })
  } catch { return null }
}

async function setCache(files) {
  try {
    const db = await openDB()
    const entries = []
    files.forEach((data, name) => {
      entries.push([name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)])
    })
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      // Drop any older-version bundles so the cache holds only the current one
      store.clear()
      store.put(entries, CACHE_KEY)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
    })
  } catch { /* non-fatal */ }
}

// ---- Iframe HTML (inlined) ----

function makeIframeHTML(leanJsUrl, leanWasmUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>
var pendingConfig = null;
var libraryFiles = [];

function mkdirp(FS, path) {
  var parts = path.split("/").filter(function(p){return p});
  var current = "";
  for (var i = 0; i < parts.length; i++) {
    current += "/" + parts[i];
    try { FS.mkdir(current); } catch(e) {}
  }
}

function runMain(args) {
  if (typeof Module.callMain === 'function') return Module.callMain(args);
  var fullArgs = ["lean"].concat(args);
  var argc = fullArgs.length;
  var argPtrs = fullArgs.map(function(arg) {
    return Module.stringToNewUTF8 ? Module.stringToNewUTF8(arg) : Module.allocateUTF8(arg);
  });
  var ptrSize = 4;
  var argvPtr = Module._malloc(ptrSize * (argc + 1));
  for (var i = 0; i < argc; i++) Module.setValue(argvPtr + i * ptrSize, argPtrs[i], "i32");
  Module.setValue(argvPtr + argc * ptrSize, 0, "i32");
  return Module.ccall("main", "number", ["number", "number"], [argc, argvPtr]);
}

window.addEventListener("message", function(event) {
  var msg = event.data || {};
  if (msg.type === "configure") pendingConfig = msg;
  if (msg.type === "load_library") {
    libraryFiles = msg.files || [];
    parent.postMessage({ type: "library_received" }, "*");
  }
  if (msg.type === "start") startLean();
});

function startLean() {
  if (!pendingConfig) { parent.postMessage({type:"error",data:"No configuration received"},"*"); return; }
  var args = pendingConfig.args || [];
  var code = pendingConfig.code;
  var codePath = pendingConfig.path;
  var t0 = performance.now();
  function timing(label) {
    var elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    parent.postMessage({type:"timing",label:label,elapsed:elapsed},"*");
  }

  window.Module = {
    locateFile: function(path) { if (path.endsWith(".wasm")) return "${leanWasmUrl}"; return path; },
    print: function(text) { parent.postMessage({type:"stdout",data:text},"*"); },
    printErr: function(text) { parent.postMessage({type:"stderr",data:text},"*"); },
    setStatus: function(text) { if(text) parent.postMessage({type:"progress",data:text},"*"); },
    noInitialRun: true,
    preRun: [function() {
      timing("lean.js loaded + WASM compiled");
      var FS = Module.FS;
      var ENV = Module.ENV;
      ENV["LEAN_PATH"] = "/lib/lean";
      try{FS.mkdir("/lib")}catch(e){}
      try{FS.mkdir("/lib/lean")}catch(e){}
      try{FS.mkdir("/workspace")}catch(e){}

      if (libraryFiles.length > 0) {
        var dirs = new Set();
        for (var i = 0; i < libraryFiles.length; i++) {
          var fn = libraryFiles[i].name;
          if (fn.startsWith("./")) fn = fn.substring(2);
          var fp = "/lib/lean/" + fn;
          dirs.add(fp.substring(0, fp.lastIndexOf("/")));
          libraryFiles[i]._path = fp;
        }
        dirs.forEach(function(d) { mkdirp(FS, d); });
        for (var i = 0; i < libraryFiles.length; i++) {
          FS.writeFile(libraryFiles[i]._path, new Uint8Array(libraryFiles[i].data));
        }
      }
      timing("FS.writeFile x " + libraryFiles.length);

      if (code && codePath) {
        var codeDir = codePath.substring(0, codePath.lastIndexOf("/"));
        if (codeDir) mkdirp(FS, codeDir);
        FS.writeFile(codePath, typeof code === 'string' ? code : String(code));
      }
      try{FS.chdir("/workspace")}catch(e){}
    }],
    onRuntimeInitialized: function() {
      timing("runtime initialized");
      try {
        var exitCode = 0;
        var execStart = performance.now();
        try { runMain(args); } catch(e) {
          if (e && (e.constructor.name === "ExitStatus" || typeof e.status === "number")) {
            exitCode = e.status || 0;
          } else { throw e; }
        }
        var execElapsed = ((performance.now() - execStart) / 1000).toFixed(2);
        parent.postMessage({type:"timing",label:"==> lean main() [import + elaborate]",elapsed:execElapsed},"*");
        timing("lean execution done");
        parent.postMessage({type:"done",exitCode:exitCode},"*");
      } catch(e) {
        parent.postMessage({type:"stderr",data:"Error: "+(e.message||e)},"*");
        parent.postMessage({type:"done",exitCode:1},"*");
      }
    },
    onExit: function(){},
    onAbort: function(what) {
      parent.postMessage({type:"stderr",data:"Aborted: "+(what||"unknown")},"*");
      parent.postMessage({type:"done",exitCode:1},"*");
    }
  };

  var script = document.createElement("script");
  script.src = "${leanJsUrl}";
  script.crossOrigin = "anonymous";
  script.onerror = function() { parent.postMessage({type:"error",data:"Failed to load lean.js"},"*"); };
  document.body.appendChild(script);
}

parent.postMessage({ type: "iframe_ready" }, "*");
<\/script></body></html>`
}

// ---- Lean4 class ----

export class Lean4 {
  constructor(options = {}) {
    const base = options.basePath
    this.leanJsUrl = base ? `${base}/lean.js` : DEFAULT_LEAN_JS_URL
    this.leanWasmUrl = base ? `${base}/lean.wasm` : DEFAULT_LEAN_WASM_URL
    this.leanLibUrl = base ? `${base}/lean-lib.tar.gz` : DEFAULT_LEAN_LIB_URL
    this.onProgress = options.onProgress ?? null
    this.timeout = options.timeout ?? 120000
    this.libraryFiles = new Map()
    this.iframe = null
    this.initialized = false
    this.leanJsBlobUrl = null
    this.leanWasmBlobUrl = null
  }

  /**
   * Initialize: download and cache the .olean library bundle.
   * Must be called before run().
   */
  async init() {
    if (this.initialized) return

    // Check prerequisites
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer not available. Page must be served with COOP/COEP headers.')
    }

    // Try IndexedDB cache
    this.onProgress?.('Checking cache...')
    const cached = await getCached()
    if (cached && cached.size > 0) {
      this.libraryFiles = cached
      this.onProgress?.(`Loaded ${cached.size} files from cache`)
    }

    if (this.libraryFiles.size === 0) {
      // Download bundle
      const bundleUrl = this.leanLibUrl
      this.onProgress?.('Downloading library bundle...')

      const response = await fetch(bundleUrl)
      if (!response.ok) throw new Error(`Failed to download ${bundleUrl}: ${response.status}`)

      const contentLength = response.headers.get('Content-Length')
      const totalBytes = contentLength ? parseInt(contentLength) : 0

      let rawData
      if (totalBytes && response.body) {
        const reader = response.body.getReader()
        const chunks = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          const pct = Math.round((received / totalBytes) * 100)
          this.onProgress?.(`Downloading: ${(received / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB (${pct}%)`)
        }
        rawData = new Uint8Array(received)
        let pos = 0
        for (const chunk of chunks) { rawData.set(chunk, pos); pos += chunk.length }
      } else {
        rawData = new Uint8Array(await response.arrayBuffer())
      }

      // Decompress if still gzipped (browser may have already decompressed)
      this.onProgress?.('Decompressing...')
      let tarData
      if (rawData[0] === 0x1f && rawData[1] === 0x8b) {
        tarData = gunzipSync(rawData)
      } else {
        tarData = rawData
      }

      // Parse tar
      this.onProgress?.('Extracting files...')
      this.libraryFiles = parseTar(tarData)

      // Cache in IndexedDB
      this.onProgress?.('Caching for next time...')
      setCache(this.libraryFiles).catch(() => {})

      this.onProgress?.(`Ready (${this.libraryFiles.size} library files)`)
    }

    // Pre-fetch lean.js and lean.wasm as blob URLs to avoid CORS issues
    this.onProgress?.('Downloading lean.js and lean.wasm...')
    const [leanJsRes, leanWasmRes] = await Promise.all([
      fetch(this.leanJsUrl),
      fetch(this.leanWasmUrl),
    ])
    if (!leanJsRes.ok) throw new Error(`Failed to download lean.js: ${leanJsRes.status}`)
    if (!leanWasmRes.ok) throw new Error(`Failed to download lean.wasm: ${leanWasmRes.status}`)

    this.onProgress?.('Preparing WASM...')
    this.leanJsBlobUrl = URL.createObjectURL(await leanJsRes.blob())
    this.leanWasmBlobUrl = URL.createObjectURL(await leanWasmRes.blob())

    this.initialized = true
  }

  /**
   * Run Lean 4 code and return the result.
   */
  async run(code, options = {}) {
    if (!this.initialized) throw new Error('Call init() before run()')

    const flags = options.flags ?? ['--json']
    const codePath = '/workspace/input.lean'
    const args = [...flags, codePath]

    // Create fresh iframe
    const iframe = await this.createIframe()

    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error('Lean execution timeout'))
        }
      }, this.timeout)

      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener('message', handler)
        iframe.remove()
      }

      const handler = (event) => {
        if (event.source !== iframe.contentWindow) return
        const msg = event.data || {}

        if (msg.type === 'timing') {
          console.log(`[lean4 timing] ${msg.label}: ${msg.elapsed}s`)
        } else if (msg.type === 'library_received') {
          iframe.contentWindow?.postMessage({ type: 'start' }, '*')
        } else if (msg.type === 'stdout') {
          stdout += msg.data + '\n'
        } else if (msg.type === 'stderr') {
          stderr += msg.data + '\n'
        } else if (msg.type === 'done') {
          if (!settled) {
            settled = true
            cleanup()
            resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: msg.exitCode })
          }
        } else if (msg.type === 'error') {
          if (!settled) {
            settled = true
            cleanup()
            reject(new Error(msg.error || msg.data))
          }
        }
      }

      window.addEventListener('message', handler)

      // Send configuration
      iframe.contentWindow.postMessage({ type: 'configure', args, code, path: codePath }, '*')

      // Send library files with Transferable
      if (this.libraryFiles.size > 0) {
        const filesArray = []
        const transferList = []
        this.libraryFiles.forEach((data, name) => {
          const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          filesArray.push({ name, data: buf })
          transferList.push(buf)
        })
        iframe.contentWindow.postMessage({ type: 'load_library', files: filesArray }, '*', transferList)
      } else {
        iframe.contentWindow.postMessage({ type: 'start' }, '*')
      }
    })
  }

  /**
   * Clean up resources.
   */
  dispose() {
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = null
    }
    this.libraryFiles.clear()
    if (this.leanJsBlobUrl) { URL.revokeObjectURL(this.leanJsBlobUrl); this.leanJsBlobUrl = null }
    if (this.leanWasmBlobUrl) { URL.revokeObjectURL(this.leanWasmBlobUrl); this.leanWasmBlobUrl = null }
    this.initialized = false
  }

  // ---- Private ----

  createIframe() {
    return new Promise((resolve, reject) => {
      const html = makeIframeHTML(this.leanJsBlobUrl, this.leanWasmBlobUrl)

      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      // Use srcdoc to keep iframe same-origin (required for SharedArrayBuffer)
      iframe.srcdoc = html
      this.iframe = iframe

      const handler = (event) => {
        if (event.source !== iframe.contentWindow) return
        if (event.data?.type === 'iframe_ready') {
          window.removeEventListener('message', handler)
          resolve(iframe)
        }
      }
      window.addEventListener('message', handler)

      document.body.appendChild(iframe)

      setTimeout(() => {
        window.removeEventListener('message', handler)
        reject(new Error('Iframe initialization timeout'))
      }, 10000)
    })
  }
}
