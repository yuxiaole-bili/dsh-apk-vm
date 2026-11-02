/**
 * lib/cdp.js — dependency-free WebView DevTools (CDP) bridge.
 *
 * Android WebViews that have debugging enabled expose an abstract unix socket
 * named `webview_devtools_remote_<pid>` (some builds also expose the generic
 * `webview_devtools_remote`). This module discovers those sockets through adb,
 * forwards each one to a host TCP port, reads `/json/list`, and speaks the
 * Chrome DevTools Protocol over the resulting WebSocket.
 *
 * Requirements: Node.js 22+ (Node 24 recommended) for the global WebSocket and
 * fetch implementations. There are no npm dependencies.
 *
 * Public API:
 *   parseForwardPort(stdout) -> number | null
 *   normalizeSelector(selector) -> CSS selector string
 *   deepQuerySelector(root, selector) -> Element | null (also injected into pages)
 *   class CdpBridge
 *   class CdpSession
 *
 * Security notes:
 *   - No page text or inserted text is echoed in return values or errors.
 *   - Session errors never include the WebSocket URL (which may carry a token).
 *   - The bridge only forwards sockets whose names match the two WebView
 *     devtools patterns, and only connects to the host-side forwarded port.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const TARGET_CACHE_MS = 1_500;
const DEFAULT_POLL_MS = 100;
const WS_OPEN = 1;
const SOCKET_NAME_RE = /^webview_devtools_remote(?:_\d+)?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
const WS_URL_MAX = 4096;
const TARGET_URL_MAX = 8192;
const TARGET_TITLE_MAX = 500;
const TARGET_ID_MAX = 512;

class CdpError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CdpError';
    this.code = code;
  }
}

function cdpError(message, code, cause) {
  return new CdpError(message, code, cause);
}

function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  return String(value);
}

function limitText(value, limit, collapse = false) {
  let text = toText(value);
  if (collapse) text = text.replace(CONTROL_RE, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function errorDetail(value, limit = 300) {
  if (!value) return '';
  if (typeof value === 'object') {
    const text = toText(value.message || value.stderr || value.stdout).replace(CONTROL_RE, ' ').trim();
    return limitText(text, limit);
  }
  return limitText(value, limit, true);
}

function checkTimeout(value) {
  const timeoutMs = value == null ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  return Math.max(1, Math.round(timeoutMs));
}

function normalizeHost(value) {
  const host = value == null ? '127.0.0.1' : String(value).trim();
  if (!host || /[\s/]/.test(host) || host.includes('://')) {
    throw new TypeError('host must be a hostname or IP address without a scheme or path');
  }
  return host;
}

function urlHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  if (host.includes(':')) return `[${host}]`;
  return host;
}

function checkSerial(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw cdpError('adb serial resolved to an empty or non-string value', 'CDP_ADB_ERROR');
  }
  return value.trim();
}

/**
 * Parse the local port printed by `adb forward tcp:0 localabstract:...`.
 * Accepts a Buffer or string, surrounding whitespace, ignored banner lines,
 * and an optional `tcp:` prefix. Returns null for unparseable output.
 *
 * @param {string | Buffer | Uint8Array} stdout
 * @returns {number | null}
 */
export function parseForwardPort(stdout) {
  const text = toText(stdout);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = /^(?:tcp:)?(\d{1,5})$/i.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return null;
}

function escapeCssString(value) {
  return String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '"') return '\\"';
    return `\\${ch.charCodeAt(0).toString(16)} `;
  });
}

/**
 * Normalize the small selector dialect accepted by the action helpers.
 * Plain CSS is passed through (outer whitespace trimmed). `testid:VALUE` is
 * translated to an exact `[data-testid="VALUE"]` attribute selector.
 *
 * @param {string} selector
 * @returns {string}
 */
export function normalizeSelector(selector) {
  if (typeof selector !== 'string') throw new TypeError('selector must be a string');
  const trimmed = selector.trim();
  if (!trimmed) throw new TypeError('selector must not be empty');
  if (trimmed.startsWith('testid:')) {
    const value = trimmed.slice('testid:'.length);
    if (!value) throw new TypeError('testid selector must include a value');
    return `[data-testid="${escapeCssString(value)}"]`;
  }
  return trimmed;
}

