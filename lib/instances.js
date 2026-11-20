/**
 * Multi-instance support for the APK VM plugin.
 *
 * One Host plugin may serve several DSH agents at the same time. Each extra
 * instance owns an independent AVD, emulator port, AndroidVm lifecycle and
 * screenshot cache, so agents cannot collide on installs/input/boot state.
 * The first ("default") instance stays owned by index.js for backwards
 * compatibility; this module manages the additional instances.
 */
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { AndroidVm } from './android.js';
import { InstanceNameBook, sanitizeDisplayName } from './instance-names.js';
import { loadLeaseStore, saveLeaseStore } from './lease-store.js';
import { createAvd, DEFAULT_SYSTEM_IMAGE } from './setup.js';
import { ScrcpyStream } from './video-stream.js';
import {
  DEFAULT_LEASE_TTL_MS,
  OWNER_ROLE,
  OWNER_SCOPE,
  VmLeaseBook,
  createOwner,
  publicOwner,
  normalizeScope,
  shortKey,
} from './vm-ownership.js';
import {
  DEFAULT_ESTIMATED_VM_BYTES,
  DEFAULT_HOST_RESERVE_BYTES,
  VM_PRESETS,
  canStartInstance,
  effectiveMaxInstances,
  formatMemory,
  hostMemoryInfo,
  resolveVmPreset,
} from './memory.js';

const AVD_HOME = process.env.ANDROID_AVD_HOME
  ? String(process.env.ANDROID_AVD_HOME)
  : path.join(os.homedir(), '.android', 'avd');

function sanitizeInstanceId(value, fallback = 'vm') {
  const text = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return text || fallback;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
}

async function pickPort(preferred) {
  for (let offset = 0; offset < 32; offset += 2) {
    const candidate = preferred + offset;
    if (await isPortFree(candidate) && await isPortFree(candidate + 1)) return candidate;
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = 5600 + Math.floor(Math.random() * 400) * 2;
    if (await isPortFree(candidate) && await isPortFree(candidate + 1)) return candidate;
  }
  return preferred;
}

/**
 * Rewrite the per-AVD config.ini so the next boot uses the plugin's preferred
 * fast-boot/display settings, plus the optional VM hardware profile (Lite
 * mode). `profile === null` keeps the historical behaviour byte-for-byte.
 */
export async function patchAvdConfig(avdName, profile = null) {
  const dir = path.join(AVD_HOME, `${avdName}.avd`);
  const file = path.join(dir, 'config.ini');
  await fsp.mkdir(dir, { recursive: true });
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    text = '';
  }
  const desired = {
    'fastboot.forceColdBoot': 'no',
    'fastboot.forceFastBoot': 'yes',
    'fastboot.forceChosenSnapshotBoot': 'no',
    'snapshot.present': 'true',
    // Extra VMs are previews, not full phone benchmarks: match the default
    // 720x1280 display so several encoders stay fast/stable on one GPU.
    'hw.lcd.width': '720',
    'hw.lcd.height': '1280',
    'hw.lcd.density': '320',
  };
  // Lite profile: smaller guest RAM + fewer vCPUs. `null`/undefined fields are
  // deliberately skipped so the AVD's existing (or avdmanager default) values
  // stay untouched.
  if (profile && typeof profile === 'object') {
    const ramSizeMb = Number(profile.ramSizeMb);
    if (Number.isFinite(ramSizeMb) && ramSizeMb > 0) {
      desired['hw.ramSize'] = `${Math.round(ramSizeMb)}M`;
    }
    const cores = Number(profile.cores);
    if (Number.isFinite(cores) && cores > 0) {
      desired['hw.cpu.ncore'] = String(Math.round(cores));
    }
  }
  for (const [key, value] of Object.entries(desired)) {
    const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    if (regex.test(text)) text = text.replace(regex, `${key} = ${value}`);
    else text += `${text && !text.endsWith('\n') ? '\n' : ''}${key} = ${value}\n`;
  }
  await fsp.writeFile(file, text, 'utf8');
}

