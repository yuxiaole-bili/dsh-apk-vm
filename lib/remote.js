/**
 * SSH adb tunnel for running the Android VM on a remote Linux host.
 *
 * The tunnel is deliberately generic: it forwards a local loopback port to the
 * remote emulator's adb port (normally 5558) with `ssh -N -L`, then the normal
 * AndroidVm attach path runs `adb connect 127.0.0.1:<localPort>`. Nothing is
 * stored, logged or sent to a third party. The caller owns the key path.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

function asPort(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function safeHost(value) {
  const host = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) throw new Error('invalid SSH host');
  return host;
}

function safeUser(value) {
  const user = String(value || '').trim() || 'root';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error('invalid SSH user');
  return user;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function isLocalPortFree(port) {
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

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`SSH tunnel did not listen on port ${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export class SshAdbTunnel {
  constructor(options = {}) {
    this.sshHost = safeHost(options.host);
    this.sshUser = safeUser(options.user);
    this.sshPort = asPort(options.sshPort, 22);
    this.remotePort = asPort(options.remotePort, 5558);
    this.localPort = asPort(options.localPort, 0);
    this.keyPath = String(options.keyPath || '').trim() ? path.resolve(String(options.keyPath)) : '';
    if (this.keyPath && !existsSync(this.keyPath)) throw new Error(`SSH key not found: ${this.keyPath}`);
    this.sshPath = String(options.sshPath || 'ssh');
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    this.startedAt = 0;
  }

  buildArgs() {
    const args = [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-p',
      String(this.sshPort),
    ];
    if (this.keyPath) args.push('-i', this.keyPath);
    args.push(
      '-L',
      `127.0.0.1:${this.localPort}:127.0.0.1:${this.remotePort}`,
      `${this.sshUser}@${this.sshHost}`,
    );
    return args;
  }

  async start() {
    if (this.state === 'running') return { ok: true, ...this.status() };
    if (this.state === 'starting') throw new Error('SSH tunnel is already starting');
    if (!this.localPort) this.localPort = await findFreePort();
    this.state = 'starting';
    const args = this.buildArgs();
    const child = spawn(this.sshPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8').slice(0, 4000);
    });
    child.once('error', (error) => {
      this.state = 'error';
      this.lastError = error.message;
    });
    child.once('exit', (code) => {
      if (this.state === 'running' || this.state === 'starting') {
        this.state = 'error';
        this.lastError = `ssh exited (${code}): ${stderr.trim().slice(0, 500)}`;
      }
      this.child = null;
    });
    await waitForPort(this.localPort, 20000);
    this.state = 'running';
    this.startedAt = Date.now();
    return { ok: true, ...this.status() };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    if (!child) return { ok: true, ...this.status() };
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { ok: true, ...this.status() };
  }

  status() {
    return {
      sshHost: this.sshHost,
      sshUser: this.sshUser,
      remotePort: this.remotePort,
      localPort: this.localPort,
      serial: this.localPort ? `127.0.0.1:${this.localPort}` : null,
      state: this.state,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }
}

export function buildSshTunnelArgs(options) {
  const tunnel = new SshAdbTunnel({ ...options, localPort: options.localPort || 15037 });
  return tunnel.buildArgs();
}

// ---------------------------------------------------------------------------
// Remote VM host: profile store + bounded SSH helpers.
//
// The "remote VM" feature treats the SSH host as a proxy for the guest: the
// panel forwards a loopback port to the remote emulator's adb port, runs
// `adb connect 127.0.0.1:<localPort>` and attaches that device like any other
// adb device. Optionally the same SSH connection runs a *fixed* headless
// emulator command (`-no-window -no-audio -no-boot-anim -gpu
// swiftshader_indirect`) so the remote host can be a plain build box.
//
// Security notes:
// * only a fixed command shape is executed remotely; every value is validated
//   and single-quote escaped, so a profile field can never inject a shell
//   command;
// * the SSH key path is caller-owned; nothing is cached except the profile JSON
//   under <profile>/.apk-vm/remote-profile.json;
// * `BatchMode=yes` is used, so a password prompt fails instead of hanging.
// ---------------------------------------------------------------------------

export const REMOTE_PROFILE_VERSION = 1;
/** Multi-profile book file format (one file can hold several hosts/AVDs). */
export const REMOTE_PROFILES_VERSION = 2;
const AVD_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REMOTE_PATH_RE = /^[A-Za-z0-9._/+-]{1,500}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Quote one argument for a POSIX `sh` command line (single quotes). */
export function quoteRemoteArg(value) {
  const text = String(value == null ? '' : value);
  if (!text) throw new Error('remote command argument is empty');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('remote command argument contains control characters');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function optionalRemotePath(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (!REMOTE_PATH_RE.test(text)) throw new Error(`invalid ${label}: ${JSON.stringify(text.slice(0, 80))}`);
  return text;
}

function optionalAvdName(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (!AVD_NAME_RE.test(text)) throw new Error(`invalid AVD name: ${JSON.stringify(text.slice(0, 80))}`);
  return text;
}

/** Optional human-readable profile label (UTF-8, control characters rejected). */
function optionalProfileName(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('invalid remote profile name');
  return text.slice(0, 64);
}

/** Optional remote emulator console port (0 = auto-allocate). */
function optionalConsolePort(value) {
  if (value == null || value === '' || value === 0 || value === '0') return 0;
  return asConsolePort(value);
}

/** Normalize/validate a remote host profile (throws on invalid input). */
export function normalizeRemoteProfile(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const profile = {
    host: safeHost(source.host),
    user: safeUser(source.user),
    sshPort: asPort(source.sshPort, 22),
    remotePort: asPort(source.remotePort, 5558),
    localPort: source.localPort == null || source.localPort === '' ? 0 : asPort(source.localPort, 0),
    consolePort: optionalConsolePort(source.consolePort),
    name: optionalProfileName(source.name),
    keyPath: String(source.keyPath == null ? '' : source.keyPath).trim() ? path.resolve(String(source.keyPath)) : '',
    sshPath: String(source.sshPath == null ? '' : source.sshPath).trim() || 'ssh',
    avdName: optionalAvdName(source.avdName),
    emulatorPath: optionalRemotePath(source.emulatorPath, 'remote emulator path'),
    sdkRoot: optionalRemotePath(source.sdkRoot, 'remote SDK root'),
    launch: source.launch === true,
    updatedAt: Date.now(),
  };
  if (profile.keyPath && !existsSync(profile.keyPath)) throw new Error(`SSH key not found: ${profile.keyPath}`);
  if (!/^[A-Za-z0-9._/:-]{1,500}$/.test(profile.sshPath)) throw new Error(`invalid ssh executable: ${JSON.stringify(profile.sshPath)}`);
  return profile;
}

/** `<dataDir>/.apk-vm/remote-profile.json` — same convention as the app registry. */
export function defaultRemoteProfilePath(dataDir) {
  return path.join(String(dataDir || process.cwd()), '.apk-vm', 'remote-profile.json');
}

/**
 * Small JSON profile store for the last used remote host. Tolerant of a missing
 * or corrupt file: load() returns `{ok:true, profile:null}` instead of throwing,
 * so a broken profile never bricks the panel.
 */
export class RemoteProfileStore {
  constructor(options = {}) {
    this.file = String(options.file || defaultRemoteProfilePath(process.cwd()));
  }

  async load() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, profile: null };
      return { ok: false, error: error && error.message ? error.message : String(error), profile: null };
    }
    try {
      const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      const raw = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : parsed;
      const profile = normalizeRemoteProfile(raw);
      return { ok: true, profile };
    } catch (error) {
      return { ok: false, error: `remote profile is invalid: ${error.message}`, profile: null };
    }
  }

  async save(profile) {
    const normalized = normalizeRemoteProfile(profile);
    const payload = `${JSON.stringify({ version: REMOTE_PROFILE_VERSION, updatedAt: normalized.updatedAt, profile: normalized }, null, 2)}\n`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, payload, 'utf8');
      await rename(temp, this.file);
      return { ok: true, file: this.file };
    } catch (error) {
      return { ok: false, file: this.file, error: error && error.message ? error.message : String(error) };
    }
  }

  async clear() {
    try {
      await rm(this.file, { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }
}

/** `<dataDir>/.apk-vm/remote-profiles.json` — multi-profile book. */
export function defaultRemoteProfilesPath(dataDir) {
  return path.join(String(dataDir || process.cwd()), '.apk-vm', 'remote-profiles.json');
}

/** Stable identity for "same remote target", used to update instead of duplicate. */
function profileIdentity(profile) {
  return [profile.host, profile.user, profile.sshPort, profile.avdName, profile.remotePort]
    .map((part) => String(part == null ? '' : part).toLowerCase())
    .join('|');
}

function buildProfileId(profile) {
  const avd = profile.avdName || `port${profile.remotePort}`;
  const base = `${avd}-${profile.user || 'root'}-${profile.host}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base || 'remote';
}

function uniqueProfileId(entries, base) {
  const used = new Set(entries.map((entry) => entry.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 58)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now()}`;
}

/**
 * Multi-profile JSON book for remote hosts (`<dataDir>/.apk-vm/remote-profiles.json`).
 *
 * Profiles are keyed by a stable `id` and a profile carrying the same
 * host/user/sshPort/AVD identity is updated in place instead of duplicated.
 * Writes are atomic (temp file + rename) and reads are tolerant of a missing,
 * legacy single-profile or corrupt file, so a bad file can never brick the
 * panel: `list()` reports the error but returns an empty list.
 */
export class RemoteProfileBook {
  constructor(options = {}) {
    this.file = String(options.file || defaultRemoteProfilesPath(process.cwd()));
  }

  async _read() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, recoverable: true, entries: [], error: null };
      return {
        ok: false,
        recoverable: false,
        entries: [],
        error: error && error.message ? error.message : String(error),
      };
    }
    try {
      const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      let rawList;
      if (Array.isArray(parsed)) rawList = parsed;
      else if (parsed && Array.isArray(parsed.profiles)) rawList = parsed.profiles;
      else if (parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object') rawList = [parsed];
      else if (parsed && typeof parsed === 'object' && parsed.host) rawList = [parsed];
      else rawList = [];
      const entries = [];
      let skipped = 0;
      for (const raw of rawList) {
        try {
          if (!raw || typeof raw !== 'object') throw new Error('entry is not an object');
          const source = raw.profile && typeof raw.profile === 'object' ? raw.profile : raw;
          const profile = normalizeRemoteProfile(source);
          const id = typeof raw.id === 'string' && PROFILE_ID_RE.test(raw.id) ? raw.id : buildProfileId(profile);
          entries.push({ id, profile });
        } catch {
          skipped += 1;
        }
      }
      const note = skipped ? `${skipped} invalid remote profile ${skipped === 1 ? 'entry was' : 'entries were'} skipped` : null;
      return { ok: true, recoverable: true, entries, error: note };
    } catch (error) {
      return {
        ok: true,
        recoverable: true,
        entries: [],
        error: `remote profiles file is invalid: ${error && error.message ? error.message : String(error)}`,
      };
    }
  }

  async _write(entries) {
    const payload = `${JSON.stringify({
      version: REMOTE_PROFILES_VERSION,
      updatedAt: Date.now(),
      profiles: entries.map(({ id, profile }) => ({ id, profile })),
    }, null, 2)}\n`;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, this.file);
  }

  /** List every valid profile: `{ok, file, profiles:[{id, ...profile}], error}`. */
  async list() {
    const read = await this._read();
    if (!read.ok) return { ok: false, file: this.file, profiles: [], error: read.error };
    const profiles = read.entries.map(({ id, profile }) => ({ id, ...profile }));
    profiles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { ok: true, file: this.file, profiles, error: read.error };
  }

  async get(id) {
    const wanted = String(id == null ? '' : id).trim();
    const read = await this._read();
    if (!read.ok) return { ok: false, file: this.file, id: wanted, profile: null, error: read.error };
    const entry = read.entries.find((candidate) => candidate.id === wanted);
    if (!entry) return { ok: true, file: this.file, id: wanted, profile: null, error: read.error };
    return { ok: true, file: this.file, id: entry.id, profile: { id: entry.id, ...entry.profile }, error: read.error };
  }

  /**
   * Upsert a profile. `options.id` pins/overwrites one entry; otherwise an entry
   * with the same remote identity is updated. Returns the stored profile.
   */
  async save(input, options = {}) {
    let profile;
    try {
      profile = normalizeRemoteProfile(input);
    } catch (error) {
      return {
        ok: false,
        file: this.file,
        id: null,
        profile: null,
        error: error && error.message ? error.message : String(error),
      };
    }
    if (options.name != null) {
      try {
        profile.name = optionalProfileName(options.name) || profile.name;
      } catch (error) {
        return { ok: false, file: this.file, id: null, profile: null, error: error.message };
      }
    }
    const requestedId = options.id == null ? '' : String(options.id).trim();
    if (requestedId && !PROFILE_ID_RE.test(requestedId)) {
      return {
        ok: false,
        file: this.file,
        id: null,
        profile: null,
        error: 'invalid remote profile id (letters, digits, dot, dash, underscore; max 64)',
      };
    }
    const read = await this._read();
    if (!read.ok && !read.recoverable) {
      return { ok: false, file: this.file, id: null, profile: null, error: read.error };
    }
    const entries = read.entries;
    const key = profileIdentity(profile);
    let index = requestedId ? entries.findIndex((entry) => entry.id === requestedId) : -1;
    if (index < 0) index = entries.findIndex((entry) => profileIdentity(entry.profile) === key);
    const id = requestedId || (index >= 0 ? entries[index].id : uniqueProfileId(entries, buildProfileId(profile)));
    const entry = { id, profile };
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    try {
      await this._write(entries);
    } catch (error) {
      return {
        ok: false,
        file: this.file,
        id,
        profile: null,
        error: error && error.message ? error.message : String(error),
      };
    }
    return { ok: true, file: this.file, id, profile: { id, ...profile }, error: null };
  }

  /** Delete one saved profile by id (no-op when it is already gone). */
  async forget(id) {
    const wanted = String(id == null ? '' : id).trim();
    if (!wanted) {
      return { ok: false, file: this.file, removed: [], error: 'forget requires a remote profile id' };
    }
    if (!PROFILE_ID_RE.test(wanted)) {
      return { ok: false, file: this.file, removed: [], error: 'invalid remote profile id' };
    }
    const read = await this._read();
    if (!read.ok && !read.recoverable) {
      return { ok: false, file: this.file, removed: [], error: read.error };
    }
    const removed = [];
    const kept = [];
    for (const entry of read.entries) {
      if (entry.id === wanted) removed.push(entry.id);
      else kept.push(entry);
    }
    if (!removed.length) return { ok: true, file: this.file, removed, error: null };
    try {
      await this._write(kept);
    } catch (error) {
      return {
        ok: false,
        file: this.file,
        removed: [],
        error: error && error.message ? error.message : String(error),
      };
    }
    return { ok: true, file: this.file, removed, error: null };
  }

  /** Remove the whole profiles file. */
  async clear() {
    try {
      await rm(this.file, { force: true });
      return { ok: true, file: this.file, error: null };
    } catch (error) {
      return { ok: false, file: this.file, error: error && error.message ? error.message : String(error) };
    }
  }
}

function asConsolePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 5554 || n > 5682 || n % 2 !== 0) {
    throw new Error('remote emulator console port must be an even integer between 5554 and 5682');
  }
  return n;
}

/**
 * Validate optional extra emulator arguments (camera/mic flags from
 * lib/media.js). They are our own strings, but are still rejected for control
 * characters and quoted individually before interpolation.
 */
export function normalizeExtraEmulatorArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('extraEmulatorArgs must be an array of strings');
  const args = [];
  const seen = new Set();
  for (const item of value) {
    const text = String(item == null ? '' : item).trim();
    if (!text) throw new Error('extra emulator arguments must be non-empty strings');
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('extra emulator arguments must not contain control characters');
    if (text.length > 200) throw new Error('extra emulator argument is too long (max 200 characters)');
    if (seen.has(text)) continue;
    seen.add(text);
    args.push(text);
  }
  return args;
}

const RESERVED_EMULATOR_FLAGS = new Set(['-avd', '-no-window', '-no-boot-anim', '-gpu', '-port']);

/**
 * Build the fixed remote command that starts a headless AVD. Returns
 * `{command, consolePort, adbPort, logPath, extraArgs}`. All values are
 * validated; the command is a single `nohup <emulator> -avd <avd> ... &` with
 * no shell metacharacters from user input.
 *
 * `extraEmulatorArgs` (string[], runtime-only; camera/mic flags) are appended
 * in order before `-port <consolePort>`. `enableAudio: true` omits the built-in
 * `-no-audio` so the guest can record from a virtual microphone.
 */
