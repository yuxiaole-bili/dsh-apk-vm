import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CdpBridge,
  CdpSession,
  deepQuerySelector,
  isSingleJsExpression,
  jsonSafeEvaluateExpression,
  normalizeSelector,
  parseForwardPort,
  previewJsValue,
} from '../lib/cdp.js';
import { losslessJson } from '../lib/json-safe.js';
import { annotateScreenshot, encodePng } from '../lib/png-annotate.js';
import { decodePng } from '../lib/image-features.js';

test('parseForwardPort accepts adb output variants', () => {
  assert.equal(parseForwardPort('54321\n'), 54321);
  assert.equal(parseForwardPort(Buffer.from('  54321 \r\n')), 54321);
  assert.equal(parseForwardPort('* daemon started successfully *\n43210\n'), 43210);
  assert.equal(parseForwardPort('tcp:61000\n'), 61000);
  assert.equal(parseForwardPort(''), null);
  assert.equal(parseForwardPort('adb: error: failed to forward'), null);
  assert.equal(parseForwardPort('0\n'), null);
  assert.equal(parseForwardPort('70000\n'), null);
  assert.equal(parseForwardPort(Buffer.from('not a port\n65536\n')), null);
});

test('normalizeSelector handles CSS, testid, and CSS string escaping', () => {
  assert.equal(normalizeSelector('  main .card  '), 'main .card');
  assert.equal(normalizeSelector('testid:login-button'), '[data-testid="login-button"]');
  assert.equal(normalizeSelector('testid:a"b\\c'), '[data-testid="a\\"b\\\\c"]');
  assert.equal(normalizeSelector('testid:a\nb'), '[data-testid="a\\a b"]');
  assert.equal(normalizeSelector('[data-testid="plain"]'), '[data-testid="plain"]');
  assert.throws(() => normalizeSelector('   '), /must not be empty/);
  assert.throws(() => normalizeSelector('testid:'), /must include a value/);
  assert.throws(() => normalizeSelector(null), /must be a string/);
});

function fakeScope({ matches = {}, children = [] } = {}) {
  return {
    querySelector(selector) {
      return matches[selector] || null;
    },
    querySelectorAll() {
      return children;
    },
  };
}

test('deepQuerySelector walks nested open shadow roots', () => {
  const direct = { name: 'direct' };
  const root = fakeScope({
    matches: { '#direct': direct },
    children: [
      {
        shadowRoot: fakeScope({ matches: { '#direct': { name: 'shadow' } } }),
      },
    ],
  });

  const nested = { name: 'nested' };
  const innerShadow = fakeScope({ matches: { '.deep': nested } });
  const outerShadow = fakeScope({
    children: [{ shadowRoot: innerShadow }],
  });
  const nestedRoot = fakeScope({
    children: [{ shadowRoot: outerShadow }],
  });

  assert.equal(deepQuerySelector(root, '#direct'), direct);
  assert.equal(deepQuerySelector(nestedRoot, '.deep'), nested);
  assert.equal(deepQuerySelector(fakeScope(), '.missing'), null);
  assert.equal(deepQuerySelector(null, '.missing'), null);
});

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', {});
  }

  reply(id, result) {
    this.dispatch('message', { data: JSON.stringify({ id, result }) });
  }
}

async function waitForSent(socket, count) {
  for (let i = 0; i < 100; i++) {
    if (socket.sent.length >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`expected ${count} CDP message(s), got ${socket.sent.length}`);
}

test('CdpSession correlates responses and evaluates JSON values', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, { id: 'page-1' }, { timeoutMs: 500 });
  t.after(() => session.close());

  const response = session.send('Runtime.enable');
  await waitForSent(socket, 1);
  const request = socket.sent[0];
  assert.equal(request.method, 'Runtime.enable');
  assert.equal(request.params && Object.keys(request.params).length, 0);
  socket.reply(request.id, { ok: true });
  assert.deepEqual(await response, { ok: true });

  const evaluation = session.evaluate('1 + 1');
  await waitForSent(socket, 2);
  socket.reply(socket.sent[1].id, { result: { type: 'number', value: 2 } });
  assert.equal(await evaluation, 2);

  const failed = session.evaluate('throw new Error("boom")');
  await waitForSent(socket, 3);
  socket.reply(socket.sent[2].id, {
    result: { type: 'object' },
    exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
  });
  await assert.rejects(failed, (error) => {
    assert.equal(error.code, 'CDP_EVALUATION_ERROR');
    assert.match(error.message, /boom/);
    return true;
  });
});