export class ExtraVmInstance {
  constructor({ id, avdName, port, name, options = {}, log, profile = null }) {
    this.id = id;
    this.avdName = avdName;
    this.name = sanitizeDisplayName(name) || null;
    this.port = port;
    this.logSink = typeof log === 'function' ? log : null;
    this.frame = { buffer: null, at: 0, inFlight: null };
    this.lastApk = null;
    this.installInFlight = null;
    // Hardware profile resolved by InstanceManager (Lite mode). Kept on a
    // dedicated `vmProfile` field: remote instances use `profile` for their SSH
    // profile, so this must never collide with that.
    const requestedProfile = profile && typeof profile === 'object'
      ? profile
      : options && typeof options.profile === 'object'
        ? options.profile
        : null;
    this.vmProfile = requestedProfile || { name: 'standard', ...VM_PRESETS.standard };
    this.vm = new AndroidVm({
      ...options,
      avdName,
      port,
      // Pin this instance to its own emulator console port; otherwise
      // AndroidVm would attach to whichever adb device happens to be online
      // (normally the first/default VM).
      serial: `emulator-${port}`,
      // Lite mode pins a software GPU (standard keeps the plugin option).
      gpuMode: this.vmProfile.gpuMode || options.gpuMode,
      // Media (virtual camera/mic) flags resolved by the plugin at create time;
      // they are stored by AndroidVm and used on every emulator (re)spawn.
      extraEmulatorArgs: options.extraEmulatorArgs,
      enableAudio: options.enableAudio === true,
      log: (line) => this._log(line),
    });
    this.stream = options.scrcpyJarPath
      ? new ScrcpyStream({
          vm: this.vm,
          jarPath: options.scrcpyJarPath,
          maxSize: this.vmProfile.scrcpyMaxSize || options.scrcpyMaxSize || 960,
          bitrate: options.scrcpyBitrate || 6_000_000,
          maxFps: this.vmProfile.scrcpyMaxFps || options.scrcpyMaxFps || 60,
          preferredPort: 27183 + port,
          log: (line) => this._log(line),
        })
      : null;
    this.owner = null;
    this.lastUsedAt = Date.now();
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  _log(line) {
    if (this.logSink) this.logSink(`[${this.id}] ${line}`);
  }

  /** Hardware profile fields shown by status()/list() (null = AVD default). */
  _profileFields() {
    const profile = this.vmProfile || {};
    const ramSizeMb = Number(profile.ramSizeMb);
    const cores = Number(profile.cores);
    return {
      ramSizeMb: Number.isFinite(ramSizeMb) && ramSizeMb > 0 ? Math.round(ramSizeMb) : null,
      cores: Number.isFinite(cores) && cores > 0 ? Math.round(cores) : null,
      profileName: typeof profile.name === 'string' && profile.name ? profile.name : null,
    };
  }

  async status() {
    const status = await this.vm.status();
    return {
      ...status,
      id: this.id,
      avdName: this.avdName,
      name: this.name || this.avdName,
      port: this.port,
      root: status.root === true,
      debugPrepared: status.debugPrepared === true,
      debugToolkit: status.debugToolkit || null,
      identity: status.identity || null,
      ...this._profileFields(),
    };
  }

  async start() {
    this.touch();
    await this.vm.start();
    return this.status();
  }

  async stop() {
    this.touch();
    return this.vm.stop();
  }

  async restart() {
    this.touch();
    await this.vm.stop();
    await this.vm.start();
    return this.status();
  }

  async saveSnapshot(name) {
    this.touch();
    return this.vm.saveSnapshot(name);
  }

  async screenshot() {
    this.touch();
    return this.vm.screenshot();
  }

  /** Cached PNG frame for the panel's extra-instance view. */
  async framePng() {
    this.touch();
    const now = Date.now();
    if (this.frame.buffer && now - this.frame.at < 400) return this.frame.buffer;
    if (!this.frame.inFlight) {
      this.frame.inFlight = (async () => {
        const png = await this.vm.screenshot();
        this.frame.buffer = png;
        this.frame.at = Date.now();
        return png;
      })().finally(() => {
        this.frame.inFlight = null;
      });
    }
    return this.frame.inFlight;
  }

  async installApk(apkPath) {
    this.touch();
    if (this.installInFlight) throw new Error('another APK install is already running on this instance');
    this.installInFlight = (async () => {
      const status = await this.vm.status();
      if (status.state !== 'ready') throw new Error(`VM is not ready (state: ${status.state}); start it first`);
      const meta = await this.vm.installApk(apkPath);
      this.lastApk = {
        path: apkPath,
        packageName: meta.packageName || null,
        label: meta.label || path.basename(apkPath),
        launchActivity: meta.launchActivity || null,
        launched: meta.launched !== false,
        installedAt: Date.now(),
      };
      this.frame.buffer = null;
      this.frame.at = 0;
      void this.vm.saveSnapshot().catch(() => {});
      return { ...this.lastApk };
    })();
    try {
      return await this.installInFlight;
    } finally {
      this.installInFlight = null;
    }
  }

  async input(payload) {
    this.touch();
    return this.vm.input(payload);
  }

  async sendTouch(message) {
    this.touch();
    if (!this.stream) throw new Error('H.264 stream is disabled for this instance');
    await this.stream.ensure();
    return this.stream.sendTouch(message);
  }

  async setClipboard(text, paste = false) {
    this.touch();
    if (!this.stream) throw new Error('H.264 stream is disabled for this instance');
    return this.stream.setClipboard(text, paste);
  }

  async getClipboard() {
    this.touch();
    if (!this.stream) throw new Error('H.264 stream is disabled for this instance');
    return this.stream.getClipboard();
  }

  /** Inject arbitrary UTF-8 text through the scrcpy control stream. */
  async sendText(text) {
    this.touch();
    if (!this.stream) throw new Error('H.264 stream is disabled for this instance');
    const messages = await this.stream.sendText(String(text));
    return { ok: true, chars: String(text).length, messages };
  }

  handleVideoClient(client) {
    this.touch();
    if (!this.stream) {
      client.sendText(JSON.stringify({ type: 'error', error: 'H.264 stream is disabled for this instance' }));
      client.close(1001, 'stream disabled');
      return;
    }
    try {
      this.stream.handleClient(client);
    } catch (error) {
      this._log(`[video] handleClient failed: ${error && error.message ? error.message : error}`);
      client.sendText(JSON.stringify({ type: 'error', error: String(error && error.message ? error.message : error) }));
      client.close(1011, 'stream handler failed');
    }
  }

  videoStatus() {
    return this.stream
      ? this.stream.status()
      : { enabled: false, active: false, clients: 0, fps: 0, maxFps: 0, error: 'scrcpyJarPath not configured' };
  }

  snapshotApk() {
    return this.lastApk ? { ...this.lastApk } : null;
  }

  // Debug surface delegates. Every method is bound so callers can pass the
  // method reference around without losing `this`.
  shell(command, opts) {
    this.touch();
    return this.vm.shell(command, opts);
  }
  logcat(opts) {
    this.touch();
    return this.vm.logcat(opts);
  }
  getprop(name) {
    this.touch();
    return this.vm.getprop(name);
  }
  setprop(name, value) {
    this.touch();
    return this.vm.setprop(name, value);
  }
  listPackages(opts) {
    this.touch();
    return this.vm.listPackages(opts);
  }
  deviceInfo() {
    this.touch();
    return this.vm.deviceInfo();
  }
  ensureRoot() {
    this.touch();
    return this.vm.ensureRoot();
  }
  rotate(orientation) {
    this.touch();
    return this.vm.rotate(orientation);
  }
  uiDump() {
    this.touch();
    return this.vm.uiDump();
  }
  screenRecord(opts) {
    this.touch();
    return this.vm.screenRecord(opts);
  }
  perfSnapshot() {
    this.touch();
    return this.vm.perfSnapshot();
  }
  pushFile(local, remote) {
    this.touch();
    return this.vm.pushFile(local, remote);
  }
  pullFile(remote, local) {
    this.touch();
    return this.vm.pullFile(remote, local);
  }
  reboot(mode, options) {
    this.touch();
    return this.vm.reboot(mode, options);
  }
  forceStop(pkg) {
    this.touch();
    return this.vm.forceStop(pkg);
  }
  clearData(pkg) {
    this.touch();
    return this.vm.clearData(pkg);
  }
  uninstall(pkg) {
    this.touch();
    return this.vm.uninstall(pkg);
  }
  debugStatus() {
    this.touch();
    return this.vm.debugStatus();
  }

  async dispose() {
    try {
      if (this.stream) await this.stream.stop();
    } catch {
      /* best effort */
    }
    try {
      await this.vm.dispose();
    } catch {
      /* best effort */
    }
    this.frame.buffer = null;
    this.lastApk = null;
  }
}

function positiveByteOption(bytesOption, mbOption, fallback) {
  const bytes = Number(bytesOption);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const mb = Number(mbOption);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return fallback;
}

/**
 * Pick the least recently used *idle* local instance that memory-pressure
 * reaping may stop. Pure helper (accepts a Map or an array) so it can be
 * unit-tested without a real manager/emulator.
 *
 * Excluded: remote instances (their SSH session manager owns them), VMs with
 * video clients, installs in flight, an owner/lease, or an in-flight frame.
 */
export function pickMemoryPressureVictim(instances) {
  const list = instances instanceof Map
    ? [...instances.values()]
    : Array.isArray(instances)
      ? instances
      : [];
  let victim = null;
  let victimLastUsedAt = Infinity;
  for (const instance of list) {
    if (!instance || typeof instance !== 'object') continue;
    if ((instance.kind || 'extra') === 'remote') continue;
    const state = instance.vm ? instance.vm._state : instance._state;
    if (state !== 'ready' && state !== 'booting' && state !== 'running') continue;
    if (instance.stream && instance.stream.clients && instance.stream.clients.size > 0) continue;
    if (instance.installInFlight) continue;
    if (instance.owner) continue;
    if (instance.frame && instance.frame.inFlight) continue;
    const lastUsedAt = Number(instance.lastUsedAt);
    if (!Number.isFinite(lastUsedAt)) continue;
    if (lastUsedAt < victimLastUsedAt) {
      victim = instance;
      victimLastUsedAt = lastUsedAt;
    }
  }
  return victim;
}

export class InstanceManager {
  constructor(options = {}) {
    this.options = options;
    this.namesFile = options.namesFile ? String(options.namesFile) : null;
    // Dedicated VMs must survive DSH/plugin restarts: leases are persisted to
    // <profile>/.apk-vm/leases.json (index.js passes the shared data root).
    this.leasesFile = options.leasesFile ? String(options.leasesFile) : null;
    this.names = new InstanceNameBook({ file: this.namesFile });
    this.sdkRoot = options.sdkRoot || null;
    this.emulatorPath = options.emulatorPath || null;
    this.adbPath = options.adbPath || null;
    this.systemImage = options.systemImage || DEFAULT_SYSTEM_IMAGE;
    this.baseAvdName = options.baseAvdName || 'dsh_apk';
    this.maxInstances = Math.max(1, Math.min(8, Number(options.maxInstances) || 3));
    this.gpuMode = options.gpuMode || 'host';
    this.snapshotName = options.snapshotName || 'default_boot';
    this.scrcpyJarPath = options.scrcpyJarPath || null;
    this.scrcpyMaxSize = options.scrcpyMaxSize || 960;
    this.scrcpyBitrate = options.scrcpyBitrate || 6_000_000;
    this.scrcpyMaxFps = options.scrcpyMaxFps || 60;
    this.idleTimeoutMs = Math.max(60_000, Number(options.idleTimeoutMs) || 15 * 60 * 1000);
    // Resident shared default VM: never deleted/released. After
    // `sharedSuspendAfterMs` idle it suspends into a quick-boot snapshot
    // (emulator exits, state `suspended`), after `sharedStopAfterMs` it is
    // marked `stopped` (snapshot + AVD kept). Any tool/panel/stream activity
    // resets the idle timer and a later start resumes on demand.
    this.defaultVm = options.defaultVm || null;
    this.sharedResident = options.sharedResident !== false;
    this.sharedSuspendAfterMs = Math.max(60_000, Number(options.sharedSuspendAfterMs) || 5 * 60 * 1000);
    this.sharedStopAfterMs = Math.max(
      this.sharedSuspendAfterMs,
      Number(options.sharedStopAfterMs) || 60 * 60 * 1000,
    );
    this._sharedLastActivityAt = Date.now();
    this.dnsServers = Array.isArray(options.dnsServers) ? options.dnsServers.map(String) : [];
    this.networkMode = options.networkMode === 'shared' ? 'shared' : 'isolated';
    this.tcpdumpPath = options.tcpdumpPath ? String(options.tcpdumpPath) : null;
    // Optional callback returning the latest media launch options
    // ({extraEmulatorArgs, enableAudio}); resolved for every new instance.
    this.mediaOptionsProvider = typeof options.mediaOptionsProvider === 'function' ? options.mediaOptionsProvider : null;
    this.mediaOptions = null;
    this.logSink = typeof options.log === 'function' ? options.log : null;
    // Host memory guard / Lite mode. Every memory helper is injectable so the
    // spike tests can exercise the guard against synthetic host memory without
    // depending on the machine they run on.
    const memoryProvider = options.memoryProvider && typeof options.memoryProvider === 'object'
      ? options.memoryProvider
      : {};
    this.memoryProvider = {
      hostMemoryInfo: typeof memoryProvider.hostMemoryInfo === 'function' ? memoryProvider.hostMemoryInfo : hostMemoryInfo,
      effectiveMaxInstances: typeof memoryProvider.effectiveMaxInstances === 'function'
        ? memoryProvider.effectiveMaxInstances
        : effectiveMaxInstances,
      canStartInstance: typeof memoryProvider.canStartInstance === 'function' ? memoryProvider.canStartInstance : canStartInstance,
      formatMemory: typeof memoryProvider.formatMemory === 'function' ? memoryProvider.formatMemory : formatMemory,
    };
    this.vmProfile = this._resolveVmProfile(options.vmPreset);
    this.memoryGuard = options.memoryGuard !== false;
    this.memoryPressureReap = options.memoryPressureReap !== false;
    this.hostReserveBytes = positiveByteOption(options.hostReserveBytes, options.hostReserveMb, DEFAULT_HOST_RESERVE_BYTES);
    this.estimatedVmBytes = positiveByteOption(options.estimatedVmBytes, options.estimatedVmMb, DEFAULT_ESTIMATED_VM_BYTES);
    this.instances = new Map();
    this.agentInstances = new Map();
    this.defaultClaimed = false;
    this.defaultOwner = null;
    this.leaseBook = new VmLeaseBook({
      ttlMs: Number(options.leaseTtlMs) > 0 ? Number(options.leaseTtlMs) : DEFAULT_LEASE_TTL_MS,
      ...(Number(options.leaseReservationTtlMs) > 0
        ? { reservationTtlMs: Number(options.leaseReservationTtlMs) }
        : {}),
      onChange: (reason, detail) => this._persistLeases(reason, detail),
    });
    this._restoreLeases();
    this.onCreated = null;
    this._lock = Promise.resolve();
  }

