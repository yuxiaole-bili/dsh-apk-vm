#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Reproducible end-to-end demo for the dsh-apk-vm HTTP API.
 *
 * It drives a running DSH Web GUI / dsh-apk-vm plugin (no plugin internals are
 * imported):
 *
 *   1. GET  /apk-vm/state                 check the VM is ready
 *   2. POST /apk-vm/install               install + launch the sample APK
 *   3. GET  /apk-vm/debug/ui              find the "Say hello" button
 *   4. POST /apk-vm/input                 tap the button
 *   5. GET  /apk-vm/debug/ui              assert "Hello from dsh-apk-vm"
 *   6. GET  /apk-vm/debug/screenshot      save a PNG of the result
 *
 * No npm dependencies; Node 20+ (built-in fetch/AbortSignal.timeout).
 * See examples/README.md for usage and expected output.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`bad arguments: ${error.message}`);
  process.exit(1);
}
if (opts.help) {
  printUsage();
  process.exit(0);
}
const timeoutSeconds = Number(opts.timeout ?? 120);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error('--timeout must be a positive number of seconds');
  process.exit(1);
}
const BASE_URL = String(opts.base || DEFAULT_BASE).replace(/\/+$/, '');
try {
  const parsed = new URL(BASE_URL);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('http only');
} catch {
  console.error(`--base is not a valid HTTP origin: ${BASE_URL}`);
  process.exit(1);
}
const REQUEST_TIMEOUT_MS = Math.max(5, timeoutSeconds) * 1000;
const UI_WAIT_MS = 30_000;
const TAP_WAIT_MS = 15_000;

if (typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') {
  console.error('this demo needs Node 20+ (built-in fetch and AbortSignal.timeout)');
  process.exit(1);
}

main().catch((error) => {
  console.error(`\nDEMO FAILED: ${error.message}`);
  if (error.status) console.error(`  HTTP status: ${error.status}`);
  if (error.body) console.error(`  response:   ${error.body}`);
  process.exitCode = 1;
});

