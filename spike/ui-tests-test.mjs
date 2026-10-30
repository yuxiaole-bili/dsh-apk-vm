/**
 * Dependency-free coverage for lib/ui-tests.js (UI assertions + exact-byte
 * screenshot baselines + reports).
 *
 * Run:  node spike/ui-tests-test.mjs
 *
 * The PNG fixtures are deliberately fake byte strings: compareScreenshot is an
 * exact-byte fingerprint helper, so no decoder is involved.
 */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAssertions, compareScreenshot, createTestReport, reportMarkdown } from '../lib/ui-tests.js';
import { parseUiHierarchy } from '../lib/ui-inspector.js';

const NODES = [
  {
    text: 'dsh-apk-vm sample',
    resourceId: 'dev.dsh.sample:id/heading',
    contentDesc: '',
    className: 'android.widget.TextView',
  },
  {
    text: '',
    resourceId: 'dev.dsh.sample:id/status',
    contentDesc: 'status line',
    className: 'android.widget.TextView',
  },
  {
    text: 'Say hello',
    resourceId: 'dev.dsh.sample:id/action',
    contentDesc: 'say hello',
    className: 'android.widget.Button',
  },
  {
    text: '  Tap   the button  ',
    resourceId: '',
    contentDesc: '',
    className: 'android.widget.TextView',
  },
];

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[0,0][720,1280]">
    <node index="0" text="dsh-apk-vm sample" resource-id="dev.dsh.sample:id/heading" class="android.widget.TextView" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[143,463][576,528]" />
    <node index="1" text="Tap the button to greet the VM." resource-id="dev.dsh.sample:id/status" class="android.widget.TextView" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[111,568][609,617]" />
    <node index="2" text="Say hello" resource-id="dev.dsh.sample:id/action" class="android.widget.Button" package="dev.dsh.sample" content-desc="say hello" clickable="true" enabled="true" bounds="[260,700][460,790]" />
  </node>
