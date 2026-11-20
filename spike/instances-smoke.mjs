#!/usr/bin/env node
/**
 * Hermetic checks for InstanceManager lifecycle helpers + host memory guard +
 * Lite mode (lib/instances.js). No emulator is spawned and no AVD tooling is
 * invoked: AVDs are fake `<avd>.ini`/`config.ini` files in a temp
 * ANDROID_AVD_HOME (set before lib/instances.js is imported, because it
 * captures the home at import time).
 *
 * Host memory is always injected via `memoryProvider` so results do not depend
 * on the machine running the tests.
 *
 * NOTE on 16 GB: the task brief said "16GB → 2", but the specified formula
 * max(1, min(requested, floor((total - reserved) / estimate))) with the
 * specified defaults (4 GiB reserve, 3 GiB/VM) gives floor(12/3) = 4 and thus
 * stays at requested=3. The formula/defaults are authoritative (same decision
 * as spike/memory-test.mjs); the discrepancy is reported to the Lead.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const AVD_HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-instances-smoke-'));
process.env.ANDROID_AVD_HOME = AVD_HOME;

const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);
const { InstanceManager, pickMemoryPressureVictim, patchAvdConfig } = await load('lib/instances.js');

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

// ---------------------------------------------------------------------------
// Helpers: synthetic host memory + fake AVDs + fake instances.
// ---------------------------------------------------------------------------
const hostMemory = (totalBytes, freeBytes) => ({
  ok: true,
  totalBytes,
  freeBytes,
  totalMb: Math.round(totalBytes / MIB),
  freeMb: Math.round(freeBytes / MIB),
});

/** A real-ish memoryProvider: injects host RAM, uses lib/memory.js for the rest. */
const providerFor = (totalBytes, freeBytes) => ({
  hostMemoryInfo: () => hostMemory(totalBytes, freeBytes),
});

const avdNameFor = (id, base = 'dsh_apk') => `${base}_${id}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

/** Pre-create a fake AVD so create() skips avdmanager and only patches config.ini. */
function prepareAvd(avdName, { ramSizeMb = 1536, cores = 4 } = {}) {
  writeFileSync(
    path.join(AVD_HOME, `${avdName}.ini`),
    `avd.ini.encoding=UTF-8\npath=${path.join(AVD_HOME, `${avdName}.avd`)}\n`,
  );
  const dir = path.join(AVD_HOME, `${avdName}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.ini'), `hw.ramSize = ${ramSizeMb}\nhw.cpu.ncore = ${cores}\n`);
}

const readAvdConfig = (avdName) => readFileSync(path.join(AVD_HOME, `${avdName}.avd`, 'config.ini'), 'utf8');

function fakeInstance({
  id,
  owner = null,
  state = 'ready',
  lastUsedAt = Date.now() - 120_000,
  clients = 0,
  installInFlight = false,
  kind,
} = {}) {
  const stream = { clients: new Set(Array.from({ length: clients }, () => ({}))) };
  const instance = {
    id,
    avdName: `${id}.avd`,
    port: 5558,
    kind,
    owner,
    lastUsedAt,
    installInFlight,
    frame: { buffer: null, at: 0, inFlight: null },
    vm: { _state: state, _serialActive: 'emulator-5558', serial: 'emulator-5558', _root: true },
    stream,
    snapshotApk: () => null,
    stop: async () => {
      instance.vm._state = 'stopped';
      instance.stopped = true;
    },
  };
  if (!kind) delete instance.kind;
  return instance;
}

const cleanupInstance = (manager, instance) => {
  manager.instances.delete(instance.id);
};

// ---------------------------------------------------------------------------
// Legacy lifecycle behaviour (idle reaping) must be preserved.
// ---------------------------------------------------------------------------
check('agent assignment: first Agent gets the default VM', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
  });
  const first = await manager.forAgent('agent-a');
  assert.equal(first.id, 'default');
  assert.equal(first.default, true);
  assert.equal(manager.defaultOwner, 'agent-a');
});

