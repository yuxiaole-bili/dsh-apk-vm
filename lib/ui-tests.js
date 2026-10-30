/**
 * Lightweight UI assertions and visual baselines for the APK VM.
 *
 * `runAssertions` checks a UIAutomator dump (raw XML or already-parsed nodes)
 * without touching a device. `compareScreenshot` fingerprints a PNG with SHA-256
 * and stores that fingerprint next to the baseline; it is an exact-byte check,
 * NOT a pixel diff, so a re-encoded but visually identical PNG counts as
 * changed. Capture screenshots through one fixed pipeline (size, density,
 * encoder) and use the result as a regression fingerprint.
 *
 * Baselines live in a caller-provided directory as
 * `<safe-name>.png.sha256` (plain lowercase hash + newline); the PNG itself is
 * saved on the first run and on `update: true`. Everything here is
 * dependency-free and keeps no state outside those files.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { parseUiHierarchy } from '../lib/ui-inspector.js';

const FIELDS = ['text', 'resourceId', 'contentDesc', 'className'];
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const HASH_SUFFIX = '.png.sha256';
const PNG_SUFFIX = '.png';
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_MARKDOWN_FAILURES = 10;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function folded(value) {
  return normalizeText(value).toLowerCase();
}

function shorten(value, limit = 80) {
  const text = normalizeText(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function normalizeNodes(input) {
  let source = input;
  if (typeof source === 'string') {
    source = parseUiHierarchy(source).nodes;
  } else if (source && !Array.isArray(source) && typeof source === 'object' && Array.isArray(source.nodes)) {
    source = source.nodes;
  }
  if (!Array.isArray(source)) return [];
  return source.map((node) => {
    const record = node && typeof node === 'object' ? node : {};
    const normalized = {};
    for (const field of FIELDS) normalized[field] = folded(record[field]);
    return normalized;
  });
}

function assertionCriteria(assertion) {
  const criteria = [];
  for (const field of FIELDS) {
    if (assertion[field] == null) continue;
    const needle = folded(assertion[field]);
    if (!needle) continue;
    criteria.push({
      field,
      needle,
      label: `${field}=${JSON.stringify(shorten(assertion[field], 60))}`,
    });
  }
  return criteria;
}

function evaluateAssertion(nodes, assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
    return { ok: false, reason: 'assertion must be an object' };
  }
  const criteria = assertionCriteria(assertion);
  if (criteria.length === 0) {
    return { ok: false, reason: 'assertion has no selector field (text, resourceId, contentDesc or className)' };
  }
  const selector = criteria.map((criterion) => criterion.label).join(', ');
  const matches = nodes.filter((node) =>
    criteria.every((criterion) => node[criterion.field].includes(criterion.needle)),
  );
  const wantsMatch = assertion.exists !== false;
  if (wantsMatch) {
    return matches.length > 0
      ? { ok: true }
      : { ok: false, reason: `no matching UI node for ${selector}` };
  }
  return matches.length === 0
    ? { ok: true }
    : { ok: false, reason: `expected no matching UI node for ${selector}, found ${matches.length}` };
}

/**
 * Run a list of `{ text?, resourceId?, contentDesc?, className?, exists? }`
 * assertions against UI nodes. Matching is case-insensitive substring on
 * trimmed/whitespace-collapsed fields; every provided field must match and
 * `exists` defaults to `true`. `nodes` may be an array of parsed nodes, the
 * `{ nodes }` object returned by parseUiHierarchy, or a raw UIAutomator XML
 * string.
 */
export function runAssertions(nodes, assertions) {
  const normalized = normalizeNodes(nodes);
  const list = assertions == null ? [] : assertions;
  if (!Array.isArray(list)) throw new TypeError('runAssertions requires an array of assertions');
  const failed = [];
  let passed = 0;
  for (const assertion of list) {
    const outcome = evaluateAssertion(normalized, assertion);
    if (outcome.ok) {
      passed += 1;
    } else {
      failed.push({ assertion, reason: outcome.reason });
    }
  }
  return { ok: failed.length === 0, total: list.length, passed, failed };
}

function safeBaselineName(value) {
  let name = String(value == null ? '' : value)
    .trim()
    .replace(/\.png$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.png$/i, '')
    .slice(0, 80);
  if (!name) name = 'screenshot';
  // Windows treats CON.txt like CON, so test the stem before the first dot.
  if (WINDOWS_RESERVED_NAME.test(name.split('.')[0])) name = `_${name}`;
  return name;
}