/**
 * Query `root` and every open shadow root below it. The function is deliberately
 * self-contained and serializable so the same implementation can be injected
 * into a page with `Function.prototype.toString()`.
 *
 * @param {any} root usually document or a ShadowRoot
 * @param {string} selector CSS selector
 * @returns {any | null}
 */
export function deepQuerySelector(root, selector) {
  if (!root || typeof root.querySelector !== 'function') return null;
  const seen = new Set([root]);
  const find = (scope) => {
    const direct = scope.querySelector(selector);
    if (direct) return direct;
    if (typeof scope.querySelectorAll !== 'function') return null;
    const elements = scope.querySelectorAll('*');
    for (const element of elements) {
      const shadow = element && element.shadowRoot;
      if (!shadow || seen.has(shadow)) continue;
      seen.add(shadow);
      const hit = find(shadow);
      if (hit) return hit;
    }
    return null;
  };
  return find(root);
}

const DEEP_QUERY_SOURCE = deepQuerySelector.toString();

function withDeepQuery(selector, body) {
  return `(() => {
    const deepQuerySelector = ${DEEP_QUERY_SOURCE};
    const selector = ${JSON.stringify(selector)};
    try {
      const element = deepQuerySelector(document, selector);
      ${body}
    } catch (error) {
      return { ok: false, reason: 'error', error: String((error && error.message) || error).slice(0, 500) };
    }
  })()`;
}

function clickProbeExpression(selector) {
  return withDeepQuery(
    selector,
    `if (!element) return { ok: false, reason: 'not-found' };
     if (typeof element.scrollIntoView === 'function') {
       try { element.scrollIntoView({ block: 'center', inline: 'center' }); }
       catch (_) { try { element.scrollIntoView(); } catch (_) {} }
     }
     let rect = null;
     if (typeof element.getBoundingClientRect === 'function') {
       const box = element.getBoundingClientRect();
       const left = Number(box && box.left);
       const top = Number(box && box.top);
       const width = Number(box && box.width);
       const height = Number(box && box.height);
       if ([left, top, width, height].every(Number.isFinite)) {
         rect = { left, top, width, height, x: left + width / 2, y: top + height / 2 };
       }
     }
     return {
       ok: true,
       rect,
       clickable: typeof element.click === 'function',
       viewport: { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 },
     };`,
  );
}

function domClickExpression(selector) {
  return withDeepQuery(
    selector,
    `if (!element) return { ok: false, reason: 'not-found' };
     if (typeof element.scrollIntoView === 'function') {
       try { element.scrollIntoView({ block: 'center', inline: 'center' }); }
       catch (_) { try { element.scrollIntoView(); } catch (_) {} }
     }
     if (typeof element.click !== 'function') return { ok: false, reason: 'not-clickable' };
     element.click();
     return { ok: true };`,
  );
}

function waitExpression(selector) {
  return withDeepQuery(
    selector,
    `return { ok: true, found: !!element };`,
  );
}

