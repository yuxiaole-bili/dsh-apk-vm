import { AndroidVm } from '../../lib/android.js';

const vm = new AndroidVm({ avdName: 'dsh_apk', emulatorPath: '<android-sdk>\\emulator\\emulator.exe', port: 5558 });

// 1. Hypervisor + snapshot: quick-boot plan, host GPU, no -accel off.
vm._detectAcceleration = async () => true;
vm._snapshotPresent = () => true;
const snap = await vm._buildLaunchPlan();
console.log(
  'snapshot-plan:',
  JSON.stringify({
    bootKind: snap.bootKind,
    accel: snap.accelAvailable,
    gpu: vm.gpuMode,
    hasSnapshotFlag: snap.args.includes('-snapshot'),
    hasAccelOff: snap.args.includes('off'),
    args: snap.args.join(' '),
  }),
);

// 2. No hypervisor + requireAccel: fail fast instead of hanging for half an hour.
vm._snapshotPresent = () => false;
vm._detectAcceleration = async () => false;
const denied = await vm._buildLaunchPlan();
console.log(
  'no-accel-plan:',
  JSON.stringify({
    fatal: Boolean(denied.fatal),
    bootKind: denied.bootKind,
    accel: denied.accelAvailable,
    args: denied.args,
    message: denied.fatal || '',
  }),
);

// 3. Explicitly allowing TCG (requireAccel:false) still emits -accel off.
vm.requireAccel = false;
const tcg = await vm._buildLaunchPlan();
console.log(
  'explicit-tcg-plan:',
  JSON.stringify({
    bootKind: tcg.bootKind,
    accel: tcg.accelAvailable,
    hasAccelOff: tcg.args.includes('off'),
    args: tcg.args.join(' '),
  }),
);

// 4. quickBoot disabled: cold boot with -no-snapshot.
vm.quickBoot = false;
vm.gpuMode = 'swiftshader_indirect';
const noQuick = await vm._buildLaunchPlan();
console.log(
  'no-quickboot-plan:',
  JSON.stringify({
    bootKind: noQuick.bootKind,
    hasNoSnapshot: noQuick.args.includes('-no-snapshot'),
    gpu: vm.gpuMode,
    args: noQuick.args.join(' '),
  }),
);