  _log(line) {
    if (this.logSink) this.logSink(line);
  }

  /**
   * Persist the lease book after every claim/release/touch/clear. Best effort:
   * a read-only profile must not break VM control, so failures only log.
   */
  _persistLeases(reason) {
    if (!this.leasesFile) return false;
    try {
      const saved = saveLeaseStore(this.leasesFile, this.leaseBook.snapshot());
      if (!saved) this._log(`[instances] could not persist leases (${reason || 'change'}) to ${this.leasesFile}`);
      return saved;
    } catch (error) {
      this._log(`[instances] failed to persist leases (${reason || 'change'}): ${error && error.message ? error.message : error}`);
      return false;
    }
  }

  /** Restore persisted leases (fresh DSH process / plugin reload). */
  _restoreLeases() {
    if (!this.leasesFile) return 0;
    const entries = loadLeaseStore(this.leasesFile);
    if (entries.length === 0) return 0;
    const restored = this.leaseBook.restore(entries);
    const defaultLease = this.leaseBook.get('default');
    if (defaultLease) {
      this.defaultClaimed = true;
      this.defaultOwner = defaultLease.key;
    }
    if (restored > 0) this._log(`[instances] restored ${restored} lease(s) from ${this.leasesFile}`);
    return restored;
  }

  /**
   * Whether the AVD for an extra instance still exists on disk. A persisted
   * lease for a deleted AVD is stale and must not recreate the instance
   * (see forOwner): cleanup of an orphan AVD must stay cleaned up.
   */
  _extraAvdExists(instanceId) {
    const avdName = `${this.baseAvdName}_${instanceId}`
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 60);
    return existsSync(path.join(AVD_HOME, `${avdName}.ini`));
  }

