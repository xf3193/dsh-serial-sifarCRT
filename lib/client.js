/**
 * sifarCRT — client half (browser bundle).
 *
 * Ships pre-built in the module system's lazy-CJS factory form: running this
 * script only registers the factory below, and the module body materializes on
 * first use. `require("react")` resolves against the shell's frozen platform
 * table, so the package declares no `dsh.client.external` entries.
 *
 * The whole feature is one native right-sidebar tab type:
 *   - a guide row in the right column's empty state that opens the panel,
 *   - the panel itself: a multi-session serial console with an ANSI-colored
 *     receive log and an in-log terminal input line.
 *
 * The ANSI engine (`createAnsiState` / `ansiFeed`) is exported unchanged from
 * the parser the log renderer uses, so the host-side verifier can drive it
 * without a browser.
 *
 * All serial I/O happens in the host half (lib/index.js). This file only
 * renders state and talks to the `/dsh-serial-sifarcrt` HTTP route.
 *
 * The registration pattern (window.__ModuleLoader__.load factory, ctx.inject on
 * `sidebarRightTabs`, keyed `sidebar.right.pane.tab[.title]` slots) follows the
 * MIT-licensed dsh-serial-debugger client bundle bundled with this DSH version.
 */
window.__ModuleLoader__.load({
  id: "dsh-serial-sifarcrt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Host route base. Overridable for non-loopback-HTTP page origins. */
    const BASE = (() => {
      const override = globalThis.__DSH_SIFAR_CRT_BASE__;
      return typeof override === "string" && override !== "" ? override : "/dsh-serial-sifarcrt";
    })();

    /** Log entries retained in the DOM per tab (host retains much more). */
    const RENDER_LIMIT = 2000;
    /** localStorage keys (exactly as specified). */
    const TABS_KEY = "sifarCRT.tabs.v1";
    const COMMANDS_KEY_PREFIX = "sifarCRT.commands.v1.";
    const ENDING_KEY_PREFIX = "sifarCRT.ending.v1.";
    /** Poll cadence while the host is healthy, and the failure backoff. */
    const POLL_INTERVAL = 250;
    /** A log is "at bottom" within this many pixels of its scroll end. */
    const BOTTOM_SLOP = 8;

    /**
     * Near-bottom test shared by every scroll handler (exported for tests so
     * the harness and the UI agree on the exact threshold).
     */
    function isLogAtBottom(scrollTop, scrollHeight, clientHeight) {
      const top = Number(scrollTop);
      const height = Number(scrollHeight);
      const client = Number(clientHeight);
      if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(client)) return false;
      return height - top - client < BOTTOM_SLOP;
    }

    /** Cap the number of styled runs stored on one rx entry. */
    const ANSI_MAX_SEGS = 400;

    /** 串口设置 dialog's baud-rate datalist presets (the field is editable). */
    const BAUD_PRESETS = [9600, 115200, 1500000];
    const DATA_BITS = [5, 6, 7, 8];
    const PARITY_VALUES = ["None", "Odd", "Even", "Mark", "Space"];
    const STOP_VALUES = ["One", "OnePointFive", "Two"];
    const HANDSHAKE_VALUES = ["None", "XOnXOff", "RequestToSend", "RequestToSendXOnXOff"];
    const PARITY_LETTER = { None: "N", Odd: "O", Even: "E", Mark: "M", Space: "S" };
    const STOP_SHORT = { One: "1", OnePointFive: "1.5", Two: "2" };
    /** Persisted console line endings (no "无": Enter always terminates). */
    const CONSOLE_ENDINGS = [
      { id: "cr", label: "CR", text: "\r" },
      { id: "lf", label: "LF", text: "\n" },
      { id: "crlf", label: "CRLF", text: "\r\n" },
    ];
    const CONSOLE_ENDING_IDS = new Set(CONSOLE_ENDINGS.map((item) => item.id));
    const CONSOLE_ENDING_OPTIONS = CONSOLE_ENDINGS.map((item) => ({ value: item.id, label: item.label }));
    const LINE_ENDINGS = [
      { id: "none", label: "无", text: "" },
      { id: "cr", label: "CR", text: "\r" },
      { id: "lf", label: "LF", text: "\n" },
      { id: "crlf", label: "CRLF", text: "\r\n" },
    ];
    const ENDING_IDS = new Set(LINE_ENDINGS.map((item) => item.id));
    const PARITY_OPTIONS = [
      { value: "None", label: "无" },
      { value: "Odd", label: "奇" },
      { value: "Even", label: "偶" },
      { value: "Mark", label: "标记" },
      { value: "Space", label: "空格" },
    ];
    const HANDSHAKE_OPTIONS = [
      { value: "None", label: "无" },
      { value: "XOnXOff", label: "XON/XOFF" },
      { value: "RequestToSend", label: "RTS/CTS" },
      { value: "RequestToSendXOnXOff", label: "XON/XOFF+RTS/CTS" },
    ];
    /** Longer form used by the config summary ("无流控" instead of "无"). */
    const HANDSHAKE_SUMMARY = {
      None: "无流控",
      XOnXOff: "XON/XOFF",
      RequestToSend: "RTS/CTS",
      RequestToSendXOnXOff: "XON/XOFF+RTS/CTS",
    };
    const STOP_OPTIONS = [
      { value: "One", label: "1" },
      { value: "OnePointFive", label: "1.5" },
      { value: "Two", label: "2" },
    ];
    const ENDING_OPTIONS = LINE_ENDINGS.map((item) => ({ value: item.id, label: item.label }));

    const COLORS = {
      label: "var(--dsw-alias-label-primary, #1f2329)",
      labelSecondary: "var(--dsw-alias-label-secondary, #646a73)",
      border: "var(--dsw-alias-border-l1, #dee0e3)",
      borderStrong: "var(--dsw-alias-border-l2, #c9cdd4)",
      bg: "var(--dsw-alias-bg-base, #ffffff)",
      bgLayer: "var(--dsw-alias-bg-layer-1, #f7f8fa)",
      bgLayer2: "var(--dsw-alias-bg-layer-2, #f2f3f5)",
      brand: "var(--dsw-alias-brand-primary, #3370ff)",
      success: "var(--dsw-alias-state-success-primary, #34c724)",
      error: "var(--dsw-alias-state-error-primary, #f54a45)",
      warn: "var(--dsw-alias-state-warn-primary, #ff8800)",
      idle: "var(--dsw-alias-state-idle-primary, #bbbfc4)",
    };

    const MONO = "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
    const ROW_HEIGHT = 24;
    const EMPTY_LINES = [];
    const EMPTY_COMMANDS = [];

    // ── generic helpers ──────────────────────────────────────────────────

    /** Error text from anything thrown, without throwing itself. */
    function messageOf(error) {
      try {
        if (error === null || error === undefined) return "未知错误";
        if (typeof error === "string") return error;
        if (typeof error.message === "string" && error.message !== "") return error.message;
        return String(error);
      } catch (error2) {
        return "未知错误";
      }
    }

    function safeHref() {
      try {
        if (typeof location !== "undefined" && location && typeof location.href === "string") return location.href;
      } catch (error) {
        // Non-browser context.
      }
      return "";
    }

    function newSessionId() {
      try {
        if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
          const id = crypto.randomUUID();
          if (typeof id === "string" && id !== "") return id;
        }
      } catch (error) {
        // Fall through to the deterministic-enough fallback.
      }
      return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    function newCommandId() {
      try {
        if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") return "cmd-" + crypto.randomUUID();
      } catch (error) {
        // Fall through.
      }
      return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    // ── localStorage (guarded: sandboxed contexts may throw) ────────────

    function storageSafe() {
      try {
        return typeof localStorage === "undefined" ? null : localStorage;
      } catch (error) {
        return null;
      }
    }

    function readJson(key, fallback) {
      try {
        const store = storageSafe();
        if (store === null) return fallback;
        const raw = store.getItem(key);
        if (typeof raw !== "string" || raw === "") return fallback;
        const value = JSON.parse(raw);
        return value === null || value === undefined ? fallback : value;
      } catch (error) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        const store = storageSafe();
        if (store === null) return;
        store.setItem(key, JSON.stringify(value));
      } catch (error) {
        // Quota or privacy mode: persistence is best effort.
      }
    }

    function removeStored(key) {
      try {
        const store = storageSafe();
        if (store !== null) store.removeItem(key);
      } catch (error) {
        // Ignore.
      }
    }

    // ── byte / text helpers ─────────────────────────────────────────────

    function bytesToB64(bytes) {
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    function b64ToBytes(b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    function b64ByteLength(b64) {
      if (typeof b64 !== "string" || b64 === "") return 0;
      const length = b64.length;
      let padding = 0;
      if (b64.charAt(length - 1) === "=") padding += 1;
      if (length > 1 && b64.charAt(length - 2) === "=") padding += 1;
      return Math.max(0, Math.floor((length * 3) / 4) - padding);
    }

    function bytesToHex(bytes) {
      const parts = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) parts[i] = bytes[i].toString(16).padStart(2, "0").toUpperCase();
      return parts.join(" ");
    }

    const textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: false });

    function bytesToText(bytes) {
      if (textDecoder !== null) {
        try {
          return textDecoder.decode(bytes);
        } catch (error) {
          // Fall through to byte-wise decoding.
        }
      }
      let out = "";
      for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
      return out;
    }

    function encodeUtf8(text) {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
      const units = [];
      for (let i = 0; i < text.length; i += 1) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          const low = text.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
            i += 1;
          }
        }
        if (code < 0x80) units.push(code);
        else if (code < 0x800) units.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code < 0x10000) units.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        else units.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
      return new Uint8Array(units);
    }

    function endingText(endingId) {
      const found = LINE_ENDINGS.find((item) => item.id === endingId);
      return found === undefined ? "" : found.text;
    }

    function endingLabel(endingId) {
      const found = LINE_ENDINGS.find((item) => item.id === endingId);
      return found === undefined ? "无" : found.label;
    }

    /** Encode a text payload plus its line ending as base64. */
    function encodeTextBase64(text, endingId) {
      const payload = String(text === undefined || text === null ? "" : text) + endingText(endingId);
      if (payload === "") throw new Error("请输入要发送的内容");
      return bytesToB64(encodeUtf8(payload));
    }

    /** Plain (ANSI-free) display body for one retained log entry. */
    function formatLineBody(line) {
      if (typeof line.b64 === "string") {
        if (line.kind === "rx" && typeof line.text === "string") return line.text;
        try {
          return bytesToText(b64ToBytes(line.b64));
        } catch (error) {
          return "（无法解码的字节）";
        }
      }
      const marker = line.kind === "err" ? "! " : "· ";
      return marker + (typeof line.text === "string" ? line.text : "");
    }

    /** One retained log entry as display text (used by 复制 / 保存日志). */
    function formatLine(line, hexView, showTime) {
      const stamp = showTime && typeof line.at === "number" ? formatStamp(line.at) : "";
      if (hexView && typeof line.b64 === "string") {
        let body;
        try {
          body = bytesToHex(b64ToBytes(line.b64));
        } catch (error) {
          body = "（无法解码的字节）";
        }
        return stamp + body;
      }
      return stamp + formatLineBody(line);
    }

    function formatStamp(at) {
      try {
        const date = new Date(at);
        const clock = date.toLocaleTimeString("zh-CN", { hour12: false });
        return "[" + clock + "." + String(date.getMilliseconds()).padStart(3, "0") + "] ";
      } catch (error) {
        return "";
      }
    }

    function formatLines(lines, hexView, showTime) {
      return lines.map((line) => formatLine(line, hexView, showTime));
    }

    /**
     * The log view shows only what the device sent back: locally-sent `tx`
     * entries never render and never appear in 复制 / 保存日志. Shared by both so
     * the screen and the saved text always match.
     */
    function visibleLines(lines) {
      if (!Array.isArray(lines)) return [];
      return lines.filter((line) => line !== null && line !== undefined && line.kind !== "tx");
    }

    // ── log keyword search helpers (pure; shared with the renderer) ─────

    /** Maximum stored matches (keeps huge logs responsive). */
    const SEARCH_LIMIT = 500;

    /** Highlight styles for matches; the current one is stronger. */
    const SEARCH_MARK_STYLE = { background: "rgba(255, 190, 0, 0.32)", color: "inherit", borderRadius: 2, padding: 0 };
    const SEARCH_MARK_CURRENT_STYLE = { background: "#ffb020", color: "#1f2329", borderRadius: 2, padding: 0, boxShadow: "0 0 0 1px rgba(255, 136, 0, 0.9)" };

    /** Blinking block caret, driven by CSS so it cannot be throttled by JS. */
    const CARET_CSS = "@keyframes sifar-crt-caret-blink{0%,49%{opacity:1}50%,100%{opacity:0}}.sifar-crt-caret{display:inline-block;width:8px;height:14px;margin-left:2px;vertical-align:text-bottom;background:var(--dsw-alias-label-primary,#e6e6e6);border-radius:1px;animation:sifar-crt-caret-blink 1s steps(1,end) infinite}";

    /** The exact body text the log renders for one entry (no timestamp). */
    function lineDisplayText(line) {
      if (!line || typeof line !== "object") return "";
      if (line.kind === "rx" && Array.isArray(line.segs) && line.segs.length > 0) {
        let out = "";
        for (const seg of line.segs) out += String(seg.t === undefined || seg.t === null ? "" : seg.t);
        return out;
      }
      return formatLineBody(line);
    }

    /** Styled runs of one entry as displayed (ANSI segments, or one plain run). */
    function lineStyleRuns(line) {
      if (!line || typeof line !== "object") return [];
      if (line.kind === "rx" && Array.isArray(line.segs) && line.segs.length > 0) {
        const runs = [];
        let offset = 0;
        for (const seg of line.segs) {
          const text = String(seg.t === undefined || seg.t === null ? "" : seg.t);
          if (text !== "") runs.push({ t: text, s: seg.s && typeof seg.s === "object" ? seg.s : {}, start: offset });
          offset += text.length;
        }
        return runs;
      }
      const text = lineDisplayText(line);
      return text === "" ? [] : [{ t: text, s: null, start: 0 }];
    }

    /**
     * Case-insensitive keyword matches over the visible (non-tx) entries.
     * Offsets are relative to each entry's rendered body text. Capped at
     * `limit` (default 500) and reports `capped`.
     */
    function findLogMatches(lines, query, limit) {
      const matches = [];
      const needle = typeof query === "string" ? query.toLowerCase() : "";
      const cap = typeof limit === "number" && limit > 0 ? limit : SEARCH_LIMIT;
      if (needle === "" || !Array.isArray(lines)) return { matches, capped: false };
      for (const line of lines) {
        if (!line || typeof line !== "object" || line.kind === "tx") continue;
        const text = lineDisplayText(line);
        if (text === "") continue;
        const lower = text.toLowerCase();
        let at = lower.indexOf(needle);
        while (at >= 0) {
          if (matches.length >= cap) return { matches, capped: true };
          matches.push({ lineKey: line.__k, start: at, end: at + needle.length, index: matches.length });
          at = lower.indexOf(needle, at + needle.length);
        }
      }
      return { matches, capped: false };
    }

    /**
     * Split styled runs at match boundaries so ANSI segments can be wrapped in
     * <mark>. A match spanning two adjacent segments is split across both.
     */
    function splitRunsByMatches(runs, ranges) {
      const out = [];
      if (!Array.isArray(runs)) return out;
      if (!Array.isArray(ranges) || ranges.length === 0) {
        for (const run of runs) out.push({ t: run.t, s: run.s, matchIndex: null });
        return out;
      }
      let rangeIdx = 0;
      for (const run of runs) {
        const runStart = run.start;
        const runEnd = runStart + run.t.length;
        let local = 0;
        while (local < run.t.length) {
          while (rangeIdx < ranges.length && ranges[rangeIdx].end <= runStart + local) rangeIdx += 1;
          const abs = runStart + local;
          if (rangeIdx < ranges.length && ranges[rangeIdx].start <= abs && ranges[rangeIdx].end > abs) {
            const endAbs = Math.min(ranges[rangeIdx].end, runEnd);
            if (endAbs > abs) out.push({ t: run.t.slice(local, endAbs - runStart), s: run.s, matchIndex: ranges[rangeIdx].index });
            local = endAbs - runStart;
          } else {
            let stopAbs = runEnd;
            if (rangeIdx < ranges.length) stopAbs = Math.min(stopAbs, ranges[rangeIdx].start);
            if (stopAbs <= abs) stopAbs = Math.min(runEnd, abs + 1);
            if (stopAbs > abs) out.push({ t: run.t.slice(local, stopAbs - runStart), s: run.s, matchIndex: null });
            local = stopAbs - runStart;
          }
        }
      }
      return out;
    }

    // ── ANSI SGR engine (pure; exported byte-for-byte as the renderer uses) ─

    /**
     * xterm/VSCode dark terminal 16-color palette. These are terminal semantics
     * (the device decides the colors), so they are literal colors rather than
     * DSH theme tokens. Order: normal 0-7, then bright 8-15.
     */
    const ANSI_PALETTE = [
      "#000000", "#cd3131", "#0dbc79", "#e5e510",
      "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
      "#666666", "#f14c4c", "#23d18b", "#f5f543",
      "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
    ];

    function ansiRgbToHex(r, g, b) {
      const clamp = (value) => {
        const rounded = Math.round(Number(value));
        if (!Number.isFinite(rounded)) return 0;
        return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
      };
      const part = (value) => clamp(value).toString(16).padStart(2, "0");
      return "#" + part(r) + part(g) + part(b);
    }

    /** xterm 256-color index → CSS color (16 palette + 6³ cube + grayscale). */
    function ansiColor256(index) {
      const numeric = Number(index);
      if (!Number.isFinite(numeric)) return null;
      const value = Math.max(0, Math.min(255, Math.floor(numeric)));
      if (value < 16) return ANSI_PALETTE[value];
      if (value < 232) {
        const cube = value - 16;
        const red = Math.floor(cube / 36);
        const green = Math.floor((cube % 36) / 6);
        const blue = cube % 6;
        const step = (channel) => (channel === 0 ? 0 : 55 + channel * 40);
        return ansiRgbToHex(step(red), step(green), step(blue));
      }
      const gray = 8 + (value - 232) * 10;
      return ansiRgbToHex(gray, gray, gray);
    }

    function defaultAnsiAttrs() {
      return {
        fg: null,
        bg: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        strike: false,
        reverse: false,
        hidden: false,
      };
    }

    /**
     * Fresh per-tab ANSI stream state: SGR attrs, pending partial escape, a
     * pending lone CR (for `\r\n` split across chunks), and a streaming UTF-8
     * decoder (multi-byte chars split across chunks).
     */
    function createAnsiState() {
      let decoder = null;
      try {
        decoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: false });
      } catch (error) {
        decoder = null;
      }
      return { decoder, pending: "", carryCR: false, attrs: defaultAnsiAttrs() };
    }

    function resetAnsiState(state) {
      if (!state || typeof state !== "object") return createAnsiState();
      const fresh = createAnsiState();
      state.decoder = fresh.decoder;
      state.pending = "";
      state.carryCR = false;
      state.attrs = fresh.attrs;
      return state;
    }

    /** Compose CSS for the current SGR attrs (only non-default keys are set). */
    function ansiCss(attrs) {
      const style = {};
      let fg = attrs.fg;
      let bg = attrs.bg;
      if (attrs.reverse) {
        const swap = fg;
        fg = bg;
        bg = swap;
      }
      if (fg !== null) style.color = fg;
      if (bg !== null) style.background = bg;
      if (attrs.bold) style.fontWeight = 600;
      if (attrs.dim) style.opacity = 0.6;
      if (attrs.italic) style.fontStyle = "italic";
      const decoration = [];
      if (attrs.underline) decoration.push("underline");
      if (attrs.strike) decoration.push("line-through");
      if (decoration.length > 0) style.textDecoration = decoration.join(" ");
      if (attrs.hidden) style.visibility = "hidden";
      return style;
    }

    /** Apply one SGR parameter list (the body of `ESC [ ... m`). */
    function applySgr(attrs, body) {
      const params = [];
      const pieces = body === "" ? ["0"] : body.split(";");
      for (const piece of pieces) {
        const trimmed = piece.trim();
        if (trimmed === "") {
          params.push(0);
          continue;
        }
        const numeric = Number(trimmed);
        params.push(Number.isFinite(numeric) ? Math.floor(numeric) : 0);
      }
      for (let index = 0; index < params.length; index += 1) {
        const code = params[index];
        if (code === 0) {
          Object.assign(attrs, defaultAnsiAttrs());
        } else if (code === 1) {
          attrs.bold = true;
        } else if (code === 2) {
          attrs.dim = true;
        } else if (code === 3) {
          attrs.italic = true;
        } else if (code === 4) {
          attrs.underline = true;
        } else if (code === 7) {
          attrs.reverse = true;
        } else if (code === 8) {
          attrs.hidden = true;
        } else if (code === 9) {
          attrs.strike = true;
        } else if (code === 21 || code === 22) {
          attrs.bold = false;
          if (code === 22) attrs.dim = false;
        } else if (code === 23) {
          attrs.italic = false;
        } else if (code === 24) {
          attrs.underline = false;
        } else if (code === 27) {
          attrs.reverse = false;
        } else if (code === 28) {
          attrs.hidden = false;
        } else if (code === 29) {
          attrs.strike = false;
        } else if (code >= 30 && code <= 37) {
          attrs.fg = ANSI_PALETTE[code - 30];
        } else if (code === 38 || code === 48) {
          const isForeground = code === 38;
          const mode = params[index + 1];
          if (mode === 5 && index + 2 < params.length) {
            const color = ansiColor256(params[index + 2]);
            if (color !== null) {
              if (isForeground) attrs.fg = color;
              else attrs.bg = color;
            }
            index += 2;
          } else if (mode === 2 && index + 4 < params.length) {
            const color = ansiRgbToHex(params[index + 2], params[index + 3], params[index + 4]);
            if (isForeground) attrs.fg = color;
            else attrs.bg = color;
            index += 4;
          }
        } else if (code === 39) {
          attrs.fg = null;
        } else if (code >= 40 && code <= 47) {
          attrs.bg = ANSI_PALETTE[code - 40];
        } else if (code === 49) {
          attrs.bg = null;
        } else if (code >= 90 && code <= 97) {
          attrs.fg = ANSI_PALETTE[code - 90 + 8];
        } else if (code >= 100 && code <= 107) {
          attrs.bg = ANSI_PALETTE[code - 100 + 8];
        }
        // All other SGR codes are intentionally ignored.
      }
    }

    /**
     * Feed one decoded text chunk through the ANSI state machine.
     *
     * Streaming: a partial escape at the end of a chunk is stored on `state`
     * and completed by the next call; a lone `\r` at the end of a chunk is
     * carried so a `\r\n` split across chunks normalizes to one `\n`.
     *
     * @returns {{segs: Array<{t: string, s: Object}>, clean: string}}
     *   `segs` are the styled runs for rendering, `clean` is the ANSI-free
     *   plain text for 复制 / 保存日志.
     */
    function ansiFeed(state, text) {
      if (!state || typeof state !== "object") state = createAnsiState();
      if (!state.attrs || typeof state.attrs !== "object") state.attrs = defaultAnsiAttrs();
      if (typeof state.pending !== "string") state.pending = "";
      const segs = [];
      let clean = "";
      let buffer = "";
      const flush = () => {
        if (buffer === "") return;
        if (segs.length >= ANSI_MAX_SEGS && segs.length > 0) {
          // Cap the styled runs but never lose text: merge into the last run.
          segs[segs.length - 1].t += buffer;
        } else {
          segs.push({ t: buffer, s: ansiCss(state.attrs) });
        }
        clean += buffer;
        buffer = "";
      };
      /**
       * Emit one normalized newline. The finished line keeps the SGR attrs that
       * were active for its text (flush first); afterwards the attrs reset so
       * the NEXT line starts with the default foreground. The device only
       * prefixes coloured lines with SGR, so kernel/plain lines must not inherit
       * the previous line's colour.
       */
      const emitNewline = () => {
        buffer += "\n";
        flush();
        state.attrs = defaultAnsiAttrs();
      };

      const source = state.pending + (typeof text === "string" ? text : text === undefined || text === null ? "" : String(text));
      state.pending = "";
      let index = 0;
      while (index < source.length) {
        if (state.carryCR) {
          state.carryCR = false;
          if (source.charAt(index) === "\n") {
            emitNewline();
            index += 1;
            continue;
          }
          emitNewline();
          // Fall through and handle the current character normally.
        }
        const ch = source.charAt(index);
        if (ch === "\r") {
          if (index + 1 < source.length) {
            if (source.charAt(index + 1) === "\n") index += 2;
            else index += 1;
          } else {
            state.carryCR = true;
            index += 1;
            continue;
          }
          emitNewline();
          continue;
        }
        if (ch === "\x1b") {
          flush();
          const next = index + 1 < source.length ? source.charAt(index + 1) : "";
          if (next === "") {
            state.pending = source.slice(index);
            index = source.length;
            break;
          }
          if (next === "[") {
            let finalAt = index + 2;
            while (finalAt < source.length) {
              const code = source.charCodeAt(finalAt);
              if (code >= 0x40 && code <= 0x7e) break;
              finalAt += 1;
            }
            if (finalAt >= source.length) {
              state.pending = source.slice(index);
              index = source.length;
              break;
            }
            const finalChar = source.charAt(finalAt);
            if (finalChar === "m") applySgr(state.attrs, source.slice(index + 2, finalAt));
            index = finalAt + 1;
            continue;
          }
          if (next === "]") {
            let scan = index + 2;
            let end = -1;
            while (scan < source.length) {
              const c = source.charAt(scan);
              if (c === "\x07") {
                end = scan + 1;
                break;
              }
              if (c === "\x1b") {
                if (scan + 1 >= source.length) {
                  end = -2;
                  break;
                }
                if (source.charAt(scan + 1) === "\\") {
                  end = scan + 2;
                  break;
                }
                end = scan + 1;
                break;
              }
              scan += 1;
            }
            if (end < 0) {
              state.pending = source.slice(index);
              index = source.length;
              break;
            }
            index = end;
            continue;
          }
          const nextCode = next.charCodeAt(0);
          if (nextCode >= 0x20 && nextCode <= 0x2f) {
            // ESC + intermediate bytes + final byte (e.g. charset selection).
            let scan = index + 1;
            while (scan < source.length) {
              const code = source.charCodeAt(scan);
              if (code >= 0x20 && code <= 0x2f) {
                scan += 1;
                continue;
              }
              if (code >= 0x30 && code <= 0x7e) scan += 1;
              break;
            }
            if (scan >= source.length) {
              state.pending = source.slice(index);
              index = source.length;
              break;
            }
            index = scan;
            continue;
          }
          index += 2; // Strip any other 2-character ESC sequence.
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code === 0x0a) {
          emitNewline();
          index += 1;
          continue;
        }
        if (code === 0x09) {
          buffer += ch;
          index += 1;
          continue;
        }
        if (code < 0x20 || code === 0x7f) {
          index += 1; // Strip other C0 controls (and DEL).
          continue;
        }
        buffer += ch;
        index += 1;
      }
      flush();
      return { segs, clean };
    }

    /** Feed raw rx bytes: streaming UTF-8 decode, then `ansiFeed`. */
    function ansiFeedBytes(state, bytes) {
      if (!state || typeof state !== "object") state = createAnsiState();
      let text;
      if (state.decoder !== null && state.decoder !== undefined) {
        try {
          text = state.decoder.decode(bytes, { stream: true });
        } catch (error) {
          text = bytesToText(bytes);
        }
      } else {
        text = bytesToText(bytes);
      }
      return ansiFeed(state, text);
    }

    // ── config validation ───────────────────────────────────────────────

    function validateBaud(raw) {
      let value = raw;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") throw new Error("请输入波特率");
        value = Number(trimmed);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new Error("波特率必须是整数");
      if (value < 50) throw new Error("波特率不能小于 50");
      if (value > 1500000) throw new Error("波特率不能超过 1500000");
      return value;
    }

    function normalizeBaud(raw) {
      try {
        return validateBaud(raw);
      } catch (error) {
        return 1500000;
      }
    }

    function summarizeConfig(config) {
      if (!config || typeof config !== "object") return "";
      const port = typeof config.port === "string" && config.port !== "" ? config.port : "—";
      const baud = config.baudRate === undefined || config.baudRate === null || config.baudRate === "" ? "—" : config.baudRate;
      const bits = config.dataBits === undefined || config.dataBits === null ? 8 : config.dataBits;
      const parity = PARITY_LETTER[config.parity] || "N";
      const stop = STOP_SHORT[config.stopBits] || "1";
      const flow = typeof config.handshake === "string" ? HANDSHAKE_SUMMARY[config.handshake] : undefined;
      return port + " · " + baud + " · " + bits + parity + stop + " · " + (flow === undefined ? "无流控" : flow);
    }

    /** Host Status → local runtime record (never throws). */
    function statusToRuntime(status) {
      if (!status || typeof status !== "object" || status.exists === false) {
        return {
          exists: false,
          connected: false,
          ready: false,
          config: null,
          lastError: status && typeof status.lastError === "string" && status.lastError !== "" ? status.lastError : null,
          loaded: true,
        };
      }
      return {
        exists: true,
        connected: Boolean(status.connected),
        ready: Boolean(status.ready),
        config: status.config && typeof status.config === "object" ? status.config : null,
        lastError: typeof status.lastError === "string" && status.lastError !== "" ? status.lastError : null,
        loaded: true,
      };
    }

    function normalizePorts(raw) {
      const list = [];
      if (!Array.isArray(raw)) return list;
      for (const item of raw) {
        if (typeof item === "string") {
          if (item !== "") list.push({ name: item, description: "" });
          continue;
        }
        if (item && typeof item === "object" && typeof item.name === "string" && item.name !== "") {
          list.push({ name: item.name, description: typeof item.description === "string" ? item.description : "" });
        }
      }
      return list;
    }

    // ── persisted tab / command model ───────────────────────────────────

    function makeTab(port) {
      return {
        id: newSessionId(),
        port: typeof port === "string" ? port : "",
        baudRate: 1500000,
        dataBits: 8,
        parity: "None",
        stopBits: "One",
        handshake: "None",
      };
    }

    function normalizeTab(raw) {
      if (!raw || typeof raw !== "object") return null;
      const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : newSessionId();
      return {
        id,
        port: typeof raw.port === "string" ? raw.port.slice(0, 64) : "",
        baudRate: normalizeBaud(raw.baudRate),
        dataBits: DATA_BITS.indexOf(raw.dataBits) >= 0 ? raw.dataBits : 8,
        parity: PARITY_VALUES.indexOf(raw.parity) >= 0 ? raw.parity : "None",
        stopBits: STOP_VALUES.indexOf(raw.stopBits) >= 0 ? raw.stopBits : "One",
        handshake: HANDSHAKE_VALUES.indexOf(raw.handshake) >= 0 ? raw.handshake : "None",
      };
    }

    function loadTabs() {
      const raw = readJson(TABS_KEY, null);
      const loaded = [];
      const seen = new Set();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const tab = normalizeTab(item);
          if (tab === null || seen.has(tab.id)) continue;
          seen.add(tab.id);
          loaded.push(tab);
        }
      }
      if (loaded.length === 0) loaded.push(makeTab(""));
      return loaded;
    }

    function commandsKey(tabId) {
      return COMMANDS_KEY_PREFIX + tabId;
    }

    function readCommands(tabId) {
      const raw = readJson(commandsKey(tabId), null);
      if (!Array.isArray(raw)) return [];
      const list = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const command = typeof item.command === "string" ? item.command : "";
        const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name : command || "命令";
        const ending = ENDING_IDS.has(item.ending) ? item.ending : "cr";
        const id = typeof item.id === "string" && item.id !== "" ? item.id : newCommandId();
        list.push({ id, name, command, ending });
      }
      return list.slice(0, 60);
    }

    function loadCommandsMap(tabs) {
      const map = {};
      for (const tab of tabs) map[tab.id] = readCommands(tab.id);
      return map;
    }

    function consoleEndingKey(tabId) {
      return ENDING_KEY_PREFIX + tabId;
    }

    function readConsoleEnding(tabId) {
      const raw = readJson(consoleEndingKey(tabId), null);
      return CONSOLE_ENDING_IDS.has(raw) ? raw : "cr";
    }

    function loadEndingsMap(tabs) {
      const map = {};
      for (const tab of tabs) map[tab.id] = readConsoleEnding(tab.id);
      return map;
    }

    // ── host API ────────────────────────────────────────────────────────

    async function request(path, init, timeoutMs) {
      const controller = typeof AbortController === "undefined" ? null : new AbortController();
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs === undefined ? 20000 : timeoutMs);
      try {
        const response = await fetch(BASE + path, {
          ...init,
          signal: controller === null ? undefined : controller.signal,
          headers: { "content-type": "application/json", ...(init && init.headers ? init.headers : {}) },
        });
        const raw = await response.text();
        let data;
        try {
          data = raw === "" ? {} : JSON.parse(raw);
        } catch (error) {
          throw new Error("宿主返回了非 JSON 响应（HTTP " + response.status + "）");
        }
        if (data && data.ok === false) throw new Error(typeof data.error === "string" && data.error !== "" ? data.error : "宿主拒绝了该请求");
        return data;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    const api = {
      ports: () => request("/ports", { method: "GET" }, 8000),
      poll: (sessions, since) => request("/poll", { method: "POST", body: JSON.stringify({ sessions, since }) }, 12000),
      open: (config) => request("/open", { method: "POST", body: JSON.stringify(config) }, 25000),
      close: (session) => request("/close", { method: "POST", body: JSON.stringify({ session }) }, 12000),
      dispose: (session) => request("/dispose", { method: "POST", body: JSON.stringify({ session }) }, 8000),
      send: (session, base64, label) => request("/send", { method: "POST", body: JSON.stringify({ session, base64, label }) }, 20000),
      clear: (session) => request("/clear", { method: "POST", body: JSON.stringify({ session }) }, 12000),
    };

    // ── shared style atoms ─────────────────────────────────────────────

    const CONTROL_STYLE = {
      height: ROW_HEIGHT,
      padding: "0 6px",
      fontSize: 12,
      fontFamily: "inherit",
      color: COLORS.label,
      background: COLORS.bg,
      border: "1px solid " + COLORS.borderStrong,
      borderRadius: 3,
      outline: "none",
      boxSizing: "border-box",
      minWidth: 0,
    };

    // ── tiny controls ──────────────────────────────────────────────────

    function Field(props) {
      const { label, children, flex, width } = props;
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            ...(width === undefined ? {} : { width }),
            ...(flex === undefined ? {} : { flex }),
          },
        },
        h("span", { style: { fontSize: 12, color: COLORS.label, whiteSpace: "nowrap", flex: "none" } }, label),
        h("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 } }, children),
      );
    }

    function ComboBox(props) {
      const { value, onChange, options, disabled, title, controlRef } = props;
      return h(
        "select",
        {
          ref: controlRef,
          value: String(value === undefined || value === null ? "" : value),
          disabled: Boolean(disabled),
          title,
          onChange: (event) => onChange(event.target.value),
          style: {
            ...CONTROL_STYLE,
            width: "100%",
            padding: "0 4px",
            color: disabled ? COLORS.idle : COLORS.label,
            background: disabled ? COLORS.bgLayer2 : COLORS.bg,
            cursor: disabled ? "not-allowed" : "pointer",
          },
        },
        options.map((option) => h("option", { key: String(option.value), value: option.value }, option.label)),
      );
    }

    function TinyButton(props) {
      const { children, onClick, onMouseDown, disabled, title, tone, style } = props;
      const ink = disabled ? COLORS.idle : tone === "danger" ? COLORS.error : tone === "primary" ? COLORS.brand : COLORS.label;
      return h(
        "button",
        {
          type: "button",
          onClick,
          onMouseDown,
          disabled: Boolean(disabled),
          title,
          style: {
            height: ROW_HEIGHT + 2,
            padding: "0 8px",
            fontSize: 12,
            fontFamily: "inherit",
            color: ink,
            background: COLORS.bg,
            border: "1px solid " + COLORS.borderStrong,
            borderRadius: 3,
            cursor: disabled ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
            flex: "none",
            ...style,
          },
        },
        children,
      );
    }

    function Check(props) {
      const { checked, onChange, label, title } = props;
      return h(
        "label",
        {
          title,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 11,
            color: COLORS.label,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flex: "none",
          },
        },
        h("input", {
          type: "checkbox",
          checked: Boolean(checked),
          onChange: (event) => onChange(event.target.checked),
          style: { margin: 0, flex: "none" },
        }),
        label,
      );
    }

    /** One session chip in the nested tab strip (status dot + label + close). */
    function SessionTab(props) {
      const { tab, index, active, runtime, problem, onSelect, onClose } = props;
      const label = typeof tab.port === "string" && tab.port !== "" ? tab.port : "串口 " + (index + 1);
      const connected = Boolean(runtime && runtime.connected);
      const dotColor = problem ? COLORS.error : connected ? COLORS.success : COLORS.idle;
      const stateText = problem ? "有错误" : connected ? "已连接" : runtime && runtime.loaded ? "未连接" : "空闲";
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            height: 26,
            flex: "none",
            maxWidth: 180,
            background: active ? COLORS.bg : COLORS.bgLayer2,
            border: "1px solid " + COLORS.border,
            borderBottom: active ? "1px solid " + COLORS.bg : "1px solid " + COLORS.border,
            borderRadius: "4px 4px 0 0",
            overflow: "hidden",
          },
        },
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": active,
            title: label + "（" + stateText + "）",
            onClick: onSelect,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 24,
              padding: "0 2px 0 7px",
              flex: "1 1 auto",
              minWidth: 0,
              background: "transparent",
              border: "none",
              color: COLORS.label,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "inherit",
              outline: "none",
            },
          },
          h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: dotColor, flex: "none" } }),
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, marginRight: 2 } }, label),
        ),
        h(
          "button",
          {
            type: "button",
            title: "关闭标签（并释放宿主会话）",
            "aria-label": "关闭" + label,
            onClick: (event) => {
              event.stopPropagation();
              onClose();
            },
            style: {
              width: 18,
              height: 24,
              padding: 0,
              lineHeight: "14px",
              fontSize: 13,
              fontFamily: "inherit",
              color: COLORS.labelSecondary,
              background: "transparent",
              border: "none",
              borderRadius: 2,
              cursor: "pointer",
              flex: "none",
            },
          },
          "×",
        ),
      );
    }

    /** Native-looking terminal glyph for the guide row. */
    function SifarCrtIcon(props) {
      const size = (props && props.size) || 16;
      const active = Boolean(props && props.active);
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: active ? 1.7 : 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("rect", {
          x: 1.7,
          y: 2.9,
          width: 12.6,
          height: 10.2,
          rx: 1.7,
          fill: active ? "currentColor" : "none",
          fillOpacity: active ? 0.14 : 0,
        }),
        h("path", { d: "M1.7 5.3h12.6", opacity: 0.7 }),
        h("circle", { cx: 3.7, cy: 4.1, r: 0.5, fill: "currentColor", stroke: "none" }),
        h("circle", { cx: 5.3, cy: 4.1, r: 0.5, fill: "currentColor", stroke: "none" }),
        h("path", { d: "M3.5 10.9l1.2-2.6 1.2 3.1 1.2-3.6 1.2 2.9 1.1-1.9 1.2 2.1" }),
      );
    }

    // ── selection / clipboard helpers (no DOM outside the panel) ───────

    function selectionInside(node) {
      try {
        if (!node || typeof window === "undefined" || typeof window.getSelection !== "function") return "";
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
        const text = selection.toString();
        if (typeof text !== "string" || text === "") return "";
        const range = selection.getRangeAt(0);
        if (node.contains(range.commonAncestorContainer)) return text;
      } catch (error) {
        // Selection APIs are unavailable in some embeddings.
      }
      return "";
    }

    async function writeClipboard(text, hostNode) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        // Fall through to the execCommand fallback.
      }
      try {
        if (typeof document === "undefined") return false;
        const parent = hostNode && hostNode.appendChild ? hostNode : null;
        if (parent === null) return false;
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "absolute";
        area.style.left = "-9999px";
        area.style.top = "0";
        area.style.opacity = "0";
        parent.appendChild(area);
        try {
          area.select();
          const ok = document.execCommand("copy");
          return Boolean(ok);
        } finally {
          if (area.parentNode === parent) parent.removeChild(area);
        }
      } catch (error) {
        return false;
      }
    }

    /** Gear glyph for the 串口设置 action button. */
    function GearIcon(props) {
      const size = (props && props.size) || 14;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: 8, cy: 8, r: 2.1 }),
        h("path", { d: "M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" }),
      );
    }

    // ── the panel ──────────────────────────────────────────────────────

    /**
     * The multi-session serial console.
     *
     * Layout, top to bottom, each band owning its own wrap so the console works
     * in the narrow (~360px) right sidebar and in a wide panel:
     *   tabs     — one chip per host session, plus "+"
     *   actions  — 连接/断开, 串口设置 gear, current config summary
     *   commands — user command chips + inline editor
     *   toolbar  — 清空 / 复制 / 保存日志 / 时间戳 / HEX / 自动滚动
     *   console  — ANSI log + fixed "# " prompt row (terminal input), status line
     */
    function SifarCrtPage() {
      // 1. session tabs, persisted across reloads (never auto-opened)
      const [tabs, setTabs] = useState(loadTabs);
      const [activeId, setActiveId] = useState(tabs.length > 0 ? tabs[0].id : "");
      const [commandsByTab, setCommandsByTab] = useState(() => loadCommandsMap(tabs));

      // 2. host state
      const [ports, setPorts] = useState([]);
      const [portsError, setPortsError] = useState(null);
      const [enumeratorError, setEnumeratorError] = useState(null);
      const [runtime, setRuntime] = useState({});
      const [logs, setLogs] = useState({});
      const [counts, setCounts] = useState({});
      const [tabErrors, setTabErrors] = useState({});
      const [pollError, setPollError] = useState(null);
      const [busy, setBusy] = useState("");

      // 3. terminal input / dialogs / display options
      const [consoleBuffers, setConsoleBuffers] = useState({});
      const [consoleEndings, setConsoleEndings] = useState(() => loadEndingsMap(tabs));
      const [consoleFocused, setConsoleFocused] = useState(false);
      const [editor, setEditor] = useState(null);
      const [settings, setSettings] = useState(null);
      const [notice, setNotice] = useState(null);
      const [hexView, setHexView] = useState(false);
      const [showTime, setShowTime] = useState(false);
      const [following, setFollowing] = useState(true);
      const [searchQuery, setSearchQuery] = useState("");
      const [searchIndex, setSearchIndex] = useState(-1);

      const tabsRef = useRef(tabs);
      const aliveRef = useRef(true);
      const cursorsRef = useRef({}); // tab id → last consumed seq
      const historyRef = useRef({}); // tab id → {items, index, draft}
      const ansiRef = useRef({}); // tab id → streaming ANSI state
      const logRef = useRef(null);
      const panelRef = useRef(null);
      const nameInputRef = useRef(null);
      const settingsFirstRef = useRef(null);
      const lineKeyRef = useRef(0);
      const commandClickTimer = useRef(null);
      const followingRef = useRef(true); // auto-scroll follow (ref mirrors state)
      const pressedRef = useRef(false); // left button held inside the log pane

      const activeTab = tabs.find((tab) => tab.id === activeId) || tabs[0] || null;
      const activeTabId = activeTab === null ? "" : activeTab.id;
      const activeRuntime = activeTabId !== "" && runtime[activeTabId] ? runtime[activeTabId] : null;
      const activeCounts = activeTabId !== "" && counts[activeTabId] ? counts[activeTabId] : { rx: 0, tx: 0 };
      const activeLines = activeTabId !== "" && logs[activeTabId] ? logs[activeTabId] : EMPTY_LINES;
      const activeCommands = activeTabId !== "" && commandsByTab[activeTabId] ? commandsByTab[activeTabId] : EMPTY_COMMANDS;
      const activeError = activeTabId !== "" && typeof tabErrors[activeTabId] === "string" ? tabErrors[activeTabId] : null;
      const connected = Boolean(activeRuntime && activeRuntime.connected);
      const consoleBuffer = activeTabId !== "" && typeof consoleBuffers[activeTabId] === "string" ? consoleBuffers[activeTabId] : "";
      const consoleEnding = activeTabId !== "" && CONSOLE_ENDING_IDS.has(consoleEndings[activeTabId]) ? consoleEndings[activeTabId] : "cr";
      // Display list: locally-sent tx entries are hidden (see visibleLines).
      const visibleActiveLines = visibleLines(activeLines);

      // ── log keyword search (3) ────────────────────────────────────────
      // Search the same visible text the log renders; TX echo is excluded.
      // HEX view still computes/counts matches but renders no highlights.
      const searchResult = findLogMatches(visibleActiveLines, searchQuery);
      const searchMatches = searchResult.matches;
      const searchCapped = searchResult.capped;
      const searchTotal = searchMatches.length;
      const searchActive = searchQuery !== "" && searchTotal > 0;
      const searchCurrentIndex = searchActive
        ? (searchIndex >= 0 && searchIndex < searchTotal ? searchIndex : 0)
        : -1;
      const searchCountText = searchQuery === ""
        ? "0/0"
        : searchActive
          ? (searchCurrentIndex + 1) + "/" + searchTotal + (searchCapped ? "+" : "")
          : "0/0";

      // ── log follow/pause plumbing ─────────────────────────────────────
      // The log follows the tail only while `following` is true. A left press
      // inside the pane pauses it immediately; mouse-up at the bottom resumes;
      // scrolling (wheel or scrollbar drag) out of the bottom pauses, and
      // scrolling back to the bottom resumes. Enter always resumes and jumps.
      const applyFollow = useCallback((value) => {
        followingRef.current = Boolean(value);
        setFollowing((previous) => (previous === Boolean(value) ? previous : Boolean(value)));
      }, []);

      const scrollLogToBottom = useCallback(() => {
        const node = logRef.current;
        if (node === null || node === undefined) return;
        node.scrollTop = node.scrollHeight;
      }, []);

      const resumeFollow = useCallback(() => {
        scrollLogToBottom();
        applyFollow(true);
      }, [applyFollow, scrollLogToBottom]);

      /** Focus the in-log terminal input (clicking the console area). */
      const focusConsole = useCallback(() => {
        const node = logRef.current;
        if (node !== null && node !== undefined && typeof node.focus === "function") {
          try {
            node.focus();
          } catch (error) {
            // Focus is a nicety, never a requirement.
          }
        }
      }, []);

      /** Clicking the console chrome focuses the input, but controls keep working. */
      const focusConsoleFromEvent = useCallback((event) => {
        const target = event && event.target;
        if (target && typeof target.closest === "function" && target.closest("select,button,input,textarea,a")) return;
        focusConsole();
      }, [focusConsole]);

      const clearSearch = useCallback(() => {
        setSearchQuery("");
        setSearchIndex(-1);
      }, []);

      const clearSearchAndFocus = useCallback(() => {
        clearSearch();
        focusConsole();
      }, [clearSearch, focusConsole]);

      /** Move to the next (+1) / previous (-1) match, wrapping around. */
      const gotoMatch = useCallback((delta) => {
        if (searchTotal <= 0) return;
        // Navigating pauses auto-follow so incoming data cannot move the view.
        applyFollow(false);
        setSearchIndex((previous) => {
          if (previous < 0 || previous >= searchTotal) return delta > 0 ? 0 : searchTotal - 1;
          return (previous + delta + searchTotal) % searchTotal;
        });
      }, [applyFollow, searchTotal]);

      const onSearchChange = useCallback((value) => {
        setSearchQuery(value);
        setSearchIndex(-1);
      }, []);

      const onSearchKeyDown = useCallback((event) => {
        if (event.nativeEvent && event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          gotoMatch(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          clearSearchAndFocus();
        }
      }, [clearSearchAndFocus, gotoMatch]);

      useEffect(() => {
        tabsRef.current = tabs;
      }, [tabs]);

      // Keep the active id pointing at a real tab after add/close.
      useEffect(() => {
        if (tabs.length > 0 && !tabs.some((tab) => tab.id === activeId)) setActiveId(tabs[0].id);
      }, [activeId, tabs]);

      // Persist the tab set (ids + configuration only; restored tabs never open).
      useEffect(() => {
        const persisted = tabs.map((tab) => ({
          id: tab.id,
          port: tab.port,
          baudRate: tab.baudRate,
          dataBits: tab.dataBits,
          parity: tab.parity,
          stopBits: tab.stopBits,
          handshake: tab.handshake,
        }));
        writeJson(TABS_KEY, persisted);
      }, [tabs]);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (commandClickTimer.current !== null) {
            clearTimeout(commandClickTimer.current);
            commandClickTimer.current = null;
          }
        };
      }, []);

      // ── state plumbing ────────────────────────────────────────────────

      const setTabError = useCallback((id, message) => {
        if (typeof id !== "string" || id === "") return;
        setTabErrors((previous) => {
          const existing = typeof previous[id] === "string" ? previous[id] : null;
          if (message === null && existing === null) return previous;
          const next = { ...previous };
          if (message === null) delete next[id];
          else next[id] = message;
          return next;
        });
      }, []);

      /** Reset a tab's streaming ANSI state (new open / clear / dispose). */
      const resetAnsiForTab = useCallback((id) => {
        if (typeof id !== "string" || id === "") return;
        const existing = ansiRef.current[id];
        ansiRef.current[id] = existing ? resetAnsiState(existing) : createAnsiState();
      }, []);

      /** Fold one `/poll` frame into local state. */
      const absorbFrame = useCallback((frame) => {
        if (!frame || !Array.isArray(frame.sessions)) return;
        const lineAdds = {};
        const runtimeAdds = {};
        const countAdds = {};
        for (const entry of frame.sessions) {
          if (!entry || typeof entry.id !== "string" || entry.id === "") continue;
          const id = entry.id;
          const status = entry.status && typeof entry.status === "object" ? entry.status : {};
          const exists = status.exists !== false;
          const previousCursor = cursorsRef.current[id];
          const base = typeof previousCursor === "number" ? previousCursor : -1;
          const incoming = Array.isArray(entry.lines) ? entry.lines : [];
          const fresh = [];
          let highest = base;
          for (const line of incoming) {
            if (!line || typeof line !== "object") continue;
            const seq = typeof line.seq === "number" && Number.isFinite(line.seq) ? line.seq : highest + 1;
            if (seq <= highest) continue;
            highest = seq;
            const decorated = {
              seq,
              at: typeof line.at === "number" ? line.at : Date.now(),
              kind: typeof line.kind === "string" ? line.kind : "sys",
              b64: typeof line.b64 === "string" ? line.b64 : undefined,
              text: typeof line.text === "string" ? line.text : undefined,
              __k: (lineKeyRef.current += 1),
            };
            if (decorated.kind === "rx" && typeof decorated.b64 === "string") {
              // Streaming ANSI decode: carried across rx chunks and polls per tab.
              try {
                let ansi = ansiRef.current[id];
                if (!ansi) {
                  ansi = createAnsiState();
                  ansiRef.current[id] = ansi;
                }
                const parsed = ansiFeedBytes(ansi, b64ToBytes(decorated.b64));
                decorated.segs = parsed.segs;
                decorated.text = parsed.clean;
              } catch (error) {
                decorated.segs = [];
                decorated.text = "（无法解码的字节）";
              }
            }
            fresh.push(decorated);
          }
          if (exists) {
            const next = typeof entry.next === "number" && Number.isFinite(entry.next) ? entry.next : 0;
            cursorsRef.current[id] = Math.max(base, next, highest);
          } else {
            // Unknown session: reset so a future open (seq restarts) is read from
            // the beginning instead of from a stale high-water mark.
            cursorsRef.current[id] = -1;
          }
          runtimeAdds[id] = statusToRuntime(status);
          if (fresh.length > 0) {
            lineAdds[id] = fresh;
            const add = { rx: 0, tx: 0 };
            for (const line of fresh) {
              if (typeof line.b64 !== "string") continue;
              const size = b64ByteLength(line.b64);
              if (line.kind === "rx") add.rx += size;
              if (line.kind === "tx") add.tx += size;
            }
            countAdds[id] = add;
          }
        }
        if (Object.keys(runtimeAdds).length > 0) {
          setRuntime((previous) => ({ ...previous, ...runtimeAdds }));
        }
        if (Object.keys(lineAdds).length > 0) {
          setLogs((previous) => {
            const next = { ...previous };
            for (const id of Object.keys(lineAdds)) {
              const merged = (next[id] || []).concat(lineAdds[id]);
              next[id] = merged.length > RENDER_LIMIT ? merged.slice(merged.length - RENDER_LIMIT) : merged;
            }
            return next;
          });
          setCounts((previous) => {
            const next = { ...previous };
            for (const id of Object.keys(countAdds)) {
              const before = next[id] || { rx: 0, tx: 0 };
              next[id] = { rx: before.rx + countAdds[id].rx, tx: before.tx + countAdds[id].tx };
            }
            return next;
          });
        }
      }, []);

      /** One-shot poll for a single session (used on tab switch and after writes). */
      const absorbTabOnce = useCallback(async (id) => {
        if (typeof id !== "string" || id === "") return;
        const cursor = cursorsRef.current[id];
        const since = {};
        since[id] = typeof cursor === "number" ? cursor : -1;
        try {
          const frame = await api.poll([id], since);
          if (!aliveRef.current) return;
          absorbFrame(frame);
        } catch (error) {
          // The long-running poll owns the "host unreachable" error channel.
        }
      }, [absorbFrame]);

      // 8. one self-rescheduling poll; a request is only scheduled after the
      // previous one settles, so a slow host never queues work up.
      useEffect(() => {
        let disposed = false;
        let timer = null;
        let failures = 0;
        const tick = async () => {
          if (disposed) return;
          timer = null;
          const currentTabs = tabsRef.current || [];
          const ids = currentTabs.map((tab) => tab.id).filter((id) => typeof id === "string" && id !== "");
          if (ids.length === 0) {
            timer = setTimeout(tick, 400);
            return;
          }
          const since = {};
          for (const id of ids) {
            const cursor = cursorsRef.current[id];
            since[id] = typeof cursor === "number" ? cursor : -1;
          }
          try {
            const frame = await api.poll(ids, since);
            if (disposed) return;
            absorbFrame(frame);
            failures = 0;
            setPollError(null);
          } catch (error) {
            if (disposed) return;
            failures += 1;
            setPollError("无法连接串口宿主：" + messageOf(error));
          }
          if (disposed) return;
          timer = setTimeout(tick, failures === 0 ? POLL_INTERVAL : Math.min(4000, 500 * failures));
        };
        tick();
        return () => {
          disposed = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [absorbFrame]);

      // Re-read the active tab when the reader switches to it.
      useEffect(() => {
        if (activeTabId === "") return undefined;
        void absorbTabOnce(activeTabId);
        return undefined;
      }, [absorbTabOnce, activeTabId]);

      // A settings hint belongs to the tab it was raised on; closing the last
      // tab removes the console element (so no blur event arrives).
      useEffect(() => {
        setNotice(null);
        if (activeTabId === "") setConsoleFocused(false);
      }, [activeTabId]);

      // New data follows the tail only while following; while paused the view
      // stays exactly where the reader left it (never programmatic scroll).
      useEffect(() => {
        if (!followingRef.current) return;
        scrollLogToBottom();
      }, [activeLines, scrollLogToBottom]);

      // Switching tabs resets follow and jumps to that tab's newest line.
      useEffect(() => {
        resumeFollow();
      }, [activeTabId, resumeFollow]);

      // A search belongs to the tab it was typed on: reset it on tab switch.
      useEffect(() => {
        setSearchQuery("");
        setSearchIndex(-1);
      }, [activeTabId]);

      // Center the current match in the log viewport after navigation.
      useEffect(() => {
        if (searchQuery === "" || searchIndex < 0) return;
        const container = logRef.current;
        if (container === null || container === undefined || typeof container.querySelector !== "function") return;
        let node = null;
        try {
          node = container.querySelector('[data-sifar-current-match="1"]');
        } catch (error) {
          node = null;
        }
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
        try {
          const hostRect = container.getBoundingClientRect();
          const matchRect = node.getBoundingClientRect();
          const delta = (matchRect.top - hostRect.top) - (container.clientHeight / 2 - matchRect.height / 2);
          container.scrollTop += delta;
        } catch (error) {
          // Layout APIs can be unavailable in exotic embeddings.
        }
      }, [searchIndex, searchQuery]);

      // 2. enumerate ports once on mount (and on demand through 刷新).
      const refreshPorts = useCallback(async () => {
        setBusy("ports");
        try {
          const data = await api.ports();
          if (!aliveRef.current) return;
          const list = normalizePorts(data && data.ports);
          setPorts(list);
          setPortsError(null);
          const enumerator = data && data.enumerator && typeof data.enumerator === "object" ? data.enumerator : null;
          setEnumeratorError(
            enumerator && enumerator.ready === false
              ? (typeof enumerator.error === "string" && enumerator.error !== "" ? enumerator.error : "串口枚举未就绪")
              : null,
          );
          if (list.length > 0) {
            setTabs((previous) => previous.map((tab) => (tab.port === "" ? { ...tab, port: list[0].name } : tab)));
            setSettings((previous) => (previous !== null && previous.port === "" && list.length > 0 ? { ...previous, port: list[0].name } : previous));
          }
        } catch (error) {
          if (!aliveRef.current) return;
          setPortsError("枚举串口失败：" + messageOf(error));
        } finally {
          if (aliveRef.current) setBusy((previous) => (previous === "ports" ? "" : previous));
        }
      }, []);

      useEffect(() => {
        void refreshPorts();
      }, [refreshPorts]);

      // ── tab actions ───────────────────────────────────────────────────

      const updateTab = useCallback((id, patch) => {
        setTabs((previous) => previous.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
      }, []);

      const addTab = useCallback(() => {
        const tab = makeTab(ports.length > 0 ? ports[0].name : "");
        setTabs((previous) => previous.concat([tab]));
        setCommandsByTab((previous) => ({ ...previous, [tab.id]: [] }));
        setConsoleBuffers((previous) => ({ ...previous, [tab.id]: "" }));
        setConsoleEndings((previous) => ({ ...previous, [tab.id]: "cr" }));
        setActiveId(tab.id);
        // New tabs start on the first enumerated port; fetch it if not known yet.
        if (ports.length === 0) void refreshPorts();
      }, [ports, refreshPorts]);

      const closeTab = useCallback(async (id) => {
        cancelPendingForTab(id);
        try {
          await api.dispose(id);
        } catch (error) {
          // Closing the UI tab must succeed even when the host already forgot it.
        }
        if (!aliveRef.current) return;
        removeStored(commandsKey(id));
        removeStored(consoleEndingKey(id));
        const index = tabs.findIndex((tab) => tab.id === id);
        const remaining = tabs.filter((tab) => tab.id !== id);
        setTabs(remaining);
        setActiveId((previous) => {
          if (previous !== id) return previous;
          if (remaining.length === 0) return "";
          return remaining[Math.min(Math.max(index, 0), remaining.length - 1)].id;
        });
        setRuntime((previous) => omitKey(previous, id));
        setLogs((previous) => omitKey(previous, id));
        setCounts((previous) => omitKey(previous, id));
        setTabErrors((previous) => omitKey(previous, id));
        setCommandsByTab((previous) => omitKey(previous, id));
        setConsoleBuffers((previous) => omitKey(previous, id));
        setConsoleEndings((previous) => omitKey(previous, id));
        delete cursorsRef.current[id];
        delete historyRef.current[id];
        delete ansiRef.current[id];
      }, [tabs]);

      /** Local cleanup shared by closeTab (defined before it runs). */
      function cancelPendingForTab(id) {
        if (typeof id !== "string") return;
        if (cursorsRef.current[id] !== undefined) delete cursorsRef.current[id];
        if (historyRef.current[id] !== undefined) delete historyRef.current[id];
      }

      // ── connect / disconnect ──────────────────────────────────────────

      const applyStatus = useCallback((id, status) => {
        setRuntime((previous) => ({ ...previous, [id]: statusToRuntime(status) }));
      }, []);

      const toggleConnection = useCallback(async () => {
        const id = activeTabId;
        const tab = tabs.find((item) => item.id === id);
        if (tab === undefined || tab === null) return;
        setNotice(null);
        if (connected) {
          setBusy("close");
          try {
            const data = await api.close(id);
            if (!aliveRef.current) return;
            if (data && data.status) applyStatus(id, data.status);
            setTabError(id, null);
            await absorbTabOnce(id);
          } catch (error) {
            if (aliveRef.current) setTabError(id, messageOf(error));
          } finally {
            if (aliveRef.current) setBusy((previous) => (previous === "close" ? "" : previous));
          }
          return;
        }
        let baudRate;
        try {
          baudRate = validateBaud(tab.baudRate);
        } catch (error) {
          setTabError(id, messageOf(error));
          return;
        }
        const port = typeof tab.port === "string" ? tab.port.trim() : "";
        if (port === "") {
          setTabError(id, "请选择或输入串口名称");
          return;
        }
        setBusy("open");
        try {
          const data = await api.open({
            session: id,
            port,
            baudRate,
            dataBits: tab.dataBits,
            parity: tab.parity,
            stopBits: tab.stopBits,
            handshake: tab.handshake,
            dtr: true,
            rts: true,
          });
          if (!aliveRef.current) return;
          if (data && data.status) applyStatus(id, data.status);
          setTabError(id, null);
          resetAnsiForTab(id);
          setTabs((previous) => previous.map((item) => (item.id === id ? { ...item, port, baudRate } : item)));
          await absorbTabOnce(id);
        } catch (error) {
          if (aliveRef.current) setTabError(id, messageOf(error));
        } finally {
          if (aliveRef.current) setBusy((previous) => (previous === "open" ? "" : previous));
        }
      }, [absorbTabOnce, activeTabId, applyStatus, connected, setTabError, tabs]);

      // ── send ──────────────────────────────────────────────────────────

      const sendPayload = useCallback(async (id, text, endingId, label) => {
        const tab = tabs.find((item) => item.id === id);
        if (tab === undefined || tab === null) return false;
        const rt = runtime[id];
        if (!rt || !rt.connected) {
          setTabError(id, "串口未连接，无法发送");
          return false;
        }
        setBusy("send");
        try {
          const base64 = encodeTextBase64(text, endingId);
          await api.send(id, base64, label === undefined || label === null ? undefined : String(label).slice(0, 160));
          if (!aliveRef.current) return false;
          setTabError(id, null);
          await absorbTabOnce(id);
          return true;
        } catch (error) {
          if (aliveRef.current) setTabError(id, messageOf(error));
          return false;
        } finally {
          if (aliveRef.current) setBusy((previous) => (previous === "send" ? "" : previous));
        }
      }, [absorbTabOnce, runtime, tabs]);

      const historyStore = useCallback((id) => {
        let store = historyRef.current[id];
        if (store === undefined || store === null) {
          store = { items: [], index: -1, draft: "" };
          historyRef.current[id] = store;
        }
        return store;
      }, []);

      const pushHistory = useCallback((id, text) => {
        const trimmed = typeof text === "string" ? text.trim() : "";
        if (trimmed === "") return;
        const store = historyStore(id);
        if (store.items[store.items.length - 1] !== trimmed) store.items.push(trimmed);
        if (store.items.length > 200) store.items.shift();
        store.index = -1;
        store.draft = "";
      }, [historyStore]);

      const sendCommand = useCallback((command) => {
        if (!command || typeof command.command !== "string" || command.command === "") return;
        if (activeTabId === "") return;
        void sendPayload(activeTabId, command.command, command.ending, command.name || command.command);
      }, [activeTabId, sendPayload]);

      // ── in-log terminal input (B) ─────────────────────────────────────

      const setConsoleEnding = useCallback((id, ending) => {
        if (typeof id !== "string" || id === "" || !CONSOLE_ENDING_IDS.has(ending)) return;
        setConsoleEndings((previous) => ({ ...previous, [id]: ending }));
        writeJson(consoleEndingKey(id), ending);
      }, []);

      /** Enter in the console: send the buffer (+ ending) or a bare CR. */
      const submitConsole = useCallback(() => {
        const id = activeTabId;
        if (id === "") return;
        // Enter always refreshes the log view: jump to the newest line and
        // resume following (even when the reader had paused on old output).
        resumeFollow();
        const buffer = typeof consoleBuffers[id] === "string" ? consoleBuffers[id] : "";
        if (buffer === "") {
          // Empty line: send a bare CR so a Linux console answers with a prompt.
          void sendPayload(id, "\r", "none", "");
          return;
        }
        const ending = CONSOLE_ENDING_IDS.has(consoleEndings[id]) ? consoleEndings[id] : "cr";
        const text = buffer;
        void sendPayload(id, text, ending, text).then((ok) => {
          if (!ok || !aliveRef.current) return;
          // Only clear what was actually sent; never wipe text typed meanwhile.
          setConsoleBuffers((previous) => (previous[id] === text ? { ...previous, [id]: "" } : previous));
          pushHistory(id, text);
        });
      }, [activeTabId, consoleBuffers, consoleEndings, pushHistory, resumeFollow, sendPayload]);

      /** Multi-line paste: send each non-empty line sequentially (ordered). */
      const sendPastedLines = useCallback(async (id, lines) => {
        const ending = CONSOLE_ENDING_IDS.has(consoleEndings[id]) ? consoleEndings[id] : "cr";
        for (const line of lines) {
          if (!aliveRef.current) return;
          const ok = await sendPayload(id, line, ending, line);
          if (!ok) return;
        }
      }, [consoleEndings, sendPayload]);

      /**
       * Ctrl+C interrupt: transmit one ETX byte (0x03) so a foreground program
       * on the board (e.g. `top`) is interrupted. No line ending, no history.
       */
      const sendInterrupt = useCallback((id) => {
        const rt = runtime[id];
        if (!rt || !rt.connected) {
          setTabError(id, "串口未连接，无法发送");
          return;
        }
        void (async () => {
          try {
            await api.send(id, "Aw=="); // base64 of the single byte 0x03 (ETX)
            if (!aliveRef.current) return;
            setTabError(id, null);
            await absorbTabOnce(id);
          } catch (error) {
            if (aliveRef.current) setTabError(id, messageOf(error));
          }
        })();
      }, [absorbTabOnce, runtime, setTabError]);

      const onConsoleKeyDown = useCallback((event) => {
        if (event.nativeEvent && event.nativeEvent.isComposing) return;
        const id = activeTabId;
        if (id === "") return;
        // Ctrl/Cmd+C: copy a log selection if there is one (let the browser do
        // it); otherwise interrupt the foreground program with a single ETX.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "c" || event.key === "C")) {
          if (selectionInside(logRef.current) !== "") return;
          event.preventDefault();
          sendInterrupt(id);
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return; // other native shortcuts (Ctrl+V/A…)
        if (event.key === "Enter") {
          event.preventDefault();
          submitConsole();
          return;
        }
        if (event.key === "Backspace") {
          event.preventDefault();
          setConsoleBuffers((previous) => {
            const current = typeof previous[id] === "string" ? previous[id] : "";
            if (current === "") return previous;
            return { ...previous, [id]: current.slice(0, -1) };
          });
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          const node = logRef.current;
          if (node !== null && node !== undefined && typeof node.blur === "function") node.blur();
          setConsoleFocused(false);
          return;
        }
        if (event.key === "Tab") return; // keep native focus traversal
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const store = historyStore(id);
          if (store.items.length === 0) return; // only swallow arrows when history exists
          event.preventDefault();
          const currentBuffer = typeof consoleBuffers[id] === "string" ? consoleBuffers[id] : "";
          if (event.key === "ArrowUp") {
            if (store.index === -1) {
              store.draft = currentBuffer;
              store.index = store.items.length - 1;
            } else if (store.index > 0) {
              store.index -= 1;
            }
            const value = store.items[store.index];
            setConsoleBuffers((previous) => ({ ...previous, [id]: value }));
            return;
          }
          if (store.index === -1) return;
          if (store.index < store.items.length - 1) {
            store.index += 1;
            setConsoleBuffers((previous) => ({ ...previous, [id]: store.items[store.index] }));
          } else {
            store.index = -1;
            setConsoleBuffers((previous) => ({ ...previous, [id]: store.draft }));
          }
          return;
        }
        if (event.key.length === 1) {
          event.preventDefault();
          const typed = event.key;
          setConsoleBuffers((previous) => {
            const current = typeof previous[id] === "string" ? previous[id] : "";
            return { ...previous, [id]: current + typed };
          });
        }
      }, [activeTabId, consoleBuffers, historyStore, sendInterrupt, submitConsole]);

      const onConsolePaste = useCallback((event) => {
        const id = activeTabId;
        if (id === "") return;
        event.preventDefault();
        let text = "";
        try {
          const clip = event.clipboardData || (typeof window !== "undefined" ? window.clipboardData : null);
          if (clip && typeof clip.getData === "function") text = clip.getData("text") || "";
        } catch (error) {
          text = "";
        }
        if (typeof text !== "string" || text === "") return;
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (normalized.indexOf("\n") >= 0) {
          // Multi-line paste: append to the current buffer, then send every
          // non-empty line sequentially (ordered) and clear the console line.
          const current = typeof consoleBuffers[id] === "string" ? consoleBuffers[id] : "";
          const combined = current + normalized;
          const lines = combined.split("\n").map((line) => line.trim()).filter((line) => line !== "");
          if (lines.length === 0) return;
          if (!connected) {
            // Nothing can be sent; keep the text in the console line.
            setConsoleBuffers((previous) => ({ ...previous, [id]: combined }));
            return;
          }
          setConsoleBuffers((previous) => ({ ...previous, [id]: "" }));
          void sendPastedLines(id, lines);
          return;
        }
        setConsoleBuffers((previous) => {
          const current = typeof previous[id] === "string" ? previous[id] : "";
          return { ...previous, [id]: current + text };
        });
      }, [activeTabId, connected, consoleBuffers, sendPastedLines]);

      // ── log actions ───────────────────────────────────────────────────

      const formattedLog = useCallback(() => formatLines(visibleLines(activeLines), hexView, showTime).join("\n"), [activeLines, hexView, showTime]);

      const clearLog = useCallback(async () => {
        const id = activeTabId;
        if (id === "") return;
        setBusy("clear");
        try {
          const data = await api.clear(id);
          if (!aliveRef.current) return;
          setLogs((previous) => ({ ...previous, [id]: [] }));
          setCounts((previous) => ({ ...previous, [id]: { rx: 0, tx: 0 } }));
          cursorsRef.current[id] = data && typeof data.next === "number" ? data.next : -1;
          resetAnsiForTab(id);
          resumeFollow();
          setTabError(id, null);
        } catch (error) {
          if (!aliveRef.current) return;
          // A restored tab may not exist on the host yet; clear locally anyway.
          setLogs((previous) => ({ ...previous, [id]: [] }));
          setCounts((previous) => ({ ...previous, [id]: { rx: 0, tx: 0 } }));
          cursorsRef.current[id] = -1;
          resetAnsiForTab(id);
          resumeFollow();
          setTabError(id, "清空日志失败：" + messageOf(error));
        } finally {
          if (aliveRef.current) setBusy((previous) => (previous === "clear" ? "" : previous));
        }
      }, [activeTabId, resetAnsiForTab, resumeFollow, setTabError]);

      // 6. copy the log selection if there is one, else the whole log.
      const copyLog = useCallback(async () => {
        const id = activeTabId;
        if (id === "") return;
        const selected = selectionInside(logRef.current);
        const text = selected !== "" ? selected : formattedLog();
        if (text === "") {
          setTabError(id, "没有可复制的内容");
          return;
        }
        const ok = await writeClipboard(text, panelRef.current);
        if (!aliveRef.current) return;
        if (ok) setTabError(id, null);
        else setTabError(id, "复制失败：当前环境不支持写入剪贴板");
      }, [activeTabId, formattedLog, setTabError]);

      const saveLog = useCallback(() => {
        const id = activeTabId;
        if (id === "") return;
        try {
          if (typeof document === "undefined") return;
          const tab = tabs.find((item) => item.id === id);
          const text = formattedLog();
          const port = tab && typeof tab.port === "string" && tab.port !== "" ? tab.port.replace(/[^A-Za-z0-9._-]/g, "_") : "serial";
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "sifarCRT-" + port + "-" + stamp + ".log";
          anchor.rel = "noopener";
          anchor.click();
          setTimeout(() => {
            try {
              URL.revokeObjectURL(url);
            } catch (error) {
              // Ignore.
            }
          }, 4000);
          setTabError(id, null);
        } catch (error) {
          setTabError(id, "保存日志失败：" + messageOf(error));
        }
      }, [activeTabId, formattedLog, setTabError, tabs]);

      // ── command editor ────────────────────────────────────────────────

      const openAddCommand = useCallback(() => {
        if (activeTabId === "") return;
        setEditor({ mode: "add", tabId: activeTabId, id: newCommandId(), name: "", command: "", ending: "cr" });
      }, [activeTabId]);

      const openEditCommand = useCallback((command) => {
        if (activeTabId === "" || !command) return;
        setEditor({
          mode: "edit",
          tabId: activeTabId,
          id: command.id,
          name: command.name,
          command: command.command,
          ending: command.ending,
        });
      }, [activeTabId]);

      const updateEditor = useCallback((patch) => {
        setEditor((previous) => (previous === null ? previous : { ...previous, ...patch }));
      }, []);

      const saveEditor = useCallback(() => {
        const current = editor;
        if (current === null) return;
        const command = typeof current.command === "string" ? current.command : "";
        if (command.trim() === "") {
          setTabError(current.tabId, "命令内容不能为空");
          return;
        }
        const name = typeof current.name === "string" && current.name.trim() !== "" ? current.name.trim().slice(0, 40) : command.trim().slice(0, 16);
        const entry = { id: current.id, name, command, ending: ENDING_IDS.has(current.ending) ? current.ending : "cr" };
        setCommandsByTab((previous) => {
          const list = (previous[current.tabId] || []).slice();
          if (current.mode === "edit") {
            const at = list.findIndex((item) => item.id === current.id);
            if (at >= 0) list[at] = entry;
            else list.push(entry);
          } else {
            list.push(entry);
          }
          writeJson(commandsKey(current.tabId), list);
          return { ...previous, [current.tabId]: list };
        });
        setTabError(current.tabId, null);
        setEditor(null);
      }, [editor, setTabError]);

      const deleteEditorCommand = useCallback(() => {
        const current = editor;
        if (current === null || current.mode !== "edit") return;
        setCommandsByTab((previous) => {
          const list = (previous[current.tabId] || []).filter((item) => item.id !== current.id);
          writeJson(commandsKey(current.tabId), list);
          return { ...previous, [current.tabId]: list };
        });
        setEditor(null);
      }, [editor]);

      // Focus the name field once per dialog opening, not on every keystroke.
      const editorIdentity = editor === null ? "" : editor.mode + ":" + editor.id;
      useEffect(() => {
        if (editorIdentity === "") return;
        const node = nameInputRef.current;
        if (node !== null && node !== undefined && typeof node.focus === "function") {
          try {
            node.focus();
            node.select();
          } catch (error) {
            // Focus is a nicety, never a requirement.
          }
        }
      }, [editorIdentity]);

      const onEditorKeyDown = useCallback((event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setEditor(null);
        }
      }, []);

      // ── serial settings dialog (C) ────────────────────────────────────

      const openSettings = useCallback(() => {
        const tab = tabs.find((item) => item.id === activeTabId);
        if (tab === undefined || tab === null) return;
        setSettings({
          tabId: tab.id,
          nonce: Date.now(),
          port: typeof tab.port === "string" ? tab.port : "",
          baudRate: tab.baudRate,
          dataBits: tab.dataBits,
          parity: tab.parity,
          stopBits: tab.stopBits,
          handshake: tab.handshake,
          error: null,
        });
        setNotice(null);
        void refreshPorts();
      }, [activeTabId, refreshPorts, tabs]);

      const updateSettings = useCallback((patch) => {
        setSettings((previous) => (previous === null ? previous : { ...previous, ...patch, error: null }));
      }, []);

      const cancelSettings = useCallback(() => {
        setSettings(null);
      }, []);

      const saveSettings = useCallback(() => {
        const current = settings;
        if (current === null) return;
        let baudRate;
        try {
          baudRate = validateBaud(current.baudRate);
        } catch (error) {
          setSettings((previous) => (previous === null ? previous : { ...previous, error: messageOf(error) }));
          return;
        }
        const port = typeof current.port === "string" ? current.port.trim() : "";
        if (port === "") {
          setSettings((previous) => (previous === null ? previous : { ...previous, error: "请选择串口" }));
          return;
        }
        updateTab(current.tabId, {
          port,
          baudRate,
          dataBits: current.dataBits,
          parity: current.parity,
          stopBits: current.stopBits,
          handshake: current.handshake,
        });
        setSettings(null);
        setTabError(current.tabId, null);
        const rt = runtime[current.tabId];
        // Never silently reconnect: only tell the user to reconnect.
        setNotice(rt && rt.connected ? "已保存，断开重连后生效" : null);
      }, [runtime, settings, setTabError, updateTab]);

      const settingsIdentity = settings === null ? "" : settings.tabId + ":" + String(settings.nonce);
      useEffect(() => {
        if (settingsIdentity === "") return;
        const node = settingsFirstRef.current;
        if (node !== null && node !== undefined && typeof node.focus === "function") {
          try {
            node.focus();
          } catch (error) {
            // Focus is a nicety, never a requirement.
          }
        }
      }, [settingsIdentity]);

      const onSettingsKeyDown = useCallback((event) => {
        if (event.nativeEvent && event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setSettings(null);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          saveSettings();
        }
      }, [saveSettings]);

      // ── display helpers ───────────────────────────────────────────────

      /**
       * Wheel/scrollbar scrolling: reaching the bottom resumes following,
       * moving away from it pauses. While the left button is held the press
       * owns the state until mouse-up (see onLogMouseUp).
       */
      const onLogScroll = useCallback((event) => {
        if (pressedRef.current) return;
        const node = event.currentTarget;
        applyFollow(isLogAtBottom(node.scrollTop, node.scrollHeight, node.clientHeight));
      }, [applyFollow]);

      /** Left press anywhere in the log pane pauses follow immediately. */
      const onLogMouseDown = useCallback((event) => {
        if (event.button !== undefined && event.button !== null && event.button !== 0) return;
        pressedRef.current = true;
        applyFollow(false);
      }, [applyFollow]);

      /** Release: resume only when the view is already at/near the bottom. */
      const onLogMouseUp = useCallback((event) => {
        if (event.button !== undefined && event.button !== null && event.button !== 0) return;
        if (!pressedRef.current) return;
        pressedRef.current = false;
        const node = logRef.current;
        if (node !== null && node !== undefined && isLogAtBottom(node.scrollTop, node.scrollHeight, node.clientHeight)) {
          resumeFollow();
        } else {
          applyFollow(false);
        }
      }, [applyFollow, resumeFollow]);

      /** Releasing outside the pane (e.g. finishing a drag) keeps it paused. */
      const onLogMouseLeave = useCallback(() => {
        if (!pressedRef.current) return;
        pressedRef.current = false;
        applyFollow(false);
      }, [applyFollow]);

      const problemText = pollError || activeError || (activeRuntime && activeRuntime.lastError ? activeRuntime.lastError : null);

      // ── render: tabs ──────────────────────────────────────────────────

      const tabStrip = h(
        "div",
        {
          role: "tablist",
          "aria-label": "串口会话",
          style: {
            flex: "none",
            display: "flex",
            alignItems: "flex-end",
            gap: 2,
            overflowX: "auto",
            overflowY: "hidden",
            borderBottom: "1px solid " + COLORS.border,
            paddingBottom: 0,
          },
        },
        tabs.map((tab, index) =>
          h(SessionTab, {
            key: tab.id,
            tab,
            index,
            active: tab.id === activeTabId,
            runtime: runtime[tab.id] || null,
            problem: Boolean(tabErrors[tab.id] || (runtime[tab.id] && runtime[tab.id].lastError) || pollError),
            onSelect: () => setActiveId(tab.id),
            onClose: () => {
              void closeTab(tab.id);
            },
          }),
        ),
        h(
          "button",
          {
            type: "button",
            title: "新建串口会话标签",
            "aria-label": "新建串口会话标签",
            onClick: addTab,
            style: {
              flex: "none",
              width: 26,
              height: 25,
              marginLeft: 2,
              padding: 0,
              fontSize: 15,
              lineHeight: "20px",
              fontFamily: "inherit",
              color: COLORS.labelSecondary,
              background: "transparent",
              border: "1px solid " + COLORS.border,
              borderRadius: "4px 4px 0 0",
              cursor: "pointer",
            },
          },
          "+",
        ),
      );

      // ── render: action row + config summary (C) ──────────────────────

      const summaryConfig = activeRuntime && activeRuntime.config
        ? activeRuntime.config
        : activeTab === null ? null : {
          port: activeTab.port,
          baudRate: activeTab.baudRate,
          dataBits: activeTab.dataBits,
          parity: activeTab.parity,
          stopBits: activeTab.stopBits,
          handshake: activeTab.handshake,
        };
      const summary = summarizeConfig(summaryConfig);
      const cannotConnect = activeTab !== null && !connected
        && (typeof activeTab.port !== "string" || activeTab.port.trim() === "");

      const actionRow = activeTab === null ? null : h(
        "div",
        { style: { flex: "none", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
        h(TinyButton, {
          onClick: () => {
            void toggleConnection();
          },
          disabled: busy === "open" || busy === "close" || cannotConnect,
          tone: connected ? "danger" : "primary",
          title: connected ? "断开串口（保留会话与日志）" : "按当前串口设置连接",
          style: { minWidth: 70 },
        }, busy === "open" ? "连接中…" : busy === "close" ? "断开中…" : connected ? "断开" : "连接"),
        h("button", {
          type: "button",
          title: "串口设置",
          "aria-label": "串口设置",
          onClick: openSettings,
          disabled: busy === "open" || busy === "close",
          style: {
            width: 26,
            height: 26,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: COLORS.label,
            background: COLORS.bg,
            border: "1px solid " + COLORS.borderStrong,
            borderRadius: 3,
            cursor: "pointer",
            flex: "none",
          },
        }, h(GearIcon, { size: 14 })),
        h("span", {
          title: "当前串口参数：点击右侧齿轮修改",
          style: { flex: "1 1 100px", minWidth: 0, fontSize: 11, color: COLORS.labelSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        }, summary),
        enumeratorError !== null
          ? h("span", { title: enumeratorError, style: { fontSize: 11, color: COLORS.warn, flex: "none" } }, "枚举未就绪")
          : null,
        portsError !== null
          ? h("span", { title: portsError, style: { fontSize: 11, color: COLORS.error, flex: "none" } }, "端口枚举失败")
          : null,
      );

      // ── render: command chips (3) ────────────────────────────────────

      const commandsBand = activeTab === null ? null : h(
        "div",
        { style: { flex: "none", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", maxHeight: 80, overflowY: "auto" } },
        activeCommands.length === 0
          ? h("span", { style: { fontSize: 11, color: COLORS.labelSecondary } }, "暂无命令按钮，点击「+」添加")
          : activeCommands.map((command) =>
            h(
              "button",
              {
                key: command.id,
                type: "button",
                title: command.name + "：" + command.command + "（" + endingLabel(command.ending) + "）\n单击发送 / 双击或右键编辑",
                // A short debounce keeps a double-click (edit) from also firing two sends.
                onClick: () => {
                  if (commandClickTimer.current !== null) clearTimeout(commandClickTimer.current);
                  commandClickTimer.current = setTimeout(() => {
                    commandClickTimer.current = null;
                    sendCommand(command);
                  }, 180);
                },
                onDoubleClick: () => {
                  if (commandClickTimer.current !== null) {
                    clearTimeout(commandClickTimer.current);
                    commandClickTimer.current = null;
                  }
                  openEditCommand(command);
                },
                onContextMenu: (event) => {
                  event.preventDefault();
                  if (commandClickTimer.current !== null) {
                    clearTimeout(commandClickTimer.current);
                    commandClickTimer.current = null;
                  }
                  openEditCommand(command);
                },
                style: {
                  height: 24,
                  padding: "0 8px",
                  fontSize: 12,
                  fontFamily: "inherit",
                  color: COLORS.label,
                  background: COLORS.bgLayer2,
                  border: "1px solid " + COLORS.border,
                  borderRadius: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  maxWidth: 150,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                },
              },
              command.name,
            ),
          ),
        h(
          "button",
          {
            type: "button",
            title: "新建命令按钮",
            "aria-label": "新建命令按钮",
            onClick: openAddCommand,
            style: {
              height: 24,
              minWidth: 26,
              padding: "0 7px",
              fontSize: 14,
              fontFamily: "inherit",
              color: COLORS.labelSecondary,
              background: "transparent",
              border: "1px dashed " + COLORS.borderStrong,
              borderRadius: 12,
              cursor: "pointer",
            },
          },
          "+",
        ),
      );

      // ── render: toolbar + log (4) ────────────────────────────────────

      const toolbar = h(
        "div",
        { style: { flex: "none", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        h(TinyButton, { onClick: () => { void clearLog(); }, disabled: busy === "clear" || activeLines.length === 0, tone: "danger", title: "清空当前标签的日志" }, "清空"),
        h(TinyButton, { onClick: () => { void copyLog(); }, disabled: visibleActiveLines.length === 0, title: "复制日志：有选中内容时复制选中，否则复制全部（不含发送回显）", onMouseDown: (event) => event.preventDefault() }, "复制"),
        h(TinyButton, { onClick: saveLog, disabled: visibleActiveLines.length === 0, title: "把当前标签日志下载为 .log 文件（不含发送回显）" }, "保存日志"),
        h(Check, { checked: showTime, onChange: setShowTime, label: "时间戳", title: "为每条日志添加时间前缀" }),
        h(Check, { checked: hexView, onChange: setHexView, label: "HEX", title: "以十六进制显示收发字节" }),
      );

      // ── render: log keyword search row (3) ───────────────────────────

      const searchRow = h(
        "div",
        { style: { flex: "none", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } },
        h("input", {
          type: "text",
          value: searchQuery,
          placeholder: "搜索日志",
          title: "搜索日志：Enter 下一个，Shift+Enter 上一个，Esc 清除并回到输入行",
          "aria-label": "搜索日志",
          onChange: (event) => onSearchChange(event.target.value),
          onKeyDown: onSearchKeyDown,
          style: { ...CONTROL_STYLE, height: 22, flex: "1 1 88px", minWidth: 0, fontSize: 11, padding: "0 5px" },
        }),
        h(TinyButton, {
          onClick: () => gotoMatch(-1),
          disabled: !searchActive,
          title: searchActive ? "上一个匹配（Shift+Enter）" : "没有可跳转的匹配",
          style: { height: 22, padding: "0 6px", fontSize: 11 },
        }, "上一个"),
        h(TinyButton, {
          onClick: () => gotoMatch(1),
          disabled: !searchActive,
          title: searchActive ? "下一个匹配（Enter）" : "没有可跳转的匹配",
          style: { height: 22, padding: "0 6px", fontSize: 11 },
        }, "下一个"),
        h("span", {
          title: searchCapped ? "匹配过多，仅保留前 " + SEARCH_LIMIT + " 个" : "当前匹配 / 匹配总数",
          style: { flex: "none", fontSize: 11, color: COLORS.labelSecondary, minWidth: 36, textAlign: "center" },
        }, searchCountText),
        h("button", {
          type: "button",
          title: "清除搜索（Esc）",
          "aria-label": "清除搜索",
          onClick: clearSearch,
          disabled: searchQuery === "",
          style: {
            flex: "none",
            width: 20,
            height: 22,
            padding: 0,
            fontSize: 13,
            lineHeight: "18px",
            fontFamily: "inherit",
            color: searchQuery === "" ? COLORS.idle : COLORS.labelSecondary,
            background: "transparent",
            border: "1px solid " + COLORS.border,
            borderRadius: 3,
            cursor: searchQuery === "" ? "default" : "pointer",
          },
        }, "×"),
      );

      // ── render: ANSI log + in-log terminal input (A/B) ───────────────

      // Group matches per entry for O(1) lookup while rendering.
      const matchesByLine = {};
      if (searchActive) {
        for (const match of searchMatches) {
          const key = match.lineKey;
          if (matchesByLine[key] === undefined) matchesByLine[key] = [];
          matchesByLine[key].push(match);
        }
      }

      /** Render one split piece: plain text/span, or a <mark> highlight. */
      const renderPiece = (piece, index) => {
        const hasStyle = piece.s !== null && piece.s !== undefined && typeof piece.s === "object" && Object.keys(piece.s).length > 0;
        if (piece.matchIndex === null || piece.matchIndex === undefined) {
          return hasStyle ? h("span", { key: "p" + index, style: piece.s }, piece.t) : piece.t;
        }
        const isCurrent = piece.matchIndex === searchCurrentIndex;
        return h("mark", {
          key: "m" + index,
          "data-sifar-match": "1",
          "data-sifar-current-match": isCurrent ? "1" : undefined,
          style: isCurrent ? SEARCH_MARK_CURRENT_STYLE : SEARCH_MARK_STYLE,
        }, hasStyle ? h("span", { style: piece.s }, piece.t) : piece.t);
      };

      const renderLogEntry = (line) => {
        // The log shows only what the board sends back; local TX echo is hidden.
        if (line.kind === "tx") return null;
        const stamp = showTime && typeof line.at === "number" ? formatStamp(line.at) : "";
        const color = line.kind === "err" ? COLORS.error : line.kind === "sys" ? COLORS.labelSecondary : COLORS.label;
        if (hexView && typeof line.b64 === "string") {
          let hex = "";
          try {
            hex = bytesToHex(b64ToBytes(line.b64));
          } catch (error) {
            hex = "（无法解码的字节）";
          }
          return h("div", { key: line.__k, style: { color } }, stamp + hex);
        }
        const lineMatches = matchesByLine[line.__k];
        if (searchActive && Array.isArray(lineMatches) && lineMatches.length > 0) {
          // Split ANSI segments at match boundaries so highlights keep colors.
          const runs = lineStyleRuns(line);
          const pieces = splitRunsByMatches(runs, lineMatches);
          const children = stamp === "" ? [] : [stamp];
          for (let index = 0; index < pieces.length; index += 1) children.push(renderPiece(pieces[index], index));
          return h("div", { key: line.__k, style: { color } }, ...children);
        }
        if (line.kind === "rx" && Array.isArray(line.segs) && line.segs.length > 0) {
          // ANSI rx: timestamp prefix stays plain, styled runs render as spans.
          const children = stamp === "" ? [] : [stamp];
          for (let index = 0; index < line.segs.length; index += 1) {
            const seg = line.segs[index];
            children.push(h("span", { key: index, style: seg.s }, seg.t));
          }
          return h("div", { key: line.__k, style: { color } }, ...children);
        }
        return h("div", { key: line.__k, style: { color } }, stamp + formatLineBody(line));
      };

      const consoleEndingControl = h(
        "div",
        { style: { width: 64, flex: "none" } },
        h(ComboBox, {
          value: consoleEnding,
          title: "发送时追加的行结束符（每个标签单独保存）",
          onChange: (value) => setConsoleEnding(activeTabId, value),
          options: CONSOLE_ENDING_OPTIONS,
        }),
      );

      const consoleNode = h(
        "div",
        {
          onClick: focusConsoleFromEvent,
          style: {
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            border: "1px solid " + COLORS.border,
            borderRadius: 3,
            background: COLORS.bg,
            overflow: "hidden",
          },
        },
        h(
          "div",
          {
            ref: logRef,
            tabIndex: 0,
            role: "log",
            "aria-label": "串口日志（点击后输入命令）",
            className: "dsh-serial-sifarcrt-log",
            onScroll: onLogScroll,
            onMouseDown: onLogMouseDown,
            onMouseUp: onLogMouseUp,
            onMouseLeave: onLogMouseLeave,
            onFocus: () => setConsoleFocused(true),
            onBlur: () => setConsoleFocused(false),
            onKeyDown: onConsoleKeyDown,
            onPaste: onConsolePaste,
            style: {
              flex: 1,
              minHeight: 48,
              overflowY: "auto",
              overflowX: "hidden",
              padding: "4px 6px",
              fontFamily: MONO,
              fontSize: 12,
              lineHeight: "17px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "text",
              color: COLORS.label,
              outline: "none",
              cursor: "text",
            },
          },
          visibleActiveLines.length === 0
            ? h("div", { style: { color: COLORS.labelSecondary, fontSize: 11 } },
              connected ? "等待数据…" : "尚未连接：先点「连接」，然后在此输入命令。")
            : visibleActiveLines.map(renderLogEntry),
        ),
        h(
          "div",
          {
            style: {
              flex: "none",
              borderTop: "1px solid " + COLORS.border,
              padding: "2px 6px 3px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              fontFamily: MONO,
              fontSize: 12,
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 4, minWidth: 0 } },
            h("span", { style: { color: COLORS.success, fontWeight: 600, flex: "none", whiteSpace: "pre" } }, "# "),
            h("span", {
              style: { flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: COLORS.label },
            }, consoleBuffer),
            consoleFocused
              ? h("span", {
                key: "caret",
                className: "sifar-crt-caret",
                "aria-hidden": "true",
                style: {
                  display: "inline-block",
                  width: 8,
                  height: 14,
                  marginLeft: 2,
                  verticalAlign: "text-bottom",
                  background: COLORS.label,
                  borderRadius: 1,
                },
              })
              : null,
            !consoleFocused
              ? h("span", { style: { fontSize: 10, color: COLORS.labelSecondary, whiteSpace: "nowrap", flex: "none" } }, "点击日志窗口输入命令")
              : null,
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.labelSecondary } },
            h("span", { style: { flex: "none" } }, "行尾"),
            consoleEndingControl,
            h("span", {
              style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, "Enter 发送 · ↑↓ 历史 · Ctrl+V 粘贴 · Esc 退出"),
            !following
              ? h("button", {
                type: "button",
                title: "日志已暂停跟随：点击此按钮，或按回车，或滚动到底部，即可恢复跟随最新内容",
                onClick: resumeFollow,
                style: {
                  flex: "none",
                  height: 18,
                  padding: "0 7px",
                  fontSize: 10,
                  fontFamily: "inherit",
                  color: COLORS.warn,
                  background: COLORS.bgLayer2,
                  border: "1px solid " + COLORS.warn,
                  borderRadius: 9,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                },
              }, "已暂停 · 跟随最新")
              : null,
            h("span", { style: { flex: "none" } }, visibleActiveLines.length + " 行"),
          ),
        ),
      );

      // ── render: status line (7) ──────────────────────────────────────

      const statusText = connected ? "已连接" : activeRuntime && activeRuntime.loaded ? "未连接" : "空闲";
      const statusDot = pollError || activeError || (activeRuntime && activeRuntime.lastError)
        ? COLORS.error
        : connected ? COLORS.success : COLORS.idle;

      const statusLine = h(
        "div",
        {
          style: {
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            minHeight: 16,
            padding: "0 1px",
            fontSize: 11,
            color: COLORS.labelSecondary,
          },
        },
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.label, flex: "none" } },
          h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: statusDot, flex: "none" } }),
          statusText),
        summary !== "" ? h("span", { title: "当前串口参数", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" } }, summary) : null,
        h("span", { style: { flex: "none" } }, "收 " + activeCounts.rx + " B"),
        h("span", { style: { flex: "none" } }, "发 " + activeCounts.tx + " B"),
        notice !== null
          ? h("span", { title: notice, style: { color: COLORS.warn, flex: "none" } }, notice)
          : null,
        problemText !== null
          ? h("span", { title: problemText, style: { color: COLORS.error, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%", flex: "1 1 100%" } }, problemText)
          : null,
      );

      const logBox = h(
        "div",
        { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 } },
        consoleNode,
        statusLine,
      );

      // ── render: empty state ──────────────────────────────────────────

      const emptyState = h(
        "div",
        {
          style: {
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            color: COLORS.labelSecondary,
            fontSize: 12,
            border: "1px dashed " + COLORS.border,
            borderRadius: 3,
          },
        },
        h("span", null, "还没有串口会话"),
        h(TinyButton, { onClick: addTab, tone: "primary", title: "创建一个新的串口会话标签" }, "新建串口会话"),
      );

      // ── render: inline command editor (never a body portal) ──────────

      let editorNode = null;
      if (editor !== null) {
        const enterSaves = (event) => {
          if (event.key === "Enter" && !(event.nativeEvent && event.nativeEvent.isComposing)) {
            event.preventDefault();
            saveEditor();
          }
        };
        editorNode = h(
          "div",
          {
            style: {
              position: "absolute",
              inset: 0,
              zIndex: 40,
              background: "rgba(0, 0, 0, 0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
              boxSizing: "border-box",
            },
            onKeyDown: onEditorKeyDown,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) setEditor(null);
            },
          },
          h(
            "div",
            {
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "命令按钮编辑",
              style: {
                width: "100%",
                maxWidth: 320,
                background: COLORS.bgLayer,
                border: "1px solid " + COLORS.borderStrong,
                borderRadius: 6,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
                boxSizing: "border-box",
              },
            },
            h("div", { style: { fontSize: 12, fontWeight: 600, color: COLORS.label } }, editor.mode === "edit" ? "编辑命令按钮" : "新建命令按钮"),
            h(Field, { label: "名称" },
              h("input", {
                ref: nameInputRef,
                type: "text",
                value: editor.name,
                placeholder: "例如：复位",
                title: "按钮显示的名称",
                "aria-label": "命令名称",
                onChange: (event) => updateEditor({ name: event.target.value.slice(0, 40) }),
                onKeyDown: enterSaves,
                style: { ...CONTROL_STYLE, width: "100%" },
              }),
            ),
            h(Field, { label: "命令" },
              h("input", {
                type: "text",
                value: editor.command,
                placeholder: "例如：AT+RST",
                title: "要发送的命令文本",
                "aria-label": "命令内容",
                onChange: (event) => updateEditor({ command: event.target.value }),
                onKeyDown: enterSaves,
                style: { ...CONTROL_STYLE, width: "100%", fontFamily: MONO },
              }),
            ),
            h(Field, { label: "行结束" },
              h(ComboBox, {
                value: editor.ending,
                title: "发送时追加的行结束符",
                onChange: (value) => updateEditor({ ending: value }),
                options: ENDING_OPTIONS,
              }),
            ),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: 2 } },
              editor.mode === "edit" ? h(TinyButton, { onClick: deleteEditorCommand, tone: "danger", title: "删除这个命令按钮" }, "删除") : null,
              h("span", { style: { flex: 1 } }),
              h(TinyButton, { onClick: () => setEditor(null), title: "取消（Esc）" }, "取消"),
              h(TinyButton, { onClick: saveEditor, tone: "primary", title: "保存（Enter）" }, "保存"),
            ),
          ),
        );
      }

      // ── render: serial settings dialog (C; inline, no body portal) ────

      let settingsNode = null;
      if (settings !== null) {
        const portList = ports.slice();
        const currentPort = typeof settings.port === "string" ? settings.port : "";
        if (currentPort !== "" && !portList.some((item) => item.name === currentPort)) {
          portList.push({ name: currentPort, description: "（未检测到）" });
        }
        const portControl = portList.length > 0
          ? h(ComboBox, {
            controlRef: settingsFirstRef,
            value: currentPort,
            title: "串口",
            onChange: (value) => updateSettings({ port: value }),
            options: portList.map((item) => ({
              value: item.name,
              label: item.description === "" ? item.name : item.name + " · " + item.description,
            })),
          })
          : h("input", {
            ref: settingsFirstRef,
            type: "text",
            value: currentPort,
            placeholder: "COM3",
            title: "手动输入串口名称",
            "aria-label": "串口名称",
            onChange: (event) => updateSettings({ port: event.target.value.slice(0, 64) }),
            style: { ...CONTROL_STYLE, width: "100%" },
          });

        settingsNode = h(
          "div",
          {
            style: {
              position: "absolute",
              inset: 0,
              zIndex: 50,
              background: "rgba(0, 0, 0, 0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
              boxSizing: "border-box",
            },
            onKeyDown: onSettingsKeyDown,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) setSettings(null);
            },
          },
          h(
            "div",
            {
              role: "dialog",
              "aria-modal": "true",
              "aria-label": "串口设置",
              style: {
                width: "100%",
                maxWidth: 320,
                background: COLORS.bgLayer,
                border: "1px solid " + COLORS.borderStrong,
                borderRadius: 6,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
                boxSizing: "border-box",
              },
            },
            h("div", { style: { fontSize: 12, fontWeight: 600, color: COLORS.label } }, "串口设置"),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
              h(Field, { label: "串口", flex: "1 1 0" }, portControl),
              h(TinyButton, {
                onClick: () => {
                  void refreshPorts();
                },
                disabled: busy === "ports",
                title: "重新枚举串口",
              }, busy === "ports" ? "…" : "刷新"),
            ),
            h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
              h(Field, { label: "波特率", flex: "1 1 110px" },
                h("input", {
                  type: "text",
                  inputMode: "numeric",
                  list: "dsh-serial-sifarcrt-baud-presets",
                  value: String(settings.baudRate === undefined || settings.baudRate === null ? "" : settings.baudRate),
                  title: "波特率（整数，50–1500000）",
                  "aria-label": "波特率",
                  onChange: (event) => {
                    const raw = event.target.value.replace(/[^0-9]/g, "");
                    updateSettings({ baudRate: raw === "" ? "" : Number(raw) });
                  },
                  style: { ...CONTROL_STYLE, width: "100%" },
                }),
                h("datalist", { id: "dsh-serial-sifarcrt-baud-presets" },
                  BAUD_PRESETS.map((rate) => h("option", { key: String(rate), value: String(rate) })),
                ),
              ),
              h(Field, { label: "校验位", flex: "1 1 90px" },
                h(ComboBox, {
                  value: settings.parity,
                  title: "校验位",
                  onChange: (value) => updateSettings({ parity: value }),
                  options: PARITY_OPTIONS,
                }),
              ),
            ),
            h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
              h(Field, { label: "流控", flex: "1 1 130px" },
                h(ComboBox, {
                  value: settings.handshake,
                  title: "流控",
                  onChange: (value) => updateSettings({ handshake: value }),
                  options: HANDSHAKE_OPTIONS,
                }),
              ),
              h(Field, { label: "数据位", flex: "1 1 70px" },
                h(ComboBox, {
                  value: String(settings.dataBits),
                  title: "数据位",
                  onChange: (value) => updateSettings({ dataBits: Number(value) }),
                  options: DATA_BITS.map((item) => ({ value: String(item), label: String(item) })),
                }),
              ),
              h(Field, { label: "停止位", flex: "1 1 70px" },
                h(ComboBox, {
                  value: settings.stopBits,
                  title: "停止位",
                  onChange: (value) => updateSettings({ stopBits: value }),
                  options: STOP_OPTIONS,
                }),
              ),
            ),
            settings.error !== null && settings.error !== undefined
              ? h("div", { style: { fontSize: 11, color: COLORS.error, wordBreak: "break-all" } }, settings.error)
              : null,
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 } },
              h("span", { style: { flex: 1, fontSize: 11, color: COLORS.labelSecondary } }, connected ? "连接中修改将在重连后生效" : ""),
              h(TinyButton, { onClick: cancelSettings, title: "取消（Esc）" }, "取消"),
              h(TinyButton, { onClick: saveSettings, tone: "primary", title: "确定（Enter）" }, "确定"),
            ),
          ),
        );
      }

      // ── render: assemble ─────────────────────────────────────────────

      const body = activeTab === null
        ? emptyState
        : h(
          "div",
          { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 } },
          actionRow,
          commandsBand,
          toolbar,
          searchRow,
          logBox,
        );

      return h(
        "div",
        {
          ref: panelRef,
          style: {
            position: "relative",
            flex: "1 1 auto",
            height: "100%",
            minHeight: 0,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            boxSizing: "border-box",
            overflow: "hidden",
            background: COLORS.bg,
            color: COLORS.label,
            fontSize: 12,
          },
        },
        h("style", { key: "dsh-serial-sifarcrt-caret-style", dangerouslySetInnerHTML: { __html: CARET_CSS } }),
        tabStrip,
        body,
        editorNode,
        settingsNode,
      );
    }

    /** Remove a key from a plain state object without mutating it. */
    function omitKey(object, key) {
      const next = { ...object };
      delete next[key];
      return next;
    }

    // ── right sidebar tab registration ─────────────────────────────────

    /** Tab type id: the registry key, and the body/title slot key. */
    const TAB_TYPE_ID = "dsh-serial-sifarcrt:panel";
    /** The kind a guide row opens and `openTab` addresses. */
    const TAB_KIND = "dsh-serial-sifarcrt";

    /** Outcome of the tab-type registration, surfaced by the mount diagnostic. */
    const rightTabState = { registered: false, error: null };
    /** Which keyed slots actually registered (diagnostic only). */
    const slotState = { body: false, title: false };

    /** The tab's chip title in the right sidebar's strip. */
    function SifarCrtTabTitle() {
      return h("span", { style: { whiteSpace: "nowrap" } }, "sifarCRT");
    }

    /**
     * Register the panel as a native right-sidebar tab type with a guide row.
     *
     * ORDERING IS THE WHOLE TRICK HERE (see the reference plugin): the native
     * seat declares `sidebar.right.pane.tab` BEFORE it provides the
     * `sidebarRightTabs` service, so waiting on the SERVICE through `ctx.inject`
     * is what makes the registration land. The body re-runs whenever the service
     * appears or is replaced.
     */
    function registerRightSidebarTab(ctx) {
      return ctx.inject(["sidebarRightTabs"], (scoped) => {
        const tabs = scoped.get("sidebarRightTabs");
        if (tabs === undefined || tabs === null) return undefined;

        const disposers = [];
        const release = () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch (error) {
              // Already released.
            }
          }
          slotState.body = false;
          slotState.title = false;
        };

        try {
          disposers.push(
            tabs.register({
              id: TAB_TYPE_ID,
              kind: TAB_KIND,
              title: () => "sifarCRT",
              guide: [
                {
                  id: TAB_KIND,
                  order: 40,
                  title: () => "sifarCRT",
                  description: () => "多串口调试 / 命令按钮 / 日志保存",
                  icon: (iconProps) => h(SifarCrtIcon, { size: (iconProps && iconProps.size) || 16, active: Boolean(iconProps && iconProps.active) }),
                },
              ],
            }),
          );
          disposers.push(
            ctx.slots.inject("sidebar.right.pane.tab", () => {
              const dispose = ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE_ID }, SifarCrtPage);
              slotState.body = true;
              return dispose;
            }),
          );
          disposers.push(
            ctx.slots.inject("sidebar.right.pane.tab.title", () => {
              const dispose = ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_TYPE_ID }, SifarCrtTabTitle);
              slotState.title = true;
              return dispose;
            }),
          );
        } catch (error) {
          release();
          rightTabState.registered = false;
          rightTabState.error = messageOf(error);
          throw error;
        }
        rightTabState.registered = true;
        rightTabState.error = null;
        return release;
      });
    }

    // ── mount diagnostic (9: verification-critical, never throws) ──────

    async function probePorts() {
      try {
        const data = await request("/ports", { method: "GET" }, 3000);
        return { ok: true, count: normalizePorts(data && data.ports).length };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    }

    function postReport(payload) {
      try {
        if (typeof fetch !== "function") return;
        void fetch(BASE + "/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
          keepalive: true,
        }).catch(() => {});
      } catch (error) {
        // A diagnostic must never break the plugin.
      }
    }

    function reportMount() {
      try {
        if (typeof document === "undefined") return;
        const payload = {
          at: Date.now(),
          href: safeHref(),
          features: ["ansi-line-reset", "blink-caret", "log-search", "ansi", "log-terminal-input", "config-dialog"],
          rightTab: { registered: rightTabState.registered, error: rightTabState.error },
          slotBody: slotState.body,
          slotTitle: slotState.title,
        };
        try {
          const guide = document.querySelector("[data-sidebar-right-guide]");
          const rows = [];
          if (guide !== null && guide !== undefined) {
            const buttons = guide.querySelectorAll("button");
            for (const row of buttons) rows.push(String(row.textContent || "").trim().slice(0, 40));
          }
          payload.domGuide = {
            found: guide !== null && guide !== undefined,
            hasMine: Boolean(guide !== null && guide !== undefined && String(guide.textContent || "").includes("sifarCRT")),
            rows,
          };
        } catch (error) {
          payload.domGuide = { found: false, hasMine: false, rows: [], error: messageOf(error) };
        }
        void probePorts().then((probe) => {
          payload.portsProbe = probe;
          postReport(payload);
        });
      } catch (error) {
        // Never let diagnostics affect rendering.
      }
    }

    // ── plugin entry ───────────────────────────────────────────────────

    /** Only the slot registry is required; sidebarRightTabs is injected. */
    const inject = ["slots"];

    function apply(ctx) {
      const seat = registerRightSidebarTab(ctx);
      ctx.effect(() => () => {
        if (seat !== undefined && seat !== null && typeof seat.dispose === "function") seat.dispose();
      }, "dsh-serial-sifarcrt: right sidebar tab type");

      // Sample a few times so the reported state is the settled one.
      const timers = [];
      for (const delay of [2000, 6000, 12000, 20000]) {
        try {
          timers.push(setTimeout(() => reportMount(), delay));
        } catch (error) {
          // Timer unavailable in this context; diagnostics are optional.
        }
      }
      ctx.effect(() => () => {
        for (const timer of timers) {
          try {
            clearTimeout(timer);
          } catch (error) {
            // Ignore.
          }
        }
      }, "dsh-serial-sifarcrt: mount diagnostics");
    }

    exports.TAB_TYPE_ID = TAB_TYPE_ID;
    exports.TAB_KIND = TAB_KIND;
    exports.SifarCrtPage = SifarCrtPage;
    exports.SifarCrtIcon = SifarCrtIcon;
    exports.SifarCrtTabTitle = SifarCrtTabTitle;
    exports.registerRightSidebarTab = registerRightSidebarTab;
    exports.reportMount = reportMount;
    exports.validateBaud = validateBaud;
    exports.summarizeConfig = summarizeConfig;
    // ANSI engine, exported exactly as the log renderer uses it (host-side
    // verification can drive the streaming parser without a browser).
    exports.createAnsiState = createAnsiState;
    exports.ansiFeed = ansiFeed;
    exports.ansiFeedBytes = ansiFeedBytes;
    exports.ansiPalette = ANSI_PALETTE;
    exports.ansiColor256 = ansiColor256;
    // Display filter shared by the log view and 复制 / 保存日志 (hides local TX echo).
    exports.visibleLines = visibleLines;
    // Near-bottom threshold shared by the log scroll handlers (pure, testable).
    exports.isLogAtBottom = isLogAtBottom;
    // Pure log-search helpers shared with the renderer (exported for tests).
    exports.findLogMatches = findLogMatches;
    exports.splitRunsByMatches = splitRunsByMatches;
    exports.lineDisplayText = lineDisplayText;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