function screenshotBytes(buffer) {
  let data;
  if (Buffer.isBuffer(buffer)) {
    data = buffer;
  } else if (buffer instanceof Uint8Array) {
    data = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else if (buffer instanceof ArrayBuffer) {
    data = Buffer.from(buffer);
  } else {
    throw new TypeError('compareScreenshot requires a Buffer');
  }
  if (data.length === 0) throw new RangeError('screenshot buffer is empty');
  if (data.length > MAX_SCREENSHOT_BYTES) {
    throw new RangeError(`screenshot buffer exceeds the ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} MB limit`);
  }
  return data;
}

async function readBaselineHash(baselinePath) {
  let raw;
  try {
    raw = await fsp.readFile(baselinePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  // Accept our plain hash format and the `sha256sum` "<hash>  <file>" form.
  const token = raw.replace(/^\uFEFF/, '').trim().split(/\s+/)[0] || '';
  if (!HASH_PATTERN.test(token)) {
    throw new Error(`invalid screenshot baseline hash in ${baselinePath}`);
  }
  return token.toLowerCase();
}

async function saveBaseline(pngPath, baselinePath, data, hash) {
  await fsp.writeFile(pngPath, data);
  await fsp.writeFile(baselinePath, `${hash}\n`, 'utf8');
}

/**
 * Compare a screenshot with `baselineDir/<safe-name>.png.sha256` using SHA-256
 * over the exact bytes (not a pixel diff). The first call creates the baseline
 * (and saves the PNG); `update: true` refreshes an existing baseline (and the
 * PNG). Rejects buffers over 10 MB. Returns `{ ok, created, updated, changed,
 * baselineHash, actualHash, baselinePath }`, where `baselineHash` is the hash
 * stored after the call, `changed` compares against the baseline that existed
 * before it, and `updated` records an explicit refresh request.
 */
export async function compareScreenshot(buffer, baselineDir, name, options = {}) {
  const data = screenshotBytes(buffer);
  if (typeof baselineDir !== 'string' || !baselineDir.trim()) {
    throw new TypeError('compareScreenshot requires a baseline directory');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const update = opts.update === true;
  const root = path.resolve(baselineDir);
  const safeName = safeBaselineName(name);
  const baselinePath = path.join(root, `${safeName}${HASH_SUFFIX}`);
  const pngPath = path.join(root, `${safeName}${PNG_SUFFIX}`);
  const actualHash = createHash('sha256').update(data).digest('hex');

  await fsp.mkdir(root, { recursive: true });
  const existingHash = await readBaselineHash(baselinePath);
  const existed = existingHash != null;
  const changed = existed && existingHash !== actualHash;

  let created = false;
  let updated = false;
  let ok = true;
  let baselineHash = existingHash;
  if (!existed) {
    await saveBaseline(pngPath, baselinePath, data, actualHash);
    created = true;
    baselineHash = actualHash;
  } else if (update) {
    await saveBaseline(pngPath, baselinePath, data, actualHash);
    updated = true;
    baselineHash = actualHash;
  } else {
    ok = !changed;
  }

  return { ok, created, updated, changed, baselineHash, actualHash, baselinePath };
}

function asCount(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(number));
}

function sanitizeAssertion(assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return {};
  const safe = {};
  for (const field of FIELDS) {
    if (assertion[field] != null && normalizeText(assertion[field])) {
      safe[field] = shorten(assertion[field], 200);
    }
  }
  if (typeof assertion.exists === 'boolean') safe.exists = assertion.exists;
  return safe;
}

function normalizeFailure(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { assertion: {}, reason: shorten(entry, 500) || 'assertion failed' };
  }
  return {
    assertion: sanitizeAssertion(entry.assertion),
    reason: shorten(entry.reason, 500) || 'assertion failed',
  };
}

/** Normalize a runAssertions result (or a plain passed/failed summary). */
function normalizeAssertions(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!source) return { ok: true, total: 0, passed: 0, failed: 0, failures: [] };
  const failureSource = Array.isArray(source.failed)
    ? source.failed
    : Array.isArray(source.failures)
      ? source.failures
      : [];
  const failures = failureSource.map(normalizeFailure);
  const failed = Array.isArray(source.failed) ? source.failed.length : asCount(source.failed, failures.length);
  let passed = asCount(source.passed, null);
  let total = asCount(source.total, null);
  if (total == null) total = (passed == null ? 0 : passed) + failed;
  if (passed == null) passed = Math.max(0, total - failed);
  total = Math.max(total, passed + failed);
  const ok = typeof source.ok === 'boolean' ? source.ok : failed === 0 && failures.length === 0;
  return { ok, total, passed, failed, failures };
}

function normalizeVisual(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const hash = (value) => (typeof value === 'string' && HASH_PATTERN.test(value) ? value.toLowerCase() : null);
  const changed = Boolean(input.changed);
  return {
    ok: typeof input.ok === 'boolean' ? input.ok : !changed,
    created: Boolean(input.created),
    updated: Boolean(input.updated),
    changed,
    baselineHash: hash(input.baselineHash),
    actualHash: hash(input.actualHash),
    baselinePath: typeof input.baselinePath === 'string' ? input.baselinePath : null,
  };
}

function escapeMarkdown(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_<>]/g, '\\$&');
}

