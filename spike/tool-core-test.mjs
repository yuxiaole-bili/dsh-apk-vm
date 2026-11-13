#!/usr/bin/env node
/**
 * Hermetic regression checks for reported apk_vm core bugs, using the REAL
 * routes/tool mounted through apply() with a fake Host ctx. It never starts an
 * emulator, auto-setup or an HTTP server; adb/DNS actions only fail fast (or use
 * an already-running device) so the checks also run on a cold host.
 *
 *   1) env_snapshot / env_restore / adb used `api` before `const api = ...`
 *      was initialized ("Cannot access 'api' before initialization").
 *   2) action=storage threw "storageSdkRoot is not defined" because the helper
 *      was only defined inside mountRoutes().
 *   3) action=push rejected valid local paths ("local file not found under an
 *      allowed root: <existing path>") because root checks were case-sensitive
 *      and ignored realpath/junction normalization; the message also merged
 *      "outside the allowed roots" with "file missing".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);
const { apply } = await load('index.js');

// ---------------------------------------------------------------------------
// Fake Host ctx / webServer (same shape the real host provides; see
// C:\dsh-e2e\autosetup-real-e2e.mjs)
// ---------------------------------------------------------------------------

const routes = new Map();
const disposers = [];
let tool = null;

const pushDisposer = (dispose) => {
  if (typeof dispose === 'function') disposers.push(dispose);
};

const webServer = {
  getOrigin: () => 'http://127.0.0.1:0',
  register: (entry) => {
    routes.set(entry.path, entry.handler);
    return () => routes.delete(entry.path);
  },
  registerUpgrade: () => () => {},
};

const hostCtx = {
  get: () => undefined,
  inject: (names, install) => {
    const effect = (fn) => {
      const dispose = fn();
      pushDisposer(dispose);
      return dispose;
    };
    if (names.includes('webServer')) return install({ effect, webServer });
    if (names.includes('tools')) {
      return install({
        effect,
        tools: {
          register: (registered) => {
            tool = registered;
            return () => {
              tool = null;
            };
          },
        },
      });
    }
    if (names.includes('sessions')) return install({ effect, on: () => () => {} });
    install({ effect });
  },
  effect: (fn) => {
    const dispose = fn();
    pushDisposer(dispose);
    return dispose;
  },
};

function makeReq({ method = 'GET', url = '/', body = null } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:0', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return req;
    },
    destroy() {},
  };
  if (body !== null) {
    setImmediate(() => {
      const chunk = Buffer.from(JSON.stringify(body));
      for (const cb of listeners.get('data') || []) cb(chunk);
      for (const cb of listeners.get('end') || []) cb();
    });
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    setHeader(key, value) {
      res.headers[key] = value;
    },
    getHeader() {
      return undefined;
    },
    write() {},
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk);
      res.ended = true;
    },
  };
  return res;
}

async function callRoute(route, options) {
  const handler = routes.get(route);
  assert.ok(typeof handler === 'function', `route ${route} is registered`);
  const res = makeRes();
  await handler(makeReq(options), res);
  assert.ok(res.ended, `route ${route} sent a response`);
  return { status: res.statusCode, json: JSON.parse(res.body || 'null') };
}

const assertJsonSafe = (value, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} survives a lossless JSON round-trip`);
};

const expectNoTdz = (label, text) => {
  assert.doesNotMatch(String(text || ''), /before initialization|Cannot access 'api'/, `${label} must not hit the api TDZ`);
};

// ---------------------------------------------------------------------------
// Mount the plugin (no emulator: autoSetup/autoStart/prewarm disabled)
// ---------------------------------------------------------------------------

const activityDir = path.join(os.tmpdir(), `apk-vm-tool-core-activity-${process.pid}`);

apply(hostCtx, {
  autoSetup: false,
  autoStart: false,
  multiInstance: false,
  prewarm: false,
  roots: [REPO, process.cwd()],
  activityDir,
});

assert.ok(tool && typeof tool.execute === 'function', 'apk_vm tool is registered');
assert.ok(typeof tool.executeInner === 'function', 'apk_vm tool exposes executeInner');
assert.ok(routes.has('/apk-vm/storage'), 'storage route is registered');

// ---------------------------------------------------------------------------
// Bug 2: storage route + tool action must not throw "storageSdkRoot is not defined"
// ---------------------------------------------------------------------------

const storageRoute = await callRoute('/apk-vm/storage', { method: 'GET', url: '/apk-vm/storage' });
assert.equal(storageRoute.status, 200, 'GET /apk-vm/storage responds 200');
assert.equal(storageRoute.json.ok, true, 'GET /apk-vm/storage report.ok');
assert.ok(storageRoute.json.totals, 'GET /apk-vm/storage has totals');
console.log('PASS storage route: GET /apk-vm/storage 200 + report');

const storageTool = await tool.execute({ action: 'storage' }, {});
assertJsonSafe(storageTool, 'storage tool result');
assert.equal(storageTool.ok, true, `storage action failed: ${storageTool.summary}`);
assert.ok(storageTool.result && storageTool.result.totals, 'storage action returns totals');
assert.doesNotMatch(String(storageTool.summary), /storageSdkRoot is not defined/);
console.log(`PASS storage action: ${storageTool.summary}`);

// ---------------------------------------------------------------------------
// Bug 1: adb / env_snapshot must resolve `api` lazily (no TDZ ReferenceError)
// ---------------------------------------------------------------------------

const attempt = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
};

const adbDirect = await attempt(() => tool.executeInner({ action: 'adb', adbArgs: ['version'] }, {}));
if (adbDirect.ok) {
  assert.equal(typeof adbDirect.value.ok, 'boolean', 'adb result has ok');
  assertJsonSafe(adbDirect.value, 'adb executeInner result');
  console.log(`PASS adb action: exit ${adbDirect.value.result.code} (no TDZ)`);
} else {
  expectNoTdz('adb action', adbDirect.error && adbDirect.error.message);
  console.log(`PASS adb action: reached adb layer without TDZ (${adbDirect.error && adbDirect.error.message})`);
}

const adbTool = await tool.execute({ action: 'adb', adbArgs: ['version'] }, {});
assertJsonSafe(adbTool, 'adb tool result');
assert.equal(typeof adbTool.ok, 'boolean', 'adb tool result has ok');
expectNoTdz('adb tool summary', adbTool.summary);
console.log(`PASS adb tool boundary: ${adbTool.summary}`);

const envSnapshot = await tool.execute({ action: 'env_snapshot' }, {});
assertJsonSafe(envSnapshot, 'env_snapshot tool result');
assert.equal(envSnapshot.ok, true, `env_snapshot failed: ${envSnapshot.summary}`);
assert.ok(Array.isArray(envSnapshot.result.forwards), 'env_snapshot reports forwards');
expectNoTdz('env_snapshot', envSnapshot.summary);
console.log(`PASS env_snapshot action: ${envSnapshot.summary}`);

// A minimal snapshot exercises the lazy `api` lookup without mutating device env.
const envRestore = await attempt(() => tool.executeInner({ action: 'env_restore', envSnapshot: {} }, {}));
if (envRestore.ok) {
  assert.equal(envRestore.value.ok, true, `env_restore failed: ${envRestore.value.summary}`);
  assert.equal(envRestore.value.result.applied.length, 0, 'empty snapshot applies nothing');
  console.log(`PASS env_restore action: ${envRestore.value.summary}`);
} else {
  expectNoTdz('env_restore action', envRestore.error && envRestore.error.message);
  console.log(`PASS env_restore action: reached env layer without TDZ (${envRestore.error && envRestore.error.message})`);
}

// ---------------------------------------------------------------------------
// Bug 3: push path resolution - outside-roots vs missing file vs normalization
// ---------------------------------------------------------------------------

// (a) Existing file outside every allowed root: actionable "outside" message.
const outsideFile =
  process.platform === 'win32'
    ? ['C:\\Windows\\win.ini'].find((candidate) => fs.existsSync(candidate)) || path.join(os.homedir(), '..')
    : '/etc/hostname';
const outside = await tool.execute({ action: 'push', path: outsideFile, remotePath: '/data/local/tmp/tool-core.xml' }, {});
assertJsonSafe(outside, 'push outside-roots result');
assert.equal(outside.ok, false, 'push outside the allowed roots fails');
assert.match(outside.summary, /outside the allowed roots/, 'push names the real problem');
assert.match(outside.summary, /Allowed roots:/, 'push lists the allowed roots');
assert.match(outside.summary, /`roots` config/, 'push hints at the roots config');
assert.doesNotMatch(outside.summary, /local file not found/, 'push does not call an existing file missing');
console.log(`PASS push outside roots: ${outside.summary.split('\n')[0]}`);

// (b) Missing file that is inside an allowed root: distinct "not found" message.
const missingPath = path.join(process.cwd(), `.tool-core-missing-${process.pid}.xml`);
assert.equal(fs.existsSync(missingPath), false, 'missing-path fixture is absent');
const missing = await tool.execute({ action: 'push', path: missingPath, remotePath: '/data/local/tmp/tool-core.xml' }, {});
assertJsonSafe(missing, 'push missing-file result');
assert.equal(missing.ok, false, 'push of a missing file fails');
assert.match(missing.summary, /local file not found:/, 'push distinguishes a missing file');
assert.doesNotMatch(missing.summary, /outside the allowed roots/, 'push does not blame the roots for a missing file');
console.log(`PASS push missing file: ${missing.summary.split('\n')[0]}`);

// (c) Valid temp file addressed with differently-cased drive/separators must not
// be rejected as "outside the allowed roots" (old code compared raw win32 paths).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-vm-tool-core-'));
try {
  const probe = path.join(tmpDir, 'probe file.xml');
  fs.writeFileSync(probe, '<probe/>');
  const variant =
    process.platform === 'win32' ? probe.replace(/^[A-Za-z]:/, (match) => match.toLowerCase()).replace(/\\/g, '/') : probe;
  const normalized = await tool.execute({ action: 'push', path: variant, remotePath: '/data/local/tmp/tool-core-probe.xml' }, {});
  assertJsonSafe(normalized, 'push normalized-path result');
  assert.doesNotMatch(
    String(normalized.summary || ''),
    /outside the allowed roots|local file not found/,
    'normalized path is accepted by the resolver (the push itself may fail without a device)',
  );
  console.log(`PASS push path normalization: ${normalized.summary.split('\n')[0]}`);

  // (d) Plain repo file inside an allowed root is accepted as well.
  const selfPath = fileURLToPath(import.meta.url);
  const inRoot = await tool.execute({ action: 'push', path: selfPath, remotePath: '/data/local/tmp/tool-core-self.mjs' }, {});
  assert.doesNotMatch(String(inRoot.summary || ''), /outside the allowed roots|local file not found/);
  console.log(`PASS push allowed root: ${inRoot.summary.split('\n')[0]}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// JSON-safe tool errors: unsupported actions come back structured, not thrown
// ---------------------------------------------------------------------------

const unsupported = await tool.execute({ action: 'not_a_real_action' }, {});
assertJsonSafe(unsupported, 'unsupported-action result');
assert.equal(unsupported.ok, false, 'unsupported action reports ok:false');
assert.match(unsupported.summary, /unsupported apk_vm action: not_a_real_action/);
assert.equal(unsupported.result.action, 'not_a_real_action');
assert.ok(unsupported.result.error && unsupported.result.error.message, 'structured error carries the message');
console.log(`PASS tool error boundary: ${unsupported.summary}`);

// ---------------------------------------------------------------------------
// Agent activity log: tool calls are recorded and exposed over HTTP
// ---------------------------------------------------------------------------

await new Promise((resolve) => setTimeout(resolve, 300));
const activityList = await callRoute('/apk-vm/activity', { method: 'GET', url: '/apk-vm/activity?limit=10' });
assert.equal(activityList.status, 200, 'GET /apk-vm/activity responds 200');
assert.equal(activityList.json.ok, true, 'GET /apk-vm/activity ok');
assert.ok(Array.isArray(activityList.json.entries), 'activity list has entries');
assert.ok(activityList.json.entries.length >= 1, 'tool calls were recorded');
assert.ok(activityList.json.stats && typeof activityList.json.stats.count === 'number', 'activity list has stats');
const recordedPush = activityList.json.entries.filter((entry) => entry.action === 'push');
assert.ok(recordedPush.length > 0, 'push tool calls were recorded');
assert.ok(
  recordedPush.some((entry) => entry.ok === false && /outside the allowed roots|local file not found/.test(String(entry.error || ''))),
  'recorded failed push keeps ok:false and the actionable error',
);
console.log(`PASS activity log list: ${activityList.json.entries.length} entries, ${activityList.json.stats.count} total`);

const filtered = await callRoute('/apk-vm/activity', { method: 'GET', url: '/apk-vm/activity?action=storage&limit=5' });
assert.equal(filtered.status, 200, 'filtered activity list responds 200');
assert.ok(filtered.json.entries.every((entry) => entry.action === 'storage'), 'action filter only returns storage entries');
console.log(`PASS activity log filter: ${filtered.json.entries.length} storage entries`);

// Panel/user operations are journaled too (source http, tool panel).
// Use the setup route: an unsupported action fails with a 400 immediately and
// never touches the device, so this assertion is hermetic on any host (a wedged
// or stopped guest must not turn the test into a timeout).
const panelAttempt = await callRoute('/apk-vm/setup', {
  method: 'POST',
  url: '/apk-vm/setup',
  body: { action: 'tool-core-unsupported-action' },
});
assert.equal(panelAttempt.status, 400, 'unsupported setup action responds 400');
const userActivity = await callRoute('/apk-vm/activity', {
  method: 'GET',
  url: '/apk-vm/activity?source=http&limit=10',
});
assert.equal(userActivity.status, 200, 'source-filtered activity list responds 200');
assert.ok(userActivity.json.entries.length >= 1, 'panel operations are journaled');
const panelEntry = userActivity.json.entries.find(
  (entry) => entry.action === 'setup' && /tool-core-unsupported-action/.test(String(entry.summary || '')),
);
assert.ok(panelEntry, 'panel setup attempt is recorded as action setup');
assert.equal(panelEntry.source, 'http', 'panel operation is recorded with source http');
assert.equal(panelEntry.tool, 'panel', 'panel operation is recorded with tool panel');
assert.equal(panelEntry.ok, false, 'failed panel operation keeps ok:false');
assert.match(String(panelEntry.error || ''), /unsupported setup action/i, 'failed panel operation keeps the HTTP error');
const toolActivity = await callRoute('/apk-vm/activity', {
  method: 'GET',
  url: '/apk-vm/activity?source=tool&limit=10',
});
assert.ok(
  toolActivity.json.entries.every((entry) => entry.source === 'tool'),
  'source=tool filter returns only tool entries',
);
console.log(`PASS user activity: panel setup attempt recorded from the HTTP route (${panelEntry.ok ? 'ok' : 'failed'})`);

const entryId = activityList.json.entries[0].id;
const single = await callRoute('/apk-vm/activity', { method: 'GET', url: `/apk-vm/activity/${encodeURIComponent(entryId)}` });
assert.equal(single.status, 200, 'activity entry route responds 200');
assert.equal(single.json.entry.id, entryId, 'entry lookup returns the requested id');
console.log(`PASS activity log entry: ${entryId}`);

const missingShot = await callRoute('/apk-vm/activity', { method: 'GET', url: '/apk-vm/activity/missing/shot' });
assert.equal(missingShot.status, 404, 'unknown activity shot responds 404');
console.log('PASS activity log shot 404');

const cleared = await callRoute('/apk-vm/activity', { method: 'POST', url: '/apk-vm/activity/clear', body: {} });
assert.equal(cleared.status, 200, 'POST /apk-vm/activity/clear responds 200');
assert.equal(cleared.json.ok, true, 'clear activity ok');
const afterClear = await callRoute('/apk-vm/activity', { method: 'GET', url: '/apk-vm/activity' });
assert.equal(afterClear.json.entries.length, 0, 'activity log is empty after clear');
console.log('PASS activity log clear');

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

for (const dispose of disposers.reverse()) dispose();
assert.equal(tool, null, 'tool registration disposed');
try {
  fs.rmSync(activityDir, { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log('PASS dispose: no throw');
console.log('');
console.log('TOOL CORE TESTS PASS');