async function main() {
  const apkPath = path.resolve(opts.apk || DEFAULT_APK);
  if (!existsSync(apkPath)) {
    throw new Error(
      `sample APK not found: ${displayPath(apkPath)}\n` +
        '  build it with: node examples/sample-apk/build.mjs\n' +
        '  (or pass --apk <path-to.apk>)',
    );
  }
  const apkBytes = statSync(apkPath).size;
  console.log('dsh-apk-vm reproducible demo');
  console.log(`  base: ${BASE_URL}`);
  console.log(`  apk:  ${displayPath(apkPath)} (${apkBytes} bytes)`);

  /* ---------------------------------------------------------------------- */
  section('1/6 Check VM state');
  const stateResponse = await api('/apk-vm/state');
  const state = expectJson(stateResponse, '/apk-vm/state');
  if (!state || state.ok !== true) throw new Error('GET /apk-vm/state did not return ok:true');
  const vm = state.vm || {};
  const screen = state.screen || {};
  if (vm.state !== 'ready') {
    throw new Error(
      `VM is not ready (state=${JSON.stringify(vm.state || 'unknown')}). ` +
        'Open the APK Virtual Machine panel and press Start VM, or POST ' +
        '{"action":"start"} to /apk-vm/vm, then retry.',
    );
  }
  const serial = vm.serial || state.serial || '(unknown)';
  const screenText = screen.width && screen.height ? `${screen.width}x${screen.height}` : '(unknown)';
  console.log(`  GET /apk-vm/state -> 200`);
  console.log(`  state=ready serial=${serial} screen=${screenText} root=${vm.root === true}`);
  if (state.installing) console.log('  note: another install is currently in progress');

  /* ---------------------------------------------------------------------- */
  section('2/6 Install and launch the sample APK');
  console.log(`  POST /apk-vm/install {"path":"${displayPath(apkPath)}"}`);
  const install = expectJson(
    await api('/apk-vm/install', {
      method: 'POST',
      json: { path: apkPath },
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
    '/apk-vm/install',
  );
  if (!install || install.ok !== true) throw new Error('install did not return ok:true');
  if (install.packageName !== EXPECTED_PACKAGE) {
    throw new Error(
      `installed package is ${JSON.stringify(install.packageName)}, expected ${EXPECTED_PACKAGE}`,
    );
  }
  if (install.launched === false) throw new Error('APK installed but the plugin did not launch it');
  console.log(
    `  200 installed ${install.packageName} (${JSON.stringify(install.label || '')}) launched=true`,
  );

  /* ---------------------------------------------------------------------- */
  section('3/6 Inspect UI and locate the button');
  console.log('  GET /apk-vm/debug/ui (polling until the Activity is visible)');
  const first = await pollUi(
    `the "${BUTTON_LABEL}" button`,
    (nodes) => {
      const button = findButton(nodes);
      const status = findStatus(nodes);
      if (!button || !status) return null;
      return { button, status };
    },
    UI_WAIT_MS,
  );
  console.log(`  hierarchy: ${first.dump.nodes} nodes, rotation=${first.dump.rotation ?? '?'}`);
  const initialStatus = first.status.text || '';
  if (initialStatus !== INITIAL_STATUS) {
    throw new Error(
      `unexpected initial status text: ${JSON.stringify(initialStatus)} (expected ${JSON.stringify(INITIAL_STATUS)})`,
    );
  }
  const [left, top, right, bottom] = first.button.bounds;
  const tapX = Math.round((left + right) / 2);
  const tapY = Math.round((top + bottom) / 2);
  console.log(
    `  button ${JSON.stringify(BUTTON_LABEL)} bounds=[${left},${top}][${right},${bottom}] center=(${tapX},${tapY})`,
  );
  console.log(`  status before tap: ${JSON.stringify(initialStatus)}`);

  /* ---------------------------------------------------------------------- */
  section('4/6 Tap the button');
  console.log(`  POST /apk-vm/input {"type":"tap","x":${tapX},"y":${tapY}}`);
  const input = expectJson(
    await api('/apk-vm/input', {
      method: 'POST',
      json: { type: 'tap', x: tapX, y: tapY },
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
    '/apk-vm/input',
  );
  if (!input || input.ok !== true) throw new Error('tap did not return ok:true');
  console.log(`  200 tap accepted at (${tapX}, ${tapY})`);

  /* ---------------------------------------------------------------------- */
  section('5/6 Assert the resulting text');
  console.log(`  GET /apk-vm/debug/ui (polling for ${JSON.stringify(RESULT_TEXT)})`);
  const after = await pollUi(
    `status text ${JSON.stringify(RESULT_TEXT)}`,
    (nodes) => {
      const status = findStatus(nodes);
      return status && status.text === RESULT_TEXT ? { status } : null;
    },
    TAP_WAIT_MS,
  );
  console.log(`  hierarchy: ${after.dump.nodes} nodes, rotation=${after.dump.rotation ?? '?'}`);
  console.log(`  status after tap: ${JSON.stringify(after.status.text)}`);
  console.log('  PASS exact result text found');

  /* ---------------------------------------------------------------------- */
  section('6/6 Save a screenshot');
  const outDir = path.resolve(opts.out || DEFAULT_OUT);
  await mkdir(outDir, { recursive: true });
  const shotPath = path.join(outDir, 'screenshot.png');
  console.log('  GET /apk-vm/debug/screenshot');
  const shot = await api('/apk-vm/debug/screenshot', { timeoutMs: REQUEST_TIMEOUT_MS });
  if (shot.body.length < 24 || !shot.body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`screenshot response is not a PNG (${shot.body.length} bytes)`);
  }
  const width = shot.body.readUInt32BE(16);
  const height = shot.body.readUInt32BE(20);
  await writeFile(shotPath, shot.body);
  console.log(`  saved ${displayPath(shotPath)} (${shot.body.length} bytes, ${width}x${height})`);

  console.log('\nDEMO PASSED');
  console.log(`  VM:         ${serial} (${vm.state})`);
  console.log(`  package:    ${install.packageName}`);
  console.log(`  tap:        (${tapX}, ${tapY})`);
  console.log(`  assertion:  ${JSON.stringify(RESULT_TEXT)}`);
  console.log(`  screenshot: ${displayPath(shotPath)}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function api(pathname, { method = 'GET', json, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(pathname, `${BASE_URL}/`);
  const headers = { accept: 'application/json', 'user-agent': 'dsh-apk-vm-reproducible-demo/1.0' };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error && error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    throw new Error(
      `${method} ${pathname} failed${detail}: ${error.message}. ` +
        `Is the DSH Web GUI reachable at ${BASE_URL} and the dsh-apk-vm plugin enabled?`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = body.toString('utf8').trim().slice(0, 2000);
    const httpError = new Error(`${method} ${pathname} returned HTTP ${response.status}`);
    httpError.status = response.status;
    httpError.body = text;
    throw httpError;
  }
  return { response, body };
}

function expectJson(result, pathname) {
  const contentType = result.response.headers.get('content-type') || '';
  const text = result.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${pathname} did not return JSON (content-type=${JSON.stringify(contentType)}): ${text.slice(0, 300)}`,
    );
  }
}

async function pollUi(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const result = await api('/apk-vm/debug/ui', { timeoutMs: REQUEST_TIMEOUT_MS });
      const dump = expectJson(result, '/apk-vm/debug/ui');
      if (!dump || dump.ok !== true || typeof dump.xml !== 'string') {
        throw new Error('UI dump did not return {ok:true, xml}');
      }
      const nodes = parseNodes(dump.xml);
      const match = predicate(nodes, dump);
      if (match) return { dump, nodes, attempts, ...match };
      lastError = new Error(`${label} is not present yet`);
    } catch (error) {
      // A missing or forbidden route will not fix itself; report it now.
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

function findButton(nodes) {
  const byId = nodes.find(
    (node) =>
      typeof node.resourceId === 'string' &&
      (node.resourceId === `${EXPECTED_PACKAGE}:id/hello_button` ||
        node.resourceId.endsWith(':id/hello_button')),
  );
  if (byId) return byId;
  return (
    nodes.find(
      (node) =>
        node.text === BUTTON_LABEL &&
        (String(node.className).includes('Button') || node.clickable === true),
    ) || null
  );
}

function findStatus(nodes) {
  const byId = nodes.find(
    (node) =>
      typeof node.resourceId === 'string' &&
      (node.resourceId === `${EXPECTED_PACKAGE}:id/status` ||
        node.resourceId.endsWith(':id/status')),
  );
  if (byId) return byId;
  return nodes.find((node) => node.text === INITIAL_STATUS || node.text === RESULT_TEXT) || null;
}

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

function displayPath(file) {
  const relative = path.relative(REPO_ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join('/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} requires a value`);
      }
      i += 1;
    }
    switch (name) {
      case 'base':
      case 'apk':
      case 'out':
      case 'timeout':
        parsed[name] = value;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: node examples/demo.mjs [options]

Drives the running dsh-apk-vm plugin over its local HTTP API:
  state -> install sample APK -> inspect UI -> tap -> assert -> screenshot

Options:
  --base <url>      DSH Web GUI origin (default: ${DEFAULT_BASE})
  --apk <file>      APK to install (default: examples/sample-apk/dsh-sample.apk)
  --out <dir>       Screenshot directory (default: examples/demo-out)
  --timeout <sec>   Per-request timeout (default: 120)
  --help            Show this help

Prerequisites: the VM is ready and the dsh-apk-vm plugin is mounted. The demo
does not start or stop the VM and does not read plugin internals.`);
}
