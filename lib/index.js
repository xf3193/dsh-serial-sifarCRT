/**
 * sifarCRT — host half.
 *
 * A SecureCRT-style serial panel needs to own real COM ports, but Windows has no
 * in-box way to drive one from Node without a native addon. So each serial
 * session is held by its own persistent Windows PowerShell child
 * (`lib/serial-helper.ps1`, System.IO.Ports over stdio). This half speaks
 * newline-delimited JSON to those children, keeps a bounded per-session
 * receive/transmit log, multiplexes several independent sessions, lazily runs a
 * separate inventory bridge for port enumeration, and republishes everything to
 * the client half over one HTTP prefix route.
 *
 * Deliberately depends on nothing but Node builtins: no `@deepseek-ai/*` import,
 * no native module, no build step. The only harness surfaces used are
 * `ctx.webServer.register` (a plain `node:http` route) and `ctx.effect`
 * (lifecycle cleanup).
 *
 * The exported classes/functions exist so the no-browser test harness
 * (`test/host-test.mjs`) can drive this code without a Cordis context.
 */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The serial bridge script; DSH_SERIAL_HELPER substitutes a protocol-compatible one. */
const HELPER_PATH = (() => {
  const override = process.env.DSH_SERIAL_HELPER
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : join(HERE, 'serial-helper.ps1')
})()

/** Route prefix owned by this plugin. */
export const ROUTE = '/dsh-serial-sifarcrt'
/** Entries retained per session. */
const MAX_LINES = 4000
/** Total base64 payload characters retained per session before older entries drop. */
const MAX_LOG_BYTES = 8 * 1024 * 1024
/** Entries returned for a "current tail" poll (negative/absent `since`). */
const TAIL_LINES = 500
/** Largest accepted HTTP request body. */
const MAX_BODY_BYTES = 1_000_000
/** Largest base64 payload accepted by one /send. */
const MAX_SEND_B64 = 1_000_000
/** How long the PowerShell interpreter may take to report ready. */
const START_TIMEOUT = 30_000
/** How long a list of open sessions a /poll may ask about. */
const MAX_POLL_SESSIONS = 64

/** Bounds applied to client-supplied port settings. */
const LIMITS = {
  baudRate: [50, 1_500_000],
  dataBits: [5, 8],
}

const PARITY_VALUES = ['None', 'Odd', 'Even', 'Mark', 'Space']
const STOP_BITS_VALUES = ['One', 'OnePointFive', 'Two']
const HANDSHAKE_VALUES = ['None', 'XOnXOff', 'RequestToSend', 'RequestToSendXOnXOff']

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/
const PORT_RE = /^[A-Za-z0-9._\\/-]{1,64}$/
const REPORT_PATH = join(tmpdir(), 'dsh-serial-sifarcrt-report.json')
/** Actions that accept POST only; anything else is an unknown route. */
const POST_ACTIONS = new Set(['open', 'close', 'dispose', 'send', 'clear', 'poll', 'report'])

/** Resolve the PowerShell executable that carries the serial bridge. */
function resolveShell() {
  const override = process.env.DSH_SERIAL_POWERSHELL
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const root = process.env.SystemRoot || 'C:\\Windows'
  // Windows PowerShell is present on every supported Windows install; pwsh 7
  // also works when a deployment points DSH_SERIAL_POWERSHELL at it.
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, [min, max], fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function pickEnum(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback
  const needle = value.trim().toLowerCase()
  if (needle === '') return fallback
  const match = allowed.find((item) => item.toLowerCase() === needle)
  return match === undefined ? fallback : match
}

/**
 * Validate and normalize `POST /open` settings; throws on unusable input.
 * Exported for the test harness so clamping can be asserted without hardware.
 */
export function normalizeOpenSettings(raw) {
  const requested = isPlainObject(raw) ? raw : {}
  const port = typeof requested.port === 'string' ? requested.port.trim() : ''
  if (port === '') throw new Error('no port was selected')
  if (!PORT_RE.test(port)) throw new Error(`invalid port name: ${port}`)
  return {
    port,
    baudRate: clampInt(requested.baudRate, LIMITS.baudRate, 1_500_000),
    dataBits: clampInt(requested.dataBits, LIMITS.dataBits, 8),
    parity: pickEnum(requested.parity, PARITY_VALUES, 'None'),
    stopBits: pickEnum(requested.stopBits, STOP_BITS_VALUES, 'One'),
    // sifarCRT default flow control is none (无流控).
    handshake: pickEnum(requested.handshake, HANDSHAKE_VALUES, 'None'),
    dtr: typeof requested.dtr === 'boolean' ? requested.dtr : true,
    rts: typeof requested.rts === 'boolean' ? requested.rts : true,
  }
}

/** A session id comes from the client; it must never escape the route handler. */
function validateSessionId(value) {
  if (typeof value !== 'string' || !SESSION_RE.test(value)) {
    throw new Error('invalid session id: expected 1-64 characters of A-Z a-z 0-9 _ -')
  }
  return value
}

/** Strict base64 decode used by /send; returns the decoded byte length. */
function validateBase64(value) {
  if (typeof value !== 'string' || value === '') throw new Error('nothing to send')
  if (value.length > MAX_SEND_B64) throw new Error('the payload is too large')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('malformed base64 payload')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0) throw new Error('nothing to send')
  if (bytes.toString('base64') !== value) throw new Error('malformed base64 payload')
  return bytes.length
}

