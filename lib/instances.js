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
import { createAvd, DEFAULT_SYSTEM_IMAGE } from './setup.js';
import { ScrcpyStream } from './video-stream.js';

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

async function patchAvdConfig(avdName) {
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
  for (const [key, value] of Object.entries(desired)) {
    const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    if (regex.test(text)) text = text.replace(regex, `${key} = ${value}`);
    else text += `${text && !text.endsWith('\n') ? '\n' : ''}${key} = ${value}\n`;
  }
  await fsp.writeFile(file, text, 'utf8');
}

export class ExtraVmInstance {
  constructor({ id, avdName, port, options, log }) {
    this.id = id;
    this.avdName = avdName;
    this.port = port;
    this.logSink = typeof log === 'function' ? log : null;
    this.frame = { buffer: null, at: 0, inFlight: null };
    this.lastApk = null;
    this.installInFlight = null;
    this.vm = new AndroidVm({
      ...options,
      avdName,
      port,
      // Pin this instance to its own emulator console port; otherwise
      // AndroidVm would attach to whichever adb device happens to be online
      // (normally the first/default VM).
      serial: `emulator-${port}`,
      log: (line) => this._log(line),
    });
    this.stream = options.scrcpyJarPath
      ? new ScrcpyStream({
          vm: this.vm,
          jarPath: options.scrcpyJarPath,
          maxSize: options.scrcpyMaxSize || 960,
          bitrate: options.scrcpyBitrate || 6_000_000,
          maxFps: options.scrcpyMaxFps || 60,
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

  async status() {
    const status = await this.vm.status();
    return {
      ...status,
      id: this.id,
      avdName: this.avdName,
      port: this.port,
      root: status.root === true,
      debugPrepared: status.debugPrepared === true,
      debugToolkit: status.debugToolkit || null,
      identity: status.identity || null,
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
  reboot(mode) {
    this.touch();
    return this.vm.reboot(mode);
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

export class InstanceManager {
  constructor(options = {}) {
    this.options = options;
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
    this.logSink = typeof options.log === 'function' ? options.log : null;
    this.instances = new Map();
    this.agentInstances = new Map();
    this.defaultClaimed = false;
    this.defaultOwner = null;
    this.onCreated = null;
    this._lock = Promise.resolve();
  }

  _log(line) {
    if (this.logSink) this.logSink(line);
  }

  list() {
    return [...this.instances.values()].map((instance) => ({
      id: instance.id,
      avdName: instance.avdName,
      port: instance.port,
      kind: 'extra',
      state: instance.vm._state || 'stopped',
      serial: instance.vm._serialActive || instance.vm.serial || null,
      root: instance.vm._root === true,
      apk: instance.snapshotApk(),
      owner: instance.owner || null,
      lastUsedAt: instance.lastUsedAt,
      idleMs: Math.max(0, Date.now() - instance.lastUsedAt),
      idleTimeoutMs: this.idleTimeoutMs,
      videoClients: instance.stream ? instance.stream.clients.size : 0,
    }));
  }

  summaries() {
    return this.list();
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  get size() {
    return this.instances.size;
  }

  async create({ name } = {}) {
    const run = async () => {
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
      await patchAvdConfig(avdName);
      const instance = new ExtraVmInstance({
        id,
        avdName,
        port,
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
          scrcpyJarPath: this.scrcpyJarPath,
          scrcpyMaxSize: this.scrcpyMaxSize,
          scrcpyBitrate: this.scrcpyBitrate,
          scrcpyMaxFps: this.scrcpyMaxFps,
        },
        log: (line) => this._log(line),
      });
      this.instances.set(id, instance);
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
    for (const [agent, mapped] of this.agentInstances) {
      if (mapped === id) this.agentInstances.delete(agent);
    }
    await instance.dispose();
    this._log(`[instances] destroyed ${id}`);
    return { ok: true, id };
  }

  /**
   * Resolve the instance an Agent should use. The first Agent gets the default
   * VM; later Agents get an isolated instance (created on demand) until
   * `maxInstances` is full.
   */
  async forAgent(agentKey) {
    const key = String(agentKey || 'anonymous');
    if (this.agentInstances.has(key)) {
      const id = this.agentInstances.get(key);
      if (id === 'default') return { id: 'default', default: true };
      const instance = this.instances.get(id);
      if (instance) return instance;
      this.agentInstances.delete(key);
    }
    if (!this.defaultClaimed) {
      this.defaultClaimed = true;
      this.defaultOwner = key;
      this.agentInstances.set(key, 'default');
      return { id: 'default', default: true };
    }
    const instance = await this.create({ name: `agent-${sanitizeInstanceId(key).slice(0, 24)}` });
    instance.owner = key;
    instance.touch();
    this.agentInstances.set(key, instance.id);
    return instance;
  }

  touch(id) {
    const instance = this.instances.get(id);
    if (instance) instance.touch();
  }

  /** Stop extra VMs whose Agent/panel has not touched them for idleTimeoutMs. */
  async reapIdle(now = Date.now()) {
    const stopped = [];
    for (const instance of this.instances.values()) {
      const idleMs = now - instance.lastUsedAt;
      const running = instance.vm._state === 'ready' || instance.vm._state === 'booting';
      const clients = instance.stream ? instance.stream.clients.size : 0;
      if (!running || clients > 0 || instance.installInFlight || idleMs < this.idleTimeoutMs) continue;
      try {
        await instance.stop();
        stopped.push({ id: instance.id, idleMs });
        this._log(`[instances] idle-stopped ${instance.id} after ${Math.round(idleMs / 1000)}s`);
      } catch (error) {
        this._log(`[instances] idle stop failed for ${instance.id}: ${error && error.message ? error.message : error}`);
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
  }
}
