/**
 * spike/installed-apps-test.mjs — hermetic tests for the remembered-APK
 * registry and the auto-reinstall pass. No VM, no adb, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  InstalledAppRegistry,
  defaultInstalledAppsPath,
  normalizeRememberedApp,
  reinstallMissingApps,
  summarizeReinstallResult,
} from '../lib/installed-apps.js';

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apk-vm-installed-apps-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeApk(dir, name) {
  const file = path.join(dir, name);
  return fsp.writeFile(file, Buffer.from('PK\u0003\u0004fake-apk')).then(() => file);
}

test('defaultInstalledAppsPath lives under <dataDir>/.apk-vm', () => {
  const expected = process.platform === 'win32'
    ? path.join('C:\\profile', '.apk-vm', 'installed-apps.json')
    : path.join('/profile', '.apk-vm', 'installed-apps.json');
  assert.equal(defaultInstalledAppsPath(process.platform === 'win32' ? 'C:\\profile' : '/profile'), expected);
});

test('normalizeRememberedApp requires an absolute APK path', () => {
  assert.equal(normalizeRememberedApp(null), null);
  assert.equal(normalizeRememberedApp({ packageName: 'x' }), null);
  assert.equal(normalizeRememberedApp({ apkPath: 'relative/app.apk' }), null);
  const entry = normalizeRememberedApp({
    apkPath: path.join(os.tmpdir(), 'app.apk'),
    packageName: ' com.example.app ',
    label: 'Example',
    instanceId: 'default',
    installedAt: 1234,
  });
  assert.equal(entry.packageName, 'com.example.app');
  assert.equal(entry.label, 'Example');
  assert.equal(entry.rememberedAt, 1234);
});

test('registry records, dedupes by path+instance, and reports summaries', async (t) => {
  const dir = await tempDir(t);
  const apk = await fakeApk(dir, 'one.apk');
  const file = path.join(dir, 'state', 'installed-apps.json');
  let clock = 1000;
  const registry = new InstalledAppRegistry({ file, maxApps: 3, now: () => ++clock });

  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(await registry.summary(), { count: 0, apps: [] });

  const first = await registry.record({ apkPath: apk, packageName: 'com.one', label: 'One', instanceId: 'default' });
  assert.equal(first.ok, true);
  assert.equal(first.entries.length, 1);
  assert.equal((await registry.list())[0].packageName, 'com.one');

  await registry.record({ apkPath: apk, packageName: 'com.one', label: 'One v2', instanceId: 'default' });
  let entries = await registry.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'One v2');

  await registry.record({ apkPath: apk, packageName: 'com.one', label: 'One', instanceId: 'extra-1' });
  entries = await registry.list();
  assert.equal(entries.length, 2);

  const summary = await registry.summary();
  assert.equal(summary.count, 2);
  assert.equal(summary.apps[0].instanceId, 'extra-1');

  const loaded = new InstalledAppRegistry({ file });
  assert.equal((await loaded.list()).length, 2);
});

test('registry trims to maxApps and forget/clear work', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'installed-apps.json');
  const registry = new InstalledAppRegistry({ file, maxApps: 2 });
  const a = await fakeApk(dir, 'a.apk');
  const b = await fakeApk(dir, 'b.apk');
  const c = await fakeApk(dir, 'c.apk');
  await registry.record({ apkPath: a, packageName: 'com.a' });
  await registry.record({ apkPath: b, packageName: 'com.b' });
  await registry.record({ apkPath: c, packageName: 'com.c' });
  const entries = await registry.list();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.packageName), ['com.c', 'com.b']);

  const forgotten = await registry.forget((entry) => entry.packageName === 'com.c');
  assert.equal(forgotten.removed, 1);
  assert.deepEqual((await registry.list()).map((entry) => entry.packageName), ['com.b']);

  const cleared = await registry.clear();
  assert.equal(cleared.removed, 1);
  assert.deepEqual(await registry.list(), []);
});

test('registry tolerates corrupt or missing state files', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'installed-apps.json');
  await fsp.writeFile(file, '{not json', 'utf8');
  const registry = new InstalledAppRegistry({ file });
  assert.deepEqual(await registry.list(), []);
  const recorded = await registry.record({ apkPath: await fakeApk(dir, 'x.apk'), packageName: 'com.x' });
  assert.equal(recorded.ok, true);
  assert.equal((await registry.list()).length, 1);
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.apps.length, 1);
});

test('reinstallMissingApps reinstalls only missing packages with present APKs', async (t) => {
  const dir = await tempDir(t);
  const apkA = await fakeApk(dir, 'a.apk');
  const apkB = await fakeApk(dir, 'b.apk');
  const entries = [
    { apkPath: apkA, packageName: 'com.a', label: 'A', instanceId: 'default' },
    { apkPath: apkB, packageName: 'com.b', label: 'B', instanceId: 'default' },
    { apkPath: path.join(dir, 'gone.apk'), packageName: 'com.gone', instanceId: 'default' },
    { apkPath: await fakeApk(dir, 'fail.apk'), packageName: 'com.fail', instanceId: 'default' },
  ];
  const installed = [];
  const result = await reinstallMissingApps({
    registry: { list: async () => entries },
    listPackages: async () => ({ packages: [{ packageName: 'com.a' }, { packageName: 'com.system' }] }),
    installApk: async (apkPath) => {
      installed.push(apkPath);
      if (apkPath.endsWith('fail.apk')) throw new Error('install failed: bad manifest');
      return { packageName: 'com.b', label: 'B' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked, 4);
  assert.deepEqual(result.reinstalled.map((item) => item.packageName), ['com.b']);
  assert.deepEqual(installed, [apkB, path.join(dir, 'fail.apk')]);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.some((item) => item.reason === 'installed'));
  assert.ok(result.skipped.some((item) => item.reason === 'apk-missing'));
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /bad manifest/);
  assert.match(summarizeReinstallResult(result), /reinstalled 1 app/);
});

test('reinstallMissingApps reports package listing failures', async () => {
  const result = await reinstallMissingApps({
    registry: { list: async () => [{ apkPath: path.join(os.tmpdir(), 'a.apk'), packageName: 'com.a' }] },
    listPackages: async () => { throw new Error('adb offline'); },
    installApk: async () => ({ packageName: 'com.a' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /adb offline/);
});

test('reinstallMissingApps is a no-op with an empty registry', async () => {
  let listed = 0;
  const result = await reinstallMissingApps({
    registry: { list: async () => [] },
    listPackages: async () => { listed++; return { packages: [] }; },
    installApk: async () => ({ packageName: 'x' }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reinstalled, []);
  assert.equal(listed, 0);
  assert.match(summarizeReinstallResult(result), /nothing to reinstall/);
});

test('reinstallMissingApps validates required dependencies', async () => {
  await assert.rejects(
    reinstallMissingApps({ registry: { list: async () => [] } }),
    /requires listPackages/,
  );
  await assert.rejects(
    reinstallMissingApps({ listPackages: async () => ({ packages: [] }), installApk: async () => ({}) }),
    /requires a registry/,
  );
});