export function buildRemoteEmulatorStartCommand(options = {}) {
  const avdName = optionalAvdName(options.avdName);
  if (!avdName) throw new Error('launch requires a remote AVD name');
  const consolePort = asConsolePort(options.consolePort == null ? 5554 : options.consolePort);
  const logPath = `/tmp/apk-vm-emulator-${consolePort}.log`;
  const emulator = optionalRemotePath(options.emulatorPath, 'remote emulator path') || 'emulator';
  const sdkRoot = optionalRemotePath(options.sdkRoot, 'remote SDK root');
  const envPrefix = sdkRoot ? `ANDROID_SDK_ROOT=${quoteRemoteArg(sdkRoot)} ANDROID_HOME=${quoteRemoteArg(sdkRoot)} ` : '';
  const extraArgs = normalizeExtraEmulatorArgs(options.extraEmulatorArgs);
  const enableAudio = options.enableAudio === true;
  const argv = [envPrefix + `nohup ${quoteRemoteArg(emulator)}`, '-avd', quoteRemoteArg(avdName), '-no-window'];
  if (!enableAudio) argv.push('-no-audio');
  argv.push('-no-boot-anim', '-gpu', 'swiftshader_indirect');
  const reserved = new Set(RESERVED_EMULATOR_FLAGS);
  reserved.add('-no-audio');
  for (const arg of extraArgs) {
    if (reserved.has(arg)) throw new Error(`extra emulator arguments must not override ${arg}`);
    argv.push(quoteRemoteArg(arg));
  }
  argv.push('-port', String(consolePort));
  const command = `${argv.join(' ')} > ${quoteRemoteArg(logPath)} 2>&1 & echo "started:$!"`;
  return { command, consolePort, adbPort: consolePort + 1, logPath, extraArgs };
}