function normalizePortList(raw) {
  const list = Array.isArray(raw) ? raw : []
  const ports = []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') continue
    ports.push({ name, description: typeof item.description === 'string' ? item.description : '' })
  }
  ports.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  return ports
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, 200)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Bounded receive/transmit log with a monotonic sequence for incremental reads. */
export class SerialLog {
  constructor(maxLines = MAX_LINES, maxBytes = MAX_LOG_BYTES) {
    this.entries = []
    this.bytes = 0
    this.seq = 0
    this.maxLines = maxLines
    this.maxBytes = maxBytes
  }

  push(entry) {
    this.seq += 1
    const record = { seq: this.seq, at: Date.now(), ...entry }
    this.entries.push(record)
    this.bytes += record.b64 === undefined ? 0 : record.b64.length
    while (this.entries.length > this.maxLines || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const dropped = this.entries.shift()
      this.bytes -= dropped.b64 === undefined ? 0 : dropped.b64.length
    }
    return record
  }

  /** Entries newer than `since`; a negative/absent `since` returns the tail. */
  since(since) {
    if (!Number.isFinite(since) || since < 0) return this.entries.slice(-TAIL_LINES)
    return this.entries.filter((entry) => entry.seq > since)
  }

  clear() {
    this.entries = []
    this.bytes = 0
    // `seq` deliberately keeps counting: client cursors must never replay.
  }
}

/**
 * One serial bridge: the PowerShell child and the port state it reports.
 * Generic enough to serve both a session and the shared inventory enumerator.
 */