test('CdpSession times out unanswered requests', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 25 });
  t.after(() => session.close());
  await assert.rejects(session.send('Runtime.enable'), (error) => {
    assert.equal(error.code, 'CDP_TIMEOUT');
    assert.match(error.message, /Runtime.enable/);
    return true;
  });
});

test('CdpSession click falls back to element.click without a usable box', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 500 });
  t.after(() => session.close());

  const clicked = session.click('testid:submit');
  await waitForSent(socket, 1);
  assert.equal(socket.sent[0].method, 'Runtime.evaluate');
  assert.match(socket.sent[0].params.expression, /data-testid/);
  socket.reply(socket.sent[0].id, {
    result: {
      type: 'object',
      value: {
        ok: true,
        rect: null,
        clickable: true,
        viewport: { width: 320, height: 640 },
      },
    },
  });

  await waitForSent(socket, 2);
  assert.equal(socket.sent[1].method, 'Runtime.evaluate');
  assert.match(socket.sent[1].params.expression, /element\.click\(\)/);
  socket.reply(socket.sent[1].id, {
    result: { type: 'object', value: { ok: true } },
  });

  assert.equal(await clicked, true);
});

test('CdpSession.insertText sends the exact Unicode text via Input.insertText', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 500 });
  t.after(() => session.close());

  const text = 'héllo 🌍\n第二行';
  const inserted = session.insertText(text);
  await waitForSent(socket, 1);
  assert.equal(socket.sent[0].method, 'Input.insertText');
  assert.deepEqual(socket.sent[0].params, { text });
  socket.reply(socket.sent[0].id, {});
  assert.equal(await inserted, true);
});

function socketTable(...names) {
  return [
    'Num       RefCount Protocol Flags    Type St Inode Path',
    ...names.map(
      (name, index) =>
        `0000000000000000: 00000002 00000000 00010000 0001 01 ${1000 + index} @${name}`,
    ),
    '',
  ].join('\n');
}

test('CdpBridge discovers targets, caches them, and removes forwards', async (t) => {
  let forwardedPort = 0;
  let httpRequests = 0;
  const adbCalls = [];
  const server = http.createServer((req, res) => {
    httpRequests++;
    if (req.url !== '/json/list') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          id: 'page-1',
          title: 'Main\nPage',
          url: 'https://example.test/app',
          type: 'page',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1',
        },
        {
          id: 'page-1',
          title: 'duplicate',
          url: 'https://example.test/duplicate',
          type: 'page',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1',
        },
      ]),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  forwardedPort = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const adb = async (args) => {
    adbCalls.push(args);
    const joined = args.join(' ');
    if (joined.includes('shell cat /proc/net/unix')) {
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(socketTable('webview_devtools_remote_4242')),
        stderr: Buffer.alloc(0),
      };
    }
    if (joined.includes('forward tcp:0')) {
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(`${forwardedPort}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    if (joined.includes('forward --remove')) {
      return { code: 0, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return { code: 1, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') };
  };

  const bridge = new CdpBridge({ adb, serial: 'emulator-5554', timeoutMs: 2000 });
  t.after(() => bridge.close());

  const targets = await bridge.targets();
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0], {
    id: 'page-1',
    title: 'Main Page',
    url: 'https://example.test/app',
    type: 'page',
    webSocketDebuggerUrl: `ws://127.0.0.1:${forwardedPort}/devtools/page/page-1`,
    socketName: 'webview_devtools_remote_4242',
    port: forwardedPort,
  });
  assert.equal(httpRequests, 1);
  assert.equal(adbCalls.filter((args) => args.includes('tcp:0')).length, 1);

  const cached = await bridge.targets();
  assert.notEqual(cached, targets);
  assert.deepEqual(cached, targets);
  assert.equal(httpRequests, 1);

  await bridge.close();
  assert.equal(adbCalls.filter((args) => args.join(' ').includes('forward --remove')).length, 1);
  await bridge.close();
  assert.equal(adbCalls.filter((args) => args.join(' ').includes('forward --remove')).length, 1);
});