check('list() keeps its legacy fields (owner/idle/videoClients)', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
  });
  await manager.forAgent('agent-a');
  const fake = fakeInstance({ id: 'idle-one', owner: 'agent-b', lastUsedAt: Date.now() - 120_000 });
  manager.instances.set(fake.id, fake);

  const listed = manager.list().find((entry) => entry.id === fake.id);
  assert.ok(listed);
  assert.equal(listed.owner, 'agent-b');
  assert.equal(listed.idleTimeoutMs, 60_000);
  assert.ok(listed.idleMs >= 60_000);
  assert.equal(listed.kind, 'extra');
  assert.equal(listed.videoClients, 0);
});

check('reapIdle(): active clients and recent use prevent idling out; old idle VM stops', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
  });
  await manager.forAgent('agent-a');
  const fake = fakeInstance({ id: 'idle-one', owner: 'agent-b', lastUsedAt: Date.now() - 120_000 });
  manager.instances.set(fake.id, fake);

  // Active stream clients and recent use must prevent reaping.
  fake.stream.clients.add({});
  assert.equal((await manager.reapIdle()).length, 0);
  fake.stream.clients.clear();
  fake.lastUsedAt = Date.now();
  assert.equal((await manager.reapIdle()).length, 0);

  // Old, idle instance is stopped.
  fake.lastUsedAt = Date.now() - 120_000;
  const reaped = await manager.reapIdle();
  assert.deepEqual(reaped.map((entry) => entry.id), ['idle-one']);
  assert.equal(fake.stopped, true);

  // A stopped instance is not reaped again.
  fake.vm._state = 'stopped';
  fake.stopped = false;
  assert.equal((await manager.reapIdle()).length, 0);
});

// ---------------------------------------------------------------------------
// memory(): shape, profile, effective cap, unknown host.
// ---------------------------------------------------------------------------
check('memory() reports host bytes, profile, cap and guard flags (16 GiB host)', () => {
  const manager = new InstanceManager({
    maxInstances: 3,
    vmPreset: 'lite',
    memoryProvider: providerFor(16 * GIB, 8 * GIB),
  });
  const info = manager.memory();
  assert.equal(info.ok, true);
  assert.deepEqual(info.host, {
    totalBytes: 16 * GIB,
    totalMb: 16384,
    freeBytes: 8 * GIB,
    freeMb: 8192,
  });
  assert.deepEqual(info.profile, {
    name: 'lite',
    ramSizeMb: 1024,
    cores: 2,
    gpuMode: 'swiftshader_indirect',
    frameFps: 1,
    scrcpyMaxSize: 720,
    scrcpyMaxFps: 30,
  });
  assert.equal(info.requestedMaxInstances, 3);
  // Formula value: floor((16-4)/3) = 4 -> capped by requested=3 (brief said 2).
  assert.equal(info.effectiveMaxInstances, 3);
  assert.equal(info.limited, false);
  assert.equal(info.runningInstances, 0);
  assert.equal(info.guard, true);
  assert.equal(info.pressureReap, true);
});

check('memory() reports the standard profile by default (no AVD changes)', () => {
  const manager = new InstanceManager({ maxInstances: 2, memoryProvider: providerFor(64 * GIB, 48 * GIB) });
  const info = manager.memory();
  assert.deepEqual(info.profile, {
    name: 'standard',
    ramSizeMb: null,
    cores: null,
    gpuMode: null,
    frameFps: null,
    scrcpyMaxSize: null,
    scrcpyMaxFps: null,
  });
  assert.equal(info.requestedMaxInstances, 2);
  assert.equal(info.effectiveMaxInstances, 2);
});

