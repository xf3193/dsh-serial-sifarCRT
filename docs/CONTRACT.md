# sifarCRT — build contract

This file is the frozen interface between the Host half (`lib/index.js` + `lib/serial-helper.ps1`)
and the Client half (`lib/client.js`). Do not change it unilaterally: if something must change,
message the Lead first and update this file.

## Package facts

- Package dir: `D:\dsh\plugin\sifarCRT`
- Package name / Client module id: `dsh-serial-sifarcrt`
- Host entry: `lib/index.js` — ESM, exports `apply(ctx)` (plus `inject` if desired). No imports of
  `@deepseek-ai/*`, no native module, no build step. Node builtins only.
- Client entry: `lib/client.js` — pre-built lazy-CJS factory form:
  `window.__ModuleLoader__.load({ id: "dsh-serial-sifarcrt", factory: (require) => { ... return module.exports } })`,
  React via `require("react")`, exports `apply(ctx)` and `inject`.
- Bridge script: `lib/serial-helper.ps1`, spawned by the Host half with Windows PowerShell 5.1.
- No serial hardware is guaranteed, but this machine currently has COM1, COM3, COM6.

## HTTP surface (Host half registers it on `ctx.webServer`)

Route prefix: `/dsh-serial-sifarcrt` (`kind: 'prefix'`). JSON in/out, `access-control-allow-origin: *`,
`OPTIONS` → 204. Handled failures return HTTP 200 with `{ "ok": false, "error": "<message>" }`.
Success always carries `"ok": true`. Max body 1 MB. All responses `cache-control: no-store`.

### `GET /dsh-serial-sifarcrt/ports`
```json
{ "ok": true,
  "ports": [{ "name": "COM3", "description": "USB Serial Port" }],
  "enumerator": { "ready": true, "error": null } }
```
`ports` is sorted by name; `description` may be `""`. Enumeration uses a lazily started
inventory PowerShell bridge (never a session's bridge), retries starting it if it died.

### `POST /dsh-serial-sifarcrt/open`
Body:
```json
{ "session": "t-abc123", "port": "COM3", "baudRate": 1500000, "dataBits": 8,
  "parity": "None", "stopBits": "One", "handshake": "None", "dtr": true, "rts": true }
```
- `session`: required, `/^[A-Za-z0-9_-]{1,64}$/`. Creates the session on first use.
- `port`: required, `/^[A-Za-z0-9._\\/-]{1,64}$/`.
- `baudRate`: integer, default 1500000, clamped to 50..1500000. **1500000 is the allowed maximum.**
- `dataBits`: 5..8, default 8.
- `parity`: one of `None|Odd|Even|Mark|Space` (case-insensitive), default `None`.
- `stopBits`: `One|OnePointFive|Two`, default `One`.
- `handshake`: `None|XOnXOff|RequestToSend|RequestToSendXOnXOff`, default `None` (无流控).
- `dtr`/`rts`: booleans, default true.
Response: `{ "ok": true, "status": <Status> }`; a failure keeps the previous port state and returns
`{ "ok": false, "error": "..." }`.

### `POST /dsh-serial-sifarcrt/close`
Body `{ "session": "..." }`. Closes the port, keeps the session and its log.
Response `{ "ok": true, "status": <Status> }`.

### `POST /dsh-serial-sifarcrt/dispose`
Body `{ "session": "..." }`. Closes the port, kills the session bridge, drops session + log.
Response `{ "ok": true }`. Unknown session is still `ok: true`.

### `POST /dsh-serial-sifarcrt/send`
Body `{ "session": "...", "base64": "...", "label": "optional text" }`. Base64 of the exact bytes
to transmit. Appends a `tx` log entry. Fails with `ok:false` when the port is not open.
Response `{ "ok": true, "next": <number> }`.

### `POST /dsh-serial-sifarcrt/clear`
Body `{ "session": "..." }`. Clears the session log. Response `{ "ok": true, "next": <number> }`.

### `POST /dsh-serial-sifarcrt/poll`
Body:
```json
{ "sessions": ["t-1", "t-2"], "since": { "t-1": 42, "t-2": -1 } }
```
- `sessions` optional, defaults to the keys of `since`.
- `since[id]` missing or negative → return the last 500 log entries.
- A session the Host does not know returns `{ "id": "...", "status": { "exists": false },
  "lines": [], "next": 0 }` and must NOT create it.
Response:
```json
{ "ok": true, "sessions": [
  { "id": "t-1", "status": <Status>, "lines": [<Entry>...], "next": 43 }
] }
```
`next` is the session's current log sequence number.

### `POST /dsh-serial-sifarcrt/report`
Body: any JSON object the Client wants to persist for mount diagnostics. The Host keeps the last
one in memory (returned by `GET /state`) and best-effort writes it as JSON to
`os.tmpdir()/dsh-serial-sifarcrt-report.json`. Response `{ "ok": true }`.

### `GET /dsh-serial-sifarcrt/state`
`{ "ok": true, "report": <last report|null>, "sessions": [<Status>...], "ports": [...] }` — debug aid.

### Status
```json
{ "exists": true, "ready": true, "connected": true,
  "config": { "port": "COM3", "baudRate": 115200, "dataBits": 8, "parity": "None",
              "stopBits": "One", "handshake": "XOnXOff" },
  "ports": [{ "name": "COM3", "description": "..." }],
  "lastError": null }
```
`config` is `null` when no port is open. `exists` is `false` for unknown sessions.

### Entry (log line)
```json
{ "seq": 12, "at": 1760000000000, "kind": "rx" | "tx" | "sys" | "err",
  "b64": "<base64 bytes>",        // present for rx/tx only
  "text": "optional label" }      // tx label, or sys/err message
```
Host retains at most 4000 entries / 8 MB per session. `seq` is per session, starts at 1, monotonic.

## PowerShell bridge protocol (one child per serial session)

NDJSON both ways. Commands in: `{op:"open"|"close"|"write"|"list"|"ping"|"shutdown", ...}` with
`port/baudRate/dataBits/parity/stopBits/handshake/dtr/rts` for `open` and `base64` for `write`.
Events out: `ready` (with `pid`, `ports`), `ports`, `opened`, `closed`, `written` (with `count`),
`data` (with `base64`), `error` (with `message`, optional `op`), `pong`, `bye`.
The bridge must default `handshake` to `None` and `baudRate` to 1500000 when omitted, set DTR/RTS true by default,
and close the port (emitting `error`) when reads start throwing after a device disappears.

## Ownership

| Path | Owner |
|---|---|
| `lib/index.js`, `lib/serial-helper.ps1`, `test/**` | host-dev |
| `lib/client.js` | client-dev |
| `package.json`, `cordis.patch.yml`, `locale/**`, `icon.svg`, `README.md`, `LICENSE`, `CONTRACT.md` | Lead |

Both halves are installed and verified by the Lead. Do not run `plugin_manager` yourself.
