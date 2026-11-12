#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-workflow example for the dsh-apk-vm HTTP API.
 *
 * This is the "what an agent actually does" loop, in one dependency-free script:
 *
 *   1. wait for (or start) a ready VM and show the environment report
 *   2. install + launch the checked-in sample APK
 *   3. inspect the UIAutomator tree and find the target button
 *   4. tap the button and assert the resulting text
 *   5. save a screenshot of the result
 *   6. print the recent Agent activity timeline (the same data the panel shows),
 *      including a saved thumbnail of the latest recorded action when available
 *
 * The activity timeline is filled by the `apk_vm` Agent tool: every tool call is
 * recorded with its duration, result and an optional screenshot. Running this
 * script through plain HTTP does not create tool entries by itself, so step 6
 * prints a hint when the timeline is still empty.
 *
 * No npm dependencies; Node 20+ (built-in fetch / AbortSignal.timeout).
 *
 * Usage:
 *   node examples/agent-workflow.mjs --base http://127.0.0.1:59480
 *   node examples/agent-workflow.mjs --base http://127.0.0.1:59480 --out examples/demo-out
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_APK = path.join(HERE, 'sample-apk', 'dsh-sample.apk');
const DEFAULT_OUT = path.join(HERE, 'demo-out');
const DEFAULT_BASE = 'http://127.0.0.1:59480';
const EXPECTED_PACKAGE = 'dev.dsh.sample';
const BUTTON_LABEL = 'Say hello';
const INITIAL_STATUS = 'Tap the button to greet the VM.';
const RESULT_TEXT = 'Hello from dsh-apk-vm';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UI_WAIT_MS = 30_000;
const TAP_WAIT_MS = 15_000;

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--base') out.base = argv[++i];
    else if (arg === '--apk') out.apk = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--timeout') out.timeout = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log(`usage: node examples/agent-workflow.mjs [options]

  --base <url>       DSH Web GUI origin (default ${DEFAULT_BASE})
  --apk <path>       APK to install (default the checked-in sample APK)
  --out <dir>        output directory for screenshots (default examples/demo-out)
  --timeout <sec>    per-request timeout (default 180)
  --help             show this help`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function displayPath(file) {
  const relative = path.relative(REPO_ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join('/');
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`bad arguments: ${error.message}`);
  console.error('run with --help for usage');
  process.exit(1);
}
if (opts.help) {
  usage();
  process.exit(0);
}

const BASE_URL = String(opts.base || DEFAULT_BASE).replace(/\/+$/, '');
try {
  const parsed = new URL(BASE_URL);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('http only');
} catch {
  console.error(`--base is not a valid HTTP origin: ${BASE_URL}`);
  process.exit(1);
}
const timeoutSeconds = Number(opts.timeout ?? 180);
const REQUEST_TIMEOUT_MS = Math.max(5, timeoutSeconds) * 1000;

if (typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') {
  console.error('this example needs Node 20+ (built-in fetch and AbortSignal.timeout)');
  process.exit(1);
}

main().catch((error) => {
  console.error(`\nAGENT WORKFLOW FAILED: ${error.message}`);
  if (error.status) console.error(`  HTTP status: ${error.status}`);
  if (error.body) console.error(`  response:   ${String(error.body).slice(0, 600)}`);
  if (error.status === 409) {
    console.error(
      '  hint: the VM is leased by another session. Release it in the panel (or from the owning ' +
        'session) and retry; the HTTP routes use the default instance.',
    );
  }
  process.exitCode = 1;
});

/* ------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* ------------------------------------------------------------------------- */

async function api(pathname, options = {}) {
  const url = new URL(pathname, `${BASE_URL}/`);
  const headers = { accept: 'application/json', 'user-agent': 'dsh-apk-vm-agent-workflow/1.0' };
  const init = { method: options.method || 'GET', headers, signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS) };
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error && error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    throw new Error(
      `${init.method} ${pathname} failed${detail}: ${error.message}. ` +
        `Is the DSH Web GUI reachable at ${BASE_URL} and the dsh-apk-vm plugin enabled?`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = body.toString('utf8').trim();
    const httpError = new Error(`${init.method} ${pathname} returned HTTP ${response.status}`);
    httpError.status = response.status;
    httpError.body = text.slice(0, 2000);
    throw httpError;
  }
  return { status: response.status, headers: response.headers, body };
}

function expectJson(result, pathname) {
  const text = result.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname} did not return JSON: ${text.slice(0, 300)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForVmReady(label) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let last = 'no response yet';
  let startSent = false;
  while (Date.now() < deadline) {
    const state = expectJson(await api('/apk-vm/state'), '/apk-vm/state') || {};
    const vm = state.vm || {};
    last = `state=${JSON.stringify(vm.state || 'unknown')}`;
    if (vm.state === 'ready') return state;
    if (vm.state === 'error') {
      throw new Error(`VM is in error state: ${JSON.stringify(vm.error || vm.lastError || '')}`);
    }
    console.log(`  ${label}: ${last}`);
    if (!startSent && (vm.state === 'stopped' || vm.state === 'starting' || vm.state === undefined)) {
      startSent = true;
      try {
        const started = expectJson(await api('/apk-vm/vm', { method: 'POST', json: { action: 'start' } }), 'POST /apk-vm/vm');
        if (started && started.ok === false) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
        console.log('  POST /apk-vm/vm {"action":"start"} accepted');
      } catch (error) {
        if (error.status === 409) throw error;
        console.log(`  start request failed: ${error.message}`);
      }
    }
    await sleep(2000);
  }
  throw new Error(`VM did not become ready within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s (${last})`);
}

async function pollUi(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const dump = expectJson(await api('/apk-vm/debug/ui', { timeoutMs: REQUEST_TIMEOUT_MS }), '/apk-vm/debug/ui');
      if (!dump || dump.ok !== true || typeof dump.xml !== 'string') {
        throw new Error('UI dump did not return {ok:true, xml}');
      }
      const nodes = parseNodes(dump.xml);
      const match = predicate(nodes, dump);
      if (match) return { dump, nodes, attempts, ...match };
      lastError = new Error(`${label} is not present yet`);
    } catch (error) {
      if (error.status === 404 || error.status === 403) throw error;
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}` +
      (lastError ? `; last error: ${lastError.message}` : ''),
  );
}