function focusExpression(selector) {
  return withDeepQuery(
    selector,
    `if (!element) return { ok: false, reason: 'not-found' };
     if (typeof element.scrollIntoView === 'function') {
       try { element.scrollIntoView({ block: 'center', inline: 'center' }); }
       catch (_) { try { element.scrollIntoView(); } catch (_) {} }
     }
     if (typeof element.focus !== 'function') return { ok: false, reason: 'not-focusable' };
     try { element.focus({ preventScroll: true }); }
     catch (_) { element.focus(); }
     return { ok: true };`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return null;
}

function rebaseWebSocketUrl(raw, host, port) {
  const text = limitText(raw, WS_URL_MAX, true);
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
  // Always connect through the local adb forward. DevTools servers sometimes
  // advertise localhost:9222 regardless of the actual forwarded port.
  return `${url.protocol}//${urlHost(host)}:${port}${url.pathname}${url.search}`;
}

function makeTarget(raw, socketName, port, ordinal, host) {
  if (!raw || typeof raw !== 'object') return null;
  const webSocketDebuggerUrl = rebaseWebSocketUrl(raw.webSocketDebuggerUrl, host, port);
  if (!webSocketDebuggerUrl) return null;
  const rawId = limitText(raw.id, TARGET_ID_MAX, true);
  return {
    id: rawId || `${socketName}:${ordinal}`,
    title: limitText(raw.title, TARGET_TITLE_MAX, true),
    url: limitText(raw.url, TARGET_URL_MAX, true),
    type: limitText(raw.type || 'page', 64, true) || 'page',
    webSocketDebuggerUrl,
    socketName,
    port,
  };
}

function targetKey(target) {
  return target.id || target.webSocketDebuggerUrl;
}

function copyTargets(targets) {
  return targets.map((target) => ({ ...target }));
}

function matchesTarget(target, index, descriptor) {
  if (descriptor.id != null && String(target.id) !== String(descriptor.id)) return false;
  if (descriptor.index != null && index !== descriptor.index) return false;
  if (
    descriptor.urlContains != null &&
    !String(target.url || '').includes(String(descriptor.urlContains))
  ) {
    return false;
  }
  if (
    descriptor.titleContains != null &&
    !String(target.title || '').includes(String(descriptor.titleContains))
  ) {
    return false;
  }
  return true;
}

function selectTarget(targets, descriptor) {
  if (descriptor == null) return targets[0];
  if (typeof descriptor === 'string') return targets.find((target) => target.id === descriptor) || null;
  if (typeof descriptor === 'number') {
    if (!Number.isInteger(descriptor) || descriptor < 0 || descriptor >= targets.length) return null;
    return targets[descriptor];
  }
  if (typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;

  const normalized = {};
  if (descriptor.id != null) normalized.id = descriptor.id;
  if (descriptor.index != null) {
    const index = Number(descriptor.index);
    if (!Number.isInteger(index) || index < 0) return null;
    normalized.index = index;
  }
  if (descriptor.urlContains != null) normalized.urlContains = descriptor.urlContains;
  if (descriptor.titleContains != null) normalized.titleContains = descriptor.titleContains;

  return targets.find((target, index) => matchesTarget(target, index, normalized)) || null;
}

function selectDescription(descriptor) {
  if (descriptor == null) return 'first target';
  if (typeof descriptor === 'string') return `id=${descriptor}`;
  if (typeof descriptor === 'number') return `index=${descriptor}`;
  if (typeof descriptor !== 'object') return 'invalid target descriptor';
  const parts = [];
  if (descriptor.id != null) parts.push(`id=${descriptor.id}`);
  if (descriptor.index != null) parts.push(`index=${descriptor.index}`);
  if (descriptor.urlContains != null) parts.push(`urlContains=${descriptor.urlContains}`);
  if (descriptor.titleContains != null) parts.push(`titleContains=${descriptor.titleContains}`);
  return parts.length ? parts.join(', ') : 'first target';
}

/**
 * Open one Chrome DevTools Protocol WebSocket.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<any>} an open WHATWG WebSocket
 */
async function openWebSocket(url, timeoutMs) {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw cdpError('global WebSocket is unavailable (Node.js 22+ is required)', 'CDP_WEBSOCKET_UNAVAILABLE');
  }

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      // Do not include the URL or a constructor message that may echo it: the
      // DevTools URL can carry a per-session token.
      reject(cdpError('Could not create CDP WebSocket', 'CDP_CONNECT_ERROR', error));
      return;
    }

    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      } catch {
        /* ignore */
      }
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(cdpError(message, 'CDP_CONNECT_ERROR'));
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.binaryType = 'arraybuffer';
      } catch {
        /* text messages are all CDP needs */
      }
      resolve(socket);
    };
    const onError = () => fail('Could not connect to the WebView DevTools WebSocket');
    const onClose = () => fail('The WebView DevTools WebSocket closed before it opened');

    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    timer = setTimeout(
      () => fail(`Timed out connecting to the WebView DevTools WebSocket after ${timeoutMs}ms`),
      timeoutMs,
    );
  });
}

/**
 * One CDP connection. Normally obtained from `CdpBridge#open()`, but it may be
 * constructed around an already-open WebSocket for tests or custom transports.
 */