check('memory() survives unknown host memory (ok:false, rest still populated)', () => {
  const manager = new InstanceManager({
    maxInstances: 3,
    memoryProvider: { hostMemoryInfo: () => ({ ok: false, error: 'probe failed' }) },
  });
  const info = manager.memory();
  assert.equal(info.ok, false);
  assert.equal(info.host, null);
  assert.equal(info.error, 'probe failed');
  assert.equal(info.effectiveMaxInstances, 3);
  assert.equal(info.limited, false);
  assert.equal(info.profile.name, 'standard');
});

check('memory() counts local instances only (remote sessions excluded)', () => {
  const manager = new InstanceManager({ maxInstances: 3, memoryProvider: providerFor(64 * GIB, 48 * GIB) });
  const local = fakeInstance({ id: 'local-1' });
  const remote = fakeInstance({ id: 'remote-1', kind: 'remote', state: 'ready' });
  manager.instances.set(local.id, local);
  manager.instances.set(remote.id, remote);
  assert.equal(manager.memory().runningInstances, 1);
  const listed = manager.list();
  const remoteEntry = listed.find((entry) => entry.id === 'remote-1');
  assert.ok(remoteEntry);
  assert.equal(remoteEntry.kind, 'remote');
  assert.equal(remoteEntry.ramSizeMb, null);
  assert.equal(remoteEntry.cores, null);
  assert.equal(remoteEntry.profileName, null);
});

check('memory() honours hostReserveMb / estimatedVmMb overrides', () => {
  const manager = new InstanceManager({
    maxInstances: 3,
    hostReserveMb: 8192,
    estimatedVmMb: 4096,
    memoryProvider: providerFor(16 * GIB, 8 * GIB),
  });
  const info = manager.memory();
  assert.equal(info.effectiveMaxInstances, 2); // floor((16384-8192)/4096) = 2
  assert.equal(info.limited, true);
});

check('invalid vmPreset falls back to standard with a logged warning (never throws)', () => {
  const warnings = [];
  const manager = new InstanceManager({
    vmPreset: 'turbo',
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
    log: (line) => warnings.push(line),
  });
  assert.equal(manager.vmProfile.name, 'standard');
  assert.equal(manager.memory().profile.name, 'standard');
  assert.ok(warnings.some((line) => /invalid vmPreset/.test(line)), 'expected a warning log line');
});

// ---------------------------------------------------------------------------
// create(): memory guard + explicit override.
// ---------------------------------------------------------------------------
check('create() throws the host memory guard when the effective cap is full', async () => {
  const manager = new InstanceManager({
    maxInstances: 3,
    memoryProvider: providerFor(8 * GIB, 4 * GIB), // effective cap = 1
  });
  const fake = fakeInstance({ id: 'local-1' });
  manager.instances.set(fake.id, fake);
  await assert.rejects(
    manager.create({ name: 'blocked' }),
    (error) => /host memory guard:/.test(error.message) && /at most 1/.test(error.message) && /memoryOverride:true/.test(error.message),
  );
});

check('create() throws the host memory guard when free memory is too low', async () => {
  const manager = new InstanceManager({
    maxInstances: 2,
    memoryProvider: providerFor(64 * GIB, 2 * GIB), // plenty of total, almost no free RAM
  });
  await assert.rejects(
    manager.create({ name: 'lowmem' }),
    (error) => /host memory guard: not enough free host memory/.test(error.message) && /memoryOverride:true/.test(error.message),
  );
});

check('memoryOverride:true bypasses the guard, legacy maxInstances check still applies', async () => {
  const manager = new InstanceManager({
    maxInstances: 1,
    memoryProvider: providerFor(8 * GIB, 4 * GIB),
  });
  const fake = fakeInstance({ id: 'local-1' });
  manager.instances.set(fake.id, fake);
  await assert.rejects(manager.create({ name: 'forced' }), /host memory guard:/);
  await assert.rejects(manager.create({ name: 'forced', memoryOverride: true }), /max instances reached/);
});

