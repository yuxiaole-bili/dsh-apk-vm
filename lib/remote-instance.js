/**
 * Remote VM instance: a VM living behind an SSH tunnel.
 *
 * `RemoteVmInstance` exposes the same public surface as `ExtraVmInstance`
 * (lib/instances.js) so the existing per-instance HTTP routes — panel, touch,
 * input, clipboard, install, debug, snapshots, network, flows, skills and
 * controls — can serve a remote session with no route changes.
 *
 * The lifecycle is inverted compared to a local AVD:
 *   1. `start()` makes sure the SSH tunnel is running, which exposes the remote
 *      emulator's adb port on 127.0.0.1:<localPort>.
 *   2. `vm.connect(serial)` runs `adb connect 127.0.0.1:<localPort>` and polls
 *      until the device is online.
 *   3. `vm.attachDevice(serial)` attaches that already-online device to the VM
 *      (AndroidVm then waits for boot + prepares the debug system).
 *   4. `stop({killRemote:true})` can additionally run the fixed remote
 *      `adb emu kill` command before detaching the local adb device.
 *
 * Everything is injectable for hermetic tests: `options.vm` (mock AndroidVm),
 * `options.tunnel` (mock SshAdbTunnel), `options.runSsh`, `options.exec`,
 * `options.now`, `options.sleep`, `options.streamFactory`.
 */
import { AndroidVm } from './android.js';
import { ScrcpyStream } from './video-stream.js';
import { buildRemoteEmulatorStopCommand, runSshCommand } from './remote.js';
import path from 'node:path';