  /**
   * Resolve the VM hardware profile at construction time. An invalid
   * config value must never take the whole plugin down: fall back to
   * `standard` and record a warning in the log instead of throwing.
   */
  _resolveVmProfile(value) {
    try {
      return resolveVmPreset(value === undefined || value === null || value === '' ? 'standard' : value);
    } catch (error) {
      this._log(`[instances] invalid vmPreset (${error && error.message ? error.message : error}); falling back to "standard"`);
      return resolveVmPreset('standard');
    }
  }

  /** Local (non-remote) instances only: remotes never count against host memory. */
  _localInstances() {
    return [...this.instances.values()].filter((instance) => (instance.kind || 'extra') !== 'remote');
  }

  /**
   * Host memory + effective instance cap + resolved profile. Shown by the panel
   * state route and the emulator inventory; `ok:false` means the host memory
   * could not be read (the rest of the shape is still populated).
   */
  memory() {
    const hostInfo = this.memoryProvider.hostMemoryInfo();
    const hostKnown = Boolean(hostInfo && hostInfo.ok === true);
    const localInstances = this._localInstances();
    const effective = this.memoryProvider.effectiveMaxInstances({
      requested: this.maxInstances,
      hostMemory: hostInfo,
      reservedBytes: this.hostReserveBytes,
      estimatedVmBytes: this.estimatedVmBytes,
    });
    const requestedMaxInstances = this.maxInstances;
    const effectiveMax = effective && Number.isFinite(Number(effective.maxInstances))
      ? Number(effective.maxInstances)
      : requestedMaxInstances;
    const profile = this.vmProfile || { name: 'standard', ...VM_PRESETS.standard };
    const result = {
      ok: hostKnown,
      host: hostKnown
        ? {
            totalBytes: hostInfo.totalBytes,
            totalMb: hostInfo.totalMb,
            freeBytes: hostInfo.freeBytes,
            freeMb: hostInfo.freeMb,
          }
        : null,
      profile: {
        name: profile.name || 'standard',
        ramSizeMb: profile.ramSizeMb ?? null,
        cores: profile.cores ?? null,
        gpuMode: profile.gpuMode ?? null,
        frameFps: profile.frameFps ?? null,
        scrcpyMaxSize: profile.scrcpyMaxSize ?? null,
        scrcpyMaxFps: profile.scrcpyMaxFps ?? null,
      },
      requestedMaxInstances,
      effectiveMaxInstances: effectiveMax,
      limited: Boolean(effective && effective.limited),
      runningInstances: localInstances.length,
      guard: this.memoryGuard,
      pressureReap: this.memoryPressureReap,
    };
    if (!hostKnown) {
      result.error = (hostInfo && hostInfo.error) || 'host memory unknown';
    } else if (effective && effective.reason) {
      result.reason = effective.reason;
    }
    return result;
  }

  /** Server-side memory guard for create(): returns an Error message or null. */
  _memoryGuardError(memoryOverride) {
    if (!this.memoryGuard || memoryOverride === true) return null;
    const hostInfo = this.memoryProvider.hostMemoryInfo();
    if (!hostInfo || hostInfo.ok !== true) return null;
    const localCount = this._localInstances().length;
    const effective = this.memoryProvider.effectiveMaxInstances({
      requested: this.maxInstances,
      hostMemory: hostInfo,
      reservedBytes: this.hostReserveBytes,
      estimatedVmBytes: this.estimatedVmBytes,
    });
    const effectiveMax = effective && Number(effective.maxInstances);
    if (Number.isFinite(effectiveMax) && localCount >= effectiveMax) {
      const budget = effective.reason
        || `host total ${this.memoryProvider.formatMemory(hostInfo.totalBytes)}, reserved ${this.memoryProvider.formatMemory(this.hostReserveBytes)}, ${this.memoryProvider.formatMemory(this.estimatedVmBytes)} per VM`;
      return `host memory guard: ${localCount} local instance(s) already exist and host memory allows at most ${effectiveMax} (${budget}); close idle instances, adjust hostReserveMb/estimatedVmMb, set memoryGuard:false, or pass memoryOverride:true to bypass this check`;
    }
    const canStart = this.memoryProvider.canStartInstance({
      hostMemory: hostInfo,
      runningCount: localCount,
      reservedBytes: this.hostReserveBytes,
      estimatedVmBytes: this.estimatedVmBytes,
    });
    if (canStart && canStart.ok === false) {
      const budget = `host total ${this.memoryProvider.formatMemory(hostInfo.totalBytes)}, reserved ${this.memoryProvider.formatMemory(this.hostReserveBytes)}, ${this.memoryProvider.formatMemory(this.estimatedVmBytes)} per VM`;
      return `host memory guard: not enough free host memory to start another VM (${canStart.reason || budget}); close idle instances, adjust hostReserveMb/estimatedVmMb, set memoryGuard:false, or pass memoryOverride:true to bypass this check`;
    }
    return null;
  }

