/**
 * sifarCRT host-half test harness (not shipped).
 *
 * Drives lib/index.js directly (no Cordis context) against the real
 * lib/serial-helper.ps1 child processes and real COM ports. Run with:
 *
 *   node test/host-test.mjs
 *
 * Exits 0 only when every check passes; prints a PASS/FAIL line per step.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SerialBridge,
  SerialLog,
  SerialSession,
  SerialManager,
  createHandler,
  normalizeOpenSettings,
} from '../lib/index.js'

const REPORT_PATH = join(tmpdir(), 'dsh-serial-sifarcrt-report.json')
const COM_PORTS = ['COM1', 'COM3', 'COM6']
const results = []
let failures = 0

function ms(value) {
  return `${value}ms`
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    const elapsed = Date.now() - started
    results.push({ name, ok: true })
    console.log(`PASS  ${name} (${ms(elapsed)})${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    failures += 1
    results.push({ name, ok: false, error })
    console.error(`FAIL  ${name}`)
    console.error(String(error instanceof Error ? error.stack ?? error.message : error).replace(/^/gm, '      '))
  }
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Run a fetch against the mounted handler and parse the JSON response. */
async function api(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, json, text }
}

function postJson(base, path, body) {
  return api(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function main() {
  console.log('sifarCRT host test — lib/index.js + real lib/serial-helper.ps1')
  console.log(`node ${process.version} · ${process.platform} · tmp report ${REPORT_PATH}\n`)

  const manager = new SerialManager()
  let httpManager = null
  let server = null

  const watchdog = setTimeout(() => {
    console.error('\nFAIL overall: test watchdog fired after 300s')
    process.exit(1)
  }, 300_000)

  try {
    // ── exported surface ────────────────────────────────────────────────────
    await step('exports bridge/session/manager classes and handler factory', () => {
      assert.equal(typeof SerialBridge, 'function')
      assert.equal(typeof SerialSession, 'function')
      assert.equal(typeof SerialManager, 'function')
      assert.equal(typeof SerialLog, 'function')
      assert.equal(typeof createHandler, 'function')
      assert.ok(manager instanceof SerialManager)
      assert.equal(typeof manager.open, 'function')
      assert.equal(typeof manager.poll, 'function')
    })

    // ── input normalization / clamps ───────────────────────────────────────
    await step('open settings are clamped and defaulted', () => {
      const settings = normalizeOpenSettings({
        port: ' COM3 ',
        baudRate: 9_999_999,
        dataBits: 99,
        parity: 'even',
        stopBits: 'Two',
        handshake: 'requesttosendxonxoff',
        dtr: false,
      })
      assert.deepEqual(settings, {
        port: 'COM3',
        baudRate: 1_500_000,
        dataBits: 8,
        parity: 'Even',
        stopBits: 'Two',
        handshake: 'RequestToSendXOnXOff',
        dtr: false,
        rts: true,
      })
      const low = normalizeOpenSettings({ port: 'COM1', baudRate: 1, dataBits: 1, parity: 'bogus', stopBits: 'bogus', handshake: 'bogus' })
      assert.equal(low.baudRate, 50)
      assert.equal(low.dataBits, 5)
      assert.equal(low.parity, 'None')
      assert.equal(low.stopBits, 'One')
      assert.equal(low.handshake, 'None')
      const defaults = normalizeOpenSettings({ port: 'COM1' })
      assert.equal(defaults.baudRate, 1_500_000)
      assert.equal(defaults.dataBits, 8)
      assert.equal(defaults.parity, 'None')
      assert.equal(defaults.stopBits, 'One')
      assert.equal(defaults.handshake, 'None')
      assert.throws(() => normalizeOpenSettings({ port: '' }), /no port was selected/)
      assert.throws(() => normalizeOpenSettings({ port: 'bad port!' }), /invalid port name/)
      return '1500000 default · None flow default · 50/5 lower clamps'
    })

    await step('SerialLog bounds entries to 4000 and bytes to 8MB', () => {
      const countLog = new SerialLog()
      for (let index = 0; index < 5000; index += 1) countLog.push({ kind: 'sys', text: `line ${index}` })
      assert.equal(countLog.entries.length, 4000)
      assert.equal(countLog.seq, 5000)
      assert.equal(countLog.entries[0].seq, 1001)
      assert.equal(countLog.since(-1).length, 500)
      assert.equal(countLog.since(4998).length, 2)
      const bytesLog = new SerialLog(4000, 8 * 1024 * 1024)
      const chunk = 'A'.repeat(5000)
      for (let index = 0; index < 3000; index += 1) bytesLog.push({ kind: 'rx', b64: chunk })
      assert.ok(bytesLog.bytes <= 8 * 1024 * 1024, `retained ${bytesLog.bytes} bytes`)
      assert.ok(bytesLog.entries.length < 4000)
      return '4000 entries / 8MB tail kept'
    })

    // ── lazy inventory bridge + port enumeration ───────────────────────────
    await step('lazily started inventory bridge lists COM ports', async () => {
      assert.equal(manager.inventory, null)
      const enumerated = await manager.enumeratePorts()
      assert.equal(enumerated.ready, true, enumerated.error ?? 'enumeration failed')
      assert.equal(enumerated.error, null)
      const names = enumerated.ports.map((port) => port.name)
      for (const wanted of COM_PORTS) assert.ok(names.includes(wanted), `missing ${wanted} in [${names}]`)
      assert.ok(manager.inventory instanceof SerialBridge)
      assert.ok(manager.inventory.pid > 0)
      assert.ok(manager.lastKnownPorts.length >= COM_PORTS.length)
      const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      assert.deepEqual(names, sorted, 'ports sorted by name')
      for (const port of enumerated.ports) assert.equal(typeof port.description, 'string')
      return `${names.join(', ')} · inventory pid ${manager.inventory.pid}`
    })

    // ── one session: open / send / poll / clear / close / reopen ───────────
    let session = null
    await step('opens COM1 at 115200 8N1 with xon/xoff', async () => {
      const status = await manager.open({
        session: 't-a',
        port: 'COM1',
        baudRate: 115200,
        dataBits: 8,
        parity: 'None',
        stopBits: 'One',
        handshake: 'XOnXOff',
      })
      assert.equal(status.exists, true)
      assert.equal(status.ready, true)
      assert.equal(status.connected, true)
      assert.equal(status.lastError, null)
      assert.deepEqual(status.config, {
        port: 'COM1',
        baudRate: 115200,
        dataBits: 8,
        parity: 'None',
        stopBits: 'One',
        handshake: 'XOnXOff',
      })
      session = manager.getSession('t-a')
      assert.ok(session instanceof SerialSession)
      assert.ok(session.bridge.pid > 0)
      assert.ok(session.log.seq >= 1, 'open should append a sys log entry')
      return `session t-a · bridge pid ${session.bridge.pid}`
    })

    // COM1's driver rejects 1500000 baud, so the hardware default check runs on
    // COM3 (which accepted 1500000 in a live probe); explicit values must win.
    await step('open without baudRate/handshake defaults to 1500000 / None', async () => {
      const defaulted = await manager.open({ session: 't-defaults', port: 'COM3' })
      assert.equal(defaulted.connected, true)
      assert.equal(defaulted.config.port, 'COM3')
      assert.equal(defaulted.config.baudRate, 1_500_000)
      assert.equal(defaulted.config.handshake, 'None')
      assert.equal(defaulted.config.dataBits, 8)
      assert.equal(defaulted.config.parity, 'None')
      assert.equal(defaulted.config.stopBits, 'One')

      const explicit = await manager.open({
        session: 't-defaults',
        port: 'COM3',
        baudRate: 115200,
        handshake: 'XOnXOff',
        parity: 'Even',
      })
      assert.equal(explicit.connected, true)
      assert.equal(explicit.config.baudRate, 115200)
      assert.equal(explicit.config.handshake, 'XOnXOff')
      assert.equal(explicit.config.parity, 'Even')

      manager.disposeSession('t-defaults')
      assert.equal(manager.getSession('t-defaults'), undefined)
      return 'COM3 default 1500000/None · explicit 115200/XOnXOff wins'
    })

    await step('writes base64 bytes and logs a tx entry', async () => {
      const payload = b64('AT+CSQ\r\n')
      const before = session.log.seq
      const sendResult = await manager.send({ session: 't-a', base64: payload, label: 'AT+CSQ' })
      assert.equal(sendResult.next, before + 1)
      assert.equal(session.log.seq, before + 1)
      const tx = session.log.entries.at(-1)
      assert.equal(tx.kind, 'tx')
      assert.equal(tx.seq, before + 1)
      assert.equal(tx.b64, payload)
      assert.equal(tx.text, 'AT+CSQ')
      assert.equal(typeof tx.at, 'number')
    })

    await step('supports a multi-chunk base64 payload (4KB)', async () => {
      const raw = Buffer.alloc(4096)
      for (let index = 0; index < raw.length; index += 1) raw[index] = index % 251
      const payload = raw.toString('base64')
      const before = session.log.seq
      const result = await manager.send({ session: 't-a', base64: payload })
      assert.equal(result.next, before + 1)
      assert.equal(session.log.entries.at(-1).b64, payload)
      assert.equal(Buffer.from(session.log.entries.at(-1).b64, 'base64').length, 4096)
      return '4096 bytes round-tripped through NDJSON'
    })

    await step('rejects malformed base64 and sends on a closed port', async () => {
      await assert.rejects(manager.send({ session: 't-a', base64: 'not base64!!' }), /malformed base64|nothing to send/)
      await assert.rejects(manager.send({ session: 't-a', base64: b64('x').slice(0, 2) }), /malformed base64/)
      await assert.rejects(manager.send({ session: 'no-such-session', base64: b64('x') }), /unknown session/)
    })

    await step('poll returns the tail then incremental entries by sequence', async () => {
      const tail = manager.poll(['t-a'], {})
      assert.equal(tail.length, 1)
      assert.equal(tail[0].id, 't-a')
      assert.equal(tail[0].status.exists, true)
      assert.equal(tail[0].next, session.log.seq)
      assert.ok(tail[0].lines.length >= 1)
      assert.equal(tail[0].lines.at(-1).seq, session.log.seq)

      const from = session.log.seq
      await manager.send({ session: 't-a', base64: b64('PING\r\n'), label: 'PING' })
      const incremental = manager.poll(['t-a'], { 't-a': from })
      assert.equal(incremental[0].lines.length, 1)
      assert.equal(incremental[0].lines[0].seq, from + 1)
      assert.equal(incremental[0].next, from + 1)
      return `tail ${tail[0].lines.length} lines · incremental +1`
    })

    await step('unknown session poll never creates a session', () => {
      const sizeBefore = manager.sessions.size
      const polled = manager.poll(['ghost-session'], {})
      assert.equal(polled[0].id, 'ghost-session')
      assert.deepEqual(polled[0].status, { exists: false })
      assert.deepEqual(polled[0].lines, [])
      assert.equal(polled[0].next, 0)
      assert.equal(manager.sessions.size, sizeBefore)
      assert.equal(manager.getSession('ghost-session'), undefined)
      const fromSince = manager.poll(undefined, { 'another-ghost': -1 })
      assert.equal(fromSince[0].status.exists, false)
      assert.equal(manager.sessions.size, sizeBefore)
    })

    await step('clear empties the log but never rewinds the sequence', async () => {
      const nextBefore = session.log.seq
      const cleared = manager.clear('t-a')
      assert.equal(cleared.next, nextBefore)
      assert.equal(manager.poll(['t-a'], {}).at(0).lines.length, 0)
      assert.equal(manager.clear('unknown-clear').next, 0)
      await manager.send({ session: 't-a', base64: b64('AFTER-CLEAR') })
      assert.equal(session.log.seq, nextBefore + 1)
      assert.equal(session.log.entries.length, 1)
      assert.equal(manager.poll(['t-a'], { 't-a': nextBefore }).at(0).lines.length, 1)
      return `next stayed ${nextBefore} then incremented`
    })

    await step('a failed open keeps the previous port state', async () => {
      await assert.rejects(
        manager.open({ session: 't-a', port: 'COM_NOT_A_REAL_PORT_9', baudRate: 115200 }),
        /./,
      )
      const status = manager.getSession('t-a').status()
      assert.equal(status.connected, true)
      assert.equal(status.config.port, 'COM1')
      assert.ok(status.lastError === null || typeof status.lastError === 'string')
      return 'COM1 restored after a failed reopen'
    })

    await step('close keeps the session and its log, reopen uses defaults', async () => {
      const closed = await manager.close('t-a')
      assert.equal(closed.exists, true)
      assert.equal(closed.connected, false)
      assert.equal(closed.config, null)
      const nextAfterClose = session.log.seq
      assert.ok(session.log.entries.some((entry) => entry.kind === 'sys' && entry.text === 'port closed'))
      const reopened = await manager.open({ session: 't-a', port: 'COM1', baudRate: 115200 })
      assert.equal(reopened.connected, true)
      assert.deepEqual(reopened.config, {
        port: 'COM1',
        baudRate: 115200,
        dataBits: 8,
        parity: 'None',
        stopBits: 'One',
        // Omitted handshake now falls back to None while explicit baud wins.
        handshake: 'None',
      })
      assert.ok(session.log.seq > nextAfterClose, 'reopen appends to the same log')
      return 'log preserved across close/reopen'
    })

    await step('close of an unknown session is handled without creating it', async () => {
      const status = await manager.close('ghost-close')
      assert.deepEqual(status, { exists: false })
      assert.equal(manager.getSession('ghost-close'), undefined)
    })

    // ── two concurrent sessions on different ports ────────────────────────
    let sessionB = null
    let sessionC = null
    await step('two sessions open COM1 and COM3 concurrently', async () => {
      await manager.close('t-a')
      const statusB = await manager.open({ session: 't-b', port: 'COM1', baudRate: 9600, handshake: 'None' })
      const statusC = await manager.open({ session: 't-c', port: 'COM3', baudRate: 57600 })
      assert.equal(statusB.connected, true)
      assert.equal(statusC.connected, true)
      assert.equal(statusB.config.baudRate, 9600)
      assert.equal(statusB.config.handshake, 'None')
      assert.equal(statusC.config.baudRate, 57600)
      assert.equal(statusC.config.handshake, 'None')
      sessionB = manager.getSession('t-b')
      sessionC = manager.getSession('t-c')
      assert.notEqual(sessionB.bridge.pid, sessionC.bridge.pid)
      assert.equal(manager.sessions.size, 3) // t-a, t-b, t-c
      return `COM1 pid ${sessionB.bridge.pid} · COM3 pid ${sessionC.bridge.pid}`
    })

    await step('concurrent writes land in independent per-session logs', async () => {
      await manager.send({ session: 't-b', base64: b64('FROM-B'), label: 'B' })
      await manager.send({ session: 't-c', base64: b64('FROM-C'), label: 'C' })
      const polls = manager.poll(['t-b', 't-c'], {})
      assert.equal(polls.length, 2)
      const pollB = polls.find((entry) => entry.id === 't-b')
      const pollC = polls.find((entry) => entry.id === 't-c')
      const txB = pollB.lines.filter((entry) => entry.kind === 'tx').at(-1)
      const txC = pollC.lines.filter((entry) => entry.kind === 'tx').at(-1)
      assert.equal(txB.text, 'B')
      assert.equal(Buffer.from(txB.b64, 'base64').toString('utf8'), 'FROM-B')
      assert.equal(txC.text, 'C')
      assert.equal(Buffer.from(txC.b64, 'base64').toString('utf8'), 'FROM-C')
      assert.ok(pollB.next > 0 && pollC.next > 0)
      return `t-b next ${pollB.next} · t-c next ${pollC.next}`
    })

    await step('dispose closes the port, kills the bridge child, drops the session', async () => {
      const pid = sessionB.bridge.pid
      assert.ok(isProcessAlive(pid), `bridge ${pid} should be alive before dispose`)
      manager.disposeSession('t-b')
      assert.equal(manager.getSession('t-b'), undefined)
      assert.equal(manager.sessions.has('t-b'), false)
      assert.equal(sessionB.bridge.disposed, true)
      assert.equal(sessionB.bridge.child, null)
      await waitFor(() => !isProcessAlive(pid), 10_000, `bridge pid ${pid} to exit`)
      assert.deepEqual(manager.disposeSession('t-b'), {}) // unknown is still success
      return `pid ${pid} exited`
    })

    await step('remaining session still works after another session is disposed', async () => {
      const polled = manager.poll(['t-c'], {})
      assert.equal(polled[0].status.connected, true)
      const result = await manager.send({ session: 't-c', base64: b64('STILL-ALIVE') })
      assert.ok(result.next > polled[0].next)
      const status = await manager.close('t-c')
      assert.equal(status.connected, false)
      manager.disposeSession('t-c')
      manager.disposeSession('t-a')
      assert.equal(manager.sessions.size, 0)
    })

    await step('a killed bridge is detected and respawns on the next open', async () => {
      const opened = await manager.open({ session: 't-r', port: 'COM1', baudRate: 115200 })
      assert.equal(opened.connected, true)
      const bridge = manager.getSession('t-r').bridge
      const firstPid = bridge.pid
      assert.ok(firstPid > 0)

      process.kill(firstPid)
      await waitFor(() => bridge.child === null && bridge.ready === false, 10_000, 'bridge exit detection')
      const offline = manager.getSession('t-r').status()
      assert.equal(offline.exists, true)
      assert.equal(offline.connected, false)
      assert.equal(offline.ready, false)
      assert.ok(
        manager.getSession('t-r').log.entries.some((entry) => entry.kind === 'err' && /exited/.test(entry.text)),
        'exit should be logged as an err entry',
      )

      const reopened = await manager.open({ session: 't-r', port: 'COM1', baudRate: 115200 })
      assert.equal(reopened.connected, true)
      assert.notEqual(bridge.pid, firstPid)
      assert.ok(bridge.pid > 0)
      const secondPid = bridge.pid
      manager.disposeSession('t-r')
      assert.equal(manager.sessions.size, 0)
      return `pid ${firstPid} → respawned pid ${secondPid}`
    })

    await step('PowerShell bridge itself defaults omitted open settings to 1500000 / None', async () => {
      // The host normally sends explicit values; this drives the helper's own
      // fallback to prove the bridge protocol defaults independently.
      const bridge = new SerialBridge()
      try {
        const opened = await bridge.request(
          { op: 'open', port: 'COM3' },
          (event) => event.type === 'opened' || event.type === 'error',
          20_000,
        )
        assert.equal(opened.port, 'COM3')
        assert.equal(opened.baudRate, 1_500_000)
        assert.equal(opened.handshake, 'None')
        assert.equal(opened.dataBits, 8)
        assert.equal(opened.parity, 'None')
        assert.equal(opened.stopBits, 'One')
        await bridge.request({ op: 'close' }, (event) => event.type === 'closed' || event.type === 'error', 10_000)
      } finally {
        bridge.dispose()
      }
      return 'COM3 opened at helper-default 1500000 / None'
    })

    // ── HTTP surface on a real node:http server ────────────────────────────
    httpManager = new SerialManager()
    const handler = createHandler(httpManager)
    server = http.createServer(handler)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const base = `http://127.0.0.1:${server.address().port}`
    const root = `${base}/dsh-serial-sifarcrt`

    await step('OPTIONS is 204 with CORS headers', async () => {
      const response = await api(root, '/open', { method: 'OPTIONS' })
      assert.equal(response.status, 204)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/)
      assert.equal(response.text, '')
    })

    await step('GET /ports returns sorted ports through the handler', async () => {
      const response = await api(root, '/ports')
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.json.ok, true)
      const names = response.json.ports.map((port) => port.name)
      for (const wanted of COM_PORTS) assert.ok(names.includes(wanted), `missing ${wanted} in [${names}]`)
      assert.equal(response.json.enumerator.ready, true)
      assert.equal(response.json.enumerator.error, null)
      return names.join(', ')
    })

    await step('POST /open validates its body and opens COM1', async () => {
      const noSession = await postJson(root, '/open', { port: 'COM1' })
      assert.equal(noSession.status, 200)
      assert.equal(noSession.json.ok, false)
      assert.match(noSession.json.error, /session/)

      const badPort = await postJson(root, '/open', { session: 'http-1', port: 'bad port!' })
      assert.equal(badPort.status, 200)
      assert.equal(badPort.json.ok, false)

      const opened = await postJson(root, '/open', {
        session: 'http-1',
        port: 'COM1',
        baudRate: 115200,
        dataBits: 8,
        parity: 'None',
        stopBits: 'One',
        handshake: 'XOnXOff',
      })
      assert.equal(opened.status, 200)
      assert.equal(opened.json.ok, true)
      assert.equal(opened.json.status.connected, true)
      assert.equal(opened.json.status.config.port, 'COM1')
    })

    await step('GET /state reports the session', async () => {
      const response = await api(root, '/state')
      assert.equal(response.status, 200)
      assert.equal(response.json.ok, true)
      assert.ok(Array.isArray(response.json.sessions))
      const found = response.json.sessions.find((entry) => entry.id === 'http-1')
      assert.ok(found)
      assert.equal(found.connected, true)
      assert.equal(response.json.report, null)
      assert.ok(Array.isArray(response.json.ports))
    })

    await step('POST /send and /poll move the log sequence incrementally', async () => {
      const sent = await postJson(root, '/send', { session: 'http-1', base64: b64('HTTP-SEND\r\n'), label: 'http' })
      assert.equal(sent.status, 200)
      assert.equal(sent.json.ok, true)
      assert.ok(Number.isInteger(sent.json.next))
      const next = sent.json.next

      const malformed = await postJson(root, '/send', { session: 'http-1', base64: '!!!!' })
      assert.equal(malformed.status, 200)
      assert.equal(malformed.json.ok, false)

      const polled = await postJson(root, '/poll', { sessions: ['http-1'], since: { 'http-1': next - 1 } })
      assert.equal(polled.status, 200)
      assert.equal(polled.json.ok, true)
      assert.equal(polled.json.sessions.length, 1)
      const entry = polled.json.sessions[0]
      assert.equal(entry.id, 'http-1')
      assert.equal(entry.next, next)
      assert.equal(entry.lines.length, 1)
      assert.equal(entry.lines[0].kind, 'tx')
      assert.equal(entry.lines[0].text, 'http')
      assert.equal(entry.lines[0].b64, b64('HTTP-SEND\r\n'))

      const tail = await postJson(root, '/poll', { sessions: ['http-1'], since: { 'http-1': -1 } })
      assert.equal(tail.json.sessions[0].lines.length, 2) // opened sys + tx
      const incremental = await postJson(root, '/poll', { sessions: ['http-1'], since: { 'http-1': entry.lines[0].seq } })
      assert.equal(incremental.json.sessions[0].lines.length, 0)
      assert.equal(incremental.json.sessions[0].next, entry.lines[0].seq)
    })

    await step('POST /poll handles unknown sessions and malformed ids', async () => {
      const sizeBefore = httpManager.sessions.size
      const unknown = await postJson(root, '/poll', { sessions: ['ghost-http'], since: { 'ghost-http': -1 } })
      assert.equal(unknown.status, 200)
      assert.equal(unknown.json.ok, true)
      assert.deepEqual(unknown.json.sessions[0], { id: 'ghost-http', status: { exists: false }, lines: [], next: 0 })
      assert.equal(httpManager.sessions.size, sizeBefore)

      const malformed = await postJson(root, '/poll', { sessions: ['../evil'], since: {} })
      assert.equal(malformed.status, 200)
      assert.equal(malformed.json.ok, false)
      assert.match(malformed.json.error, /invalid session id/)
    })

    await step('POST /clear empties the log and reports the stable sequence', async () => {
      const before = await postJson(root, '/poll', { sessions: ['http-1'], since: { 'http-1': -1 } })
      const nextBefore = before.json.sessions[0].next
      const cleared = await postJson(root, '/clear', { session: 'http-1' })
      assert.equal(cleared.json.ok, true)
      assert.equal(cleared.json.next, nextBefore)
      const afterClear = await postJson(root, '/poll', { sessions: ['http-1'], since: { 'http-1': -1 } })
      assert.deepEqual(afterClear.json.sessions[0].lines, [])
    })

    await step('POST /close then /send fails cleanly', async () => {
      const closed = await postJson(root, '/close', { session: 'http-1' })
      assert.equal(closed.status, 200)
      assert.equal(closed.json.ok, true)
      assert.equal(closed.json.status.connected, false)
      const sent = await postJson(root, '/send', { session: 'http-1', base64: b64('x') })
      assert.equal(sent.status, 200)
      assert.equal(sent.json.ok, false)
      assert.match(sent.json.error, /not open/)
    })

    await step('POST /open without baudRate/handshake uses 1500000 / None defaults', async () => {
      const defaulted = await postJson(root, '/open', { session: 'http-1', port: 'COM3' })
      assert.equal(defaulted.status, 200)
      assert.equal(defaulted.json.ok, true)
      assert.equal(defaulted.json.status.config.baudRate, 1_500_000)
      assert.equal(defaulted.json.status.config.handshake, 'None')

      const explicit = await postJson(root, '/open', {
        session: 'http-1',
        port: 'COM3',
        baudRate: 9600,
        handshake: 'RequestToSend',
      })
      assert.equal(explicit.status, 200)
      assert.equal(explicit.json.ok, true)
      assert.equal(explicit.json.status.config.baudRate, 9600)
      assert.equal(explicit.json.status.config.handshake, 'RequestToSend')
      return 'HTTP default 1500000/None · explicit 9600/RequestToSend wins'
    })

    await step('POST /report stores state and writes the tmp report file', async () => {
      const diagnostics = {
        at: 1760000000000,
        href: 'http://127.0.0.1:7798/',
        rightTab: { registered: true, error: null },
        slotBody: true,
        slotTitle: true,
        domGuide: { found: true, hasMine: true, rows: ['sifarCRT'] },
        portsProbe: { ok: true, count: 3 },
      }
      const posted = await postJson(root, '/report', diagnostics)
      assert.equal(posted.status, 200)
      assert.equal(posted.json.ok, true)
      const state = await api(root, '/state')
      assert.deepEqual(state.json.report, diagnostics)
      const onDisk = JSON.parse(await readFile(REPORT_PATH, 'utf8'))
      assert.deepEqual(onDisk, diagnostics)
      return REPORT_PATH
    })

    await step('POST /dispose drops the session; unknown dispose still succeeds', async () => {
      const disposed = await postJson(root, '/dispose', { session: 'http-1' })
      assert.equal(disposed.status, 200)
      assert.equal(disposed.json.ok, true)
      assert.equal(httpManager.getSession('http-1'), undefined)
      const again = await postJson(root, '/dispose', { session: 'http-1' })
      assert.equal(again.json.ok, true)
      const state = await api(root, '/state')
      assert.deepEqual(state.json.sessions, [])
    })

    await step('unknown action 404, GET on a POST endpoint 405, invalid JSON body handled', async () => {
      const unknown = await api(root, '/nope')
      assert.equal(unknown.status, 404)
      assert.equal(unknown.json.ok, false)
      const wrongMethod = await api(root, '/open')
      assert.equal(wrongMethod.status, 405)
      assert.equal(wrongMethod.json.ok, false)
      const badJson = await api(root, '/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
      assert.equal(badJson.status, 200)
      assert.equal(badJson.json.ok, false)
      assert.match(badJson.json.error, /invalid JSON/)
      const notObject = await api(root, '/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[1,2,3]',
      })
      assert.equal(notObject.status, 200)
      assert.equal(notObject.json.ok, false)
    })

    await step('rejects request bodies larger than 1MB', async () => {
      const huge = JSON.stringify({ session: 'http-1', base64: 'A'.repeat(1_100_000) })
      const response = await api(root, '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: huge,
      })
      assert.equal(response.status, 200)
      assert.equal(response.json.ok, false)
      assert.match(response.json.error, /too large/)
      return `${huge.length} byte body rejected`
    })

    await step('createHandler rejects a non-manager', () => {
      assert.throws(() => createHandler({}), /SerialManager/)
    })
  } finally {
    if (httpManager !== null) httpManager.dispose()
    if (server !== null) {
      await new Promise((resolve) => server.close(resolve))
    }
    manager.dispose()
    clearTimeout(watchdog)
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((entry) => entry.ok).length
  const failed = failures
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`sifarCRT host test: ${passed}/${results.length} steps passed, ${failed} failed`)
  console.log('─'.repeat(64))
  if (failed > 0) {
    process.exitCode = 1
    console.error('FAILED')
  } else {
    console.log('ALL HOST TESTS PASSED')
  }
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
