// Shared-resident default VM policy: suspend after idle, mark stopped after a
// longer idle, never delete anything, and resume on activity.
//
// The real AndroidVm is replaced by a tiny fake so the policy can be tested
// without an emulator: the manager only reads `_state` and calls
// `suspend()` / `markSuspendedStopped()`.

import { InstanceManager } from '../lib/instances.js';

let checks = 0;
const failures = [];

function ok(condition, label) {
  checks += 1;
  if (!condition) failures.push(label);
}

function eq(actual, expected, label) {
  checks += 1;
  if (!Object.is(actual, expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeVm() {
  const calls = [];
  const vm = {
    _state: 'ready',
    calls,
    async suspend(reason) {
      calls.push(['suspend', reason]);
      vm._state = 'suspended';
      return true;
    },
    markSuspendedStopped(reason) {
      calls.push(['markSuspendedStopped', reason]);
      vm._state = 'stopped';
      return true;
    },
  };
  return vm;
}

function makeManager(options = {}) {
  const vm = options.vm || makeVm();
  const manager = new InstanceManager({
    maxInstances: 2,
    leaseTtlMs: 0,
    defaultVm: vm,
    sharedSuspendAfterMs: 60_000,
    sharedStopAfterMs: 120_000,
    ...options,
  });
  return { manager, vm };
}

/* ---- defaults ---------------------------------------------------- */
{
  const { manager } = makeManager({ sharedSuspendAfterMs: undefined, sharedStopAfterMs: undefined });
  eq(manager.sharedResident, true, 'sharedResident defaults to true');
  eq(manager.sharedSuspendAfterMs, 5 * 60_000, 'suspendAfter defaults to 5 minutes');
  eq(manager.sharedStopAfterMs, 60 * 60_000, 'stopAfter defaults to 60 minutes');
}

/* ---- status snapshot --------------------------------------------- */
{
  const now = 1_000_000;
  const { manager } = makeManager();
  manager.noteSharedActivity(now);
  const status = manager.sharedStatus(now);
  ok(status && status.resident === true, 'status reports resident');
  eq(status.state, 'ready', 'status reports default VM state');
  eq(status.idleMs, 0, 'status idle starts at 0');
  eq(status.suspendAfterMs, 60_000, 'status carries suspend threshold');
  eq(status.stopAfterMs, 120_000, 'status carries stop threshold');
  eq(status.nextAction, null, 'no action while idle is short');
  eq(await manager.reconcileShared(now), null, 'reconcile does nothing while idle is short');
}

/* ---- idle -> suspend, activity resets ---------------------------- */
{
  const now = 2_000_000;
  const { manager, vm } = makeManager();
  manager.noteSharedActivity(now - 61_000);
  const status = manager.sharedStatus(now);
  eq(status.nextAction, 'suspend', 'status announces a pending suspend');
  const result = await manager.reconcileShared(now);
  eq(result && result.action, 'suspend', 'reconcile suspends an idle ready VM');
  eq(vm._state, 'suspended', 'fake VM suspended');
  eq(vm.calls.length, 1, 'suspend called once');
  eq(vm.calls[0][1], 'shared-idle', 'suspend reason is shared-idle');
  eq(manager.sharedStatus(now).idleMs, 0, 'suspend resets the idle timer');
  eq(await manager.reconcileShared(now), null, 'no second suspend right away');

  // A tool/panel call wakes it up: the next reconcile must not suspend again.
  const later = now + 10_000;
  manager.noteSharedActivity(later);
  vm._state = 'ready';
  eq(await manager.reconcileShared(later), null, 'activity resets the idle timer');
}

/* ---- suspended + long idle -> stopped ---------------------------- */
{
  const now = 3_000_000;
  const { manager, vm } = makeManager();
  vm._state = 'suspended';
  manager.noteSharedActivity(now - 121_000);
  const result = await manager.reconcileShared(now);
  eq(result && result.action, 'stop', 'reconcile stops a long-suspended VM');
  eq(vm._state, 'stopped', 'fake VM marked stopped');
  eq(vm.calls.length, 1, 'markSuspendedStopped called once');
  eq(vm.calls[0][0], 'markSuspendedStopped', 'stop uses markSuspendedStopped');
  eq(await manager.reconcileShared(now), null, 'stopped VM is left alone');
}

/* ---- disabled / failed suspend ----------------------------------- */
{
  const now = 4_000_000;
  const { manager, vm } = makeManager({ sharedResident: false });
  manager.noteSharedActivity(now - 61_000);
  eq(manager.sharedStatus(now).resident, false, 'disabled status reports non-resident');
  eq(await manager.reconcileShared(now), null, 'disabled policy never suspends');
  eq(vm.calls.length, 0, 'disabled policy never touches the VM');
}

{
  const now = 5_000_000;
  const { manager } = makeManager();
  const vm = manager.defaultVm;
  vm.suspend = async () => false;
  manager.noteSharedActivity(now - 61_000);
  const result = await manager.reconcileShared(now);
  eq(result && result.action, 'suspend-failed', 'failed suspend is reported');
  const retried = await manager.reconcileShared(now);
  eq(retried && retried.action, 'suspend-failed', 'failed state retried on next tick');
}

/* ---- default VM becomes stopped while suspended ------------------ */
{
  const now = 6_000_000;
  const { manager, vm } = makeManager();
  vm._state = 'stopped';
  manager.noteSharedActivity(now - 200_000);
  eq(await manager.reconcileShared(now), null, 'stopped VM is not touched');
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`shared-resident: ${checks - failures.length}/${checks} checks passed`);
  process.exit(1);
}
console.log(`shared-resident: ${checks} checks passed`);
