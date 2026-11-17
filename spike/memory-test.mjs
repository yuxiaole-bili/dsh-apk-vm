#!/usr/bin/env node
/**
 * Hermetic checks for lib/memory.js (host memory guard + VM hardware presets).
 * No emulator, no real AVD, no dependency on the host's actual RAM: every
 * hostMemoryInfo() call that matters is injected.
 *
 * NOTE on the 16 GB expectation: the task brief mentioned "16GB → 2", but the
 * specified formula max(1, min(requested, floor((total - reserved) / estimate)))
 * with the specified defaults (4 GiB reserve, 3 GiB/VM) gives floor(12/3) = 4,
 * so requested=3 stays 3. The formula + defaults are authoritative here; the
 * discrepancy is reported to the Lead instead of silently bending the API.
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_ESTIMATED_VM_BYTES,
  DEFAULT_HOST_MIN_FREE_BYTES,
  DEFAULT_HOST_RESERVE_BYTES,
  GIB,
  MIB,
  VM_PRESETS,
  canStartInstance,
  effectiveMaxInstances,
  formatMemory,
  hostMemoryInfo,
  resolveVmPreset,
} from '../lib/memory.js';

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

const memory = (totalBytes, freeBytes) => hostMemoryInfo({ totalmem: totalBytes, freemem: freeBytes });

// ---------------------------------------------------------------------------
// Constants + presets
// ---------------------------------------------------------------------------
check('constants match the documented defaults', () => {
  assert.equal(GIB, 1024 ** 3);
  assert.equal(MIB, 1024 ** 2);
  assert.equal(DEFAULT_HOST_RESERVE_BYTES, 4 * GIB);
  assert.equal(DEFAULT_ESTIMATED_VM_BYTES, 3 * GIB);
  assert.equal(DEFAULT_HOST_MIN_FREE_BYTES, 1.5 * GIB);
});

check('VM_PRESETS: standard keeps AVD defaults, lite is the documented profile', () => {
  assert.deepEqual(
    { ...VM_PRESETS.standard },
    { ramSizeMb: null, cores: null, gpuMode: null, frameFps: null, scrcpyMaxSize: null, scrcpyMaxFps: null },
  );
  assert.deepEqual(
    { ...VM_PRESETS.lite },
    { ramSizeMb: 1024, cores: 2, gpuMode: 'swiftshader_indirect', frameFps: 1, scrcpyMaxSize: 720, scrcpyMaxFps: 30 },
  );
  assert.ok(Object.isFrozen(VM_PRESETS.standard) && Object.isFrozen(VM_PRESETS.lite));
});

// ---------------------------------------------------------------------------
// hostMemoryInfo
// ---------------------------------------------------------------------------
check('hostMemoryInfo(8/16/64 GiB) returns ok bytes + rounded MB', () => {
  for (const size of [8 * GIB, 16 * GIB, 64 * GIB]) {
    const info = memory(size, size / 2);
    assert.equal(info.ok, true);
    assert.equal(info.totalBytes, size);
    assert.equal(info.freeBytes, size / 2);
    assert.equal(info.totalMb, size / MIB);
    assert.equal(info.freeMb, size / 2 / MIB);
  }
});

check('hostMemoryInfo reads node:os when nothing is injected', () => {
  const info = hostMemoryInfo();
  assert.equal(info.ok, true);
  assert.ok(info.totalBytes > 0);
  assert.ok(info.freeBytes > 0);
  assert.ok(Number.isFinite(info.totalMb) && Number.isFinite(info.freeMb));
});

check('hostMemoryInfo rejects NaN / negative / zero / non-numeric values', () => {
  // `undefined` means "fall back to node:os" (tested above), so it is not an
  // invalid injected value.
  for (const bad of [NaN, -1, 0, -GIB, 'nope', Infinity]) {
    const info = hostMemoryInfo({ totalmem: bad, freemem: 8 * GIB });
    assert.equal(info.ok, false, `totalmem=${String(bad)} should be rejected`);
    assert.match(info.error, /totalmem/);
  }
  const badFree = hostMemoryInfo({ totalmem: 16 * GIB, freemem: NaN });
  assert.equal(badFree.ok, false);
  assert.match(badFree.error, /freemem/);
});

// ---------------------------------------------------------------------------
// effectiveMaxInstances
// ---------------------------------------------------------------------------
check('effectiveMaxInstances: 16 GiB / requested 3 -> 3 by the documented formula', () => {
  const result = effectiveMaxInstances({ requested: 3, hostMemory: memory(16 * GIB, 8 * GIB) });
  assert.equal(result.maxInstances, 3);
  assert.equal(result.requested, 3);
  assert.equal(result.limited, false);
});

check('effectiveMaxInstances: 8 GiB / requested 3 -> 1', () => {
  const result = effectiveMaxInstances({ requested: 3, hostMemory: memory(8 * GIB, 4 * GIB) });
  assert.equal(result.maxInstances, 1);
  assert.equal(result.limited, true);
  assert.match(result.reason, /host memory/);
});

check('effectiveMaxInstances: 64 GiB / requested 3 -> 3', () => {
  assert.equal(effectiveMaxInstances({ requested: 3, hostMemory: memory(64 * GIB, 32 * GIB) }).maxInstances, 3);
});

check('effectiveMaxInstances: requested=1 stays 1 on a huge host', () => {
  assert.equal(effectiveMaxInstances({ requested: 1, hostMemory: memory(64 * GIB, 32 * GIB) }).maxInstances, 1);
});

check('effectiveMaxInstances: 200 GiB / requested 8 clamps to 8', () => {
  assert.equal(effectiveMaxInstances({ requested: 8, hostMemory: memory(200 * GIB, 100 * GIB) }).maxInstances, 8);
});

check('effectiveMaxInstances: requested > 8 clamps to 8', () => {
  assert.equal(effectiveMaxInstances({ requested: 100, hostMemory: memory(200 * GIB, 100 * GIB) }).maxInstances, 8);
});

check('effectiveMaxInstances: unknown host memory never blocks', () => {
  const missing = effectiveMaxInstances({ requested: 3 });
  assert.equal(missing.maxInstances, 3);
  assert.equal(missing.requested, 3);
  assert.equal(missing.limited, false);
  assert.equal(missing.reason, 'host memory unknown');

  const broken = effectiveMaxInstances({ requested: 2, hostMemory: { ok: false, error: 'boom' } });
  assert.equal(broken.maxInstances, 2);
  assert.equal(broken.limited, false);
});

check('effectiveMaxInstances: custom reserve/estimate shift the budget', () => {
  const result = effectiveMaxInstances({
    requested: 4,
    hostMemory: memory(16 * GIB, 8 * GIB),
    reservedBytes: 8 * GIB,
    estimatedVmBytes: 4 * GIB,
  });
  assert.equal(result.maxInstances, 2);
  assert.equal(result.limited, true);
});

check('effectiveMaxInstances: tiny host still yields at least 1', () => {
  assert.equal(effectiveMaxInstances({ requested: 3, hostMemory: memory(2 * GIB, 1 * GIB) }).maxInstances, 1);
});

// ---------------------------------------------------------------------------
// canStartInstance
// ---------------------------------------------------------------------------
check('canStartInstance: enough free memory -> ok', () => {
  const result = canStartInstance({ hostMemory: memory(16 * GIB, 8 * GIB) });
  assert.equal(result.ok, true);
  assert.equal(result.freeBytes, 8 * GIB);
  assert.equal(result.requiredBytes, DEFAULT_HOST_RESERVE_BYTES + DEFAULT_ESTIMATED_VM_BYTES);
  assert.match(result.reason, /enough free host memory/);
});

check('canStartInstance: exactly reserved + estimate is ok', () => {
  const free = DEFAULT_HOST_RESERVE_BYTES + DEFAULT_ESTIMATED_VM_BYTES;
  assert.equal(canStartInstance({ hostMemory: memory(16 * GIB, free) }).ok, true);
});

check('canStartInstance: not enough free memory -> not ok with an actionable reason', () => {
  const result = canStartInstance({ hostMemory: memory(16 * GIB, 5 * GIB), runningCount: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.freeBytes, 5 * GIB);
  assert.match(result.reason, /not enough free host memory/);
  assert.match(result.reason, /stop idle instances/);
});

check('canStartInstance: unknown host memory is treated as allowed', () => {
  const result = canStartInstance({});
  assert.equal(result.ok, true);
  assert.equal(result.freeBytes, null);
  assert.equal(result.reason, 'host memory unknown');
});

check('canStartInstance: custom reserve/estimate are honoured', () => {
  assert.equal(canStartInstance({
    hostMemory: memory(16 * GIB, 6 * GIB),
    reservedBytes: 4 * GIB,
    estimatedVmBytes: 2 * GIB,
  }).ok, true);
  assert.equal(canStartInstance({
    hostMemory: memory(16 * GIB, 5 * GIB),
    reservedBytes: 4 * GIB,
    estimatedVmBytes: 2 * GIB,
  }).ok, false);
});

// ---------------------------------------------------------------------------
// resolveVmPreset
// ---------------------------------------------------------------------------
check('resolveVmPreset: default / standard resolve to all-null profile', () => {
  for (const value of [undefined, null, '', 'standard', 'STANDARD']) {
    const profile = resolveVmPreset(value);
    assert.equal(profile.name, 'standard');
    assert.deepEqual(
      { ...profile, name: undefined },
      { name: undefined, ramSizeMb: null, cores: null, gpuMode: null, frameFps: null, scrcpyMaxSize: null, scrcpyMaxFps: null },
    );
  }
});

check('resolveVmPreset: lite returns the documented profile', () => {
  const profile = resolveVmPreset('lite');
  assert.deepEqual(profile, {
    name: 'lite',
    ramSizeMb: 1024,
    cores: 2,
    gpuMode: 'swiftshader_indirect',
    frameFps: 1,
    scrcpyMaxSize: 720,
    scrcpyMaxFps: 30,
  });
});

check('resolveVmPreset: object without name is "custom" and starts from standard', () => {
  const profile = resolveVmPreset({ ramSizeMb: 2048, gpuMode: 'swiftshader_indirect' });
  assert.equal(profile.name, 'custom');
  assert.equal(profile.ramSizeMb, 2048);
  assert.equal(profile.gpuMode, 'swiftshader_indirect');
  assert.equal(profile.cores, null);
  assert.equal(profile.frameFps, null);
});

check('resolveVmPreset: object name is preserved', () => {
  assert.equal(resolveVmPreset({ name: 'my-lite', ramSizeMb: 1536 }).name, 'my-lite');
});

check('resolveVmPreset: overrides win over the named preset', () => {
  const profile = resolveVmPreset('lite', { ramSizeMb: 2048, scrcpyMaxFps: 45 });
  assert.equal(profile.name, 'lite');
  assert.equal(profile.ramSizeMb, 2048);
  assert.equal(profile.scrcpyMaxFps, 45);
  assert.equal(profile.cores, 2);
});

check('resolveVmPreset: null fields are explicit "unchanged" values', () => {
  const profile = resolveVmPreset('lite', { cores: null, gpuMode: null });
  assert.equal(profile.cores, null);
  assert.equal(profile.gpuMode, null);
  assert.equal(profile.ramSizeMb, 1024);
});

check('resolveVmPreset: returns a fresh object (presets stay frozen)', () => {
  const profile = resolveVmPreset('lite');
  profile.ramSizeMb = 4096;
  assert.equal(VM_PRESETS.lite.ramSizeMb, 1024);
  assert.notEqual(resolveVmPreset('lite'), profile);
});

check('resolveVmPreset: invalid fields throw a TypeError naming the field', () => {
  const cases = [
    ['ramSizeMb', 128],
    ['ramSizeMb', 8193],
    ['ramSizeMb', 1024.5],
    ['ramSizeMb', 'big'],
    ['cores', 0],
    ['cores', 17],
    ['frameFps', 0],
    ['frameFps', 11],
    ['scrcpyMaxSize', 320],
    ['scrcpyMaxSize', 2000],
    ['scrcpyMaxFps', 10],
    ['scrcpyMaxFps', 61],
    ['gpuMode', ''],
    ['gpuMode', 42],
  ];
  for (const [field, value] of cases) {
    assert.throws(
      () => resolveVmPreset({ [field]: value }),
      (error) => error instanceof TypeError && error.message.includes(field),
      `${field}=${String(value)} should throw`,
    );
  }
  assert.throws(() => resolveVmPreset('lite', { ramSizeMb: 1 }), (error) => error instanceof TypeError && error.message.includes('ramSizeMb'));
});

check('resolveVmPreset: unknown preset names / bad arguments throw TypeError', () => {
  for (const name of ['strict', 'turbo', 'lite-plus', 5, ['lite']]) {
    assert.throws(() => resolveVmPreset(name), TypeError, `${String(name)} should be rejected`);
  }
  assert.throws(() => resolveVmPreset('standard', 'nope'), TypeError);
});

// ---------------------------------------------------------------------------
// formatMemory
// ---------------------------------------------------------------------------
check('formatMemory: human readable units', () => {
  assert.equal(formatMemory(12.3 * GIB), '12.3 GB');
  assert.equal(formatMemory(12 * GIB), '12 GB');
  assert.equal(formatMemory(64 * GIB), '64 GB');
  assert.equal(formatMemory(1.5 * GIB), '1.5 GB');
  assert.equal(formatMemory(512 * MIB), '512 MB');
  assert.equal(formatMemory(1536 * MIB), '1.5 GB');
  assert.equal(formatMemory(2048), '2 KB');
  assert.equal(formatMemory(0), '0 B');
});

check('formatMemory: invalid input -> n/a', () => {
  for (const bad of [NaN, Infinity, -1, -GIB, 'abc', null, undefined, {}]) {
    assert.equal(formatMemory(bad), 'n/a');
  }
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
      process.exitCode = 1;
      throw error;
    }
  }
  return passed;
}

const passed = await runChecks();
console.log(`\nmemory-test: ${passed}/${checks.length} checks passed`);
process.exitCode = process.exitCode || 0;