check('memoryOverride:true really creates past a guard that would otherwise block (fake AVD)', async () => {
  const manager = new InstanceManager({
    maxInstances: 2,
    memoryProvider: providerFor(8 * GIB, 4 * GIB), // effective cap = 1
  });
  const fake = fakeInstance({ id: 'local-1' });
  manager.instances.set(fake.id, fake);
  prepareAvd(avdNameFor('override-vm'));
  const instance = await manager.create({ name: 'override-vm', memoryOverride: true });
  try {
    assert.equal(manager.instances.size, 2);
    assert.equal(instance.vmProfile.name, 'standard');
    const listed = manager.list().find((entry) => entry.id === 'override-vm');
    assert.equal(listed.ramSizeMb, null);
    assert.equal(listed.profileName, 'standard');
  } finally {
    cleanupInstance(manager, instance);
  }
});

check('memoryGuard:false disables the guard entirely (fake AVDs)', async () => {
  const manager = new InstanceManager({
    maxInstances: 3,
    memoryGuard: false,
    memoryProvider: providerFor(8 * GIB, 4 * GIB), // effective cap = 1, but guard off
  });
  prepareAvd(avdNameFor('noguard-a'));
  prepareAvd(avdNameFor('noguard-b'));
  const first = await manager.create({ name: 'noguard-a' });
  const second = await manager.create({ name: 'noguard-b' });
  try {
    assert.equal(manager.instances.size, 2);
    assert.equal(manager.memory().guard, false);
  } finally {
    cleanupInstance(manager, first);
    cleanupInstance(manager, second);
  }
});

check('unknown host memory does not block create() (conservative)', async () => {
  const manager = new InstanceManager({
    maxInstances: 2,
    memoryProvider: { hostMemoryInfo: () => ({ ok: false, error: 'no probe' }) },
  });
  prepareAvd(avdNameFor('unknown-host'));
  const instance = await manager.create({ name: 'unknown-host' });
  try {
    assert.equal(instance.vmProfile.name, 'standard');
  } finally {
    cleanupInstance(manager, instance);
  }
});

// ---------------------------------------------------------------------------
// patchAvdConfig: lite writes RAM/cores, standard leaves the AVD untouched.
// ---------------------------------------------------------------------------
check('patchAvdConfig(profile): writes hw.ramSize/hw.cpu.ncore for a lite profile', async () => {
  await patchAvdConfig('patch-lite', { name: 'lite', ramSizeMb: 1024, cores: 2 });
  const text = readAvdConfig('patch-lite');
  assert.match(text, /^hw\.ramSize = 1024M$/m);
  assert.match(text, /^hw\.cpu\.ncore = 2$/m);
  assert.match(text, /^hw\.lcd\.width = 720$/m);
  assert.match(text, /^fastboot\.forceFastBoot = yes$/m);
});

check('patchAvdConfig(null): legacy behaviour, existing RAM/cores stay untouched', async () => {
  prepareAvd('patch-standard', { ramSizeMb: 1536, cores: 4 });
  await patchAvdConfig('patch-standard');
  const text = readAvdConfig('patch-standard');
  assert.match(text, /^hw\.ramSize = 1536$/m);
  assert.match(text, /^hw\.cpu\.ncore = 4$/m);
  assert.equal(/^hw\.ramSize\s*=\s*1024M$/m.test(text), false);
});

check('patchAvdConfig(standard profile): also leaves RAM/cores untouched', async () => {
  prepareAvd('patch-standard-2', { ramSizeMb: 1536, cores: 4 });
  await patchAvdConfig('patch-standard-2', {
    name: 'standard',
    ramSizeMb: null,
    cores: null,
    gpuMode: null,
    frameFps: null,
    scrcpyMaxSize: null,
    scrcpyMaxFps: null,
  });
  const text = readAvdConfig('patch-standard-2');
  assert.match(text, /^hw\.ramSize = 1536$/m);
  assert.match(text, /^hw\.cpu\.ncore = 4$/m);
});