function assertionLabel(assertion) {
  const safe = sanitizeAssertion(assertion);
  const parts = [];
  for (const field of FIELDS) {
    if (safe[field]) parts.push(`${field}=${JSON.stringify(shorten(safe[field], 60))}`);
  }
  if (safe.exists === false) parts.push('exists=false');
  if (parts.length === 0) return '`(no selector)`';
  return `\`${parts.join(', ').replace(/`/g, "'")}\``;
}

/**
 * Build a JSON-serializable test report plus its compact Markdown rendering.
 * `assertions` is normally the runAssertions result; `visual` is normally the
 * compareScreenshot result. The report shape is `{ name, instanceId,
 * generatedAt, durationMs, ok, assertions: { ok, total, passed, failed,
 * failures }, visual }`. Returns `{ report, markdown }`.
 */
export function createTestReport(params = {}) {
  const input = params && typeof params === 'object' ? params : {};
  const assertions = normalizeAssertions(input.assertions);
  const visual = normalizeVisual(input.visual);
  const report = {
    name: shorten(input.name, 200) || 'ui-test',
    instanceId: shorten(input.instanceId, 120) || 'default',
    generatedAt: new Date().toISOString(),
    durationMs: asCount(input.durationMs, 0),
    ok: assertions.ok && (!visual || visual.ok),
    assertions,
    visual,
  };
  return { report, markdown: reportMarkdown(report) };
}

/** Render a report (or a `{ report, ... }` wrapper) as a compact Markdown string. */
export function reportMarkdown(report) {
  const source =
    report && typeof report === 'object' && report.report && typeof report.report === 'object'
      ? report.report
      : report;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return '# UI test report\n\n_No report data._\n';
  }

  const assertions = normalizeAssertions(source.assertions);
  const visual = source.visual && typeof source.visual === 'object' ? normalizeVisual(source.visual) : null;
  const ok = typeof source.ok === 'boolean' ? source.ok : assertions.ok && (!visual || visual.ok);
  const lines = [];
  lines.push(`# UI test: ${escapeMarkdown(shorten(source.name, 200) || 'ui-test')}`);
  lines.push('');
  lines.push(`- Status: **${ok ? 'PASS' : 'FAIL'}**`);
  if (normalizeText(source.instanceId)) lines.push(`- Instance: \`${shorten(source.instanceId, 120)}\``);
  lines.push(`- Duration: ${asCount(source.durationMs, 0)} ms`);
  if (typeof source.generatedAt === 'string' && source.generatedAt) {
    lines.push(`- Generated: ${escapeMarkdown(source.generatedAt)}`);
  }
  lines.push('');
  lines.push('## Assertions');
  lines.push(`- ${assertions.passed} passed, ${assertions.failed} failed (${assertions.total} total).`);
  if (assertions.failures.length === 0) {
    if (assertions.failed > 0) {
      lines.push(`- ${assertions.failed} failure(s) reported without details.`);
    } else {
      lines.push(assertions.total > 0 ? '- All assertions passed.' : '- No assertions recorded.');
    }
  } else {
    const shownFailures = assertions.failures.slice(0, MAX_MARKDOWN_FAILURES);
    for (const failure of shownFailures) {
      const reason = failure.reason ? ` - ${escapeMarkdown(failure.reason)}` : '';
      lines.push(`- FAIL ${assertionLabel(failure.assertion)}${reason}`);
    }
    if (assertions.failures.length > shownFailures.length) {
      lines.push(`- ...and ${assertions.failures.length - shownFailures.length} more failure(s).`);
    }
    const withoutDetails = assertions.failed - assertions.failures.length;
    if (withoutDetails > 0) lines.push(`- ...and ${withoutDetails} failure(s) without details.`);
  }
  lines.push('');
  lines.push('## Visual');
  if (!visual) {
    lines.push('- Not compared.');
  } else {
    lines.push(`- Result: ${visual.ok ? 'match' : 'changed'} (exact-byte SHA-256, not a pixel diff).`);
    const state = visual.created
      ? 'created'
      : visual.updated
        ? 'updated'
        : visual.changed || !visual.ok
          ? 'changed'
          : 'unchanged';
    lines.push(`- Baseline: ${state}.`);
    if (visual.baselineHash) lines.push(`- Baseline SHA-256: \`${visual.baselineHash}\``);
    if (visual.actualHash && visual.actualHash !== visual.baselineHash) {
      lines.push(`- Actual SHA-256: \`${visual.actualHash}\``);
    }
    if (visual.baselinePath) lines.push(`- Path: \`${visual.baselinePath.replace(/`/g, "'")}\``);
  }
  return `${lines.join('\n')}\n`;
}