export class SerialBridge {
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    this.helperPath = typeof opts.helperPath === 'string' && opts.helperPath !== '' ? opts.helperPath : HELPER_PATH
    this.shell = typeof opts.shell === 'string' && opts.shell !== '' ? opts.shell : resolveShell()
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null
    this.child = null
    this.startPromise = null
    this.startResolve = null
    this.startReject = null
    this.startTimer = null
    this.ready = false
    this.ports = []
    this.config = null
    this.lastError = null
    this.waiters = new Set()
    this.stdoutCarry = ''
    this.disposed = false
  }

  get pid() {
    return this.child === null ? null : this.child.pid ?? null
  }

  get alive() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  notify(event) {
    if (this.onEvent === null) return
    try {
      this.onEvent(event)
    } catch {
      // A listener must never take the bridge down.
    }
  }

  settleStart(error) {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    const resolve = this.startResolve
    const reject = this.startReject
    this.startResolve = null
    this.startReject = null
    if (error) {
      this.startPromise = null
      if (reject !== null) reject(error)
      return
    }
    if (resolve !== null) resolve()
  }

  /** Start the child once; resolves when it reports `ready`. */
  start() {
    if (this.disposed) return Promise.reject(new Error('the serial bridge has been disposed'))
    if (this.ready && this.child !== null) return Promise.resolve()
    if (this.startPromise !== null) return this.startPromise

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath]
    let child
    try {
      child = spawn(this.shell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      // Keep startPromise null so a retry can spawn again.
      return Promise.reject(new Error(`could not start ${this.shell}: ${errorMessage(error)}`))
    }

    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
      this.child = child
      this.stdoutCarry = ''

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.handleStdout(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') this.notify({ type: 'stderr', message: text.slice(0, 400) })
      })
      child.on('error', (error) => {
        const message = `bridge process error: ${errorMessage(error)}`
        this.lastError = message
        if (this.child === child) {
          this.child = null
          this.ready = false
          this.config = null
          this.settleStart(new Error(message))
          this.rejectWaiters(new Error(message))
        }
        this.notify({ type: 'process-error', message })
      })
      child.on('exit', (code, signal) => this.handleExit(code, signal))

      this.startTimer = setTimeout(() => {
        this.settleStart(new Error('the serial bridge did not become ready within 30s'))
        this.killChild(child)
      }, START_TIMEOUT)
      this.startTimer.unref?.()
    })

    return this.startPromise
  }

  handleExit(code, signal) {
    const wasDisposed = this.disposed
    const message = `serial bridge exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`
    this.ready = false
    this.child = null
    this.config = null
    this.stdoutCarry = ''
    if (!wasDisposed) this.lastError = message
    this.settleStart(new Error(message))
    this.rejectWaiters(new Error(message))
    if (!wasDisposed) this.notify({ type: 'exit', code, signal, message })
  }

  /** Record one parsed bridge event, then settle any command waiting for it. */
  handleEvent(event) {
    if (!isPlainObject(event) || typeof event.type !== 'string') return
    switch (event.type) {
      case 'ready':
        this.ready = true
        this.ports = normalizePortList(event.ports)
        this.settleStart(null)
        break
      case 'ports':
        this.ports = normalizePortList(event.ports)
        break
      case 'opened':
        this.config = {
          port: typeof event.port === 'string' ? event.port : String(event.port ?? ''),
          baudRate: clampInt(event.baudRate, LIMITS.baudRate, 1_500_000),
          dataBits: clampInt(event.dataBits, LIMITS.dataBits, 8),
          parity: pickEnum(event.parity, PARITY_VALUES, 'None'),
          stopBits: pickEnum(event.stopBits, STOP_BITS_VALUES, 'One'),
          handshake: pickEnum(event.handshake, HANDSHAKE_VALUES, 'None'),
        }
        this.lastError = null
        break
      case 'closed':
        this.config = null
        break
      case 'error':
        this.lastError = typeof event.message === 'string' ? event.message : 'serial bridge error'
        break
      case 'bye':
        this.ready = false
        break
      default:
        break
    }
    this.notify(event)
    this.settleWaiters(event)
  }

  handleStdout(text) {
    this.stdoutCarry += text
    for (;;) {
      const index = this.stdoutCarry.indexOf('\n')
      if (index < 0) break
      const line = this.stdoutCarry.slice(0, index).trim()
      this.stdoutCarry = this.stdoutCarry.slice(index + 1)
      if (line === '') continue
      try {
        this.handleEvent(JSON.parse(line))
      } catch {
        this.notify({ type: 'stderr', message: `unparsed bridge output: ${line.slice(0, 200)}` })
      }
    }
  }

  settleWaiters(event) {
    for (const waiter of [...this.waiters]) {
      if (!this.waiters.has(waiter)) continue
      let match = false
      try {
        match = Boolean(waiter.predicate(event))
      } catch {
        match = false
      }
      if (!match) continue
      this.waiters.delete(waiter)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      if (event.type === 'error') {
        waiter.reject(new Error(typeof event.message === 'string' ? event.message : 'serial bridge error'))
      } else {
        waiter.resolve(event)
      }
    }
  }

  /** Reject every in-flight command: the bridge went away, no answer is coming. */
  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  /** Send one command line to the child. */
  command(payload) {
    if (this.disposed) throw new Error('the serial bridge has been disposed')
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new Error('the serial bridge is not running')
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /**
   * Run a command and resolve with the first event satisfying `predicate`.
   * A bridge `error` event rejects; so does a child exit or a timeout, so a
   * caller can never hang on a stale waiter.
   */
  async request(payload, predicate, timeoutMs) {
    await this.start()
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        if (!this.waiters.delete(waiter)) return
        reject(new Error(`the serial bridge did not answer "${payload.op}" within ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.add(waiter)
      try {
        this.command(payload)
      } catch (error) {
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Read the current port list from the operating system. */
  async listPorts() {
    await this.request({ op: 'list' }, (event) => event.type === 'ports' || event.type === 'error', 20_000)
    return this.ports.map((port) => ({ ...port }))
  }

  /** Open a port with validated settings. Throws on failure; previous config is kept by the caller. */
  async open(raw) {
    const settings = normalizeOpenSettings(raw)
    await this.request(
      { op: 'open', ...settings },
      (event) => event.type === 'opened' || event.type === 'error',
      20_000,
    )
    return this.config === null ? null : { ...this.config }
  }

  /** Close the port if the child is running; never starts a bridge just to close it. */
  async close() {
    if (this.disposed) {
      this.config = null
      return
    }
    if (this.child === null) {
      this.config = null
      return
    }
    try {
      await this.request({ op: 'close' }, (event) => event.type === 'closed' || event.type === 'error', 10_000)
    } finally {
      this.config = null
    }
  }

  /** Transmit already-encoded bytes; resolves with the child-reported byte count. */
  async write(base64) {
    if (this.config === null) throw new Error('the port is not open')
    const byteLength = validateBase64(base64)
    const baudRate = this.config.baudRate > 0 ? this.config.baudRate : 1_500_000
    // Large payloads legitimately take a while at low baud rates; scale the
    // timeout with the wire time but keep a sane ceiling.
    const wireMs = Math.ceil((byteLength * 10 * 1000) / baudRate)
    const timeoutMs = Math.min(180_000, Math.max(15_000, wireMs + 15_000))
    const event = await this.request(
      { op: 'write', base64 },
      (done) => done.type === 'written' || done.type === 'error',
      timeoutMs,
    )
    return Number.isFinite(Number(event.count)) ? Number(event.count) : byteLength
  }

  killChild(child) {
    try {
      child.kill()
    } catch {
      // Already exited.
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = null
    this.ready = false
    this.config = null
    this.settleStart(new Error('the serial bridge has been disposed'))
    this.rejectWaiters(new Error('the serial bridge has been disposed'))
    if (child === null) return
    try {
      if (child.stdin !== null && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
        child.stdin.end()
      }
    } catch {
      // The child is already gone; fall through to the kill below.
    }
    const timer = setTimeout(() => this.killChild(child), 3000)
    timer.unref?.()
  }
}

/**
 * One serial session: its id, its bridge child, and its bounded traffic log.
 * A session outlives `close()` (log kept) until the manager disposes it.
 */
export class SerialSession {
  constructor(id, options = {}) {
    const opts = isPlainObject(options) ? options : {}
    this.id = id
    this.createdAt = Date.now()
    this.log = new SerialLog()
    this.bridge = new SerialBridge({
      helperPath: typeof opts.helperPath === 'string' ? opts.helperPath : undefined,
      shell: typeof opts.shell === 'string' ? opts.shell : undefined,
      onEvent: (event) => this.handleEvent(event),
    })
  }

  handleEvent(event) {
    switch (event.type) {
      case 'opened':
        this.log.push({
          kind: 'sys',
          text: `opened ${event.port} @ ${event.baudRate} ${event.dataBits}${String(event.parity ?? 'N').charAt(0)}${event.stopBits} ${event.handshake}`,
        })
        break
      case 'closed':
        this.log.push({ kind: 'sys', text: 'port closed' })
        break
      case 'data':
        if (typeof event.base64 === 'string' && event.base64 !== '') {
          this.log.push({ kind: 'rx', b64: event.base64 })
        }
        break
      case 'error':
        this.log.push({ kind: 'err', text: `error${event.op ? ` (${event.op})` : ''}: ${event.message}` })
        break
      case 'stderr':
        this.log.push({ kind: 'err', text: `bridge stderr: ${event.message}` })
        break
      case 'process-error':
        this.log.push({ kind: 'err', text: event.message })
        break
      case 'exit':
        if (!this.bridge.disposed) this.log.push({ kind: 'err', text: event.message })
        break
      default:
        break
    }
  }

  status() {
    const config = this.bridge.config
    return {
      exists: true,
      ready: this.bridge.ready,
      connected: config !== null,
      config: config === null ? null : { ...config },
      ports: this.bridge.ports.map((port) => ({ ...port })),
      lastError: this.bridge.lastError,
    }
  }

  /**
   * Open with validated settings. On failure the previously open port is
   * restored best-effort, matching the contract's "a failure keeps the previous
   * port state".
   */
  async open(raw) {
    const previous = this.bridge.config === null ? null : { ...this.bridge.config }
    try {
      await this.bridge.open(raw)
      return this.status()
    } catch (error) {
      if (previous !== null) {
        try {
          await this.bridge.open(previous)
        } catch {
          // The old port could not be restored; status will report it.
        }
      }
      throw error
    }
  }

  async close() {
    await this.bridge.close()
    return this.status()
  }

  /** Transmit and append the matching `tx` log entry once the child confirms it. */
  async send(base64, label) {
    const count = await this.bridge.write(base64)
    const text = normalizeLabel(label)
    this.log.push(text === undefined ? { kind: 'tx', b64: base64 } : { kind: 'tx', b64: base64, text })
    return count
  }

  clear() {
    this.log.clear()
  }

  dispose() {
    this.bridge.dispose()
  }
}

/**
 * Owns every session plus the lazy inventory bridge. Unknown session ids are
 * never created by read paths (`/poll`, `/close`, `/clear`, `/dispose`).
 */
export class SerialManager {
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    this.helperPath = typeof opts.helperPath === 'string' && opts.helperPath !== '' ? opts.helperPath : undefined
    this.shell = typeof opts.shell === 'string' && opts.shell !== '' ? opts.shell : undefined
    this.sessions = new Map()
    this.inventory = null
    this.portsInFlight = null
    this.lastKnownPorts = []
    this.report = null
    this.disposed = false
  }

  assertUsable() {
    if (this.disposed) throw new Error('the serial manager has been disposed')
  }

  ensureSession(id) {
    this.assertUsable()
    let session = this.sessions.get(id)
    if (session === undefined) {
      session = new SerialSession(id, { helperPath: this.helperPath, shell: this.shell })
      this.sessions.set(id, session)
    }
    return session
  }

  getSession(id) {
    return this.sessions.get(id)
  }

  /** `POST /open` — creates the session on first use. */
  async open(body) {
    this.assertUsable()
    const requested = isPlainObject(body) ? body : {}
    const id = validateSessionId(requested.session)
    const settings = normalizeOpenSettings(requested)
    const session = this.ensureSession(id)
    return session.open(settings)
  }

  /** `POST /close` — never creates a session. */
  async close(sessionId) {
    this.assertUsable()
    const id = validateSessionId(sessionId)
    const session = this.sessions.get(id)
    if (session === undefined) return { exists: false }
    return session.close()
  }

  /** `POST /send` — unknown session is a handled failure. */
  async send(body) {
    this.assertUsable()
    const requested = isPlainObject(body) ? body : {}
    const id = validateSessionId(requested.session)
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`unknown session: ${id}`)
    await session.send(requested.base64, requested.label)
    return { next: session.log.seq }
  }

  /** `POST /clear` — unknown session is a no-op with next 0. */
  clear(sessionId) {
    this.assertUsable()
    const id = validateSessionId(sessionId)
    const session = this.sessions.get(id)
    if (session === undefined) return { next: 0 }
    session.clear()
    return { next: session.log.seq }
  }

  /** `POST /dispose` — unknown session is still success. */
  disposeSession(sessionId) {
    this.assertUsable()
    const id = validateSessionId(sessionId)
    const session = this.sessions.get(id)
    if (session !== undefined) {
      session.dispose()
      this.sessions.delete(id)
    }
    return {}
  }

  /** `POST /poll` — returns snapshots; must never create a session. */
  poll(rawSessions, rawSince) {
    this.assertUsable()
    const sinceMap = isPlainObject(rawSince) ? rawSince : {}
    const requested = rawSessions === undefined ? Object.keys(sinceMap) : rawSessions
    if (!Array.isArray(requested)) throw new Error('"sessions" must be an array')
    if (requested.length > MAX_POLL_SESSIONS) throw new Error('too many sessions requested')
    const out = []
    const seen = new Set()
    for (const rawId of requested) {
      const id = validateSessionId(rawId)
      if (seen.has(id)) continue
      seen.add(id)
      const session = this.sessions.get(id)
      if (session === undefined) {
        out.push({ id, status: { exists: false }, lines: [], next: 0 })
        continue
      }
      const sinceValue = Number(sinceMap[id])
      const since = Number.isFinite(sinceValue) && sinceValue >= 0 ? Math.trunc(sinceValue) : -1
      out.push({ id, status: session.status(), lines: session.log.since(since), next: session.log.seq })
    }
    return out
  }

  statuses() {
    return [...this.sessions.values()].map((session) => ({ id: session.id, ...session.status() }))
  }

  /** `POST /report` — keep the last diagnostics frame and write it best-effort. */
  async setReport(payload) {
    this.assertUsable()
    this.report = payload
    try {
      await writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // Best effort: a read-only tmpdir must not fail the panel.
    }
  }

  /**
   * `GET /ports` — enumeration runs on a dedicated lazily started bridge, never
   * on a session's bridge. A dead inventory bridge is replaced on the next call.
   */
  async enumeratePorts() {
    this.assertUsable()
    if (this.portsInFlight !== null) return this.portsInFlight

    const attempt = (async () => {
      let bridge = this.inventory
      if (bridge !== null && bridge.disposed) bridge = null
      if (bridge === null) {
        bridge = new SerialBridge({
          helperPath: this.helperPath,
          shell: this.shell,
          onEvent: (event) => {
            if (event.type === 'ready' || event.type === 'ports') {
              this.lastKnownPorts = normalizePortList(bridge.ports)
            }
          },
        })
        this.inventory = bridge
      }

      try {
        const ports = await bridge.listPorts()
        this.lastKnownPorts = normalizePortList(ports)
        return { ports: this.lastKnownPorts.slice(), ready: true, error: null }
      } catch (error) {
        const message = errorMessage(error)
        if (this.inventory === bridge) {
          bridge.dispose()
          this.inventory = null
        }
        return { ports: this.lastKnownPorts.slice(), ready: false, error: message }
      }
    })()

    this.portsInFlight = attempt
    try {
      return await attempt
    } finally {
      if (this.portsInFlight === attempt) this.portsInFlight = null
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    if (this.inventory !== null) {
      this.inventory.dispose()
      this.inventory = null
    }
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...corsHeaders(),
  })
  res.end(body)
}

function sendNoContent(res) {
  res.writeHead(204, corsHeaders())
  res.end()
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
  if (!isPlainObject(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Build the prefix-route handler for one manager. Plain `node:http` handler so
 * the test harness can mount it on a real server with no Cordis context.
 */
export function createHandler(manager) {
  if (!(manager instanceof SerialManager)) throw new TypeError('createHandler expects a SerialManager')

  return async function sifarCrtHandler(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'OPTIONS') {
      sendNoContent(res)
      return
    }

    let url
    try {
      url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    } catch {
      sendJson(res, 200, { ok: false, error: 'invalid request URL' })
      return
    }

    const action = url.pathname.startsWith(ROUTE)
      ? url.pathname.slice(ROUTE.length).replace(/^\/+/, '').replace(/\/+$/, '')
      : null
    if (action === null) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }

    try {
      if (method === 'GET' && (action === 'ports')) {
        const result = await manager.enumeratePorts()
        sendJson(res, 200, { ok: true, ports: result.ports, enumerator: { ready: result.ready, error: result.error } })
        return
      }

      if (method === 'GET' && (action === 'state' || action === '')) {
        sendJson(res, 200, {
          ok: true,
          report: manager.report,
          sessions: manager.statuses(),
          ports: manager.lastKnownPorts.slice(),
        })
        return
      }

      if (!POST_ACTIONS.has(action)) {
        sendJson(res, 404, { ok: false, error: `unknown action: ${action}` })
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `${action} requires POST` })
        return
      }

      const body = await readJsonBody(req)

      if (action === 'open') {
        const status = await manager.open(body)
        sendJson(res, 200, { ok: true, status })
        return
      }

      if (action === 'close') {
        const status = await manager.close(body.session)
        sendJson(res, 200, { ok: true, status })
        return
      }

      if (action === 'dispose') {
        manager.disposeSession(body.session)
        sendJson(res, 200, { ok: true })
        return
      }

      if (action === 'send') {
        const result = await manager.send(body)
        sendJson(res, 200, { ok: true, next: result.next })
        return
      }

      if (action === 'clear') {
        const result = manager.clear(body.session)
        sendJson(res, 200, { ok: true, next: result.next })
        return
      }

      if (action === 'poll') {
        const sessions = manager.poll(body.sessions, body.since)
        sendJson(res, 200, { ok: true, sessions })
        return
      }

      if (action === 'report') {
        await manager.setReport(body)
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown action: ${action}` })
    } catch (error) {
      // The contract defines handled failures as HTTP 200 with ok:false.
      sendJson(res, 200, { ok: false, error: errorMessage(error) })
    }
  }
}

/** Plugin name (informational; the profile row comes from cordis.patch.yml). */
export const name = 'dsh-serial-sifarcrt'

/**
 * Mount the serial manager and its HTTP route.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const manager = new SerialManager()
  ctx.effect(() => () => manager.dispose(), 'dsh-serial-sifarcrt: serial sessions')

  const handler = createHandler(manager)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'dsh-serial-sifarcrt: http route',
    )
  })
}
