#!/usr/bin/env node
/**
 * App Skill + Control Codebook + image-feature checks.
 * No emulator required: UIAutomator XML and PNG screencaps are fixtures.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ControlMatchError,
  findCodeEntry,
  listCodes,
  normalizeCodebook,
  resolveControl,
  snapshotIdForXml,
} from '../lib/control-codebook.js';
import {
  attachNodeImageFeatures,
  compareImageFeatures,
  computeImageFeatures,
  decodePng,
  normalizeImageFeatures,
} from '../lib/image-features.js';
import { decorateUiNodes, parseUiHierarchy } from '../lib/ui-inspector.js';
import {
  SkillRecorder,
  SkillStore,
  normalizeSkill,
  normalizeSkillStep,
  runSkill,
  slugifySkillName,
} from '../lib/app-skills.js';

let checked = 0;
async function check(label, fn) {
  checked += 1;
  try {
    await fn();
    console.log(`  ok ${checked} - ${label}`);
  } catch (error) {
    console.error(`  not ok ${checked} - ${label}`);
    throw error;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function makePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Login" resource-id="com.demo:id/login" class="android.widget.Button" package="com.demo" content-desc="Sign in" clickable="true" enabled="true" bounds="[20,100][220,180]" />
  <node index="1" text="Email" resource-id="com.demo:id/email" class="android.widget.EditText" package="com.demo" clickable="true" enabled="true" bounds="[20,200][220,260]" />
  <node index="2" text="" resource-id="" class="android.widget.Button" package="com.demo" content-desc="Go" clickable="true" enabled="true" bounds="[20,300][220,360]" />
  <node index="3" text="Duplicate" resource-id="com.demo:id/dup-a" class="android.widget.Button" package="com.demo" clickable="true" enabled="true" bounds="[20,400][220,460]" />
  <node index="4" text="Duplicate" resource-id="com.demo:id/dup-b" class="android.widget.Button" package="com.demo" clickable="true" enabled="true" bounds="[20,500][220,560]" />
</hierarchy>`;

const parsed = parseUiHierarchy(XML);
const screen = { width: 400, height: 800 };
const snapshotId = snapshotIdForXml(XML);

const codebook = normalizeCodebook({
  name: 'Demo login codebook',
  entries: [
    { code: 'A01', name: 'Login button', features: { resourceId: 'com.demo:id/login' } },
    { code: 'LOGIN_BTN', aliases: ['A02'], features: { text: 'Login', clickable: true } },
    { code: 'EMAIL', features: { resourceId: 'com.demo:id/email' } },
    { code: 'GO', features: { contentDesc: 'Go' } },
    { code: 'DUP', features: { text: 'Duplicate' }, index: 0 },
    { code: 'DUP_AMBIGUOUS', features: { text: 'Duplicate' } },
  ],
});

await check('UI hierarchy and stable snapshot id', () => {
  assert.equal(parsed.nodes.length, 5);
  assert.match(snapshotId, /^ui-[0-9a-f]{12}$/);
});

await check('decorated nodes expose controlId, snapshotId, features and tags', () => {
  const decorated = decorateUiNodes(parsed.nodes, { screen, snapshotId });
  assert.equal(decorated.nodes.length, 5);
  assert.equal(decorated.nodes[0].controlId, 'c1');
  assert.equal(decorated.nodes[0].snapshotId, snapshotId);
  assert.equal(decorated.nodes[0].features.resourceId, 'com.demo:id/login');
  assert.ok(decorated.nodes[0].tags.includes('clickable'));
  assert.equal(decorated.total, 5);
});

await check('codebook accepts numeric and semantic codes and aliases', () => {
  assert.equal(findCodeEntry(codebook, 'A01').name, 'Login button');
  assert.equal(findCodeEntry(codebook, 'LOGIN_BTN').code, 'LOGIN_BTN');
  assert.equal(findCodeEntry(codebook, 'a02').code, 'LOGIN_BTN');
  assert.deepEqual(listCodes(codebook), ['A01', 'LOGIN_BTN', 'EMAIL', 'GO', 'DUP', 'DUP_AMBIGUOUS']);
});

await check('resolveControl resolves numeric code, semantic code and alias', () => {
  const a = resolveControl(codebook, 'A01', parsed.nodes, { screen });
  assert.equal(a.code, 'A01');
  assert.equal(a.node.resourceId, 'com.demo:id/login');
  const b = resolveControl(codebook, 'LOGIN_BTN', parsed.nodes, { screen });
  assert.equal(b.node.text, 'Login');
  const c = resolveControl(codebook, 'A02', parsed.nodes, { screen });
  assert.equal(c.code, 'LOGIN_BTN');
});

await check('ambiguous control errors with candidates; index disambiguates', () => {
  assert.throws(() => resolveControl(codebook, 'DUP_AMBIGUOUS', parsed.nodes, { screen }), (error) => {
    assert.ok(error instanceof ControlMatchError);
    assert.equal(error.candidates.length, 2);
    return true;
  });
  const resolved = resolveControl(codebook, 'DUP', parsed.nodes, { screen });
  assert.equal(resolved.node.resourceId, 'com.demo:id/dup-a');
});

await check('unknown code and invisible control are explicit errors', () => {
  assert.throws(() => resolveControl(codebook, 'NOPE', parsed.nodes, { screen }), /unknown control code/);
  assert.throws(
    () => resolveControl(normalizeCodebook([{ code: 'NONE', features: { text: 'Missing' } }]), 'NONE', parsed.nodes, { screen }),
    /not visible/,
  );
});

await check('duplicate codes in one codebook are rejected', () => {
  assert.throws(
    () => normalizeCodebook([
      { code: 'DUP', features: { text: 'One' } },
      { code: 'dup', features: { text: 'Two' } },
    ]),
    /duplicate code/,
  );
});

await check('image features: decode, hash/colour, same/other crop', () => {
  const png = makePng(64, 64, (x, y) => (x < 32 ? [x * 4, y * 4, 40] : [40, y * 3, x * 3]));
  const decoded = decodePng(png);
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 64);
  const left = computeImageFeatures(png, { x1: 0, y1: 0, x2: 32, y2: 32 });
  const leftAgain = computeImageFeatures(png, { x1: 0, y1: 0, x2: 32, y2: 32 });
  const right = computeImageFeatures(png, { x1: 32, y1: 0, x2: 64, y2: 32 });
  assert.equal(left.hash, leftAgain.hash);
  assert.equal(compareImageFeatures(left, leftAgain).ok, true);
  assert.equal(compareImageFeatures(left, right).ok, false);
});

await check('image features can identify an icon-only control with structural features', () => {
  const png = makePng(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2]);
  const node = {
    order: 0,
    className: 'android.widget.ImageButton',
    clickable: true,
    bounds: { x1: 0, y1: 0, x2: 64, y2: 64, width: 64, height: 64, center: { x: 32, y: 32 } },
  };
  attachNodeImageFeatures(png, [node]);
  assert.ok(node.imageFeatures && node.imageFeatures.hash);
  const image = normalizeImageFeatures({
    name: 'star-icon',
    hash: node.imageFeatures.hash,
    avgColor: node.imageFeatures.avgColor,
    maxDistance: 2,
    colorTolerance: 30,
  });
  assert.equal(image.name, 'star-icon');
  const iconbook = normalizeCodebook([
    { code: 'ICON', features: { className: 'android.widget.ImageButton', image } },
  ]);
  assert.equal(resolveControl(iconbook, 'ICON', [node], { screen: { width: 64, height: 64 } }).node.order, 0);
});

await check('Skill normalisation embeds its own codebook and validates steps', () => {
  const skill = normalizeSkill({
    name: 'Demo login flow',
    package: 'com.demo',
    target: 'GO',
    codebook,
    steps: [
      { action: 'tap', code: 'A01' },
      { action: 'input', code: 'EMAIL', value: '{{email}}' },
      { action: 'waitFor', code: 'GO', timeoutMs: 900 },
    ],
    variables: { email: 'demo-user' },
  });
  assert.equal(skill.id, 'demo-login-flow');
  assert.equal(skill.codebook.entries.length, 6);
  assert.equal(skill.steps.length, 3);
  assert.equal(skill.target, 'GO');
  assert.throws(() => normalizeSkillStep({ action: 'tap' }), /requires code or selector/);
  assert.equal(slugifySkillName('你好 Demo 登录'), 'demo');
});

await check('SkillStore and recorder persist an embedded codebook', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-skill-test-'));
  try {
    const store = new SkillStore({ dir });
    const normalized = normalizeSkill({
      name: 'Stored flow',
      package: 'com.demo',
      codebook,
      steps: [{ action: 'tap', code: 'A01' }],
    });
    await store.save(normalized);
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].codebook.entries.length, 6);
    assert.equal((await store.get(normalized.id)).steps[0].code, 'A01');
    assert.equal(await store.remove(normalized.id), true);
    assert.equal((await store.list()).length, 0);

    const recorder = new SkillRecorder({ store });
    await recorder.start('default', { name: 'Recorded flow', codebook });
    recorder.add('default', { action: 'tap', code: 'A01' });
    recorder.add('default', { action: 'input', code: 'EMAIL', value: 'x-user' });
    const saved = await recorder.stop('default');
    assert.equal(saved.steps.length, 2);
    assert.equal(saved.codebook.entries.length, 6);
    assert.equal((await store.list()).length, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function fakeApi(xml, log = []) {
  return {
    uiDump: async () => ({ ok: true, xml, bytes: xml.length }),
    screenSize: async () => ({ width: 400, height: 800 }),
    screenshotBuffer: async () => makePng(64, 64, (x, y) => [x * 4, y * 4, 20]),
    launchPackage: async (pkg, activity) => {
      log.push(['launch', pkg, activity || null]);
      return { ok: true };
    },
    input: async (payload) => {
      log.push(['input', payload]);
      return { ok: true };
    },
  };
}

await check('runSkill replays semantic steps, interpolates variables and reports', async () => {
  const log = [];
  const skill = normalizeSkill({
    name: 'Login',
    package: 'com.demo',
    codebook,
    steps: [
      { action: 'launch' },
      { action: 'tap', code: 'A01' },
      { action: 'input', code: 'EMAIL', value: '{{email}}' },
      { action: 'waitFor', code: 'GO', timeoutMs: 500 },
    ],
  });
  const report = await runSkill(skill, fakeApi(XML, log), { variables: { email: 'agent-user' } });
  assert.equal(report.ok, true);
  assert.equal(report.stepsRun, 4);
  assert.equal(report.reached, null);
  assert.deepEqual(log[0], ['launch', 'com.demo', null]);
  assert.equal(log[1][1].type, 'tap');
  assert.equal(log[1][1].x, 120);
  assert.equal(log[1][1].y, 140);
  assert.deepEqual(log[2][1], { type: 'tap', x: 120, y: 230 });
  assert.deepEqual(log[3][1], { type: 'text', text: 'agent-user' });
});

await check('runSkill stops at untilCode and supports dryRun', async () => {
  const skill = normalizeSkill({
    name: 'Fast target',
    package: 'com.demo',
    codebook,
    steps: [
      { action: 'tap', code: 'A01' },
      { action: 'tap', code: 'EMAIL' },
    ],
  });
  const log = [];
  const report = await runSkill(skill, fakeApi(XML, log), { untilCode: 'GO' });
  assert.equal(report.ok, true);
  assert.equal(report.stepsRun, 1);
  assert.equal(report.reached, true);

  const dryLog = [];
  const dry = await runSkill(skill, fakeApi(XML, dryLog), { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dryLog.length, 0);
});

await check('runSkill failure carries step/candidates diagnostics', async () => {
  const skill = normalizeSkill({
    name: 'Broken',
    package: 'com.demo',
    codebook,
    steps: [{ action: 'tap', code: 'NOT_THERE' }],
  });
  await assert.rejects(runSkill(skill, fakeApi(XML)), (error) => {
    assert.equal(error.name, 'SkillRunError');
    assert.equal(error.stepsRun, 0);
    assert.match(error.message, /unknown control code/);
    return true;
  });
});

await check('runSkill assert exists:false succeeds only when the control is absent', async () => {
  const absent = normalizeSkill({
    name: 'Absent check',
    codebook,
    steps: [{ action: 'assert', code: 'NOPE_IN_CODEBOOK', exists: false }],
  });
  await assert.rejects(runSkill(absent, fakeApi(XML)), (error) => {
    assert.equal(error.name, 'SkillRunError');
    assert.match(error.message, /unknown control code/);
    return true;
  });

  const missing = normalizeCodebook([{ code: 'MISSING', features: { text: 'Not on screen' } }]);
  const okSkill = normalizeSkill({
    name: 'Absent ok',
    codebook: missing,
    steps: [{ action: 'assert', code: 'MISSING', exists: false }],
  });
  const report = await runSkill(okSkill, fakeApi(XML));
  assert.equal(report.ok, true);
  assert.equal(report.stepsRun, 1);
  assert.equal(report.events[0].exists, false);

  const visibleSkill = normalizeSkill({
    name: 'Absent fails',
    codebook,
    steps: [{ action: 'assert', code: 'GO', exists: false }],
  });
  await assert.rejects(runSkill(visibleSkill, fakeApi(XML)), /is visible/);
});

await check('runSkill waitFor polls a not-visible control instead of treating candidates as ambiguous', async () => {
  const missing = normalizeCodebook([{ code: 'MISSING', features: { text: 'Not on screen' } }]);
  const skill = normalizeSkill({
    name: 'Poll missing',
    codebook: missing,
    steps: [{ action: 'waitFor', code: 'MISSING', timeoutMs: 160 }],
  });
  await assert.rejects(runSkill(skill, fakeApi(XML)), (error) => {
    assert.match(error.message, /timed out after 160ms/);
    assert.equal(error.candidates.length > 1, true);
    return true;
  });
});

console.log(`\nskill-test: ${checked} checks passed`);