/* ------------------------------------------------------------------------- */
/* UI helpers                                                                 */
/* ------------------------------------------------------------------------- */

function parseNodes(xml) {
  const nodes = [];
  const nodePattern = /<node\b([^>]*?)\/?>/g;
  let nodeMatch;
  while ((nodeMatch = nodePattern.exec(xml))) {
    const attributes = {};
    const attributePattern = /([\w:-]+)="([^"]*)"/g;
    let attributeMatch;
    while ((attributeMatch = attributePattern.exec(nodeMatch[1]))) {
      attributes[attributeMatch[1]] = decodeXml(attributeMatch[2]);
    }
    const bounds = parseBounds(attributes.bounds || '');
    if (!bounds) continue;
    nodes.push({
      text: attributes.text || '',
      resourceId: attributes['resource-id'] || '',
      contentDesc: attributes['content-desc'] || '',
      className: attributes.class || '',
      clickable: attributes.clickable === 'true',
      bounds,
    });
  }
  return nodes;
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function findButton(nodes) {
  const byId = nodes.find(
    (node) =>
      typeof node.resourceId === 'string' &&
      (node.resourceId === `${EXPECTED_PACKAGE}:id/hello_button` || node.resourceId.endsWith(':id/hello_button')),
  );
  if (byId) return byId;
  return (
    nodes.find(
      (node) => node.text === BUTTON_LABEL && (String(node.className).includes('Button') || node.clickable === true),
    ) || null
  );
}

