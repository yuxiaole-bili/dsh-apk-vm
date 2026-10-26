/**
 * Unit coverage for the substantive 0.4 features that have no adb boundary:
 * UI Inspector parsing/selectors, interaction flow recording/replay, APK bundle
 * extraction and X.509 subject-hash generation.
 */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseUiHierarchy, decorateUiNodes, buildInspectorPayload, selectorForNode } from '../lib/ui-inspector.js';
import { FlowRecorder } from '../lib/flows.js';
import { extractApkBundle, cleanupBundle, listZipEntries } from '../lib/apk-bundle.js';
import { inspectCertificate, subjectHashOld } from '../lib/x509.js';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APK = path.join(SPIKE_DIR, 'android', 'sample.apk');
const TEST_CA = path.join(SPIKE_DIR, 'android', 'test-ca.pem');

let checks = 0;
let failed = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    checks += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[0,0][720,1280]">
    <node index="0" text="dsh-apk-vm sample" resource-id="dev.dsh.sample:id/heading" class="android.widget.TextView" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[143,463][576,528]" />
    <node index="1" text="Tap the button to greet the VM." resource-id="dev.dsh.sample:id/status" class="android.widget.TextView" package="dev.dsh.sample" content-desc="" clickable="false" enabled="true" bounds="[111,568][609,617]" />
    <node index="2" text="Say hello" resource-id="dev.dsh.sample:id/action" class="android.widget.Button" package="dev.dsh.sample" content-desc="say hello" clickable="true" enabled="true" bounds="[260,700][460,790]" />
  </node>
</hierarchy>`;

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const nameBuf = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14); // crc is not validated by our reader
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuf, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

await check('UI inspector parses hierarchy and generates stable selectors', async () => {
  const parsed = parseUiHierarchy(UI_XML);
  assert.equal(parsed.rotation, 0);
  assert.equal(parsed.nodes.length, 4);
  const button = parsed.nodes.find((node) => node.resourceId === 'dev.dsh.sample:id/action');
  assert.ok(button);
  assert.equal(button.clickable, true);
  assert.ok(button.bounds && button.bounds.center && button.bounds.center.x === 360 && button.bounds.center.y === 745);
  const selector = selectorForNode(button);
  assert.equal(selector.by, 'resourceId');
  assert.match(selector.tapCommand, /^tap_text /);
  const decorated = decorateUiNodes(parsed.nodes, { limit: 10 });
  assert.equal(decorated.nodes.length, 4);
  assert.ok(decorated.nodes.every((node) => node.bounds && node.selector));
  const payload = buildInspectorPayload({ xml: UI_XML, bytes: UI_XML.length }, { width: 720, height: 1280 });
  assert.equal(payload.ok, true);
  assert.equal(payload.screen.width, 720);
});

await check('Flow recorder saves, lists and replays timed input', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-flow-test-'));
  const recorder = new FlowRecorder({ dir });
  try {
    const started = recorder.start('default', 'greeting flow');
    assert.ok(started.id);
    recorder.record('default', { type: 'tap', x: 360, y: 745 });
    recorder.record('default', { type: 'text', text: 'hello' });
    recorder.record('default', { type: 'key', key: 'ENTER' });
    recorder.record('default', { type: 'not-an-input' });
    const stopped = await recorder.stop('default');
    assert.equal(stopped.events, 3);
    const list = await recorder.list('default');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'greeting_flow');
    const replayed = [];
    const result = await recorder.replay(stopped.id, async (payload) => replayed.push(payload), {
      instanceId: 'default',
      delayCapMs: 0,
    });
    assert.equal(result.steps, 3);
    assert.deepEqual(replayed[0], { type: 'tap', x: 360, y: 745 });
    assert.deepEqual(replayed[1], { type: 'text', text: 'hello' });
    await recorder.remove(stopped.id, 'default');
    assert.equal((await recorder.list('default')).length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await check('APK bundle extraction handles APKS/XAPK split archives', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bundle-test-'));
  const sample = await fsp.readFile(SAMPLE_APK);
  try {
    const apksPath = path.join(dir, 'sample.apks');
    await fsp.writeFile(apksPath, makeZip({ 'splits/base-master.apk': sample, 'splits/base-x86_64.apk': sample }));
    const apks = await extractApkBundle(apksPath, { dir: path.join(dir, 'apks') });
    assert.equal(apks.kind, 'apks');
    assert.equal(apks.apkPaths.length, 2);
    assert.match(apks.basePath, /base-master\.apk$/);
    assert.equal((await listZipEntries(await fsp.readFile(apks.apkPaths[0]))).length > 0, true);
    await cleanupBundle(apks);

    const xapkPath = path.join(dir, 'sample.xapk');
    await fsp.writeFile(xapkPath, makeZip({ 'base.apk': sample }));
    const xapk = await extractApkBundle(xapkPath, { dir: path.join(dir, 'xapk') });
    assert.equal(xapk.kind, 'xapk');
    assert.equal(xapk.apkPaths.length, 1);
    await cleanupBundle(xapk);

    await assert.rejects(() => extractApkBundle(path.join(dir, 'missing.aab')), /AAB/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await check('X.509 subject_hash_old matches OpenSSL for the test CA', async () => {
  const pem = await fsp.readFile(TEST_CA);
  const cert = inspectCertificate(pem);
  assert.equal(cert.hash, '73393196');
  assert.equal(cert.fileName, '73393196.0');
  assert.equal(subjectHashOld(cert.der), '73393196');
  assert.match(cert.subject, /dsh-apk-vm-test-ca/);
});

console.log(`\n--- summary ---\nchecks: ${checks}, failed: ${failed}`);
if (failed) process.exitCode = 1;