/** Build the fixed remote command that kills an emulator started by the plugin. */
export function buildRemoteEmulatorStopCommand(options = {}) {
  const consolePort = asConsolePort(options.consolePort == null ? 5554 : options.consolePort);
  const serial = `emulator-${consolePort}`;
  // Non-interactive SSH sessions do not inherit the login PATH, so resolve adb
  // from the profile SDK root when it is known instead of relying on `adb`.
  const adbPath = optionalRemotePath(options.adbPath, 'remote adb path') || 'adb';
  return {
    command: `${quoteRemoteArg(adbPath)} -s ${quoteRemoteArg(serial)} emu kill 2>&1 || true`,
    consolePort,
    serial,
    adbPath,
  };
}

/** Assemble the local `ssh` argv that runs a single remote command. */
export function buildSshCommandArgs(options = {}, command) {
  if (!command) throw new Error('buildSshCommandArgs requires a command');
  const sv = new SshAdbTunnel({ ...options, localPort: 15037 });
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=15',
    '-p',
    String(sv.sshPort),
  ];
  if (sv.keyPath) args.push('-i', sv.keyPath);
  args.push(`${sv.sshUser}@${sv.sshHost}`, command);
  return args;
}

/**
 * Run one bounded remote command over SSH and return `{ok, code, stdout,
 * stderr}`. Never throws for command failures; `options.exec` can be injected
 * for hermetic tests (shape: `(file, args, {timeoutMs}) => {code,stdout,stderr}`).
 */