export class CdpSession {
  /**
   * @param {any} socket already-open WHATWG WebSocket
   * @param {object} target sanitized target descriptor (optional, informational)
   * @param {{ timeoutMs?: number, url?: string }} options
   */
  constructor(socket, target = {}, options = {}) {
    if (!socket || typeof socket.send !== 'function' || typeof socket.addEventListener !== 'function') {
      throw new TypeError('socket must be an open WHATWG WebSocket');
    }
    this.target = target && typeof target === 'object' ? { ...target } : {};
    this.timeoutMs = checkTimeout(options.timeoutMs);
    this._socket = socket;
    this._url = typeof options.url === 'string' ? options.url : '';
    this._nextId = 1;
    this._pending = new Map();
    this._closed = false;
    this._reconnectUsed = false;
    this._connectPromise = null;
    this._attach(socket);
  }

  /** Build a session by opening a WebSocket. */
  static async connect(url, target = {}, options = {}) {
    if (typeof url !== 'string' || !/^wss?:\/\//i.test(url)) {
      throw cdpError('target has no usable WebSocket debugger URL', 'CDP_NO_TARGET');
    }
    const timeoutMs = checkTimeout(options.timeoutMs);
    const socket = await openWebSocket(url, timeoutMs);
    return new CdpSession(socket, target, { ...options, timeoutMs, url });
  }

  _attach(socket) {
    socket.addEventListener('message', (event) => {
      if (this._socket !== socket) return;
      this._onMessage(event);
    });
    socket.addEventListener('close', () => {
      if (this._socket !== socket) return;
      this._socket = null;
      this._rejectPending(cdpError('CDP WebSocket closed unexpectedly', 'CDP_DISCONNECTED'));
    });
    socket.addEventListener('error', () => {
      if (this._socket !== socket) return;
      this._socket = null;
      this._rejectPending(cdpError('CDP WebSocket failed', 'CDP_DISCONNECTED'));
      try {
        socket.close();
      } catch {
        /* already down */
      }
    });
  }