function findStatus(nodes) {
  const byId = nodes.find(
    (node) =>
      typeof node.resourceId === 'string' &&
      (node.resourceId === `${EXPECTED_PACKAGE}:id/status` || node.resourceId.endsWith(':id/status')),
  );
  if (byId) return byId;
  return nodes.find((node) => node.text === INITIAL_STATUS || node.text === RESULT_TEXT) || null;
}

function savePng(buffer, file) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`response is not a PNG (${buffer.length} bytes)`);
  }
  return { file, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

function formatTime(at) {
  if (!at) return '??:??:??';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at).slice(11, 19) || '??:??:??';
  return date.toISOString().slice(11, 19);
}

/* ------------------------------------------------------------------------- */
/* Flow                                                                       */
/* ------------------------------------------------------------------------- */

async function main() {
  const apkPath = path.resolve(opts.apk || DEFAULT_APK);
  if (!existsSync(apkPath)) {
    throw new Error(`APK not found: ${displayPath(apkPath)}\n  build the sample with: node examples/sample-apk/build.mjs`);
  }
  const outDir = path.resolve(opts.out || DEFAULT_OUT);
  await mkdir(outDir, { recursive: true });

  console.log('dsh-apk-vm agent workflow');
  console.log(`  base: ${BASE_URL}`);
  console.log(`  apk:  ${displayPath(apkPath)} (${statSync(apkPath).size} bytes)`);
  console.log(`  out:  ${displayPath(outDir)}`);

  /* 1 --------------------------------------------------------------------- */
  section('1/6 VM state + environment');
  const state = await waitForVmReady('GET /apk-vm/state');
  const vm = state.vm || {};
  const screen = state.screen || {};
  console.log(
    `  ready serial=${vm.serial || state.serial || '?'} screen=${screen.width || '?'}x${screen.height || '?'} ` +
      `root=${vm.root === true} boot=${vm.bootKind || '?'}${vm.bootMs ? ` (${vm.bootMs} ms)` : ''}`,
  );
  const setup = expectJson(await api('/apk-vm/setup'), '/apk-vm/setup') || {};
  const missing = Array.isArray(setup.missing) ? setup.missing : [];
  const auto = setup.autoSetup || {};
  console.log(
    `  setup: ok=${setup.ok === true} sdk=${setup.sdkRoot || '(auto)'} accel=${setup.accel?.backend || '?'} ` +
      `missing=${missing.length === 0 ? 'none' : missing.join(', ')}`,
  );
  if (auto.state) console.log(`  autoSetup: state=${auto.state}${auto.step ? ` step=${auto.step}/${auto.totalSteps || '?'}` : ''}`);

  /* 2 --------------------------------------------------------------------- */
  section('2/6 Install and launch the sample APK');
  const install = expectJson(await api('/apk-vm/install', { method: 'POST', json: { path: apkPath } }), '/apk-vm/install');
  if (!install || install.ok !== true) throw new Error('install did not return ok:true');
  if (install.packageName !== EXPECTED_PACKAGE) {
    throw new Error(`installed ${JSON.stringify(install.packageName)}, expected ${EXPECTED_PACKAGE}`);
  }
  console.log(`  installed ${install.packageName} (${JSON.stringify(install.label || '')}) launched=${install.launched !== false}`);

  /* 3 --------------------------------------------------------------------- */
  section('3/6 Inspect UI and find the target button');
  const found = await pollUi(
    `the "${BUTTON_LABEL}" button`,
    (nodes) => {
      const button = findButton(nodes);
      const status = findStatus(nodes);
      return button && status ? { button, status } : null;
    },
    UI_WAIT_MS,
  );
  const [left, top, right, bottom] = found.button.bounds;
  const tapX = Math.round((left + right) / 2);
  const tapY = Math.round((top + bottom) / 2);
  console.log(`  hierarchy: ${found.dump.nodes} nodes, rotation=${found.dump.rotation ?? '?'}`);
  console.log(`  button ${JSON.stringify(BUTTON_LABEL)} bounds=[${left},${top}][${right},${bottom}] center=(${tapX},${tapY})`);
  console.log(`  status before tap: ${JSON.stringify(found.status.text)}`);

  /* 4 --------------------------------------------------------------------- */
  section('4/6 Tap and assert the resulting text');
  const input = expectJson(
    await api('/apk-vm/input', { method: 'POST', json: { type: 'tap', x: tapX, y: tapY } }),
    '/apk-vm/input',
  );
  if (!input || input.ok !== true) throw new Error('tap did not return ok:true');
  const after = await pollUi(
    `status text ${JSON.stringify(RESULT_TEXT)}`,
    (nodes) => (findStatus(nodes)?.text === RESULT_TEXT ? { status: findStatus(nodes) } : null),
    TAP_WAIT_MS,
  );
  console.log(`  tap accepted; status after tap: ${JSON.stringify(after.status.text)}`);

  /* 5 --------------------------------------------------------------------- */
  section('5/6 Save a screenshot of the result');
  const shot = await api('/apk-vm/debug/screenshot');
  const shotPath = path.join(outDir, 'agent-workflow-result.png');
  const shotMeta = savePng(shot.body, shotPath);
  await writeFile(shotPath, shot.body);
  console.log(`  saved ${displayPath(shotPath)} (${shotMeta.width}x${shotMeta.height}, ${shotMeta.bytes} bytes)`);

  /* 6 --------------------------------------------------------------------- */
  section('6/6 Agent activity timeline');
  let activity = null;
  try {
    activity = expectJson(await api('/apk-vm/activity?limit=20'), '/apk-vm/activity');
  } catch (error) {
    if (error.status === 404) {
      console.log('  activity route is not available on this plugin version (404)');
    } else {
      console.log(`  activity timeline unavailable: ${error.message}`);
    }
  }
  if (activity) {
    const entries = Array.isArray(activity.entries) ? activity.entries : [];
    const stats = activity.stats || {};
    console.log(`  entries=${entries.length} total=${stats.count ?? entries.length} shots=${stats.shots ?? 0}`);
    for (const entry of entries.slice(0, 8)) {
      const ok = entry.ok === false ? 'FAIL' : ' ok ';
      const duration = Number.isFinite(entry.durationMs) ? `${entry.durationMs} ms` : '-';
      console.log(
        `  ${formatTime(entry.at)}  ${ok}  ${String(entry.action || entry.tool || '?').padEnd(18)} ` +
          `${String(entry.summary || '').slice(0, 72).padEnd(74)} ${duration}`,
      );
    }
    if (entries.length === 0) {
      console.log('  no entries yet. Entries are recorded when an Agent calls the apk_vm tool, e.g.:');
      console.log('    apk_vm action=install path=<apk>   /   apk_vm action=tap_text text="Say hello"');
    }
    const latestWithShot = entries.find((entry) => entry.shotId || entry.hasShot);
    if (latestWithShot) {
      const id = latestWithShot.id;
      const shotResponse = await api(`/apk-vm/activity/${encodeURIComponent(id)}/shot`);
      const activityShotPath = path.join(outDir, 'agent-workflow-activity.png');
      const meta = savePng(shotResponse.body, activityShotPath);
      await writeFile(activityShotPath, shotResponse.body);
      console.log(`  saved latest activity shot ${displayPath(activityShotPath)} (${meta.width}x${meta.height})`);
    }
    try {
      const debug = expectJson(await api('/apk-vm/debug/info'), '/apk-vm/debug/info') || {};
      if (debug.identity) {
        console.log(
          `  device: Android ${debug.identity.release} (API ${debug.identity.sdk}) ${debug.identity.abi} root=${debug.identity.root}`,
        );
      }
    } catch (error) {
      console.log(`  debug/info unavailable: ${error.message}`);
    }
  }

  console.log('\nAGENT WORKFLOW PASSED');
}