test('CdpBridge reports a clear error when there is no debuggable WebView', async () => {
  const bridge = new CdpBridge({
    serial: async () => 'emulator-5554',
    adb: async (args) => {
      if (args.join(' ').includes('shell cat /proc/net/unix')) {
        return {
          code: 0,
          timedOut: false,
          stdout: Buffer.from('Num RefCount Protocol Flags Type St Inode Path\n'),
          stderr: Buffer.alloc(0),
        };
      }
      return { code: 1, timedOut: false, stdout: '', stderr: '' };
    },
    timeoutMs: 1000,
  });
  await assert.rejects(bridge.discover(), (error) => {
    assert.equal(error.code, 'CDP_NO_WEBVIEWS');
    assert.match(error.message, /No WebView devtools sockets/);
    return true;
  });
  await bridge.close();
});

test('losslessJson removes every tool-output rejection cause', () => {
  const circular = { name: 'vm' };
  circular.self = circular;
  const info = {
    ok: true,
    serial: 'emulator-5558',
    avatar: undefined,
    size: { width: 720, height: 1280 },
    dpr: 2,
    statusBarTop: 48,
    nan: NaN,
    infinity: Infinity,
    big: 10n,
    bytes: Buffer.from('png'),
    when: new Date('2026-01-02T03:04:05.000Z'),
    error: new Error('boom'),
    circular,
  };
  const result = losslessJson(info);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /undefined|NaN|Infinity/);
  assert.equal(result.avatar, null);
  assert.equal(result.nan, null);
  assert.equal(result.infinity, null);
  assert.equal(result.big, '10');
  assert.deepEqual(result.bytes, { type: 'bytes', length: 3 });
  assert.equal(result.when, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(result.error, { name: 'Error', message: 'boom', code: null });
  assert.equal(result.circular.self, '[Circular]');
  assert.doesNotThrow(() => JSON.parse(json));
});

test('PNG annotation draws node boxes and round-trips pixels', () => {
  const width = 20;
  const height = 12;
  const pixels = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 20;
    pixels[i + 1] = 22;
    pixels[i + 2] = 28;
    pixels[i + 3] = 255;
  }
  const source = encodePng({ width, height, pixels });
  const annotated = annotateScreenshot(source, [
    { bounds: { x1: 3, y1: 2, x2: 12, y2: 9 }, text: 'Login' },
  ]);
  assert.equal(annotated.width, width);
  assert.equal(annotated.height, height);
  assert.equal(annotated.boxes.length, 1);
  assert.equal(annotated.boxes[0].label, 'Login');
  const decoded = decodePng(annotated.buffer);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  const border = (2 * width + 3) * 4;
  assert.ok(decoded.pixels[border + 3] > 0);
});

test('isSingleJsExpression accepts reads and rejects statement programs', () => {
  assert.equal(isSingleJsExpression('document.title'), true);
  assert.equal(isSingleJsExpression('document.title;'), true);
  assert.equal(isSingleJsExpression('matchMedia("(pointer: coarse)").matches'), true);
  assert.equal(isSingleJsExpression('(() => { const r = document.body.getBoundingClientRect(); return r.width; })()'), true);
  assert.equal(isSingleJsExpression('JSON.stringify([1, 2, 3])'), true);
  assert.equal(isSingleJsExpression('const x = 1; x + 2'), false);
  assert.equal(isSingleJsExpression('if (document.body) 1'), false);
  assert.equal(isSingleJsExpression('a(); b()'), false);
  assert.equal(isSingleJsExpression(''), false);
  assert.equal(isSingleJsExpression(null), false);
});

test('jsonSafeEvaluateExpression wraps expressions and expands non-by-value results', () => {
  assert.equal(jsonSafeEvaluateExpression('const x = 1; x'), null);
  const wrapped = jsonSafeEvaluateExpression('document.querySelector("#file").getBoundingClientRect()');
  assert.match(wrapped, /__dshKind/);
  assert.match(wrapped, /getBoundingClientRect/);
  assert.match(wrapped, /JSON\.stringify/);
  assert.match(wrapped, /getOwnPropertyNames/);
});

