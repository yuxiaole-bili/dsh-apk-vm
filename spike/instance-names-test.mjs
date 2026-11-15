/**
 * Hermetic tests for persistent VM display names (lib/instance-names.js) and
 * the InstanceManager rename plumbing.
 *
 * Run with: node spike/instance-names-test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INSTANCE_NAMES_VERSION,
  InstanceNameBook,
  defaultInstanceNamesPath,
  sanitizeDisplayName,
} from '../lib/instance-names.js';
import { InstanceManager } from '../lib/instances.js';

let checks = 0;
async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), 'apk-vm-instance-names-'));
const file = path.join(root, '.apk-vm', 'instance-names.json');

await check('sanitizeDisplayName trims, flattens control characters and caps length', () => {
  assert.equal(sanitizeDisplayName('  frontend\n\tVM  '), 'frontend VM');
  assert.equal(sanitizeDisplayName(null), '');
  assert.equal(sanitizeDisplayName(undefined), '');
  assert.equal(sanitizeDisplayName('x'.repeat(80)).length, 48);
});

await check('defaultInstanceNamesPath anchors the registry under .apk-vm', () => {
  assert.equal(defaultInstanceNamesPath(root), file);
});

await check('name book persists, reloads and deletes entries', async () => {
  const book = new InstanceNameBook({ file });
  assert.equal(book.get('default'), '');
  assert.deepEqual(await book.set('default', ' QA phone '), { ok: true, id: 'default', name: 'QA phone' });
  assert.deepEqual(await book.set('frontend', 'Frontend VM'), { ok: true, id: 'frontend', name: 'Frontend VM' });
  assert.equal(book.get('default'), 'QA phone');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, INSTANCE_NAMES_VERSION);
  assert.deepEqual(raw.names, { default: 'QA phone', frontend: 'Frontend VM' });

  const reopened = new InstanceNameBook({ file });
  assert.equal(reopened.get('frontend'), 'Frontend VM');
  assert.deepEqual(await reopened.delete('frontend'), { ok: true, removed: true });
  assert.deepEqual(await reopened.delete('frontend'), { ok: true, removed: false });
  assert.equal(reopened.get('frontend'), '');
});

await check('name book rejects empty names and keeps working without a file', async () => {
  const book = new InstanceNameBook({ file: path.join(root, 'nope', 'names.json') });
  assert.equal((await book.set('x', '   ')).ok, false);
  assert.equal((await book.set('', 'name')).ok, false);
  const memory = new InstanceNameBook({ file: null });
  assert.equal((await memory.set('default', 'Memory VM')).ok, true);
  assert.equal(memory.get('default'), 'Memory VM');
});

await check('corrupt registry is tolerated and starts empty', async () => {
  const corrupt = path.join(root, 'corrupt.json');
  writeFileSync(corrupt, '{not json', 'utf8');
  const book = new InstanceNameBook({ file: corrupt });
  assert.deepEqual(book.list(), {});
  assert.equal((await book.set('default', 'Recovered')).ok, true);
  assert.equal(book.get('default'), 'Recovered');
});

await check('InstanceManager renames the default VM and rejects unknown ids', async () => {
  const manager = new InstanceManager({
    namesFile: path.join(root, 'manager-names.json'),
    maxInstances: 1,
  });
  assert.equal(manager.nameFor('default', 'dsh_apk'), 'dsh_apk');
  const renamed = await manager.rename('default', 'QA phone');
  assert.deepEqual(renamed, { ok: true, id: 'default', name: 'QA phone', previous: null });
  assert.equal(manager.nameFor('default', 'dsh_apk'), 'QA phone');
  const reopened = new InstanceManager({ namesFile: path.join(root, 'manager-names.json') });
  assert.equal(reopened.nameFor('default', 'dsh_apk'), 'QA phone');
  const missing = await manager.rename('does-not-exist', 'nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /unknown instance/);
  const empty = await manager.rename('default', '   ');
  assert.equal(empty.ok, false);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${checks} checks passed (instance names)`);