// ---------------------------------------------------------------------------
// Lite profile is applied end-to-end by create() (fake AVD, no emulator).
// ---------------------------------------------------------------------------
check('create(vmPreset:"lite"): AVD config + instance profile + list/status fields', async () => {
  const manager = new InstanceManager({
    maxInstances: 2,
    vmPreset: 'lite',
    gpuMode: 'host',
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
  });
  const avdName = avdNameFor('lite-vm');
  prepareAvd(avdName, { ramSizeMb: 1536, cores: 4 });
  const instance = await manager.create({ name: 'lite-vm' });
  try {
    assert.equal(instance.vmProfile.name, 'lite');
    assert.equal(instance.vmProfile.ramSizeMb, 1024);
    assert.equal(instance.vmProfile.cores, 2);
    // gpuMode from the profile wins over the manager's "host" option.
    assert.equal(instance.vm.gpuMode, 'swiftshader_indirect');

    const text = readAvdConfig(avdName);
    assert.match(text, /^hw\.ramSize = 1024M$/m);
    assert.match(text, /^hw\.cpu\.ncore = 2$/m);

    const listed = manager.list().find((entry) => entry.id === 'lite-vm');
    assert.equal(listed.ramSizeMb, 1024);
    assert.equal(listed.cores, 2);
    assert.equal(listed.profileName, 'lite');

    // status() delegates to vm.status(); stub it so no adb/emulator is touched.
    instance.vm.status = async () => ({ state: 'stopped' });
    const status = await instance.status();
    assert.equal(status.ramSizeMb, 1024);
    assert.equal(status.cores, 2);
    assert.equal(status.profileName, 'lite');
  } finally {
    cleanupInstance(manager, instance);
  }
});

check('create(standard default): AVD config untouched and profile fields null', async () => {
  const manager = new InstanceManager({
    maxInstances: 2,
    memoryProvider: providerFor(64 * GIB, 48 * GIB),
  });
  const avdName = avdNameFor('standard-vm');
  prepareAvd(avdName, { ramSizeMb: 1536, cores: 4 });
  const instance = await manager.create({ name: 'standard-vm' });
  try {
    assert.equal(instance.vmProfile.name, 'standard');
    const text = readAvdConfig(avdName);
    assert.match(text, /^hw\.ramSize = 1536$/m);
    assert.match(text, /^hw\.cpu\.ncore = 4$/m);
    // lib/android.js falls back from "host" GPU to the software renderer on
    // headless Linux (CI runners have neither DISPLAY nor WAYLAND_DISPLAY).
    const headlessLinux =
      process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    assert.equal(instance.vm.gpuMode, headlessLinux ? 'swiftshader_indirect' : 'host');

    const listed = manager.list().find((entry) => entry.id === 'standard-vm');
    assert.equal(listed.ramSizeMb, null);
    assert.equal(listed.cores, null);
    assert.equal(listed.profileName, 'standard');
  } finally {
    cleanupInstance(manager, instance);
  }
});

// ---------------------------------------------------------------------------
// Memory-pressure reaping.
// ---------------------------------------------------------------------------
check('pickMemoryPressureVictim: picks the oldest eligible local VM', () => {
  const remote = fakeInstance({ id: 'remote-oldest', kind: 'remote', lastUsedAt: 1 });
  const busy = fakeInstance({ id: 'busy-clients', lastUsedAt: 2, clients: 1 });
  const owned = fakeInstance({ id: 'owned', lastUsedAt: 3, owner: 'agent-a' });
  const installing = fakeInstance({ id: 'installing', lastUsedAt: 4, installInFlight: {} });
  const stopped = fakeInstance({ id: 'stopped', lastUsedAt: 5, state: 'stopped' });
  const booting = fakeInstance({ id: 'booting', lastUsedAt: 200, state: 'booting' });
  const readyOld = fakeInstance({ id: 'ready-old', lastUsedAt: 100, state: 'ready' });
  const readyNew = fakeInstance({ id: 'ready-new', lastUsedAt: 300, state: 'ready' });

  const list = [remote, busy, owned, installing, stopped, booting, readyOld, readyNew];
  assert.equal(pickMemoryPressureVictim(list)?.id, 'ready-old');
  // Works with a Map too.
  assert.equal(pickMemoryPressureVictim(new Map(list.map((instance) => [instance.id, instance])))?.id, 'ready-old');
});