test('previewJsValue produces compact single-line previews', () => {
  assert.equal(previewJsValue(null), 'null');
  assert.equal(previewJsValue(undefined), 'undefined');
  assert.equal(previewJsValue(false), 'false');
  assert.equal(previewJsValue({ matches: false }), '{"matches":false}');
  const long = previewJsValue({ text: 'x'.repeat(500) }, 40);
  assert.ok(long.length <= 40);
  assert.match(long, /\.\.\.$/);
  assert.equal(previewJsValue('a\nb'), '"a\\nb"');
});

test('CdpSession.evaluateJson converts DOMRect/MediaQueryList-style values', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 500 });
  t.after(() => session.close());

  const rect = session.evaluateJson('document.querySelector("#card").getBoundingClientRect()');
  await waitForSent(socket, 1);
  assert.equal(socket.sent[0].method, 'Runtime.evaluate');
  assert.match(socket.sent[0].params.expression, /__dshKind/);
  assert.match(socket.sent[0].params.expression, /getBoundingClientRect/);
  assert.equal(socket.sent[0].params.awaitPromise, true);
  assert.equal(socket.sent[0].params.returnByValue, true);
  socket.reply(socket.sent[0].id, {
    result: {
      type: 'object',
      value: {
        __dshKind: 'props',
        __dshType: '[object DOMRect]',
        __dshProps: { x: 12, y: 34, width: 100, height: 48, top: 34, left: 12 },
      },
    },
  });
  assert.deepEqual(await rect, {
    __type: '[object DOMRect]', x: 12, y: 34, width: 100, height: 48, top: 34, left: 12,
  });

  const media = session.evaluateJson('matchMedia("(pointer: coarse)")');
  await waitForSent(socket, 2);
  socket.reply(socket.sent[1].id, {
    result: {
      type: 'object',
      value: {
        __dshKind: 'props',
        __dshType: '[object MediaQueryList]',
        __dshProps: { matches: false, media: '(pointer: coarse)' },
      },
    },
  });
  assert.deepEqual(await media, {
    __type: '[object MediaQueryList]', matches: false, media: '(pointer: coarse)',
  });

  const json = session.evaluateJson('({ ready: true, count: 3 })');
  await waitForSent(socket, 3);
  socket.reply(socket.sent[2].id, {
    result: { type: 'object', value: { __dshKind: 'json', __dshJson: '{"ready":true,"count":3}' } },
  });
  assert.deepEqual(await json, { ready: true, count: 3 });

  const errors = session.evaluateJson('window.__missing.value');
  await waitForSent(socket, 4);
  socket.reply(socket.sent[3].id, {
    result: {
      type: 'object',
      value: { __dshKind: 'error', __dshError: 'Cannot read properties of undefined (reading value)' },
    },
  });
  await assert.rejects(errors, (error) => {
    assert.equal(error.code, 'CDP_EVALUATION_ERROR');
    assert.match(error.message, /Cannot read properties/);
    return true;
  });
});

test('CdpSession.evaluateJson falls back to plain evaluate for statements', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 500 });
  t.after(() => session.close());

  const statements = session.evaluateJson('const x = 1; x + 2');
  await waitForSent(socket, 1);
  assert.equal(socket.sent[0].method, 'Runtime.evaluate');
  assert.doesNotMatch(socket.sent[0].params.expression, /__dshKind/);
  socket.reply(socket.sent[0].id, { result: { type: 'number', value: 3 } });
  assert.equal(await statements, 3);
});

test('CdpSession.evaluateJson retries plain evaluate when the wrapper is a syntax error', async (t) => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {}, { timeoutMs: 500 });
  t.after(() => session.close());

  const retried = session.evaluateJson('a?.b');
  await waitForSent(socket, 1);
  socket.reply(socket.sent[0].id, {
    result: { type: 'object' },
    exceptionDetails: { text: 'SyntaxError: unexpected token' },
  });
  await waitForSent(socket, 2);
  assert.doesNotMatch(socket.sent[1].params.expression, /__dshKind/);
  socket.reply(socket.sent[1].id, { result: { type: 'string', value: 'ok' } });
  assert.equal(await retried, 'ok');
});