export async function runSshCommand(options, command, execOptions = {}) {
  const args = buildSshCommandArgs(options, command);
  const timeoutMs = Number.isFinite(execOptions.timeoutMs) ? Math.max(1000, execOptions.timeoutMs) : 30000;
  const maxBytes = 64 * 1024;
  if (typeof execOptions.exec === 'function') {
    const result = await execOptions.exec('ssh', args, { timeoutMs, maxBytes });
    return { ok: !result.error && result.code === 0, code: result.code, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), error: result.error || null };
  }
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: error && error.message ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: null, stdout, stderr, error: `remote command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8').slice(0, maxBytes - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8').slice(0, maxBytes - stderr.length);
    });
    child.once('error', (error) => finish({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.once('exit', (code) => finish({ ok: code === 0, code, stdout, stderr, error: null }));
  });
}

// ---------------------------------------------------------------------------
// Multi-session remote VM manager.
//
// One manager owns N independent remote sessions (N SSH tunnels + N network adb
// serials), each backed by a RemoteVmInstance and optionally registered into an
// InstanceManager so the existing per-instance HTTP routes can serve it.
//
// Everything that touches the outside world is injectable for hermetic tests:
// `tunnelFactory`, `instanceFactory`, `exec` (ssh), `runSsh`, `now`,
// `findFreePort`, `sleep`. A test can therefore create/inspect/destroy sessions
// without spawning ssh or an emulator.
// ---------------------------------------------------------------------------

const REMOTE_CONSOLE_PORTS = Object.freeze(Array.from({ length: 65 }, (_, index) => 5554 + index * 2));
/** Remote command that lists listening TCP ports (Ubuntu: ss, fallback netstat). */
export const REMOTE_LISTEN_COMMAND = 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true';

/**
 * Parse listening TCP ports from `ss -ltn` or `netstat -ltn` output.
 * Tolerant by design: any line mentioning LISTEN contributes its `:port`
 * columns, which also covers localized/column-shifted outputs.
 */
export function parseRemoteListeningPorts(text) {
  const ports = [];
  const seen = new Set();
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!/\bLISTEN\b/i.test(line)) continue;
    for (const match of line.matchAll(/:(\d{1,5})(?!\d)/g)) {
      const port = Number(match[1]);
      if (port > 0 && port <= 65535 && !seen.has(port)) {
        seen.add(port);
        ports.push(port);
      }
    }
  }
  return ports;
}

function sanitizeSessionId(value, fallback = 'remote') {
  const text = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const id = text || fallback;
  return id === 'default' ? `remote-${id}` : id;
}

function asPortOption(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/**
 * Multi-session remote VM engine. Public API (all routes can call these):
 *
 *   const manager = new RemoteSessionManager({ dataDir, instances, scrcpyJarPath, onSessionCreated });
 *   await manager.listProfiles();                    // {ok, profiles}
 *   await manager.saveProfile(profile, {id});        // {} throws on invalid
 *   await manager.forgetProfile(id);                 // {} throws on invalid
 *   await manager.createSession({ profile, options }); // summary; throws on failure
 *   manager.list();                                  // [summary]
 *   await manager.state();                           // {ok, sessions, profiles, ...}
 *   await manager.reconnect(id, {relaunch?});
 *   await manager.disconnectSession(id, {killRemote});
 *   await manager.removeSession(id, {killRemote});
 *   manager.getInstance(id);                         // RemoteVmInstance | null
 *   await manager.dispose();
 *
 * `onSessionCreated(instance, record)` (constructor option) or
 * `options.onCreated(instance, record)` (per createSession call) is invoked
 * once the session is registered; use it to add the RemoteVmInstance to an
 * InstanceManager and register its HTTP routes.
 *
 * `createSession` options (runtime only; never persisted in the profile):
 *   launch/avdName/consolePort/remotePort/localPort, extraEmulatorArgs,
 *   enableAudio, id/name, attachInBackground, saveProfile, profileId,
 *   checkRemotePorts, connectTimeoutMs, launchTimeoutMs, portCheckTimeoutMs,
 *   connectRetryDelayMs, remoteStopTimeoutMs, scrcpy/adbPath/sdkRoot.
 */
export class RemoteSessionManager {
  constructor(options = {}) {
    this.options = options && typeof options === 'object' ? options : {};
    this.dataDir = String(this.options.dataDir || process.cwd());
    this.profileBook = this.options.profiles || new RemoteProfileBook({
      file: this.options.profilesFile || defaultRemoteProfilesPath(this.dataDir),
    });
    this.tunnelFactory = typeof this.options.tunnelFactory === 'function'
      ? this.options.tunnelFactory
      : (config) => new SshAdbTunnel(config);
    this.instanceFactory = typeof this.options.instanceFactory === 'function' ? this.options.instanceFactory : null;
    this.exec = typeof this.options.exec === 'function' ? this.options.exec : null;
    this.runSsh = typeof this.options.runSsh === 'function' ? this.options.runSsh : runSshCommand;
    this.now = typeof this.options.now === 'function' ? this.options.now : Date.now;
    this.findFreePort = typeof this.options.findFreePort === 'function' ? this.options.findFreePort : findFreePort;
    this.sleep = typeof this.options.sleep === 'function' ? this.options.sleep : sleep;
    this.logSink = typeof this.options.log === 'function' ? this.options.log : null;
    this.instances = this.options.instances && typeof this.options.instances === 'object' ? this.options.instances : null;
    this.onSession = typeof this.options.onSession === 'function' ? this.options.onSession : null;
    this.onSessionCreated = typeof this.options.onSessionCreated === 'function' ? this.options.onSessionCreated : null;
    this.onDisconnected = typeof this.options.onDisconnected === 'function' ? this.options.onDisconnected : null;
    this.maxSessions = Math.max(1, Math.min(16, Number(this.options.maxSessions) || 8));
    this.consolePorts = Array.isArray(this.options.consolePorts) && this.options.consolePorts.length
      ? this.options.consolePorts.map(Number).filter((port) => Number.isInteger(port) && port % 2 === 0 && port >= 5554 && port <= 5682)
      : [...REMOTE_CONSOLE_PORTS];
    this.connectTimeoutMs = Math.max(1000, Number(this.options.connectTimeoutMs) || 180000);
    this.launchTimeoutMs = Math.max(1000, Number(this.options.launchTimeoutMs) || 30000);
    this.portCheckTimeoutMs = Math.max(1000, Number(this.options.portCheckTimeoutMs) || 10000);
    this.remoteStopTimeoutMs = Math.max(1000, Number(this.options.remoteStopTimeoutMs) || 15000);
    this.connectRetryDelayMs = Math.max(10, Number(this.options.connectRetryDelayMs) || 2000);
    this.sessions = new Map();
    this._lock = Promise.resolve();
    this._disposed = false;
    this._RemoteVmInstance = null;
  }

  _log(line) {
    if (this.logSink) this.logSink(line);
  }

  async _withLock(run) {
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

  _summarize(record) {
    const tunnelStatus = record.tunnel && typeof record.tunnel.status === 'function' ? record.tunnel.status() : null;
    const vm = record.instance && record.instance.vm ? record.instance.vm : null;
    return {
      ok: true,
      id: record.id,
      kind: 'remote',
      state: record.state,
      error: record.error || null,
      profileId: record.profileId || null,
      name: record.profile.name || null,
      host: record.profile.host,
      user: record.profile.user,
      sshPort: record.profile.sshPort,
      avdName: record.avdName || '',
      serial: record.state === 'disconnected'
        ? null
        : (record.serial || (vm && (vm._serialActive || vm.serial)) || (tunnelStatus && tunnelStatus.serial) || null),
      localPort: record.localPort || (tunnelStatus && tunnelStatus.localPort) || 0,
      remotePort: record.remotePort,
      consolePort: record.consolePort || null,
      launch: record.launchInfo ? { ...record.launchInfo } : null,
      tunnel: tunnelStatus ? { ...tunnelStatus } : null,
      vmState: vm ? vm._state || 'stopped' : null,
      instanceId: record.instance ? record.instance.id : null,
      createdAt: record.createdAt,
      disconnectedAt: record.disconnectedAt || null,
    };
  }

  list() {
    return [...this.sessions.values()].map((record) => this._summarize(record));
  }

  get(id) {
    const record = this.sessions.get(String(id));
    return record ? this._summarize(record) : null;
  }

  getInstance(id) {
    const record = this.sessions.get(String(id));
    return record ? record.instance : null;
  }

  getSession(id) {
    const record = this.sessions.get(String(id));
    if (!record) return null;
    return { ...this._summarize(record), instance: record.instance, tunnel: record.tunnel, profile: record.profile };
  }

  async state() {
    const listed = await this.profileBook.list();
    const sessions = this.list();
    return {
      ok: true,
      sessions,
      profiles: Array.isArray(listed.profiles) ? listed.profiles : [],
      profilesFile: listed.file || this.profileBook.file || null,
      profilesError: listed.error || null,
      counts: {
        sessions: sessions.length,
        connected: sessions.filter((session) => session.state === 'connected').length,
      },
      maxSessions: this.maxSessions,
    };
  }

  async remoteState() {
    return this.state();
  }

  async listProfiles() {
    return this.profileBook.list();
  }

  async getProfile(id) {
    return this.profileBook.get(id);
  }

  async saveProfile(profile, options = {}) {
    const saved = await this.profileBook.save(profile, options);
    if (!saved.ok) throw new Error(saved.error || 'could not save the remote profile');
    return saved;
  }

  async forgetProfile(id) {
    const removed = await this.profileBook.forget(id);
    if (!removed.ok) throw new Error(removed.error || 'could not forget the remote profile');
    return removed;
  }

  async _remoteListeningPorts(profile, runtime) {
    if (runtime.checkRemotePorts === false) return { ok: false, ports: [], error: 'remote port check disabled' };
    const result = await this.runSsh(profile, REMOTE_LISTEN_COMMAND, {
      timeoutMs: this.portCheckTimeoutMs,
      exec: this.exec || undefined,
    });
    if (!result || result.ok !== true) {
      return { ok: false, ports: [], error: (result && (result.error || result.stderr)) || 'remote port check failed' };
    }
    return { ok: true, ports: parseRemoteListeningPorts(result.stdout), error: null };
  }

  /** Pick the first even console port not used by a session or listening remotely. */
  async _pickConsolePort(profile, runtime) {
    if (runtime.consolePort != null) return asConsolePort(runtime.consolePort);
    const used = new Set();
    for (const record of this.sessions.values()) {
      const other = record.profile;
      if (!other) continue;
      if (other.host !== profile.host || other.user !== profile.user || other.sshPort !== profile.sshPort) continue;
      if (record.consolePort) {
        used.add(record.consolePort);
        used.add(record.consolePort + 1);
      }
      if (record.remotePort) used.add(record.remotePort);
    }
    const checked = await this._remoteListeningPorts(profile, runtime);
    const listening = new Set(checked.ports);
    for (const candidate of this.consolePorts) {
      if (used.has(candidate) || listening.has(candidate) || listening.has(candidate + 1)) continue;
      return candidate;
    }
    throw new Error(
      `no free remote emulator console port available on ${profile.host} ` +
      `(tried ${this.consolePorts[0]}..${this.consolePorts[this.consolePorts.length - 1]})`,
    );
  }

  async _findLocalPort() {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = await this.findFreePort();
      if (Number.isInteger(candidate) && candidate > 0 && ![...this.sessions.values()].some((record) => record.localPort === candidate)) {
        return candidate;
      }
    }
    throw new Error('could not allocate a free local loopback port for the SSH tunnel');
  }

  async _allocateLocalPort(profile, runtime) {
    const requested = asPortOption(runtime.localPort, profile.localPort || 0);
    if (requested) {
      const inUseBySession = [...this.sessions.values()].some((record) => record.localPort === requested);
      if (!inUseBySession && await isLocalPortFree(requested)) return requested;
      this._log(`[remote] local port ${requested} is unavailable; allocating a free one`);
    }
    return this._findLocalPort();
  }

  async _runLaunch(profile, start) {
    const result = await this.runSsh(profile, start.command, {
      timeoutMs: this.launchTimeoutMs,
      exec: this.exec || undefined,
    });
    if (!result || result.ok !== true) {
      const detail = String((result && (result.stderr || result.stdout || result.error)) || 'ssh command failed')
        .trim()
        .slice(0, 500);
      throw new Error(
        `could not start the remote emulator on ${profile.host}: ${detail}; see ${start.logPath}`,
      );
    }
    return result;
  }

  _runtimeOptions(input) {
    const runtime = input && typeof input === 'object' ? input : {};
    return {
      ...runtime,
      launch: runtime.launch != null ? runtime.launch === true : null,
      extraEmulatorArgs: runtime.extraEmulatorArgs,
      enableAudio: runtime.enableAudio === true,
      connectTimeoutMs: Math.max(1000, Number(runtime.connectTimeoutMs) || this.connectTimeoutMs),
      launchTimeoutMs: Math.max(1000, Number(runtime.launchTimeoutMs) || this.launchTimeoutMs),
      portCheckTimeoutMs: Math.max(1000, Number(runtime.portCheckTimeoutMs) || this.portCheckTimeoutMs),
      connectRetryDelayMs: Math.max(10, Number(runtime.connectRetryDelayMs) || this.connectRetryDelayMs),
      remoteStopTimeoutMs: Math.max(1000, Number(runtime.remoteStopTimeoutMs) || this.remoteStopTimeoutMs),
    };
  }

  _instanceArgs({ id, profile, tunnel, launchInfo, runtime }) {
    return {
      id,
      profile,
      tunnel,
      launchInfo,
      options: {
        ...this.options.instanceOptions,
        sdkRoot: runtime.sdkRoot || this.options.sdkRoot,
        adbPath: runtime.adbPath || this.options.adbPath,
        scrcpyJarPath: runtime.scrcpyJarPath || this.options.scrcpyJarPath,
        scrcpyMaxSize: runtime.scrcpyMaxSize || this.options.scrcpyMaxSize,
        scrcpyBitrate: runtime.scrcpyBitrate || this.options.scrcpyBitrate,
        scrcpyMaxFps: runtime.scrcpyMaxFps || this.options.scrcpyMaxFps,
        connectTimeoutMs: runtime.connectTimeoutMs,
        connectRetryDelayMs: runtime.connectRetryDelayMs,
        remoteStopTimeoutMs: runtime.remoteStopTimeoutMs,
        exec: runtime.exec || this.exec || undefined,
        runSsh: this.runSsh,
        now: this.now,
        sleep: this.sleep,
        // Runtime-only media flags: AndroidVm stores them so a reconnect keeps
        // the camera/mic configuration (they are never persisted in the profile).
        extraEmulatorArgs: runtime.extraEmulatorArgs,
        enableAudio: runtime.enableAudio === true,
        vmOptions: runtime.vmOptions || this.options.vmOptions,
      },
      log: (line) => this._log(`[remote:${id}] ${line}`),
    };
  }

  async _newInstance(args) {
    if (this.instanceFactory) return await this.instanceFactory(args);
    if (!this._RemoteVmInstance) {
      const module = await import('./remote-instance.js');
      this._RemoteVmInstance = module.RemoteVmInstance;
    }
    return new this._RemoteVmInstance(args);
  }

  _registerInstance(instance) {
    if (!this.instances || typeof this.instances.addRemoteInstance !== 'function') return;
    this.instances.addRemoteInstance(instance);
  }

  _unregisterInstance(id) {
    if (this.instances && typeof this.instances.removeInstance === 'function') {
      try {
        this.instances.removeInstance(id);
      } catch {
        /* best effort: a stale entry is removed by InstanceManager.destroy */
      }
    }
  }

  /**
   * Create + start one remote session.
   *
   * Accepts `{ profile }` (raw/partial profile object) or `{ profile: '<id>' }`
   * / `{ profileId: '<id>' }` for a saved profile. Throws an actionable error on
   * failure; nothing stays registered in that case.
   */
  async createSession({ profile: profileInput, profileId: profileIdInput = null, options = {} } = {}) {
    if (this._disposed) throw new Error('RemoteSessionManager has been disposed');
    const runtime = this._runtimeOptions(options);
    let profile;
    let profileId = profileIdInput ? String(profileIdInput) : null;
    if (typeof profileInput === 'string') profileId = profileInput;
    if (profileId && (profileInput == null || typeof profileInput === 'string')) {
      const found = await this.profileBook.get(profileId);
      if (!found.ok) throw new Error(found.error || 'could not read the remote profiles file');
      if (!found.profile) throw new Error(`unknown remote profile: ${profileId}`);
      profile = normalizeRemoteProfile(found.profile);
    } else if (profileInput && typeof profileInput === 'object') {
      profile = normalizeRemoteProfile(profileInput);
    } else {
      throw new Error('createSession requires a remote profile object or profileId');
    }
    const launch = runtime.launch != null ? runtime.launch : profile.launch === true;
    if (launch) {
      const avdName = optionalAvdName(runtime.avdName || profile.avdName);
      if (!avdName) throw new Error('launch requires a remote AVD name (set the profile avdName)');
      profile = { ...profile, avdName };
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`max remote sessions reached (${this.maxSessions}); disconnect one first`);
    }
    return this._withLock(async () => {
      // Re-check inside the lock: concurrent creates must not overbook ports.
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`max remote sessions reached (${this.maxSessions}); disconnect one first`);
      }
      let consolePort = 0;
      let remotePort;
      if (launch) {
        consolePort = await this._pickConsolePort(profile, runtime);
        remotePort = consolePort + 1;
      } else {
        consolePort = runtime.consolePort != null
          ? asConsolePort(runtime.consolePort)
          : profile.consolePort || 0;
        remotePort = asPortOption(runtime.remotePort, profile.remotePort);
        if (runtime.remotePort == null && runtime.consolePort != null && remotePort === profile.remotePort) {
          remotePort = consolePort + 1;
        }
      }
      const duplicate = [...this.sessions.values()].find((record) => {
        if (record.state !== 'connected' && record.state !== 'connecting') return false;
        if (record.profile.host !== profile.host || record.profile.user !== profile.user || record.profile.sshPort !== profile.sshPort) return false;
        if (launch) return record.avdName === profile.avdName;
        return record.remotePort === remotePort;
      });
      if (duplicate) {
        throw new Error(
          `remote ${launch ? `AVD ${profile.avdName}` : `adb port ${remotePort}`} on ${profile.host} ` +
          `is already used by session ${duplicate.id}`,
        );
      }
      const localPort = await this._allocateLocalPort(profile, runtime);
      let launchInfo = null;
      if (launch) {
        const start = buildRemoteEmulatorStartCommand({
          avdName: profile.avdName,
          consolePort,
          emulatorPath: profile.emulatorPath,
          sdkRoot: profile.sdkRoot,
          extraEmulatorArgs: runtime.extraEmulatorArgs,
          enableAudio: runtime.enableAudio,
        });
        await this._runLaunch(profile, start);
        launchInfo = {
          consolePort: start.consolePort,
          adbPort: start.adbPort,
          logPath: start.logPath,
          startedAt: this.now(),
        };
      }
      const tunnel = this.tunnelFactory({
        host: profile.host,
        user: profile.user,
        sshPort: profile.sshPort,
        keyPath: profile.keyPath,
        sshPath: profile.sshPath,
        remotePort,
        localPort,
      });
      let started;
      try {
        started = await tunnel.start();
      } catch (error) {
        try { await tunnel.stop(); } catch { /* best effort */ }
        this._log(`[remote] tunnel start failed for ${profile.host}: ${error && error.message ? error.message : error}`);
        throw new Error(`SSH tunnel from ${profile.host} failed: ${error && error.message ? error.message : String(error)}`);
      }
      const serial = (started && started.serial) || (tunnel.status ? tunnel.status().serial : null);
      if (!serial) {
        try { await tunnel.stop(); } catch { /* best effort */ }
        throw new Error('SSH tunnel started but did not expose a loopback adb serial');
      }
      const baseId = sanitizeSessionId(runtime.id || runtime.name || (profileId ? `remote-${profileId}` : `remote-${profile.avdName || profile.host}-${remotePort}`));
      let id = baseId;
      let suffix = 1;
      while (this.sessions.has(id)) id = `${baseId}-${suffix++}`;
      let instance;
      try {
        instance = await this._newInstance(this._instanceArgs({ id, profile, tunnel, launchInfo, runtime }));
        if (!instance || typeof instance.start !== 'function') throw new Error('remote instance factory returned an invalid instance');
      } catch (error) {
        try { await tunnel.stop(); } catch { /* best effort */ }
        throw new Error(`could not create the remote VM instance: ${error && error.message ? error.message : String(error)}`);
      }
      // HTTP callers should get their session summary back quickly; the
      // (potentially long) wait for Android boot continues in the background.
      // Pass `attachInBackground:false` to wait for boot inside createSession.
      const attachInBackground = runtime.attachInBackground !== false;
      try {
        if (attachInBackground) {
          await instance.start({ wait: false, attachInBackground: true });
        } else {
          await instance.start();
        }
      } catch (error) {
        try { if (typeof instance.stop === 'function') await instance.stop(); } catch { /* best effort */ }
        try { await tunnel.stop(); } catch { /* best effort */ }
        throw error;
      }
      const record = {
        id,
        profile,
        profileId,
        avdName: profile.avdName,
        tunnel,
        instance,
        launchInfo,
        consolePort: launchInfo ? consolePort : consolePort || null,
        remotePort,
        localPort: Number(tunnel.localPort) || Number(started.localPort) || localPort,
        serial,
        state: 'connected',
        error: null,
        runtime,
        createdAt: this.now(),
      };
      try {
        this._registerInstance(instance);
      } catch (error) {
        try { if (typeof instance.stop === 'function') await instance.stop(); } catch { /* best effort */ }
        try { await tunnel.stop(); } catch { /* best effort */ }
        throw new Error(`could not register the remote instance for routing: ${error && error.message ? error.message : String(error)}`);
      }
      this.sessions.set(id, record);
      this._log(
        `[remote] session ${id} connected (${profile.user}@${profile.host}, avd=${profile.avdName || '-'}, ` +
        `serial=${serial}, remote adb=${remotePort}, local=${record.localPort})`,
      );
      // Let the caller route the new instance: `onSessionCreated(instance,
      // record)` from the constructor options or `options.onCreated` per call.
      const onCreated = typeof runtime.onCreated === 'function' ? runtime.onCreated : this.onSessionCreated;
      if (onCreated) {
        try {
          onCreated(instance, record);
        } catch {
          /* observer callbacks are best effort */
        }
      }
      const summary = this._summarize(record);
      if (this.onSession) {
        try {
          this.onSession(summary);
        } catch {
          /* observer callbacks are best effort */
        }
      }
      return summary;
    });
  }

  async reconnect(id, options = {}) {
    if (this._disposed) throw new Error('RemoteSessionManager has been disposed');
    const record = this.sessions.get(String(id));
    if (!record) throw new Error(`unknown remote session: ${id}`);
    const runtime = this._runtimeOptions(options);
    return this._withLock(async () => {
      record.error = null;
      record.state = 'connecting';
      try {
        if (runtime.relaunch === true && record.launchInfo && record.launchInfo.consolePort) {
          await record.instance.stop({ killRemote: true }).catch(() => {});
          const start = buildRemoteEmulatorStartCommand({
            avdName: record.profile.avdName,
            consolePort: record.launchInfo.consolePort,
            emulatorPath: record.profile.emulatorPath,
            sdkRoot: record.profile.sdkRoot,
            extraEmulatorArgs: record.runtime.extraEmulatorArgs,
            enableAudio: record.runtime.enableAudio === true,
          });
          await this._runLaunch(record.profile, start);
        }
        await record.instance.start();
        record.state = 'connected';
        record.disconnectedAt = null;
        record.serial = record.instance.serial || record.serial;
        record.localPort = Number(record.tunnel.localPort) || record.localPort;
      } catch (error) {
        record.state = 'error';
        record.error = error && error.message ? error.message : String(error);
        throw error;
      }
      return this._summarize(record);
    });
  }

  /**
   * Stop the tunnel + detach the remote device. The session record is kept
   * (`state:'disconnected'`) unless `remove: true`, so `reconnect(id)` can
   * reopen it later.
   */
  async disconnectSession(id, { killRemote = false, remove = false } = {}) {
    const record = this.sessions.get(String(id));
    if (!record) return { ok: true, id: String(id), kind: 'remote', disconnected: false, removed: false };
    return this._withLock(async () => {
      let stop = null;
      let stopError = null;
      try {
        if (typeof record.instance.stop === 'function') stop = await record.instance.stop({ killRemote: killRemote === true });
      } catch (error) {
        stopError = error && error.message ? error.message : String(error);
        record.error = stopError;
      }
      record.state = 'disconnected';
      record.disconnectedAt = this.now();
      record.serial = null;
      if (remove) {
        this.sessions.delete(record.id);
        this._unregisterInstance(record.id);
      }
      const summary = this._summarize(record);
      if (this.onDisconnected) {
        try {
          this.onDisconnected(summary);
        } catch {
          /* observer callbacks are best effort */
        }
      }
      return { ...summary, disconnected: true, removed: remove === true, stop, stopError };
    });
  }

  async removeSession(id, { killRemote = false } = {}) {
    return this.disconnectSession(id, { killRemote, remove: true });
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const record of [...this.sessions.values()]) {
      try {
        if (record.instance && typeof record.instance.stop === 'function') await record.instance.stop({ killRemote: false });
      } catch {
        /* best effort */
      }
      this._unregisterInstance(record.id);
    }
    this.sessions.clear();
  }
}