check('pickMemoryPressureVictim: returns null when nobody is eligible', () => {
  const list = [
    fakeInstance({ id: 'remote', kind: 'remote' }),
    fakeInstance({ id: 'clients', clients: 1 }),
    fakeInstance({ id: 'owned', owner: 'agent-a' }),
    fakeInstance({ id: 'installing', installInFlight: {} }),
    fakeInstance({ id: 'stopped', state: 'stopped' }),
  ];
  assert.equal(pickMemoryPressureVictim(list), null);
  assert.equal(pickMemoryPressureVictim([]), null);
  assert.equal(pickMemoryPressureVictim(null), null);
});

check('reapIdle(): low free memory stops one idle local VM per tick (oldest first)', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryPressureReap: true,
    memoryProvider: providerFor(16 * GIB, 2 * GIB), // canStartInstance -> false
  });
  const now = Date.now();
  const older = fakeInstance({ id: 'older', lastUsedAt: now - 20_000 });
  const newer = fakeInstance({ id: 'newer', lastUsedAt: now - 10_000 });
  manager.instances.set(older.id, older);
  manager.instances.set(newer.id, newer);

  const first = await manager.reapIdle(now);
  assert.deepEqual(first.map((entry) => entry.id), ['older']);
  assert.equal(first[0].reason, 'memory-pressure');
  assert.equal(older.stopped, true);
  assert.equal(newer.stopped, undefined);

  const second = await manager.reapIdle(now);
  assert.deepEqual(second.map((entry) => entry.id), ['newer']);

  const third = await manager.reapIdle(now);
  assert.deepEqual(third, []);
});

check('reapIdle(): memoryPressureReap:false leaves idle VMs alone under pressure', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryPressureReap: false,
    memoryProvider: providerFor(16 * GIB, 2 * GIB),
  });
  const now = Date.now();
  const victim = fakeInstance({ id: 'victim', lastUsedAt: now - 10_000 });
  manager.instances.set(victim.id, victim);
  assert.deepEqual(await manager.reapIdle(now), []);
  assert.equal(victim.stopped, undefined);
  assert.equal(manager.memory().pressureReap, false);
});

check('reapIdle(): leased/owned instances are never memory-pressure reaped', async () => {
  const manager = new InstanceManager({
    idleTimeoutMs: 60_000,
    maxInstances: 3,
    memoryPressureReap: true,
    memoryProvider: providerFor(16 * GIB, 2 * GIB),
  });
  const now = Date.now();
  const owned = fakeInstance({ id: 'owned-live', lastUsedAt: now - 10_000, owner: 'agent-a' });
  manager.instances.set(owned.id, owned);
  // A live lease (or even just the instance.owner marker) must block reaping.
  try {
    manager.claimOwner(owned.id, manager.ownerFor({ key: 'agent-a', label: 'agent-a' }), { force: true });
  } catch {
    /* the instance.owner marker alone is enough for pickMemoryPressureVictim */
  }
  assert.equal(owned.owner, 'agent-a');
  assert.deepEqual(await manager.reapIdle(now), []);
});

// ---------------------------------------------------------------------------
async function runChecks() {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (error) {
      console.error(`  not ok - ${name}: ${error && error.stack ? error.stack : error}`);
      throw error;
    }
  }
  return passed;
}

let passed = 0;
try {
  passed = await runChecks();
  console.log(`\ninstances-smoke: ${passed}/${checks.length} checks passed`);
} finally {
  rmSync(AVD_HOME, { recursive: true, force: true });
}