function shortHash(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export class RemoteVmInstance {
  /**
   * @param {object} args
   * @param {string} args.id session/instance id
   * @param {object} args.profile normalized remote profile
   * @param {object} args.tunnel SshAdbTunnel (or mock with start/stop/status)
   * @param {object|null} [args.launchInfo] {consolePort,adbPort,logPath,startedAt}
   * @param {object} [args.options] runtime options
   * @param {Function} [args.log]
   */
  constructor({ id, profile, tunnel, launchInfo = null, options = {}, log }) {
    this.id = id;
    this.kind = 'remote';
    this.profile = profile && typeof profile === 'object' ? profile : {};
    this.tunnel = tunnel;
    this.launchInfo = launchInfo && typeof launchInfo === 'object' ? launchInfo : null;
    this.options = options && typeof options === 'object' ? options : {};
    this.logSink = typeof log === 'function' ? log : null;

    this.frame = { buffer: null, at: 0, inFlight: null };
    this.lastApk = null;
    this.installInFlight = null;
    this.owner = null;
    this.lastUsedAt = Date.now();

    this.connectTimeoutMs = Math.max(1000, Number(this.options.connectTimeoutMs) || 180000);
    this.connectRetryDelayMs = Math.max(10, Number(this.options.connectRetryDelayMs) || 2000);
    this.remoteStopTimeoutMs = Math.max(1000, Number(this.options.remoteStopTimeoutMs) || 15000);
    this.now = typeof this.options.now === 'function' ? this.options.now : Date.now;
    this.sleep = typeof this.options.sleep === 'function' ? this.options.sleep : defaultSleep;
    this.runSsh = typeof this.options.runSsh === 'function' ? this.options.runSsh : runSshCommand;
    this.exec = typeof this.options.exec === 'function' ? this.options.exec : null;

    this.lastAttachError = null;
    this._attachPromise = null;
    this.lastRemoteKill = null;

    this.vm = this._createVm();
    this.stream = this._createStream();
  }

  // -------------------------------------------------------------------------
  // construction helpers (mockable)
  // -------------------------------------------------------------------------

  _initialSerial() {
    if (this.options.serial) return String(this.options.serial);
    const status = this._tunnelStatus();
    return status && status.serial ? status.serial : null;
  }

  _createVm() {
    if (this.options.vm && typeof this.options.vm === 'object') return this.options.vm;
    if (typeof this.options.vmFactory === 'function') {
      return this.options.vmFactory({
        serial: this._initialSerial(),
        profile: this.profile,
        options: this.options,
        log: (line) => this._log(line),
      });
    }
    const vmOptions = { ...(this.options.vmOptions || {}) };
    for (const key of [
      'sdkRoot',
      'adbPath',
      'gpuMode',
      'quickBoot',
      'snapshotName',
      'bootTimeoutMs',
      'connectTimeoutMs',
      'pollIntervalMs',
      'networkMode',
      'dnsServers',
      // Media (virtual camera/mic) flags must stay on the AndroidVm so an
      // SSH detach/attach restart keeps the same launch arguments.
      'extraEmulatorArgs',
      'enableAudio',
    ]) {
      if (this.options[key] !== undefined && vmOptions[key] === undefined) vmOptions[key] = this.options[key];
    }
    return new AndroidVm({
      ...vmOptions,
      // The remote host owns the emulator process: never spawn or kill locally.
      spawnEmulator: false,
      avdName: '',
      serial: this._initialSerial() || undefined,
      log: (line) => this._log(line),
    });
  }

  _createStream() {
    if (!this.options.scrcpyJarPath && typeof this.options.streamFactory !== 'function') return null;
    const args = {
      vm: this.vm,
      jarPath: this.options.scrcpyJarPath,
      maxSize: this.options.scrcpyMaxSize || 960,
      bitrate: this.options.scrcpyBitrate || 6_000_000,
      maxFps: this.options.scrcpyMaxFps || 60,
      // Keep remote scrcpy ports out of the range used by local extra instances
      // (27183 + emulator port) and let ScrcpyStream pick a free one anyway.
      preferredPort: Number(this.options.streamPort) || 29183 + (shortHash(this.id) % 1000),
      log: (line) => this._log(line),
    };
    if (typeof this.options.streamFactory === 'function') return this.options.streamFactory(args);
    return new ScrcpyStream(args);
  }

  // -------------------------------------------------------------------------
  // basic instance surface
  // -------------------------------------------------------------------------

  touch() {
    this.lastUsedAt = Date.now();
  }

  _log(line) {
    if (this.logSink) this.logSink(`[${this.id}] ${line}`);
  }

  _tunnelStatus() {
    if (!this.tunnel || typeof this.tunnel.status !== 'function') return null;
    try {
      return this.tunnel.status();
    } catch {
      return null;
    }
  }

  serial() {
    const tunnelStatus = this._tunnelStatus();
    return this.options.serial || (tunnelStatus && tunnelStatus.serial) || null;
  }

  async status() {
    let status;
    try {
      status = await this.vm.status();
    } catch (error) {
      status = { state: 'error', error: errorText(error) };
    }
    const tunnel = this._tunnelStatus();
    const serial = (status && status.serial) || this.serial();
    return {
      ...status,
      id: this.id,
      kind: 'remote',
      host: this.profile.host || null,
      user: this.profile.user || null,
      sshPort: this.profile.sshPort || null,
      avdName: this.profile.avdName || (status && status.avd) || '',
      port: null,
      serial: serial || null,
      tunnel,
      launch: this.launchInfo ? { ...this.launchInfo } : null,
      profile: { ...this.profile },
      attachError: this.lastAttachError,
      attachInFlight: Boolean(this._attachPromise),
      remoteKill: this.lastRemoteKill,
      root: status && status.root === true,
      debugPrepared: status && status.debugPrepared === true,
      debugToolkit: (status && status.debugToolkit) || null,
      identity: (status && status.identity) || null,
    };
  }

  /** Ensure the SSH tunnel is running; returns its status. */
  async _ensureTunnel() {
    if (!this.tunnel || typeof this.tunnel.start !== 'function') {
      throw new Error('remote instance has no SSH tunnel');
    }
    const current = this._tunnelStatus();
    if (current && current.state === 'running') return current;
    this._log('starting SSH tunnel');
    const started = await this.tunnel.start();
    if (started && started.ok === false) {
      throw new Error(`SSH tunnel failed to start: ${started.error || started.lastError || 'unknown error'}`);
    }
    return this._tunnelStatus() || started || null;
  }

  _attachError(serial, lastError, attempts) {
    const logPath = this.launchInfo && this.launchInfo.logPath
      ? this.launchInfo.logPath
      : (this.consolePort() ? `/tmp/apk-vm-emulator-${this.consolePort()}.log` : 'no remote emulator log (launch disabled)');
    const detail = lastError ? errorText(lastError) : 'unknown error';
    return new Error(
      `remote adb attach failed for ${serial}: ${detail} (after ${attempts} attempt${attempts === 1 ? '' : 's'}); ` +
      `emulator log: ${logPath}`,
    );
  }

  /**
   * Start the remote VM: tunnel → adb connect (retry within the deadline) →
   * attach the device. `wait:false`/`attachInBackground:true` kicks off the
   * (potentially long, boot-waiting) attach without blocking the caller.
   */
  async start(options = {}) {
    this.touch();
    if (this._attachPromise && options.wait !== false) {
      // A previous background attach is still running; reuse it.
      await this._attachPromise;
      return this.status();
    }
    await this._ensureTunnel();
    const serial = this.serial();
    if (!serial) throw new Error('SSH tunnel is not exposing a loopback adb serial');

    const deadline = this.now() + this.connectTimeoutMs;
    let attempts = 0;
    let lastError = null;
    for (;;) {
      attempts += 1;
      try {
        await this.vm.connect(serial);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = errorText(error);
        if (/unauthorized/i.test(message)) throw this._attachError(serial, error, attempts);
        if (this.now() >= deadline) throw this._attachError(serial, lastError, attempts);
        this._log(`adb connect ${serial} failed (attempt ${attempts}): ${message}`);
        await this.sleep(this.connectRetryDelayMs);
      }
    }

    const attach = async () => {
      try {
        await this.vm.attachDevice(serial);
        this.lastAttachError = null;
      } catch (error) {
        this.lastAttachError = errorText(error);
        throw error;
      }
    };
    const background = options.attachInBackground === true || options.wait === false;
    if (!background) {
      await attach();
      return this.status();
    }
    if (!this._attachPromise) {
      this._attachPromise = attach()
        .catch((error) => {
          this._log(`background attach failed: ${errorText(error)}`);
        })
        .finally(() => {
          this._attachPromise = null;
        });
    }
    return this.status();
  }

  /** Await the in-flight background attach, if any (used by tests/routes). */
  async waitForAttach() {
    if (this._attachPromise) await this._attachPromise;
    return this.lastAttachError;
  }

  consolePort() {
    if (this.launchInfo && Number(this.launchInfo.consolePort) > 0) return Number(this.launchInfo.consolePort);
    const remotePort = Number(this.profile.remotePort);
    if (Number.isInteger(remotePort) && remotePort > 1) return remotePort - 1;
    return null;
  }

  _remoteAdbPath() {
    const sdkRoot = this.profile && typeof this.profile.sdkRoot === 'string' ? this.profile.sdkRoot.trim() : '';
    if (!sdkRoot) return null;
    return sdkRoot.replace(/\/+$/, '') + '/platform-tools/adb';
  }

  async _killRemote() {
    const consolePort = this.consolePort();
    if (!consolePort) {
      this.lastRemoteKill = { ok: false, error: 'no remote emulator console port is known for this session' };
      return this.lastRemoteKill;
    }
    let command;
    try {
      ({ command } = buildRemoteEmulatorStopCommand({ consolePort, adbPath: this._remoteAdbPath() }));
    } catch (error) {
      this.lastRemoteKill = { ok: false, error: errorText(error) };
      return this.lastRemoteKill;
    }
    try {
      const result = await this.runSsh(this.profile, command, {
        timeoutMs: this.remoteStopTimeoutMs,
        exec: this.exec || undefined,
      });
      this.lastRemoteKill = { ...(result || {}), command };
      return this.lastRemoteKill;
    } catch (error) {
      this.lastRemoteKill = { ok: false, error: errorText(error), command };
      return this.lastRemoteKill;
    }
  }

  /**
   * Stop the remote VM. Order is deliberate: optional remote `emu kill` first
   * (so the adb port can be reused immediately), then detach the local device,
   * then tear the SSH tunnel down.
   */
  async stop(options = {}) {
    this.touch();
    const killRemote = options && options.killRemote === true;
    const remoteKill = killRemote ? await this._killRemote() : null;
    let detach = null;
    let detachError = null;
    try {
      detach = await this._stopVm();
    } catch (error) {
      detachError = errorText(error);
      this._log(`stop: detach failed: ${detachError}`);
    }
    let tunnelStop = null;
    let tunnelError = null;
    try {
      if (this.tunnel && typeof this.tunnel.stop === 'function') tunnelStop = await this.tunnel.stop();
    } catch (error) {
      tunnelError = errorText(error);
      this._log(`stop: tunnel stop failed: ${tunnelError}`);
    }
    this.frame.buffer = null;
    this.frame.at = 0;
    return {
      ok: true,
      id: this.id,
      kind: 'remote',
      killRemote,
      remoteKill,
      detach,
      detachError,
      tunnel: tunnelStop || this._tunnelStatus(),
      tunnelError,
    };
  }

  async _stopVm() {
    if (this._attachPromise) {
      try {
        await this._attachPromise;
      } catch {
        /* the attach error is recorded in status()/attachError */
      }
    }
    return this.vm.stop();
  }

  async restart() {
    this.touch();
    await this.stop();
    return this.start();
  }

  async saveSnapshot(name) {
    this.touch();
    return this.vm.saveSnapshot(name);
  }

  async screenshot() {
    this.touch();
    return this.vm.screenshot();
  }

  /** Cached PNG frame for the panel's instance view. */
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
      this._log(`[video] handleClient failed: ${errorText(error)}`);
      client.sendText(JSON.stringify({ type: 'error', error: errorText(error) }));
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

  // Debug surface delegates (same as ExtraVmInstance; they also touch()).
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
      await this.stop();
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