  _onMessage(event) {
    const text = messageText(event && event.data);
    if (text == null) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || message.id == null || message.method) return;
    const id = Number(message.id);
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      const detail = limitText(message.error.message || 'CDP request failed', 500, true);
      const error = cdpError(`CDP ${pending.method} failed: ${detail}`, 'CDP_ERROR');
      if (message.error.code != null) error.cdpCode = message.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result && typeof message.result === 'object' ? message.result : {});
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _isOpen() {
    return !!this._socket && this._socket.readyState === WS_OPEN;
  }

  async _ensureConnected() {
    if (this._closed) throw cdpError('CDP session is closed', 'CDP_CLOSED');
    if (this._isOpen()) return this._socket;
    if (this._socket) {
      throw cdpError('CDP WebSocket is not open', 'CDP_DISCONNECTED');
    }
    if (!this._url || this._reconnectUsed) {
      throw cdpError('CDP session is disconnected', 'CDP_DISCONNECTED');
    }
    if (this._connectPromise) return this._connectPromise;

    this._reconnectUsed = true;
    this._connectPromise = openWebSocket(this._url, this.timeoutMs)
      .then((socket) => {
        if (this._closed) {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          throw cdpError('CDP session is closed', 'CDP_CLOSED');
        }
        this._attach(socket);
        this._socket = socket;
        return socket;
      })
      .finally(() => {
        this._connectPromise = null;
      });
    return this._connectPromise;
  }

  /**
   * Send a CDP command and resolve with its `result` object.
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<object>}
   */
  async send(method, params) {
    if (typeof method !== 'string' || !method.trim()) {
      throw new TypeError('method must be a non-empty CDP method string');
    }
    if (this._closed) throw cdpError('CDP session is closed', 'CDP_CLOSED');
    await this._ensureConnected();
    const socket = this._socket;
    if (!this._isOpen()) {
      throw cdpError('CDP WebSocket is not open', 'CDP_DISCONNECTED');
    }

    const id = this._nextId++;
    let payload;
    try {
      payload = JSON.stringify({ id, method, params: params === undefined ? {} : params });
    } catch (error) {
      throw cdpError(`Could not serialize CDP params: ${errorDetail(error)}`, 'CDP_INVALID_PARAMS', error);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(cdpError(`CDP ${method} timed out after ${this.timeoutMs}ms`, 'CDP_TIMEOUT'));
      }, this.timeoutMs);
      this._pending.set(id, { method, resolve, reject, timer });
      try {
        socket.send(payload);
      } catch (error) {
        if (this._pending.delete(id)) clearTimeout(timer);
        reject(cdpError(`Could not send CDP ${method}: ${errorDetail(error)}`, 'CDP_SEND_ERROR', error));
      }
    });
  }

  /**
   * Evaluate JavaScript in the main frame and return a JSON-safe by-value result.
   * `undefined`, DOM nodes and other non-by-value results become null. BigInt
   * and special numbers are returned as their CDP `unserializableValue` string.
   * @param {string} expression
   * @param {{ awaitPromise?: boolean, returnByValue?: boolean }} [options]
   * @returns {Promise<any>}
   */
  async evaluate(expression, options = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new TypeError('expression must be a non-empty string');
    }
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
    });
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception || {};
      let description = exception.description || exception.value;
      if (description == null) description = details.text;
      if (description == null) description = 'unknown exception';
      throw cdpError(
        `Runtime.evaluate failed: ${limitText(description, 1000, true)}`,
        'CDP_EVALUATION_ERROR',
      );
    }
    const remote = result && result.result;
    if (!remote || typeof remote !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
      return remote.value === undefined ? null : remote.value;
    }
    if (typeof remote.unserializableValue === 'string') return remote.unserializableValue;
    return null;
  }

  /**
   * Click an element found through the deep (open shadow DOM) query. Mouse
   * events at the viewport center are preferred; when a box is unavailable or
   * the mouse dispatch fails, the page's `element.click()` is used.
   * @param {string} selector CSS or `testid:VALUE`
   * @returns {Promise<true>}
   */
  async click(selector) {
    const normalized = normalizeSelector(selector);
    const probe = await this.evaluate(clickProbeExpression(normalized));
    if (!probe || probe.ok !== true) {
      if (probe && probe.reason === 'not-found') {
        throw cdpError(
          `Selector not found: ${limitText(normalized, 300, true)}`,
          'CDP_SELECTOR_NOT_FOUND',
        );
      }
      throw cdpError(
        `Could not inspect selector ${limitText(normalized, 300, true)}: ${limitText(probe && probe.error, 500, true)}`,
        'CDP_EVALUATION_ERROR',
      );
    }

    const rect = probe.rect;
    const viewport = probe.viewport || {};
    const vw = Number(viewport.width);
    const vh = Number(viewport.height);
    const x = rect ? Number(rect.x) : NaN;
    const y = rect ? Number(rect.y) : NaN;
    if (
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(vw) &&
      Number.isFinite(vh) &&
      x >= 0 &&
      y >= 0 &&
      x < vw &&
      y < vh
    ) {
      try {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
        });
        await this.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        return true;
      } catch {
        // Fall through to element.click(); a screen surface may reject input
        // events even though the JS click path still works.
      }
    }

    const clicked = await this.evaluate(domClickExpression(normalized));
    if (clicked && clicked.ok === true) return true;
    if (clicked && clicked.reason === 'not-found') {
      throw cdpError(
        `Selector not found: ${limitText(normalized, 300, true)}`,
        'CDP_SELECTOR_NOT_FOUND',
      );
    }
    if (clicked && clicked.reason === 'not-clickable') {
      throw cdpError(
        `Element for selector ${limitText(normalized, 300, true)} has no click() method`,
        'CDP_CLICK_FAILED',
      );
    }
    throw cdpError(
      `Could not click selector ${limitText(normalized, 300, true)}: ${limitText(clicked && clicked.error, 500, true)}`,
      'CDP_CLICK_FAILED',
    );
  }

  /**
   * Poll for a selector, including inside open shadow roots.
   * @param {string} selector
   * @param {{ timeoutMs?: number, pollMs?: number }} [options]
   * @returns {Promise<true>}
   */
  async waitFor(selector, options = {}) {
    const normalized = normalizeSelector(selector);
    const timeoutMs = options.timeoutMs == null ? this.timeoutMs : Number(options.timeoutMs);
    const pollMs = options.pollMs == null ? DEFAULT_POLL_MS : Number(options.pollMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a non-negative number');
    }
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new TypeError('pollMs must be a positive number');
    }

    const started = Date.now();
    for (;;) {
      const result = await this.evaluate(waitExpression(normalized));
      if (result && typeof result === 'object' && result.reason === 'error') {
        throw cdpError(
          `Could not query selector ${limitText(normalized, 300, true)}: ${limitText(result.error, 500, true)}`,
          'CDP_EVALUATION_ERROR',
        );
      }
      if (result && result.found === true) return true;
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        throw cdpError(
          `Timed out waiting for selector ${limitText(normalized, 300, true)} after ${Math.round(elapsed)}ms`,
          'CDP_SELECTOR_TIMEOUT',
        );
      }
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
    }
  }

  /**
   * Focus an element (when a selector is supplied) and insert Unicode text via
   * `Input.insertText`. No page text is included in the return value.
   * @param {string} text
   * @param {{ selector?: string }} [options]
   * @returns {Promise<true>}
   */
  async insertText(text, options = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (options.selector != null) {
      const normalized = normalizeSelector(options.selector);
      const focused = await this.evaluate(focusExpression(normalized));
      if (!focused || focused.ok !== true) {
        if (focused && focused.reason === 'not-found') {
          throw cdpError(
            `Selector not found for focus: ${limitText(normalized, 300, true)}`,
            'CDP_SELECTOR_NOT_FOUND',
          );
        }
        if (focused && focused.reason === 'not-focusable') {
          throw cdpError(
            `Element for selector ${limitText(normalized, 300, true)} cannot be focused`,
            'CDP_FOCUS_FAILED',
          );
        }
        throw cdpError(
          `Could not focus selector ${limitText(normalized, 300, true)}: ${limitText(focused && focused.error, 500, true)}`,
          'CDP_FOCUS_FAILED',
        );
      }
    }
    await this.send('Input.insertText', { text });
    return true;
  }

  /** Close the WebSocket and reject all pending commands. Idempotent. */
  close() {
    if (this._closed) return;
    this._closed = true;
    const socket = this._socket;
    this._socket = null;
    this._rejectPending(cdpError('CDP session is closed', 'CDP_CLOSED'));
    if (socket) {
      try {
        socket.close(1000, '');
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Discover, cache, and connect to WebView DevTools targets on one adb device.
 */
export class CdpBridge {
  /**
   * @param {{
   *   adb: (args: string[], options?: object) => Promise<{code:number,timedOut:boolean,stdout:any,stderr:any}>,
   *   serial: string | (() => string | Promise<string>),
   *   host?: string,
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options = {}) {
    if (typeof options.adb !== 'function') throw new TypeError('adb must be a function');
    if (typeof options.serial !== 'string' && typeof options.serial !== 'function') {
      throw new TypeError('serial must be a string or an async function returning a string');
    }
    this.adb = options.adb;
    this.serial = options.serial;
    this.host = normalizeHost(options.host);
    this.timeoutMs = checkTimeout(options.timeoutMs);

    this._closed = false;
    this._discovering = null;
    this._cacheTargets = [];
    this._cacheAt = 0;
    this._forwards = new Map();
    this._sessions = new Set();
  }

  async _getSerial() {
    let value;
    try {
      value = typeof this.serial === 'function' ? await this.serial() : this.serial;
    } catch (error) {
      throw cdpError(`Could not resolve adb serial: ${errorDetail(error)}`, 'CDP_ADB_ERROR', error);
    }
    return checkSerial(value);
  }

  async _runAdb(args, label) {
    let result;
    try {
      result = await this.adb(args, { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw cdpError(`${label}: ${errorDetail(error)}`, 'CDP_ADB_ERROR', error);
    }
    if (!result || typeof result !== 'object') {
      throw cdpError(`${label}: adb returned no result object`, 'CDP_ADB_ERROR');
    }
    if (result.timedOut) {
      throw cdpError(`${label}: adb timed out after ${this.timeoutMs}ms`, 'CDP_ADB_ERROR');
    }
    if (result.code !== 0) {
      const detail = errorDetail(result.stderr) || errorDetail(result.stdout);
      throw cdpError(
        `${label}: adb exited ${result.code}${detail ? ` (${detail})` : ''}`,
        'CDP_ADB_ERROR',
      );
    }
    return result;
  }

  _socketNames(unixTable) {
    const names = [];
    const seen = new Set();
    for (const rawLine of toText(unixTable).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const fields = line.split(/\s+/);
      const candidate = fields[fields.length - 1].replace(/^@/, '');
      if (!SOCKET_NAME_RE.test(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      names.push(candidate);
    }
    return names;
  }

  _forwardKey(serial, socketName) {
    return `${serial}\u0000${socketName}`;
  }

  async _ensureForward(serial, socketName) {
    const key = this._forwardKey(serial, socketName);
    const cached = this._forwards.get(key);
    if (cached) return cached;
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');

    const result = await this._runAdb(
      ['-s', serial, 'forward', 'tcp:0', `localabstract:${socketName}`],
      `Could not forward WebView socket ${socketName}`,
    );
    const port = parseForwardPort(result.stdout);
    if (!port) {
      throw cdpError(
        `adb forward for ${socketName} did not report a local port: ${limitText(result.stdout, 200, true) || '(empty output)'}`,
        'CDP_FORWARD_FAILED',
      );
    }
    if (this._closed) {
      await this._removeForward({ serial, socketName, port });
      throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    }
    const entry = { serial, socketName, port };
    this._forwards.set(key, entry);
    return entry;
  }

  async _removeForward(entry) {
    if (!entry) return;
    try {
      await this.adb(
        ['-s', entry.serial, 'forward', '--remove', `tcp:${entry.port}`],
        { timeoutMs: this.timeoutMs },
      );
    } catch {
      /* best effort: the device may already be gone */
    }
  }

  async _dropForward(key, entry) {
    if (this._forwards.get(key) === entry) this._forwards.delete(key);
    await this._removeForward(entry);
  }

  async _fetchTargetList(port) {
    const url = `http://${urlHost(this.host)}:${port}/json/list`;
    const controller = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller,
      });
    } catch (error) {
      const reason = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? `timed out after ${this.timeoutMs}ms`
        : errorDetail(error);
      throw cdpError(`Could not read /json/list from localhost:${port}: ${reason}`, 'CDP_HTTP_ERROR', error);
    }
    if (response && response.ok === false) {
      throw cdpError(
        `Could not read /json/list from localhost:${port}: HTTP ${response.status}`,
        'CDP_HTTP_ERROR',
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw cdpError(
        `Could not parse /json/list from localhost:${port}: ${errorDetail(error)}`,
        'CDP_HTTP_ERROR',
        error,
      );
    }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.targets)) return data.targets;
    throw cdpError(
      `Unexpected /json/list response from localhost:${port}`,
      'CDP_HTTP_ERROR',
    );
  }

  async _discover() {
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    const serial = await this._getSerial();
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');

    const unix = await this._runAdb(
      ['-s', serial, 'shell', 'cat /proc/net/unix'],
      'Could not list WebView devtools sockets',
    );
    const sockets = this._socketNames(unix.stdout);
    if (sockets.length === 0) {
      throw cdpError(
        'No WebView devtools sockets found. Start the app with WebView debugging enabled and reload the page.',
        'CDP_NO_WEBVIEWS',
      );
    }

    const targets = [];
    const failures = [];
    const seen = new Set();
    for (const socketName of sockets) {
      if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
      let forward;
      try {
        forward = await this._ensureForward(serial, socketName);
      } catch (error) {
        if (error && error.code === 'CDP_CLOSED') throw error;
        failures.push(`${socketName}: ${errorDetail(error)}`);
        continue;
      }

      let list;
      try {
        list = await this._fetchTargetList(forward.port);
      } catch (error) {
        failures.push(`${socketName}: ${errorDetail(error)}`);
        await this._dropForward(this._forwardKey(serial, socketName), forward);
        continue;
      }

      for (let ordinal = 0; ordinal < list.length; ordinal++) {
        const target = makeTarget(list[ordinal], socketName, forward.port, ordinal, this.host);
        if (!target) continue;
        const key = targetKey(target);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(target);
      }
    }

    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    if (targets.length === 0) {
      const detail = failures.length ? ` Last error: ${failures[0]}` : '';
      throw cdpError(
        `No reachable WebView debug targets found on ${serial}.${detail}`,
        'CDP_NO_TARGETS',
      );
    }
    this._cacheTargets = copyTargets(targets);
    this._cacheAt = Date.now();
    return copyTargets(this._cacheTargets);
  }

  /**
   * Freshly list WebView sockets, create/reuse one forward per socket, and
   * return deduplicated, JSON-safe targets. Throws when no targets are found.
   * @returns {Promise<Array<object>>}
   */
  async discover() {
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    if (this._discovering) return this._discovering;
    const task = this._discover().finally(() => {
      if (this._discovering === task) this._discovering = null;
    });
    this._discovering = task;
    return task;
  }

  /**
   * Cached target listing (1500 ms). Mirrors `discover()` when the cache is cold.
   * @returns {Promise<Array<object>>}
   */
  async targets() {
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    if (this._cacheTargets.length > 0 && Date.now() - this._cacheAt < TARGET_CACHE_MS) {
      return copyTargets(this._cacheTargets);
    }
    return copyTargets(await this.discover());
  }

  /**
   * Open a target. The descriptor may be `{id}`, `{index}`, `{urlContains}`,
   * `{titleContains}` (combined predicates are ANDed), a string id, a numeric
   * index, or omitted for the first target.
   * @param {object | string | number | null} [descriptor]
   * @returns {Promise<CdpSession>}
   */
  async open(descriptor) {
    if (this._closed) throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    const targets = await this.targets();
    const target = selectTarget(targets, descriptor);
    if (!target) {
      throw cdpError(
        `No WebView target matched ${selectDescription(descriptor)} (${targets.length} available)`,
        'CDP_NO_TARGET',
      );
    }
    const session = await CdpSession.connect(target.webSocketDebuggerUrl, target, {
      timeoutMs: this.timeoutMs,
    });
    if (this._closed) {
      session.close();
      throw cdpError('CDP bridge is closed', 'CDP_CLOSED');
    }
    this._sessions.add(session);
    return session;
  }

  /**
   * Query an element without a long-lived session. Returns geometry and text;
   * `found:false` is a normal result, not an error.
   * @param {string} selector CSS or `testid:VALUE`
   * @param {{ target?: object | string | number | null }} [options]
   */
  async query(selector, options = {}) {
    const normalized = normalizeSelector(selector);
    const session = await this.open(options.target);
    try {
      return await session.evaluate(withDeepQuery(
        normalized,
        `if (!element) return { found: false, selector: ${JSON.stringify(normalized)} };
         let box = { x: 0, y: 0, width: 0, height: 0 };
         try {
           if (typeof element.getBoundingClientRect === 'function') box = element.getBoundingClientRect();
         } catch (_) { /* detached or non-box element */ }
         return {
           found: true,
           selector: ${JSON.stringify(normalized)},
           tag: String(element.tagName || '').toLowerCase(),
           text: String(element.innerText || element.textContent || '').trim().slice(0, 500),
           rect: {
             x: Math.round(Number(box.x || 0) * 100) / 100,
             y: Math.round(Number(box.y || 0) * 100) / 100,
             width: Math.round(Number(box.width || 0) * 100) / 100,
             height: Math.round(Number(box.height || 0) * 100) / 100,
           },
           visible: Boolean(element.getClientRects && element.getClientRects().length),
         };`,
      ));
    } finally {
      session.close();
    }
  }

  /** Close all sessions and remove all adb forwards. Idempotent, best effort. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const session of this._sessions) {
      try {
        session.close();
      } catch {
        /* best effort */
      }
    }
    this._sessions.clear();
    const forwards = [...this._forwards.values()];
    this._forwards.clear();
    await Promise.all(forwards.map((entry) => this._removeForward(entry)));
  }
}