  list() {
    return [...this.instances.values()].map((instance) => {
      const lease = this.leaseBook.get(instance.id);
      const profile = typeof instance._profileFields === 'function'
        ? instance._profileFields()
        : { ramSizeMb: null, cores: null, profileName: null };
      return {
        id: instance.id,
        avdName: instance.avdName,
        name: this.nameFor(instance.id, instance.avdName),
        port: instance.port,
        kind: instance.kind || 'extra',
        state: instance.vm._state || 'stopped',
        serial: instance.vm._serialActive || instance.vm.serial || null,
        root: instance.vm._root === true,
        apk: instance.snapshotApk(),
        owner: instance.owner || (lease ? lease.key : null),
        ownerInfo: lease ? publicOwner(lease) : null,
        ownerLabel: lease ? lease.label : null,
        scope: lease ? lease.scope : null,
        lastUsedAt: instance.lastUsedAt,
        idleMs: Math.max(0, Date.now() - instance.lastUsedAt),
        idleTimeoutMs: this.idleTimeoutMs,
        videoClients: instance.stream ? instance.stream.clients.size : 0,
        ...profile,
      };
    });
  }

  summaries() {
    return this.list();
  }

  /** Preferred display name for an instance id (custom name or fallback). */
  nameFor(id, fallback = null) {
    return this.names.get(id) || sanitizeDisplayName(fallback) || String(id || '');
  }

  /** Rename an instance (or the externally-owned default VM). */
  async rename(id, name) {
    const target = String(id || '').trim();
    if (!target) return { ok: false, error: 'rename requires an instance id' };
    const clean = sanitizeDisplayName(name);
    if (!clean) return { ok: false, error: 'rename requires a non-empty name' };
    if (target !== 'default' && !this.instances.has(target)) {
      return { ok: false, error: `unknown instance: ${target}` };
    }
    const instance = this.instances.get(target);
    const previous = instance ? instance.name || instance.avdName : this.names.get(target) || null;
    const saved = await this.names.set(target, clean);
    if (!saved.ok) return saved;
    if (instance) instance.name = clean;
    return { ok: true, id: target, name: clean, previous };
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  get size() {
    return this.instances.size;
  }

  /** Public lease for any VM id, including the externally-owned default VM. */
  ownerInfo(id = 'default') {
    const lease = this.leaseBook.get(id);
    if (!lease && String(id) === 'default' && this.defaultOwner) {
      // The lease expired (or was force-released) without a new claim: clear
      // the legacy fields so status/UI do not report a stale owner.
      this.defaultClaimed = false;
      this.defaultOwner = null;
    }
    return lease ? publicOwner(lease) : null;
  }

  ownerList() {
    return this.leaseBook.list();
  }

  /** Return a public owner descriptor from loose tool/route arguments. */
  ownerFor({ key, scope, sessionId, workspace, label, role = OWNER_ROLE.USER, source = 'tool' } = {}) {
    return createOwner({
      key,
      scope: normalizeScope(scope || OWNER_SCOPE.SHARED),
      sessionId,
      workspace,
      label,
      role,
      source,
    });
  }

  /**
   * Claim a VM for an owner without ever silently taking another owner's VM.
   * `force` is explicit takeover; normal paths throw VmLeaseConflict (409).
   */
  claimOwner(id, owner, { force = false, touchInstance = true } = {}) {
    const instanceId = String(id || 'default');
    const normalized = createOwner(owner || {});
    const result = this.leaseBook.claim(instanceId, normalized, { force });
    if (touchInstance) {
      if (instanceId === 'default') {
        this.defaultClaimed = true;
        this.defaultOwner = normalized.key;
      } else {
        const instance = this.instances.get(instanceId);
        if (instance) {
          instance.owner = normalized.key;
          instance.touch();
        }
      }
    }
    // Keep the agent mapping in sync with the lease: an explicit claim (tool,
    // HTTP or panel) must redirect later implicit tool calls to the claimed VM,
    // both for the owner key itself and for the other scope of the same
    // session (a conversation/project claim is also that session's VM).
    const mappedId = instanceId === 'default' ? 'default' : instanceId;
    this.agentInstances.set(normalized.key, mappedId);
    if (normalized.sessionId) {
      this.agentInstances.set(`session:${normalized.sessionId}`, mappedId);
      this.agentInstances.set(`shared:${normalized.sessionId}`, mappedId);
    }
    return result;
  }

  releaseOwner(id, ownerOrKey = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const key = ownerOrKey && typeof ownerOrKey === 'object' ? ownerOrKey.key : ownerOrKey;
    const released = this.leaseBook.release(instanceId, key || null, { force });
    if (instanceId === 'default') {
      if (this.defaultOwner === key || force || key === null) {
        this.defaultClaimed = false;
        this.defaultOwner = null;
      }
    } else {
      const instance = this.instances.get(instanceId);
      if (instance) instance.owner = null;
    }
    // A released lease must not keep routing implicit tool calls to the VM.
    for (const [agent, mapped] of this.agentInstances) {
      if (mapped === instanceId) this.agentInstances.delete(agent);
    }
    return released;
  }

  /**
   * Release every VM held by a DSH session. Called when the session is disposed
   * so a closed conversation does not keep the default VM locked.
   */
  releaseBySession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return [];
    const matches = this.leaseBook.list().filter((entry) =>
      entry.sessionId === id ||
      entry.key === `session:${id}` ||
      entry.key === `shared:${id}`
    );
    const released = [];
    for (const entry of matches) {
      try {
        const owner = this.releaseOwner(entry.id, entry.key, { force: true });
        if (owner) released.push({ instanceId: entry.id, owner });
      } catch {
        /* a race with another release must not break session disposal */
      }
    }
    return released;
  }