</hierarchy>`;

const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-apk-vm fake png payload', 'utf8'),
]);

let passedChecks = 0;
let failedChecks = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passedChecks += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failedChecks += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-tests-'));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

await check('runAssertions matches normalized nodes and exists:false', async () => {
  const result = runAssertions(NODES, [
    { text: 'say HELLO' },
    { resourceId: 'id/action' },
    { contentDesc: 'SAY HELLO', className: 'Button' },
    { text: 'Tap the button' },
    { text: 'not on screen', exists: false },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.total, 5);
  assert.equal(result.passed, 5);
  assert.deepEqual(result.failed, []);
});

await check('runAssertions parses UIAutomator XML and the { nodes } payload', async () => {
  const parsed = parseUiHierarchy(UI_XML);
  assert.equal(parsed.nodes.length, 4);
  const fromXml = runAssertions(UI_XML, [
    { text: 'Say hello' },
    { resourceId: 'id/action' },
    { contentDesc: 'say HELLO' },
    { className: 'Button' },
    { text: 'not on screen', exists: false },
  ]);
  assert.equal(fromXml.ok, true);
  assert.equal(fromXml.total, 5);
  assert.equal(fromXml.passed, 5);
  const fromParsed = runAssertions(parsed, [{ text: 'greet the VM' }]);
  assert.equal(fromParsed.ok, true);
  assert.equal(fromParsed.passed, 1);
});

await check('runAssertions reports failures, exists:false mismatches and invalid selectors', async () => {
  const result = runAssertions(NODES, [
    { text: 'Say hello' },
    { text: 'not on screen' },
    { resourceId: 'id/action', exists: false },
    { exists: false },
    null,
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.total, 5);
  assert.equal(result.passed, 1);
  assert.equal(result.failed.length, 4);
  assert.equal(result.failed[0].assertion.text, 'not on screen');
  assert.match(result.failed[0].reason, /no matching UI node/);
  assert.match(result.failed[1].reason, /expected no matching UI node/);
  assert.match(result.failed[2].reason, /no selector field/);
  assert.match(result.failed[3].reason, /must be an object/);
});

await check('runAssertions handles empty inputs without a device', async () => {
  assert.deepEqual(runAssertions(NODES, []), { ok: true, total: 0, passed: 0, failed: [] });
  const absent = runAssertions([], [{ text: 'anything', exists: false }]);
  assert.equal(absent.ok, true);
  assert.equal(absent.total, 1);
  assert.equal(absent.passed, 1);
});

await check('compareScreenshot creates, matches, changes and updates a baseline', async () => {
  await withTempDir(async (dir) => {
    const baselineDir = path.join(dir, 'baselines');
    const unsafeName = '../Login: screen*?';

    const first = await compareScreenshot(FAKE_PNG, baselineDir, unsafeName);
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.updated, false);
    assert.equal(first.changed, false);
    assert.match(first.actualHash, /^[0-9a-f]{64}$/);
    assert.equal(first.baselineHash, first.actualHash);
    assert.equal(path.basename(first.baselinePath), 'Login-screen.png.sha256');
    assert.equal(path.dirname(first.baselinePath), path.resolve(baselineDir));
    const pngPath = path.join(path.dirname(first.baselinePath), 'Login-screen.png');
    assert.equal((await fsp.readFile(first.baselinePath, 'utf8')).trim(), first.actualHash);
    assert.equal((await fsp.readFile(pngPath)).equals(FAKE_PNG), true);

    const second = await compareScreenshot(FAKE_PNG, baselineDir, unsafeName);
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.updated, false);
    assert.equal(second.changed, false);
    assert.equal(second.baselineHash, first.baselineHash);
    assert.equal(second.baselinePath, first.baselinePath);

    const modifiedPng = Buffer.from(FAKE_PNG);
    modifiedPng[modifiedPng.length - 1] ^= 0xff;
    const changed = await compareScreenshot(modifiedPng, baselineDir, unsafeName);
    assert.equal(changed.ok, false);
    assert.equal(changed.created, false);
    assert.equal(changed.updated, false);
    assert.equal(changed.changed, true);
    assert.equal(changed.baselineHash, first.baselineHash);
    assert.notEqual(changed.actualHash, first.actualHash);
    assert.equal((await fsp.readFile(first.baselinePath, 'utf8')).trim(), first.baselineHash);
    assert.equal((await fsp.readFile(pngPath)).equals(FAKE_PNG), true);

    const updated = await compareScreenshot(modifiedPng, baselineDir, unsafeName, { update: true });
    assert.equal(updated.ok, true);
    assert.equal(updated.created, false);
    assert.equal(updated.updated, true);
    assert.equal(updated.changed, true);
    assert.equal(updated.baselineHash, changed.actualHash);
    assert.equal((await fsp.readFile(first.baselinePath, 'utf8')).trim(), changed.actualHash);
    assert.equal((await fsp.readFile(pngPath)).equals(modifiedPng), true);

    const afterUpdate = await compareScreenshot(modifiedPng, baselineDir, unsafeName);
    assert.equal(afterUpdate.ok, true);
    assert.equal(afterUpdate.changed, false);
    assert.equal(afterUpdate.updated, false);
    assert.equal(afterUpdate.baselineHash, changed.actualHash);
  });
});

await check('compareScreenshot sanitizes reserved and empty baseline names', async () => {
  await withTempDir(async (dir) => {
    const reserved = await compareScreenshot(FAKE_PNG, dir, 'CON.png');
    assert.equal(path.basename(reserved.baselinePath), '_CON.png.sha256');
    const fallback = await compareScreenshot(FAKE_PNG, dir, '.png');
    assert.equal(path.basename(fallback.baselinePath), 'screenshot.png.sha256');
    const dotted = await compareScreenshot(FAKE_PNG, dir, 'home.screen.v2');
    assert.equal(path.basename(dotted.baselinePath), 'home.screen.v2.png.sha256');
  });
});

await check('compareScreenshot enforces the 10 MB limit and buffer type', async () => {
  await withTempDir(async (dir) => {
    const exact = await compareScreenshot(Buffer.alloc(10 * 1024 * 1024, 0x7a), dir, 'exact-limit');
    assert.equal(exact.ok, true);
    assert.equal(exact.created, true);
    await assert.rejects(() => compareScreenshot(Buffer.alloc(10 * 1024 * 1024 + 1), dir, 'too-big'), /10 MB/);
    await assert.rejects(() => compareScreenshot(Buffer.alloc(0), dir, 'empty'), /empty/);
    await assert.rejects(() => compareScreenshot('not a buffer', dir, 'bad-type'), /Buffer/);
  });
});

await check('createTestReport captures passing results and renders Markdown', async () => {
  await withTempDir(async (dir) => {
    const assertions = runAssertions(NODES, [
      { text: 'Say hello' },
      { text: 'not on screen', exists: false },
    ]);
    const visual = await compareScreenshot(FAKE_PNG, path.join(dir, 'baselines'), 'home-screen');
    const result = createTestReport({
      name: 'Home screen smoke',
      assertions,
      visual,
      durationMs: 42,
      instanceId: 'default',
    });

    assert.equal(result.report.ok, true);
    assert.equal(result.report.name, 'Home screen smoke');
    assert.equal(result.report.instanceId, 'default');
    assert.equal(result.report.durationMs, 42);
    assert.equal(result.report.assertions.total, 2);
    assert.equal(result.report.assertions.passed, 2);
    assert.equal(result.report.assertions.failed, 0);
    assert.equal(result.report.visual.ok, true);
    assert.match(result.markdown, /^# UI test: Home screen smoke/m);
    assert.match(result.markdown, /\*\*PASS\*\*/);
    assert.match(result.markdown, /2 passed, 0 failed \(2 total\)/);
    assert.match(result.markdown, /exact-byte SHA-256/);
    assert.equal(result.markdown, reportMarkdown(result.report));
    assert.equal(result.markdown, reportMarkdown(result));

    const roundTrip = JSON.parse(JSON.stringify(result.report));
    assert.equal(roundTrip.assertions.passed, 2);
    assert.equal(roundTrip.visual.created, true);
    assert.equal(JSON.stringify(result.report).includes('Buffer'), false);
  });
});

await check('createTestReport marks failing assertions and changed visuals in Markdown', async () => {
  await withTempDir(async (dir) => {
    const assertions = runAssertions(NODES, [
      { text: 'Say hello' },
      { text: 'not on screen' },
      { resourceId: 'id/action', exists: false },
    ]);
    const baseline = await compareScreenshot(FAKE_PNG, dir, 'failed-screen');
    assert.equal(baseline.created, true);
    const changedPng = Buffer.from(FAKE_PNG);
    changedPng[0] = 0x00;
    const visual = await compareScreenshot(changedPng, dir, 'failed-screen');
    assert.equal(visual.changed, true);

    const result = createTestReport({
      name: 'Broken flow',
      assertions,
      visual,
      durationMs: 7,
      instanceId: 'vm-2',
    });
    assert.equal(result.report.ok, false);
    assert.equal(result.report.assertions.total, 3);
    assert.equal(result.report.assertions.passed, 1);
    assert.equal(result.report.assertions.failed, 2);
    assert.equal(result.report.assertions.failures.length, 2);
    assert.equal(result.report.assertions.failures[0].assertion.text, 'not on screen');
    assert.equal(result.report.visual.ok, false);
    assert.match(result.markdown, /\*\*FAIL\*\*/);
    assert.match(result.markdown, /1 passed, 2 failed \(3 total\)/);
    assert.match(result.markdown, /no matching UI node/);
    assert.match(result.markdown, /expected no matching UI node/);
    assert.match(result.markdown, /changed \(exact-byte SHA-256/);
    assert.doesNotThrow(() => JSON.stringify(result.report));
  });
});

await check('createTestReport accepts summary counts without failure details', async () => {
  const result = createTestReport({
    name: 'Summary only',
    assertions: { ok: false, total: 3, passed: 1, failed: 2 },
    durationMs: 3,
  });
  assert.equal(result.report.ok, false);
  assert.equal(result.report.assertions.total, 3);
  assert.equal(result.report.assertions.passed, 1);
  assert.equal(result.report.assertions.failed, 2);
  assert.equal(result.report.visual, null);
  assert.match(result.markdown, /\*\*FAIL\*\*/);
  assert.match(result.markdown, /1 passed, 2 failed \(3 total\)/);
  assert.match(result.markdown, /2 failure\(s\) reported without details/);
  assert.equal(result.markdown.includes('All assertions passed'), false);
  assert.match(result.markdown, /- Not compared\./);
});

await check('createTestReport derives visual status from a raw changed:true summary', async () => {
  const result = createTestReport({
    name: 'Manual visual',
    assertions: { ok: true, total: 1, passed: 1, failed: 0 },
    visual: {
      changed: true,
      baselineHash: 'a'.repeat(64),
      actualHash: 'b'.repeat(64),
    },
  });
  assert.equal(result.report.visual.ok, false);
  assert.equal(result.report.ok, false);
  assert.match(result.markdown, /\*\*FAIL\*\*/);
  assert.match(result.markdown, /changed \(exact-byte SHA-256/);
  assert.match(result.markdown, /Baseline SHA-256: `[a-f0-9]{64}`/);
  assert.match(result.markdown, /Actual SHA-256: `[a-f0-9]{64}`/);
});

console.log(`\n--- summary ---\nchecks: ${passedChecks + failedChecks}, passed: ${passedChecks}, failed: ${failedChecks}`);
if (failedChecks > 0) process.exitCode = 1;
