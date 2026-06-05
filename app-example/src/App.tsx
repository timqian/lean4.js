import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Lean4 } from 'lean4.js'
import GitHubButton from 'react-github-btn'
import './App.css'

// Parsed Lean diagnostic message
interface LeanDiagnostic {
  severity: 'information' | 'warning' | 'error' | string
  data: string
  pos: { line: number; column: number }
  endPos: { line: number; column: number }
  fileName: string
  caption?: string
  kind?: string
}

// Parse JSON output lines from Lean
function parseLeanOutput(output: string): { diagnostics: LeanDiagnostic[]; rawLines: string[] } {
  const diagnostics: LeanDiagnostic[] = []
  const rawLines: string[] = []

  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed.pos && parsed.data !== undefined) {
        diagnostics.push(parsed as LeanDiagnostic)
      } else {
        rawLines.push(line)
      }
    } catch {
      rawLines.push(line)
    }
  }

  return { diagnostics, rawLines }
}

type Status = 'idle' | 'loading' | 'ready' | 'running' | 'error'

function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [output, setOutput] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [leanCode, setLeanCode] = useState<string>(`#check 2 + 2
#check Nat.add
def hello := "Hello, WASM!"
#check hello`)
  const [leanFlags, setLeanFlags] = useState<string>('--json')
  const [loadingProgress, setLoadingProgress] = useState<string>('')
  const outputRef = useRef<HTMLDivElement>(null)
  const leanRef = useRef<Lean4 | null>(null)

  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'

  // Initialize Lean4 instance
  const loadLean = useCallback(async () => {
    if (!hasSharedArrayBuffer) {
      setError('SharedArrayBuffer is not available. This page must be served with proper COOP/COEP headers.')
      setStatus('error')
      return
    }

    setStatus('loading')
    setOutput('')
    setError('')

    try {
      const lean = new Lean4({
        // basePath: '/lean-wasm',
        onProgress: (msg: string) => setLoadingProgress(msg),
      })
      await lean.init()
      leanRef.current = lean
      setLoadingProgress('Lean 4 WASM ready!')
      setStatus('ready')
    } catch (err) {
      console.error('Load error:', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
      setStatus('error')
    }
  }, [hasSharedArrayBuffer])

  // Run a Lean command and return result
  const runLeanCommand = useCallback(async (flags: string[]) => {
    const lean = leanRef.current
    if (!lean) {
      setError('Lean WASM not loaded yet')
      return
    }

    setStatus('running')
    setOutput('')
    setError('')
    setLoadingProgress('Running...')

    try {
      const result = await lean.run(leanCode, { flags })
      if (result.stdout) setOutput(result.stdout)
      // Only surface stderr when the run actually failed
      if (result.exitCode !== 0 && result.stderr) setError(result.stderr)
    } catch (err) {
      console.error('Error running code:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingProgress('')
      setStatus('ready')
    }
  }, [leanCode])

  // Test with --version
  const testVersion = useCallback(async () => {
    const lean = leanRef.current
    if (!lean) return
    setStatus('running')
    setOutput('')
    setError('')
    setLoadingProgress('Running...')
    try {
      const result = await lean.run('', { flags: ['--version'] })
      setOutput(result.stdout)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingProgress('')
      setStatus('ready')
    }
  }, [])

  // Test with --help
  const testHelp = useCallback(async () => {
    const lean = leanRef.current
    if (!lean) return
    setStatus('running')
    setOutput('')
    setError('')
    setLoadingProgress('Running...')
    try {
      const result = await lean.run('', { flags: ['--help'] })
      setOutput(result.stdout)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingProgress('')
      setStatus('ready')
    }
  }, [])

  // Run user's Lean code
  const runLean = useCallback(async () => {
    const flags = leanFlags.trim().split(/\s+/).filter(f => f.length > 0)
    await runLeanCommand(flags)
  }, [leanFlags, runLeanCommand])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      leanRef.current?.dispose()
    }
  }, [])

  // Parse output for display
  const parsedOutput = useMemo(() => {
    return parseLeanOutput(output)
  }, [output])

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output, error])

  return (
    <div className="app">
      <header className="header">
        <h1>
          Lean4.js
        </h1>
        <p className="subtitle">
          Run Lean 4 directly in your browser via WebAssembly. Note: Running code currently takes close to 1 minute. Contributions are welcome.
        </p>
        <div className="header-github">
          <GitHubButton
            href="https://github.com/timqian/lean4.js"
            data-color-scheme="no-preference: light; light: light; dark: dark;"
            data-size="large"
            data-show-count="true"
            aria-label="Star timqian/lean4.js on GitHub"
          >
            Star
          </GitHubButton>
        </div>
      </header>

      <main className="main">
        {!hasSharedArrayBuffer && (
          <div className="warning">
            ⚠️ SharedArrayBuffer is not available. Make sure the server sends:
            <code>Cross-Origin-Opener-Policy: same-origin</code>
            <code>Cross-Origin-Embedder-Policy: require-corp</code>
          </div>
        )}

        <div className="controls">
          {status === 'idle' && (
            <button onClick={loadLean} className="btn btn-primary">
              Load Lean 4 WASM
            </button>
          )}
          {status === 'loading' && (
            <div className="loading">
              <div className="spinner"></div>
              <span>{loadingProgress}</span>
            </div>
          )}
          {(status === 'ready' || status === 'running') && (
            <>
              {status === 'running' && loadingProgress && (
                <div className="loading" style={{ marginRight: '1rem' }}>
                  <div className="spinner"></div>
                  <span>{loadingProgress}</span>
                </div>
              )}
              <button
                onClick={testVersion}
                disabled={status === 'running'}
                className="btn btn-secondary"
                title="Test basic initialization"
              >
                --version
              </button>
              <button
                onClick={testHelp}
                disabled={status === 'running'}
                className="btn btn-secondary"
                title="Show help"
              >
                --help
              </button>
              <button
                onClick={runLean}
                disabled={status === 'running'}
                className="btn btn-primary"
              >
                {status === 'running' ? 'Running...' : 'Run Code'}
              </button>
            </>
          )}
          {status === 'error' && (
            <button onClick={loadLean} className="btn btn-secondary">
              Retry
            </button>
          )}
          <span className={`status status-${status}`}>
            {status === 'idle' && 'Not loaded'}
            {status === 'loading' && 'Loading...'}
            {status === 'ready' && 'Ready'}
            {status === 'running' && 'Running'}
            {status === 'error' && 'Error'}
          </span>
        </div>

        <div className="editor-container">
          <div className="panel">
            <div className="panel-header">
              <span>Code</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                <label htmlFor="lean-flags" style={{ opacity: 0.7 }}>Flags:</label>
                <input
                  id="lean-flags"
                  type="text"
                  value={leanFlags}
                  onChange={(e) => setLeanFlags(e.target.value)}
                  placeholder="--json --quiet"
                  style={{
                    padding: '0.25rem 0.5rem',
                    border: '1px solid #262626',
                    background: '#0a0a0a',
                    color: '#f5f5f5',
                    width: '200px',
                    fontSize: '0.75rem',
                    fontFamily: "'IBM Plex Mono', monospace"
                  }}
                  title="Additional flags to pass to Lean (e.g., --json, --quiet, --stats)"
                />
              </div>
            </div>
            <textarea
              className="code-editor"
              value={leanCode}
              onChange={(e) => setLeanCode(e.target.value)}
              placeholder="Enter Lean 4 code here..."
              spellCheck={false}
            />
          </div>

          <div className="panel">
            <div className="panel-header">
              <span>Output</span>
              <button
                onClick={() => { setOutput(''); setError('') }}
                className="btn btn-small"
              >
                Clear
              </button>
            </div>
            <div className="output" ref={outputRef}>
              {parsedOutput.diagnostics.length > 0 && (
                <div className="diagnostics">
                  {parsedOutput.diagnostics.map((diag, i) => (
                    <div
                      key={i}
                      className={`diagnostic diagnostic-${diag.severity}`}
                    >
                      <div className="diagnostic-header">
                        <span className="diagnostic-pos">
                          {diag.pos.line}:{diag.pos.column}
                        </span>
                        <span className={`diagnostic-badge diagnostic-badge-${diag.severity}`}>
                          {diag.severity === 'information' ? 'info' : diag.severity}
                        </span>
                      </div>
                      <div className="diagnostic-data">{diag.data}</div>
                    </div>
                  ))}
                </div>
              )}
              {parsedOutput.rawLines.length > 0 && (
                <div className="raw-output">
                  {parsedOutput.rawLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
              {error && <span className="output-error">{error}</span>}
              {!output && !error && (
                <span className="output-placeholder">
                  Output will appear here...
                </span>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="footer">
        <p className="runtime-note">
          Run Lean 4 directly in your browser via WebAssembly. 
        </p>
      </footer>
    </div>
  )
}

export default App