  /** Update both the instance activity timestamp and its lease heartbeat. */
  touchOwner(id, key = null) {
    const instanceId = String(id || 'default');
    this.leaseBook.touch(instanceId, key);
    if (instanceId === 'default') return;
    const instance = this.instances.get(instanceId);
    if (instance) instance.touch();
  }

  /**
   * Lock a leased VM. While locked, every mutating request from another owner
   * or agent is rejected with 409 `vm-locked` (even admin takeover).
   */
  lockOwner(id, ownerOrKey = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const key = ownerOrKey && typeof ownerOrKey === 'object' ? ownerOrKey.key : ownerOrKey;
    const locked = this.leaseBook.lock(instanceId, key || null, { force });
    if (instanceId !== 'default') {
      const instance = this.instances.get(instanceId);
      if (instance) instance.touch();
    }
    return locked;
  }

  /** Remove a lock. `force` is reserved for the local admin/panel unlock path. */
  unlockOwner(id, ownerOrKey = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const key = ownerOrKey && typeof ownerOrKey === 'object' ? ownerOrKey.key : ownerOrKey;
    return this.leaseBook.unlock(instanceId, key || null, { force });
  }

  _mappedInstance(key) {
    const mapped = this.agentInstances.get(key);
    if (!mapped) return null;
    if (mapped === 'default') return { id: 'default', default: true };
    const instance = this.instances.get(mapped);
    if (instance) return instance;
    this.agentInstances.delete(key);
    return null;
  }

  /**
   * Resolve a VM for a session/project owner:
   * - shared: first owner gets the default VM, later owners get extras;
   * - conversation/project: the owner gets a dedicated extra VM, reusing it
   *   across turns by stable key.
   * The lease is claimed before returning, so callers never receive a VM that
   * they do not own (unless force takeover was explicitly requested).
   */
  async forOwner(owner, { force = false } = {}) {
    const normalized = createOwner(owner || {});
    const key = normalized.key;
    const existing = this._mappedInstance(key);
    if (existing) {
      const id = existing.default ? 'default' : existing.id;
      const current = this.leaseBook.get(id);
      // The same session may hold the lease under its other scope key
      // (conversation/project vs shared). That is not a stale mapping.
      const sameSession = Boolean(
        current &&
          normalized.sessionId &&
          (current.sessionId === normalized.sessionId ||
            current.key === `session:${normalized.sessionId}` ||
            current.key === `shared:${normalized.sessionId}`)
      );
      if (current && current.key !== key && !sameSession) {
        // The mapping is stale (e.g. lease was force-released). Release it and
        // fall through to normal scheduling instead of silently reusing it.
        this.agentInstances.delete(key);
      } else {
        if (current && current.key !== key) {
          // Keep the live lease under its original key; just refresh it.
          this.leaseBook.touch(id, current.key);
        } else {
          this.claimOwner(id, normalized, { force: false });
        }
        return existing;
      }
    }

    // A dedicated (conversation/project) VM must survive restarts: if the
    // persisted lease book still names this owner, reuse the reserved VM
    // instead of handing it to the first session that asks.
    const persisted = this.leaseBook.list().find((entry) => entry.key === key);
    if (persisted) {
      try {
        if (persisted.id === 'default') {
          this.defaultClaimed = true;
          this.defaultOwner = key;
          this.agentInstances.set(key, 'default');
          return { id: 'default', default: true };
        }
        const local = this.instances.get(persisted.id);
        if (local) {
          this.agentInstances.set(key, local.id);
          this.claimOwner(local.id, normalized, { force: true });
          return local;
        }
        // Never resurrect an extra AVD that was deleted (for example by
        // clean_storage --action orphan-avds) just because an old lease was
        // persisted: the reservation is stale, so release it and let normal
        // scheduling decide. Recreating the AVD here would silently consume
        // gigabytes and break the user's cleanup.
        if (!this._extraAvdExists(persisted.id)) {
          throw new Error(`its AVD for ${persisted.id} no longer exists`);
        }
        const adopted = await this.create({ name: persisted.id });
        this.agentInstances.set(key, adopted.id);
        this.claimOwner(adopted.id, normalized, { force: true });
        return adopted;
      } catch (error) {
        this.agentInstances.delete(key);
        try {
          this.releaseOwner(persisted.id, key, { force: true });
        } catch {
          /* a stale reservation must not block scheduling */
        }
        this._log(`[instances] could not restore persisted lease for ${key}: ${error && error.message ? error.message : error}`);
      }
    }

    // The first owner (any scope) may claim an unleased default VM; the lease
    // makes it exclusive, so another session/project gets an isolated extra VM.
    // Only the live lease matters: an expired lease must not keep the default
    // VM artificially "claimed" forever.
    if (!this.leaseBook.get('default')) {
      this.defaultClaimed = true;
      this.defaultOwner = key;
      this.agentInstances.set(key, 'default');
      this.claimOwner('default', normalized);
      return { id: 'default', default: true };
    }

    const prefix = normalized.scope === OWNER_SCOPE.CONVERSATION
      ? 'conv'
      : normalized.scope === OWNER_SCOPE.PROJECT
        ? 'proj'
        : 'agent';
    const instance = await this.create({ name: `${prefix}-${shortKey(key, 18).replace(/[^A-Za-z0-9._-]+/g, '-')}` });
    this.agentInstances.set(key, instance.id);
    try {
      this.claimOwner(instance.id, normalized, { force });
    } catch (error) {
      // Do not leave an unowned (or worse, conflicting) VM behind.
      this.agentInstances.delete(key);
      await this.destroy(instance.id).catch(() => {});
      throw error;
    }
    return instance;
  }

  /**
   * Resolve the instance an Agent should use. The first Agent gets the default
   * VM; later Agents get an isolated instance (created on demand) until
   * `maxInstances` is full.
   */
  async forAgent(agentKey) {
    const key = String(agentKey || 'anonymous');
    return this.forOwner(createOwner({
      key,
      scope: OWNER_SCOPE.SHARED,
      label: key,
      source: 'agent',
    }));
  }


  async create({ name, memoryOverride = false } = {}) {
    const run = async () => {
      // Host memory guard first: a hard cap from actual host RAM, then the
      // current free-memory check. memoryOverride:true is the explicit escape
      // hatch (e.g. the user knows another VM just exited).
      const guardError = this._memoryGuardError(memoryOverride);
      if (guardError) throw new Error(guardError);
      if (this.instances.size >= this.maxInstances) {
        throw new Error(`max instances reached (${this.maxInstances}); destroy an instance or raise maxInstances`);
      }
      const base = sanitizeInstanceId(name, `vm-${Date.now().toString(36)}`);
      let id = base;
      let suffix = 1;
      while (this.instances.has(id)) id = `${base}-${suffix++}`;
      const port = await pickPort(5558 + 2 * (this.instances.size + 1));
      const avdName = `${this.baseAvdName}_${id}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
      let avdPresent = existsSync(path.join(AVD_HOME, `${avdName}.ini`));
      if (!avdPresent) {
        this._log(`[instances] creating AVD ${avdName} (system image ${this.systemImage})`);
        const created = await createAvd({
          sdkRoot: this.sdkRoot || undefined,
          emulatorPath: this.emulatorPath || undefined,
          avdName,
          systemImage: this.systemImage,
        });
        if (!created.ok) throw new Error(created.error || `failed to create AVD ${avdName}`);
        avdPresent = true;
      }
      await patchAvdConfig(avdName, this.vmProfile);
      // Resolve the media (virtual camera/mic) flags at create time so the new
      // AndroidVm can append them on every emulator spawn. A broken provider
      // must never block VM creation.
      let mediaOptions = null;
      if (this.mediaOptionsProvider) {
        try {
          const resolved = this.mediaOptionsProvider();
          if (resolved && typeof resolved === 'object') mediaOptions = resolved;
        } catch (error) {
          this._log(`[instances] mediaOptionsProvider failed: ${error && error.message ? error.message : error}`);
        }
      }
      const displayName = sanitizeDisplayName(name) || id;
      const instance = new ExtraVmInstance({
        id,
        avdName,
        port,
        name: displayName,
        profile: this.vmProfile,
        options: {
          sdkRoot: this.sdkRoot || undefined,
          adbPath: this.adbPath || undefined,
          emulatorPath: this.emulatorPath || undefined,
          gpuMode: this.gpuMode,
          accel: 'auto',
          requireAccel: true,
          quickBoot: true,
          snapshotName: this.snapshotName,
          saveSnapshotAfterBoot: true,
          dnsServers: this.dnsServers,
          networkMode: this.networkMode,
          tcpdumpPath: this.tcpdumpPath,
          scrcpyJarPath: this.scrcpyJarPath,
          scrcpyMaxSize: this.scrcpyMaxSize,
          scrcpyBitrate: this.scrcpyBitrate,
          scrcpyMaxFps: this.scrcpyMaxFps,
          extraEmulatorArgs: mediaOptions && Array.isArray(mediaOptions.extraEmulatorArgs)
            ? mediaOptions.extraEmulatorArgs
            : undefined,
          enableAudio: mediaOptions ? mediaOptions.enableAudio === true : undefined,
        },
        log: (line) => this._log(line),
      });
      this.instances.set(id, instance);
      await this.names.set(id, displayName);
      this._log(`[instances] created ${id} (avd=${avdName}, port=${port})`);
      if (typeof this.onCreated === 'function') {
        try {
          this.onCreated(instance.id);
        } catch {
          /* route registration is best effort */
        }
      }
      return instance;
    };
    const previous = this._lock;
    let release;
    this._lock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await run();
    } finally {
      release();
    }
  }

  async destroy(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`unknown instance: ${id}`);
    this.instances.delete(id);
    this.leaseBook.release(id, null, { force: true });
    for (const [agent, mapped] of this.agentInstances) {
      if (mapped === id) this.agentInstances.delete(agent);
    }
    await this.names.delete(id);
    await instance.dispose();
    this._log(`[instances] destroyed ${id}`);
    return { ok: true, id };
  }

  /**
   * Register an externally managed VM (a remote SSH-tunnel session) so the
   * existing per-instance HTTP routes can serve it like an extra VM.
   *
   * The caller (RemoteSessionManager) owns the lifecycle. Remote instances do
   * not count against `maxInstances` (the session manager enforces `maxSessions`)
   * and are skipped by reapIdle(): stopping a remote VM would tear down its SSH
   * tunnel, which the session manager must decide explicitly.
   */
  addRemoteInstance(instance) {
    if (!instance || typeof instance.id !== 'string' || !instance.id) {
      throw new Error('addRemoteInstance requires an instance with an id');
    }
    this.instances.set(instance.id, instance);
    this._log(`[instances] registered remote instance ${instance.id}`);
    if (typeof this.onCreated === 'function') {
      try {
        this.onCreated(instance.id);
      } catch {
        /* route registration is best effort */
      }
    }
    return instance;
  }

  /** Remove a VM from the routable set without disposing it (remote sessions). */
  removeInstance(id) {
    const instance = this.instances.get(id);
    if (!instance) return null;
    this.instances.delete(id);
    this.leaseBook.release(id, null, { force: true });
    for (const [agent, mapped] of this.agentInstances) {
      if (mapped === id) this.agentInstances.delete(agent);
    }
    this._log(`[instances] unregistered instance ${id}`);
    return instance;
  }

  /** Registered remote sessions (kind === 'remote'). */
  remoteInstances() {
    return [...this.instances.values()].filter((instance) => instance.kind === 'remote');
  }

  /**
   * Remember the latest media launch options and apply them to every existing
   * instance VM (local and remote). Nothing is restarted here: the caller
   * decides when to stop/start a VM so the new flags take effect.
   */
  applyMediaOptions(media) {
    this.mediaOptions = media && typeof media === 'object' ? media : null;
    let applied = 0;
    for (const instance of this.instances.values()) {
      const vm = instance && instance.vm;
      if (!vm) continue;
      try {
        if (this.mediaOptions && Array.isArray(this.mediaOptions.extraEmulatorArgs)) {
          vm.extraEmulatorArgs = this.mediaOptions.extraEmulatorArgs.map(String).filter((arg) => arg.trim().length > 0);
        } else if (!this.mediaOptions) {
          vm.extraEmulatorArgs = [];
        }
        vm.enableAudio = this.mediaOptions ? this.mediaOptions.enableAudio === true : false;
        applied += 1;
      } catch {
        /* best effort: a frozen/foreign VM is skipped */
      }
    }
    return { ok: true, applied, media: this.mediaOptions ? { ...this.mediaOptions } : null };
  }

  touch(id) {
    const instance = this.instances.get(id);
    if (instance) instance.touch();
  }

  /** Record shared default VM activity (tool/panel/stream) and reset its idle timer. */
  noteSharedActivity(now = Date.now()) {
    this._sharedLastActivityAt = now;
  }

  /** Snapshot of the resident shared VM policy (used by GET /apk-vm/state). */
  sharedStatus(now = Date.now()) {
    const vm = this.defaultVm;
    if (!vm) return null;
    const idleMs = Math.max(0, now - this._sharedLastActivityAt);
    const state = vm._state;
    const nextAction =
      this.sharedResident && state === 'ready' && idleMs >= this.sharedSuspendAfterMs
        ? 'suspend'
        : this.sharedResident && state === 'suspended' && idleMs >= this.sharedStopAfterMs
          ? 'stop'
          : null;
    return {
      resident: this.sharedResident,
      state,
      idleMs,
      suspendAfterMs: this.sharedSuspendAfterMs,
      stopAfterMs: this.sharedStopAfterMs,
      nextAction,
    };
  }

  /**
   * Apply the resident shared VM policy: suspend a ready default VM after
   * `sharedSuspendAfterMs` idle, fully stop a suspended one after
   * `sharedStopAfterMs`. Never deletes the AVD or the quick-boot snapshot.
   */
  async reconcileShared(now = Date.now()) {
    if (!this.sharedResident || !this.defaultVm) return null;
    const vm = this.defaultVm;
    const idleMs = now - this._sharedLastActivityAt;
    if (vm._state === 'ready' && idleMs >= this.sharedSuspendAfterMs) {
      this._log(`[instances] suspending resident shared VM after ${Math.round(idleMs / 1000)}s idle`);
      const suspended = await vm.suspend('shared-idle').catch(() => false);
      if (!suspended) return { action: 'suspend-failed' };
      this.noteSharedActivity(now);
      return { action: 'suspend' };
    }
    if (vm._state === 'suspended' && idleMs >= this.sharedStopAfterMs) {
      if (vm.markSuspendedStopped()) {
        this._log(`[instances] resident shared VM idle-stopped after ${Math.round(idleMs / 1000)}s suspended`);
        return { action: 'stop' };
      }
    }
    return null;
  }

  /** Stop extra VMs whose Agent/panel has not touched them for idleTimeoutMs. */
  async reapIdle(now = Date.now()) {
    const stopped = [];
    for (const instance of this.instances.values()) {
      // Remote sessions are owned by the RemoteSessionManager (killRemote and
      // SSH tunnel teardown are explicit actions); never reap them here.
      if (instance.kind === 'remote') continue;
      const idleMs = now - instance.lastUsedAt;
      const running = instance.vm._state === 'ready' || instance.vm._state === 'booting';
      const clients = instance.stream ? instance.stream.clients.size : 0;
      // A live lease means an Agent/session still considers this VM its own;
      // stopping it under that user would be a surprise takeover.
      const leased = Boolean(this.leaseBook.get(instance.id));
      if (!running || clients > 0 || instance.installInFlight || leased || idleMs < this.idleTimeoutMs) continue;
      try {
        await instance.stop();
        stopped.push({ id: instance.id, idleMs });
        this._log(`[instances] idle-stopped ${instance.id} after ${Math.round(idleMs / 1000)}s`);
      } catch (error) {
        this._log(`[instances] idle stop failed for ${instance.id}: ${error && error.message ? error.message : error}`);
      }
    }
    // Memory-pressure reaping: when the idle-timeout loop above found nothing,
    // but the host cannot fit another VM (free < reserved + estimate), stop at
    // most one idle local VM per tick — the least recently used one — so the
    // next create()/boot has room. Remote sessions are never touched here.
    if (this.memoryPressureReap) {
      try {
        const hostInfo = this.memoryProvider.hostMemoryInfo();
        if (hostInfo && hostInfo.ok === true) {
          const local = this._localInstances();
          const check = this.memoryProvider.canStartInstance({
            hostMemory: hostInfo,
            runningCount: local.length,
            reservedBytes: this.hostReserveBytes,
            estimatedVmBytes: this.estimatedVmBytes,
          });
          if (check && check.ok === false) {
            // Instances with a live lease are excluded: stopping another
            // session's VM would look like a takeover.
            const candidates = new Map(
              [...this.instances].filter(([id]) => !this.leaseBook.get(id)),
            );
            const victim = pickMemoryPressureVictim(candidates);
            if (victim) {
              const idleMs = Math.max(0, now - Number(victim.lastUsedAt || now));
              try {
                await victim.stop();
                stopped.push({ id: victim.id, idleMs, reason: 'memory-pressure' });
                this._log(
                  `[instances] memory-pressure stopped ${victim.id} (free ${this.memoryProvider.formatMemory(hostInfo.freeBytes)}, ${check.reason})`,
                );
              } catch (error) {
                this._log(`[instances] memory-pressure stop failed for ${victim.id}: ${error && error.message ? error.message : error}`);
              }
            }
          }
        }
      } catch (error) {
        this._log(`[instances] memory-pressure reap failed: ${error && error.message ? error.message : error}`);
      }
    }
    return stopped;
  }

  async dispose() {
    for (const instance of this.instances.values()) {
      try {
        await instance.dispose();
      } catch {
        /* best effort */
      }
    }
    this.instances.clear();
    this.agentInstances.clear();
    this.leaseBook.clear();
    this.defaultClaimed = false;
    this.defaultOwner = null;
  }
}
