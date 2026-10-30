/**
 * dsh-apk-vm 鈥?Host half.
 *
 * Mounts the APK Virtual Machine bridge behind the Web server:
 *   GET  /apk-vm/state    VM lifecycle snapshot (adb/emulator state, display size)
 *   GET  /apk-vm/apks     discover *.apk files under the configured roots
 *   POST /apk-vm/vm       { action: 'start' | 'stop' | 'restart' }
 *   POST /apk-vm/install  { path }  install + launch one APK inside the VM
 *   GET  /apk-vm/frame    latest PNG frame (screencap; polled by the sidebar panel)
 *   POST /apk-vm/input    tap / swipe / key / text forwarded to the VM
 *
 * The Android runtime is an open-source AOSP Android Emulator (software TCG when
 * no hypervisor is available), driven through adb by lib/android.js. The design
 * and the open-source framework choices are documented in README.md / DESIGN.md.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AndroidVm } from './lib/android.js';
import { InstanceManager } from './lib/instances.js';
import { ScrcpySession, annexbToAvcc, CONTROL_MESSAGE_TYPE } from './lib/scrcpy.js';
import { detectEnvironment, createAvd, installSystemImage, installSdkPackages, bootstrapSdk, DEFAULT_SYSTEM_IMAGE } from './lib/setup.js';
import { acceptWebSocket } from './lib/ws.js';
import { parseUiHierarchy, decorateUiNodes, buildInspectorPayload } from './lib/ui-inspector.js';
import { FlowRecorder } from './lib/flows.js';
import { collectStorage, cleanTempFiles, cleanSnapshots, cleanOrphanAvds, formatBytes } from './lib/storage.js';
import { buildApksFromAab, aabInfo, detectBundletool } from './lib/aab.js';
import { readHarFile, summarizeHar, filterHar, toCurl } from './lib/har.js';
import { runAssertions, compareScreenshot, createTestReport, reportMarkdown } from './lib/ui-tests.js';
import { SshAdbTunnel } from './lib/remote.js';

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

export const name = 'dsh-apk-vm';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRCPY_JAR = path.join(PLUGIN_DIR, 'lib', 'vendor', 'scrcpy-server-v5.0.1.jar');

/** Body limit for the JSON control endpoints. */
const BODY_LIMIT_BYTES = 64 * 1024;
/** Upload limit for browser APK uploads (500 MiB; Android emulator system apps are smaller). */
const UPLOAD_LIMIT_BYTES = 500 * 1024 * 1024;
/** Reuse one screencap for this long; a TCG frame is expensive to capture. */
const FRAME_TTL_MS = 200;
/** Cache `wm size` for a while to keep the 2 s status poll cheap. */
const SCREEN_TTL_MS = 15_000;

function isReady(vm) {
  return vm && vm.state === 'ready';
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: String(message || 'unknown error') });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error(`request body exceeds ${BODY_LIMIT_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Read a raw request body with a hard byte limit (browser APK upload). */
function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(new Error(`upload exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(error && error.message ? error : new Error(String(error))));
  });
}

/** Reject browser cross-origin requests to the local debug surface. */
/** When false (default), only requests originating on loopback may use the VM APIs. */
let ALLOW_REMOTE = false;

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isSameOrigin(req) {
  if (!ALLOW_REMOTE && !isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false;
  const host = String(req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false;
  return true;
}

/** Check whether a local TCP port is free for the scrcpy forward tunnel. */
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

async function pickScrcpyPort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = 28000 + Math.floor(Math.random() * 2000);
    if (await isPortFree(candidate)) return candidate;
  }
  return preferred;
}

function resolveRoots(ctx, configured) {
  const roots = [];
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.trim() && !roots.includes(candidate)) {
      roots.push(path.resolve(candidate));
    }
  };
  if (Array.isArray(configured)) configured.forEach(push);
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
    if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
      push(workingDirectory.defaultDirectory);
    }
  } catch {
    /* optional service */
  }
  push(process.cwd());
  push(os.homedir());
  return roots;
}

function resolveApkPath(candidate, roots) {
  const raw = String(candidate || '').trim();
  if (!raw) throw new Error('APK path is required');
  const paths = [raw];
  if (!path.isAbsolute(raw)) {
    for (const root of roots) paths.push(path.join(root, raw));
  }
  for (const p of paths) {
    try {
      const resolved = path.resolve(p);
      if (!/\.(?:apk|apks|xapk)$/i.test(resolved)) continue;
      if (existsSync(resolved)) return resolved;
    } catch {
      /* try next */
    }
  }
  throw new Error(`APK file not found: ${raw}`);
}

/**
 * Mount the routes and own the AndroidVm instance.
 * @param ctx cordis host context.
 * @param config optional row config: { roots, adbPath, sdkRoot, emulatorPath, avdName, serial, spawnEmulator }.
 */
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  ALLOW_REMOTE = cfg.allowRemote === true;
  const vm = new AndroidVm({
    sdkRoot: cfg.sdkRoot || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || undefined,
    adbPath: cfg.adbPath || undefined,
    emulatorPath: cfg.emulatorPath || undefined,
    avdName: cfg.avdName || undefined,
    serial: cfg.serial || undefined,
    port: cfg.port || undefined,
    emulatorArgs: Array.isArray(cfg.emulatorArgs) ? cfg.emulatorArgs : undefined,
    spawnEmulator: cfg.spawnEmulator !== false,
    apkRoots: Array.isArray(cfg.roots) ? cfg.roots : undefined,
    bootTimeoutMs: cfg.bootTimeoutMs || undefined,
    // Fast-boot strategy: host GPU + hypervisor detection + quick-boot snapshots.
    gpuMode: cfg.gpuMode || undefined,
    accel: cfg.accel || undefined,
    requireAccel: cfg.requireAccel !== false,
    quickBoot: cfg.quickBoot !== false,
    snapshotName: cfg.snapshotName || undefined,
    saveSnapshotAfterBoot: cfg.saveSnapshotAfterBoot !== false,
    dnsServers: Array.isArray(cfg.dnsServers) ? cfg.dnsServers.map(String) : undefined,
    networkMode: cfg.networkMode || undefined,
    tcpdumpPath: cfg.tcpdumpPath || undefined,
  });

  const instanceManager =
    cfg.multiInstance === false
      ? null
      : new InstanceManager({
          sdkRoot: vm.sdkRoot || cfg.sdkRoot || undefined,
          adbPath: vm.adbPath,
          emulatorPath: vm.emulatorPath,
          systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
          baseAvdName: cfg.avdName || 'dsh_apk',
          maxInstances: cfg.maxInstances || 3,
          gpuMode: cfg.gpuMode || 'host',
          snapshotName: cfg.snapshotName || 'default_boot',
          scrcpyJarPath: SCRCPY_JAR,
          scrcpyMaxSize: cfg.scrcpyMaxSize || 960,
          scrcpyBitrate: cfg.scrcpyBitrate || 6_000_000,
          scrcpyMaxFps: cfg.scrcpyMaxFps || 60,
          idleTimeoutMs: cfg.instanceIdleMs || 15 * 60 * 1000,
          dnsServers: Array.isArray(cfg.dnsServers) ? cfg.dnsServers.map(String) : undefined,
          networkMode: cfg.networkMode || undefined,
          tcpdumpPath: cfg.tcpdumpPath || undefined,
          log: (line) => vm._pushLog(line),
        });

  let lastApk = null;
  let lastClientReport = null;
  let serverOrigin = null;
  let registerInstanceRoutes = null;
  let disposeInstanceRoutes = null;
  const flowRecorder = new FlowRecorder();
  if (instanceManager) {
    instanceManager.onCreated = (id) => {
      registerInstanceRoutes?.(id);
    };
  }
  let installInFlight = null;
  let remoteTunnel = null;
  let startKick = null;
  let autoStartKicked = false;
  const frame = { buffer: null, at: 0, inFlight: null, receivedAt: [] };
  const screen = { value: null, at: 0 };
  const preferAutoStart = cfg.autoStart !== false;
  let streamFps = Number.isFinite(Number(cfg.frameFps)) ? Math.min(10, Math.max(1, Math.round(Number(cfg.frameFps)))) : 2;

  function measuredFrameFps() {
    const now = Date.now();
    const cutoff = now - 5000;
    while (frame.receivedAt.length && frame.receivedAt[0] < cutoff) frame.receivedAt.shift();
    if (frame.receivedAt.length < 2) return null;
    const span = now - frame.receivedAt[0];
    if (span <= 0) return null;
    return Math.round((frame.receivedAt.length / (span / 1000)) * 10) / 10;
  }

  /* ---- H.264 video stream (scrcpy) ---------------------------------- *
   * The PNG screencap path is capped near 1-2 fps by adb. For real frame
   * rates the plugin runs the Apache-2.0 scrcpy server (vendored jar), parses
   * its H.264 stream with lib/scrcpy.js, converts Annex-B 鈫?AVCC, and relays
   * the packets over a no-dependency WebSocket (/apk-vm/ws) to the panel,
   * which decodes them with WebCodecs VideoDecoder. Input still goes through
   * the existing /apk-vm/input routes.                                    */

  const scrcpyConfig = {
    enabled: cfg.scrcpy !== false,
    jarPath: cfg.scrcpyJarPath ? String(cfg.scrcpyJarPath) : SCRCPY_JAR,
    maxSize: Math.min(4096, Math.max(240, Number(cfg.scrcpyMaxSize) || 960)),
    bitrate: Math.max(500_000, Number(cfg.scrcpyBitrate) || 6_000_000),
    maxFps: Math.min(60, Math.max(1, Number(cfg.scrcpyMaxFps) || 60)),
    port: Number(cfg.scrcpyPort) || 27183,
  };
  const STREAM_PRESETS = Object.freeze({
    low: { maxSize: 540, bitrate: 2_500_000, maxFps: 30 },
    balanced: { maxSize: 720, bitrate: 4_000_000, maxFps: 60 },
    high: { maxSize: 960, bitrate: 6_000_000, maxFps: 60 },
  });
  let streamPreset = 'custom';
  for (const [name, preset] of Object.entries(STREAM_PRESETS)) {
    if (
      preset.maxSize === scrcpyConfig.maxSize &&
      preset.bitrate === scrcpyConfig.bitrate &&
      preset.maxFps === scrcpyConfig.maxFps
    ) {
      streamPreset = name;
      break;
    }
  }

  async function setStreamQuality(preset) {
    const name = String(preset || '').toLowerCase();
    const config = STREAM_PRESETS[name];
    if (!config) throw new Error(`unknown stream preset: ${preset || '(missing)'}`);
    scrcpyConfig.maxSize = config.maxSize;
    scrcpyConfig.bitrate = config.bitrate;
    scrcpyConfig.maxFps = config.maxFps;
    streamPreset = name;
    const wasActive = Boolean(scrcpyState && scrcpyState.session && scrcpyState.session.state === 'running');
    if (wasActive) await stopScrcpy();
    return {
      ok: true,
      preset: name,
      maxSize: config.maxSize,
      bitrate: config.bitrate,
      maxFps: config.maxFps,
      restarted: wasActive,
    };
  }
  let scrcpyState = null;
  let scrcpyIdleTimer = null;
  let scrcpyInitClients = null; // WeakSet of clients that already got the init JSON

  let setupCache = null;
  let setupCacheAt = 0;
  async function loadSetup(force = false) {
    const now = Date.now();
    if (!force && setupCache && now - setupCacheAt < 15000) return setupCache;
    setupCache = await detectEnvironment({
      sdkRoot: cfg.sdkRoot || undefined,
      adbPath: cfg.adbPath || undefined,
      emulatorPath: cfg.emulatorPath || undefined,
      avdName: cfg.avdName || undefined,
      systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
    });
    setupCacheAt = now;
    return setupCache;
  }

  function getScrcpyState() {
    if (scrcpyState) return scrcpyState;
    scrcpyInitClients = new WeakSet();
    scrcpyState = {
      session: null,
      startPromise: null,
      clients: new Set(),
      init: null,
      initSent: false,
      initSignature: null,
      dims: null,
      videoConfig: null,
      pending: [],
      lastError: null,
      fps: 0,
      frames: 0,
      fpsAt: 0,
    };
    return scrcpyState;
  }

  function scrcpyBroadcastText(payload) {
    const st = getScrcpyState();
    const text = JSON.stringify(payload);
    for (const client of st.clients) client.sendText(text);
  }

  function scrcpyBroadcastBinary(payload) {
    const st = getScrcpyState();
    for (const client of st.clients) client.sendBinary(payload);
  }

  function sendScrcpyInit(st) {
    if (!st.dims || !st.videoConfig) return;
    const signature = `${st.dims.width}x${st.dims.height}:${st.videoConfig.codecString}:${Buffer.from(st.videoConfig.avcC).toString('base64')}`;
    const changed = Boolean(st.initSignature && st.initSignature !== signature);
    if (changed) {
      // Rotation / encoder reset: every client must reconfigure its decoder.
      st.init = null;
      st.initSent = false;
      st.initSignature = null;
      st.pending = [];
      scrcpyInitClients = new WeakSet();
    }
    if (!st.init) {
      st.init = {
        type: 'init',
        codec: 'h264',
        codecString: st.videoConfig.codecString,
        description: Buffer.from(st.videoConfig.avcC).toString('base64'),
        width: st.dims.width,
        height: st.dims.height,
        maxFps: scrcpyConfig.maxFps,
        bitrate: scrcpyConfig.bitrate,
      };
    }
    if (scrcpyInitClients) {
      for (const client of st.clients) {
        if (scrcpyInitClients.has(client)) continue;
        scrcpyInitClients.add(client);
        client.sendText(JSON.stringify(st.init));
      }
    }
    st.initSignature = signature;
    if (st.initSent) return;
    st.initSent = true;
    const pending = st.pending.splice(0);
    for (const packet of pending) scrcpyBroadcastBinary(packet);
  }

  function scrcpyRecordFrame(st) {
    const now = Date.now();
    st.frames += 1;
    if (!st.fpsAt) st.fpsAt = now;
    if (now - st.fpsAt >= 1000) {
      st.fps = Math.round((st.frames / (now - st.fpsAt)) * 1000 * 10) / 10;
      st.frames = 0;
      st.fpsAt = now;
    }
  }

  function scrcpyStatus() {
    const st = scrcpyState;
    return {
      enabled: scrcpyConfig.enabled,
      active: Boolean(st && st.session && st.session.state === 'running'),
      clients: st ? st.clients.size : 0,
      fps: st ? st.fps : 0,
      maxFps: scrcpyConfig.maxFps,
      maxSize: scrcpyConfig.maxSize,
      bitrate: scrcpyConfig.bitrate,
      preset: streamPreset,
      width: st && st.dims ? st.dims.width : null,
      height: st && st.dims ? st.dims.height : null,
      error: st && st.lastError ? String(st.lastError.message || st.lastError) : null,
    };
  }

  async function stopScrcpy() {
    if (scrcpyIdleTimer) {
      clearTimeout(scrcpyIdleTimer);
      scrcpyIdleTimer = null;
    }
    const st = scrcpyState;
    if (!st) return;
    const session = st.session;
    st.session = null;
    st.startPromise = null;
    st.init = null;
    st.initSent = false;
    st.initSignature = null;
    st.dims = null;
    st.videoConfig = null;
    st.pending = [];
    st.frames = 0;
    st.fps = 0;
    st.fpsAt = 0;
    for (const client of st.clients) {
      try {
        client.close(1001, 'video stream stopped');
      } catch {
        /* ignore */
      }
    }
    st.clients.clear();
    if (session) {
      try {
        await session.stop();
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleScrcpyIdleStop() {
    if (scrcpyIdleTimer) clearTimeout(scrcpyIdleTimer);
    scrcpyIdleTimer = setTimeout(() => {
      scrcpyIdleTimer = null;
      const st = scrcpyState;
      if (st && st.clients.size === 0) void stopScrcpy();
    }, 15000);
    if (typeof scrcpyIdleTimer.unref === 'function') scrcpyIdleTimer.unref();
  }

  function ensureScrcpy() {
    const st = getScrcpyState();
    if (!scrcpyConfig.enabled) return Promise.reject(new Error('H.264 video stream is disabled'));
    if (st.session && st.session.state === 'running') return Promise.resolve(st);
    if (st.startPromise) return st.startPromise;
    st.startPromise = (async () => {
      try {
        if (!existsSync(scrcpyConfig.jarPath)) {
          throw new Error(`scrcpy server jar not found: ${scrcpyConfig.jarPath}`);
        }
        const status = await vm.status();
        if (!isReady(status)) throw new Error(`VM is not ready (state: ${status.state})`);
        try {
          await vm.ensureRoot();
        } catch {
          /* scrcpy server works as shell too */
        }
        const session = new ScrcpySession({
          adbPath: vm.adbPath,
          serial: status.serial,
          serverJarPath: scrcpyConfig.jarPath,
          port: await pickScrcpyPort(scrcpyConfig.port),
          maxSize: scrcpyConfig.maxSize,
          videoBitRate: scrcpyConfig.bitrate,
          maxFps: scrcpyConfig.maxFps,
          logLevel: 'warn',
        });
        st.session = session;
        st.init = null;
        st.initSent = false;
        st.initSignature = null;
        st.dims = null;
        st.videoConfig = null;
        st.pending = [];
        st.lastError = null;
        st.fps = 0;
        st.frames = 0;
        st.fpsAt = 0;
        session.onInit((payload) => {
          if (!payload || !payload.width || !payload.height) return;
          st.dims = { width: payload.width, height: payload.height };
          sendScrcpyInit(st);
        });
        session.onConfig((config) => {
          if (!config || !config.avcC) return;
          st.videoConfig = {
            avcC: Buffer.isBuffer(config.avcC) ? config.avcC : Buffer.from(config.avcC),
            codecString: config.codecString,
          };
          sendScrcpyInit(st);
        });
        session.onSession((payload) => {
          if (!payload || !payload.width || !payload.height) return;
          if (st.dims && st.dims.width === payload.width && st.dims.height === payload.height) return;
          st.dims = { width: payload.width, height: payload.height };
          sendScrcpyInit(st);
        });
        session.onVideo((packet) => {
          if (!packet || !packet.data || packet.isConfig) return;
          let avcc;
          try {
            avcc = annexbToAvcc(packet.data);
          } catch {
            return;
          }
          const pts = Math.max(0, Number(packet.pts) || 0);
          const buffer = Buffer.allocUnsafe(10 + avcc.length);
          buffer[0] = 1; // video packet
          buffer[1] = packet.isKeyFrame ? 1 : 0;
          buffer.writeBigInt64LE(BigInt(Math.round(pts)), 2);
          avcc.copy(buffer, 10);
          scrcpyRecordFrame(st);
          if (st.initSent) scrcpyBroadcastBinary(buffer);
          else if (st.pending.length < 240) st.pending.push(buffer);
        });
        session.onError((error) => {
          st.lastError = error instanceof Error ? error : new Error(String(error));
          scrcpyBroadcastText({ type: 'error', error: String(st.lastError.message || st.lastError) });
        });
        await session.start();
        return st;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        st.lastError = failure;
        const failed = st.session;
        st.session = null;
        if (failed) {
          try {
            await failed.stop();
          } catch {
            /* ignore */
          }
        }
        scrcpyBroadcastText({ type: 'error', error: String(failure.message || failure) });
        throw failure;
      } finally {
        st.startPromise = null;
      }
    })();
    return st.startPromise;
  }

  function handleScrcpyClient(client) {
    const st = getScrcpyState();
    st.clients.add(client);
    sendScrcpyInit(st);
    if (st.initSent && st.session && st.session.state === 'running') {
      // A late client only has delta frames; ask the encoder for a fresh keyframe.
      void Promise.resolve(st.session.sendEmptyMessage(CONTROL_MESSAGE_TYPE.RESET_VIDEO)).catch(() => {});
    }
    client.onClose(() => {
      st.clients.delete(client);
      if (st.clients.size === 0) scheduleScrcpyIdleStop();
    });
    client.onError(() => {
      st.clients.delete(client);
      if (st.clients.size === 0) scheduleScrcpyIdleStop();
    });
    ensureScrcpy().catch((error) => {
      const message = String((error && error.message) || error);
      client.sendText(JSON.stringify({ type: 'error', error: message }));
      client.close(1011, 'stream unavailable');
    });
  }

  const rootsFor = () => resolveRoots(ctx, cfg.roots);
  const snapshotApk = () => (lastApk ? { ...lastApk } : null);

  /** Resolve, install and launch one APK; shared by the HTTP route, upload and Agent tool. */
  async function installApkFromPath(candidate, options = {}) {
    let apkPath;
    if (options.trustedPath === true) {
      apkPath = path.resolve(String(candidate || ''));
      if (!/\.(?:apk|apks|xapk|aab)$/i.test(apkPath) || !existsSync(apkPath)) {
        throw new Error(`uploaded APK/bundle is missing or invalid: ${apkPath}`);
      }
    } else {
      apkPath = resolveApkPath(candidate, rootsFor());
    }
    if (/\.aab$/i.test(apkPath)) {
      const built = await buildApksFromAab({
        aabPath: apkPath,
        outDir: path.join(os.tmpdir(), 'dsh-apk-vm-aab'),
        mode: 'universal',
        bundletoolPath: options.bundletoolPath,
        javaPath: options.javaPath,
      });
      if (!built.ok) throw new Error(built.error || 'AAB conversion failed; install bundletool and retry');
      apkPath = built.apksPath;
    }
    const status = await vm.status();
    if (!isReady(status)) throw new Error(`VM is not ready (state: ${status.state}); start it first`);
    const meta = await vm.installApk(apkPath);
    lastApk = {
      path: apkPath,
      packageName: meta.packageName || null,
      label: meta.label || path.basename(apkPath),
      launchActivity: meta.launchActivity || null,
      launched: meta.launched !== false,
      installedAt: Date.now(),
      bundle: meta.bundle || null,
    };
    frame.buffer = null;
    frame.at = 0;
    // Persist the installed app into the quick-boot image so the next start
    // restores straight into the installed state.
    void vm.saveSnapshot().catch(() => {});
    return { ...lastApk };
  }

  const uploadDir = path.join(os.tmpdir(), 'dsh-apk-vm-uploads');
  async function prepareUploadDir() {
    await fsp.mkdir(uploadDir, { recursive: true });
    // Best-effort stale cleanup; uploaded APKs are only needed for this session.
    try {
      const entries = await fsp.readdir(uploadDir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        const file = path.join(uploadDir, entry);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat && stat.isFile() && stat.mtimeMs < cutoff) await fsp.rm(file, { force: true }).catch(() => {});
      }
    } catch {
      /* cleanup is best effort */
    }
    return uploadDir;
  }
  async function cleanupUploads() {
    await fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  }

  /** Resolve a host-side path for debug push/pull, confined to the scan roots + temp. */
  function resolveDebugLocal(candidate, mustExist) {
    const raw = String(candidate || '').trim();
    if (!raw) throw new Error('local path is required');
    const roots = [...rootsFor(), os.tmpdir()];
    const candidates = [raw];
    if (!path.isAbsolute(raw)) for (const root of roots) candidates.push(path.join(root, raw));
    for (const value of candidates) {
      try {
        const resolved = path.resolve(value);
        const allowed = roots.some((root) => {
          const base = path.resolve(root);
          return resolved === base || resolved.startsWith(base + path.sep);
        });
        if (!allowed) continue;
        if (!mustExist || existsSync(resolved)) return resolved;
      } catch {
        /* try next */
      }
    }
    throw new Error(
      mustExist ? `local file not found under an allowed root: ${raw}` : `local path must be under ${roots.join(', ')}`,
    );
  }

  /** Idempotent background start used by prewarm / auto-start / the Start button. */
  function ensureStarted() {
    if (startKick) return startKick;
    startKick = vm
      .start()
      .catch((error) => {
        if (typeof console !== 'undefined' && typeof console.log === 'function') {
          console.log(`[apk-vm] background start failed: ${error && error.message ? error.message : error}`);
        }
      })
      .finally(() => {
        startKick = null;
      });
    return startKick;
  }

  function maybeAutoStart(status) {
    if (!preferAutoStart || autoStartKicked) return;
    if (!status || status.state !== 'stopped') return;
    if (!cfg.emulatorPath && !cfg.serial) return; // nothing this plugin can start
    if (status.serial) return;
    autoStartKicked = true;
    void ensureStarted();
  }

  async function getFrame() {
    if (frame.buffer && Date.now() - frame.at < FRAME_TTL_MS) return frame.buffer;
    if (frame.inFlight) return frame.inFlight;
    frame.inFlight = vm
      .screenshot()
      .then((buffer) => {
        frame.buffer = buffer;
        frame.at = Date.now();
        return buffer;
      })
      .finally(() => {
        frame.inFlight = null;
      });
    return frame.inFlight;
  }

  async function getScreen(serial) {
    if (screen.value && Date.now() - screen.at < SCREEN_TTL_MS) return screen.value;
    try {
      const size = await vm.screenSize();
      if (size && size.width > 0 && size.height > 0) {
        screen.value = { width: size.width, height: size.height, serial };
        screen.at = Date.now();
      }
      return screen.value;
    } catch {
      return screen.value;
    }
  }

  async function stateBody() {
    const status = await vm.status();
    const ready = status && status.state === 'ready';
    let display = null;
    if (ready) display = await getScreen(status.serial);
    maybeAutoStart(status);
    return {
      ok: true,
      pluginVersion: PLUGIN_VERSION,
      vm: {
        state: status.state,
        serial: status.serial || null,
        avd: status.avd || null,
        bootMs: status.bootMs ?? null,
        bootKind: status.bootKind || null,
        quickBoot: status.quickBoot !== false,
        snapshotName: status.snapshotName || null,
        snapshotAvailable: status.snapshotAvailable === true,
        gpuMode: status.gpuMode || null,
        accel: status.accel === true ? 'hardware' : status.accel === false ? 'software' : null,
        root: status.root === true,
        debugPrepared: status.debugPrepared === true,
        debugToolkit: status.debugToolkit || null,
        identity: status.identity || null,
        error: status.error || null,
        logTail: Array.isArray(status.logTail) ? status.logTail.slice(-40) : [],
      },
      screen: display ? { width: display.width, height: display.height } : null,
      apk: snapshotApk(),
      installing: Boolean(installInFlight),
      warming: Boolean(startKick),
      stream: { fps: streamFps, hostFps: measuredFrameFps(), h264: scrcpyStatus() },
      origin: serverOrigin,
      multiInstance: Boolean(instanceManager),
      client: lastClientReport,
      instances: [
        {
          id: 'default',
          kind: 'default',
          avdName: status.avd || vm.avdName || null,
          port: vm.port || null,
          state: status.state,
          serial: status.serial || null,
          root: status.root === true,
          apk: snapshotApk(),
          owner: instanceManager ? instanceManager.defaultOwner : null,
          lastUsedAt: null,
          idleMs: null,
          videoClients: null,
        },
        ...(instanceManager ? instanceManager.list() : []),
      ],
      roots: rootsFor(),
    };
  }

  function mountRoutes(webServer) {
    try {
      serverOrigin = webServer.getOrigin();
    } catch {
      serverOrigin = null;
    }
    const disposers = [];
    const wrapHandler = (handler) => async (req, res) => {
      if (!isSameOrigin(req)) {
        sendError(res, 403, 'cross-origin request rejected');
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        sendError(res, 500, error && error.message ? error.message : error);
      }
    };
    const register = (pathname, handler) => {
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: pathname,
          handler: wrapHandler(handler),
        }),
      );
    };

    async function handleFlowRequest(req, res, instanceId, inputFn) {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          instance: instanceId,
          recording: flowRecorder.isRecording(instanceId),
          flows: await flowRecorder.list(instanceId),
        });
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      try {
        if (action === 'start') {
          const flow = flowRecorder.start(instanceId, body.name);
          sendJson(res, 200, { ok: true, action, ...flow });
          return;
        }
        if (action === 'stop') {
          const flow = await flowRecorder.stop(instanceId);
          sendJson(res, 200, { ok: true, action, ...flow });
          return;
        }
        if (action === 'replay') {
          if (!body.id) throw new Error('replay requires id');
          const result = await flowRecorder.replay(body.id, inputFn, { instanceId });
          sendJson(res, 200, { ok: true, action, ...result });
          return;
        }
        if (action === 'delete') {
          if (!body.id) throw new Error('delete requires id');
          const removed = await flowRecorder.remove(body.id, instanceId);
          sendJson(res, 200, { ok: true, action, removed });
          return;
        }
        throw new Error(`unsupported flow action: ${action || '(missing)'}`);
      } catch (error) {
        sendError(res, 400, error.message);
      }
    }

    register('/apk-vm/flows', async (req, res) => {
      await handleFlowRequest(req, res, 'default', async (payload) => {
        const status = await vm.status();
        if (!isReady(status)) throw new Error(`VM is not ready (state: ${status.state})`);
        return vm.input(payload);
      });
    });

    function storageSdkRoot() {
      if (vm.sdkRoot) return vm.sdkRoot;
      if (vm.adbPath) return path.dirname(path.dirname(vm.adbPath));
      return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
    }

    register('/apk-vm/storage', async (req, res) => {
      const known = () => {
        const names = new Set();
        if (vm.avdName) names.add(vm.avdName);
        if (instanceManager) {
          for (const item of instanceManager.list()) if (item.avdName) names.add(item.avdName);
        }
        return [...names];
      };
      const active = () => {
        const names = new Set();
        if (vm.avdName && ['ready', 'booting', 'starting'].includes(vm._state)) names.add(vm.avdName);
        if (instanceManager) {
          for (const item of instanceManager.list()) {
            if (item.avdName && ['ready', 'booting', 'starting'].includes(item.state)) names.add(item.avdName);
          }
        }
        return [...names];
      };
      if (req.method === 'GET') {
        try {
          sendJson(
            res,
            200,
            await collectStorage({
              sdkRoot: storageSdkRoot(),
              avdRoot: undefined,
              knownAvds: known(),
              activeAvds: active(),
            }),
          );
        } catch (error) {
          sendError(res, 500, error.message);
        }
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      try {
        let result;
        if (action === 'temp') {
          result = await cleanTempFiles();
        } else if (action === 'snapshots') {
          if (body.confirm !== true) throw new Error('snapshot cleanup requires confirm:true');
          const name = String(body.avdName || vm.avdName || 'dsh_apk');
          if (active().includes(name)) throw new Error(`AVD ${name} is active; stop it before deleting snapshots`);
          result = await cleanSnapshots({ avdName: name });
        } else if (action === 'orphan-avds') {
          if (body.confirm !== true) throw new Error('orphan AVD cleanup requires confirm:true');
          result = await cleanOrphanAvds({ knownAvds: known(), activeAvds: active() });
        } else {
          throw new Error(`unsupported storage action: ${action || '(missing)'}`);
        }
        sendJson(res, 200, result);
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/state', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET only');
        return;
      }
      sendJson(res, 200, await stateBody());
    });

    register('/apk-vm/setup', async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost');
        sendJson(res, 200, await loadSetup(url.searchParams.get('force') === '1'));
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      if (action === 'refresh') {
        sendJson(res, 200, { ok: true, setup: await loadSetup(true) });
        return;
      }
      if (action === 'create-avd') {
        const result = await createAvd({
          sdkRoot: cfg.sdkRoot || undefined,
          emulatorPath: cfg.emulatorPath || undefined,
          avdName: body.avdName || cfg.avdName || 'dsh_apk',
          systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
        });
        setupCache = null;
        sendJson(res, 200, { ok: result.ok === true, action, result });
        return;
      }
      if (action === 'install-image') {
        if (cfg.allowSetupDownloads !== true && body.confirmDownload !== true) {
          sendError(res, 403, 'downloading Android system images is disabled; set allowSetupDownloads: true to enable it');
          return;
        }
        const result = await installSystemImage({
          sdkRoot: cfg.sdkRoot || undefined,
          systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
          acceptLicenses: true,
        });
        setupCache = null;
        sendJson(res, 200, { ok: result.ok === true, action, result });
        return;
      }
      if (action === 'install-tools') {
        if (cfg.allowSetupDownloads !== true && body.confirmDownload !== true) {
          sendError(res, 403, 'downloading Android SDK components is disabled; set allowSetupDownloads: true to enable it');
          return;
        }
        const image = String(cfg.systemImage || DEFAULT_SYSTEM_IMAGE);
        const apiLevel = (image.split(';')[1] || 'android-34').replace(/^android-/, '');
        const packages = Array.isArray(body.packages) && body.packages.length
          ? body.packages
          : ['platform-tools', 'emulator', `build-tools;${apiLevel}.0.0`, `platforms;android-${apiLevel}`];
        const result = await installSdkPackages({
          sdkRoot: cfg.sdkRoot || undefined,
          packages,
          acceptLicenses: true,
        });
        setupCache = null;
        sendJson(res, 200, { ok: result.ok === true, action, result });
        return;
      }
      if (action === 'bootstrap-sdk') {
        if (cfg.allowSetupDownloads !== true && body.confirmDownload !== true) {
          sendError(res, 403, 'downloading Android SDK components is disabled; set allowSetupDownloads: true to enable it');
          return;
        }
        const result = await bootstrapSdk({
          sdkRoot: cfg.sdkRoot || undefined,
          packages: Array.isArray(body.packages) ? body.packages : undefined,
          acceptLicenses: true,
        });
        setupCache = null;
        sendJson(res, 200, { ok: result.ok === true, action, result });
        return;
      }
      sendError(res, 400, `unsupported setup action: ${action || '(missing)'}`);
    });

    register('/apk-vm/instances', async (req, res) => {
      if (!instanceManager) {
        sendError(res, 503, 'multi-instance support is disabled');
        return;
      }
      if (req.method === 'GET') {
        const defaultStatus = await vm.status();
        if (instanceManager) {
          for (const instance of instanceManager.instances.values()) {
            try {
              ensureExtraRouteSet(instance.id);
            } catch {
              /* route registration is best effort */
            }
          }
        }
        sendJson(res, 200, {
          ok: true,
          maxInstances: instanceManager.maxInstances,
          instances: [
            {
              id: 'default',
              kind: 'default',
              avdName: defaultStatus.avd || vm.avdName || null,
              port: vm.port || null,
              state: defaultStatus.state,
              serial: defaultStatus.serial || null,
              root: defaultStatus.root === true,
              apk: snapshotApk(),
              owner: instanceManager.defaultOwner,
              lastUsedAt: null,
              idleMs: null,
              videoClients: null,
            },
            ...instanceManager.list(),
          ],
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const instance = await instanceManager.create({ name: body.name });
          registerInstanceRoutes?.(instance.id);
          if (body.start === true) void instance.start();
          sendJson(res, 201, {
            ok: true,
            instance: {
              id: instance.id,
              kind: 'extra',
              avdName: instance.avdName,
              port: instance.port,
              state: instance.vm.state,
              serial: instance.vm._serialActive || null,
            },
            maxInstances: instanceManager.maxInstances,
          });
        } catch (error) {
          sendError(res, 400, error.message);
        }
        return;
      }
      sendError(res, 405, 'GET or POST only');
    });

    async function handleExtraRequest(req, res, forcedId, forcedRest) {
      if (!instanceManager) {
        sendError(res, 503, 'multi-instance support is disabled');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const id = String(forcedId || '');
      const rest = String(forcedRest || '');
      const instance = instanceManager.get(id);
      if (!instance) {
        sendError(res, 404, `unknown instance: ${id || '(missing)'}`);
        return;
      }
      const ready = async () => {
        const status = await instance.status();
        if (status.state !== 'ready') {
          sendJson(res, 409, { ok: false, error: `instance ${id} is not ready (state: ${status.state})` });
          return false;
        }
        return true;
      };
      const instanceState = async () => {
        const status = await instance.status();
        let display = null;
        if (status.state === 'ready') {
          try {
            display = await instance.vm.screenSize();
          } catch {
            display = null;
          }
        }
        return {
          ok: true,
          pluginVersion: PLUGIN_VERSION,
          instance: { id: instance.id, kind: 'extra', avdName: instance.avdName, port: instance.port },
          vm: {
            state: status.state,
            serial: status.serial || null,
            avd: instance.avdName,
            bootMs: status.bootMs ?? null,
            bootKind: status.bootKind || null,
            quickBoot: true,
            snapshotName: instance.vm.snapshotName,
            snapshotAvailable: Boolean(instance.vm._snapshotPresent()),
            gpuMode: instance.vm.gpuMode,
            accel: instance.vm.accel?.available === false ? 'software' : 'hardware',
            root: status.root === true,
            debugPrepared: status.debugPrepared === true,
            error: status.error || null,
            logTail: Array.isArray(status.logTail) ? status.logTail.slice(-40) : [],
          },
          screen: display ? { width: display.width, height: display.height } : null,
          apk: instance.snapshotApk(),
          installing: Boolean(instance.installInFlight),
          origin: serverOrigin,
          stream: { fps: 2, hostFps: null, h264: instance.videoStatus ? instance.videoStatus() : { enabled: false, active: false, clients: 0, maxFps: 0 } },
        };
      };

      if (!rest) {
        if (req.method === 'DELETE') {
          await instanceManager.destroy(id);
          disposeInstanceRoutes?.(id);
          sendJson(res, 200, { ok: true, id, destroyed: true });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, await instanceState());
          return;
        }
        sendError(res, 405, 'GET or DELETE only');
        return;
      }
      if (rest === 'state' && req.method === 'GET') {
        sendJson(res, 200, await instanceState());
        return;
      }
      if (rest === 'frame' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!(await ready())) return;
        const png = await instance.framePng();
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(png);
        return;
      }
      if (rest === 'vm' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const action = String(body.action || '').toLowerCase();
        if (action === 'start' || action === 'warm') {
          void instance.start();
          sendJson(res, 202, { ok: true, action, accepted: true, instance: id });
          return;
        }
        if (action === 'stop') {
          const snapshot = await instance.stop();
          sendJson(res, 200, { ok: true, action, vm: snapshot, instance: id });
          return;
        }
        if (action === 'restart') {
          void instance.restart();
          sendJson(res, 202, { ok: true, action, accepted: true, instance: id });
          return;
        }
        if (action === 'snapshot') {
          sendJson(res, 200, { ok: true, action, ...(await instance.saveSnapshot(body.name)) });
          return;
        }
        sendError(res, 400, `unsupported action: ${action || '(missing)'}`);
        return;
      }
      if (rest === 'input' && req.method === 'POST') {
        if (!(await ready())) return;
        const body = await readJsonBody(req);
        flowRecorder.record(id, body);
        await instance.input(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (rest === 'flows') {
        await handleFlowRequest(req, res, id, async (payload) => {
          const status = await instance.status();
          if (status.state !== 'ready') throw new Error(`instance ${id} is not ready (state: ${status.state})`);
          return instance.input(payload);
        });
        return;
      }
      if (rest === 'snapshots') {
        if (req.method === 'GET') {
          sendJson(res, 200, instance.vm.listNamedSnapshots());
          return;
        }
        if (req.method !== 'POST') {
          sendError(res, 405, 'GET or POST only');
          return;
        }
        const body = await readJsonBody(req);
        const action = String(body.action || '').toLowerCase();
        try {
          if (action === 'save') sendJson(res, 200, await instance.vm.saveNamedSnapshot(body.name));
          else if (action === 'load') sendJson(res, 200, await instance.vm.loadNamedSnapshot(body.name));
          else if (action === 'delete') sendJson(res, 200, await instance.vm.deleteNamedSnapshot(body.name));
          else throw new Error(`unsupported snapshot action: ${action || '(missing)'}`);
        } catch (error) {
          sendError(res, 400, error.message);
        }
        return;
      }
      if (rest === 'network') {
        if (!(await ready())) return;
        if (req.method === 'GET') {
          sendJson(res, 200, await instance.vm.networkInfo());
          return;
        }
        if (req.method !== 'POST') {
          sendError(res, 405, 'GET or POST only');
          return;
        }
        const body = await readJsonBody(req);
        const action = String(body.action || '').toLowerCase();
        try {
          let result;
          if (action === 'mode') result = instance.vm.setNetworkMode(body.mode);
          else if (action === 'dns') result = await instance.vm.setDnsServers(body.servers);
          else if (action === 'hosts') result = await instance.vm.setHosts(body.entries);
          else if (action === 'test') result = await instance.vm.testNetwork(body);
          else if (action === 'pcap') result = instance.vm.setTcpdumpPath(body.path);
          else if (action === 'forward-add') result = await instance.vm.addPortForward(body.localPort, body.remotePort, { shared: body.shared === true });
          else if (action === 'forward-remove') result = await instance.vm.removePortForward(body.localPort);
          else throw new Error(`unsupported network action: ${action || '(missing)'}`);
          sendJson(res, 200, result);
        } catch (error) {
          sendError(res, 400, error.message);
        }
        return;
      }
      if (rest === 'network/pcap') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'GET or HEAD only');
          return;
        }
        const tcpdumpPath = instance.vm.tcpdumpPath;
        if (!tcpdumpPath || !existsSync(tcpdumpPath)) {
          sendError(res, 404, 'pcap capture is not configured or has no file yet');
          return;
        }
        const stat = await fsp.stat(tcpdumpPath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.tcpdump.pcap',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${path.basename(tcpdumpPath)}"`,
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(tcpdumpPath).pipe(res);
        return;
      }
      if (rest === 'touch' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const action = String(body.action || '').toLowerCase();
        if (!['down', 'move', 'up', 'cancel'].includes(action)) {
          sendError(res, 400, 'action must be down|move|up|cancel');
          return;
        }
        await instance.sendTouch({ action, pointerId: body.pointerId, x: body.x, y: body.y });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (rest === 'clipboard' && (req.method === 'GET' || req.method === 'POST')) {
        if (req.method === 'GET') {
          try {
            sendJson(res, 200, { ok: true, text: await instance.getClipboard() });
          } catch (error) {
            sendError(res, 504, error && error.message ? error.message : String(error));
          }
          return;
        }
        const body = await readJsonBody(req);
        if (typeof body.text !== 'string') {
          sendError(res, 400, 'text must be a string');
          return;
        }
        const result = await instance.setClipboard(body.text, body.paste === true);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (rest === 'install' && req.method === 'POST') {
        if (!(await ready())) return;
        const body = await readJsonBody(req);
        const apkPath = resolveApkPath(body.path, rootsFor());
        sendJson(res, 200, { ok: true, ...(await instance.installApk(apkPath)) });
        return;
      }
      if (rest === 'upload' && req.method === 'POST') {
        if (!(await ready())) return;
        let name = 'upload.apk';
        try {
          name = decodeURIComponent(String(req.headers['x-apk-name'] || 'upload.apk'));
        } catch {
          name = 'upload.apk';
        }
        name = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_') || 'upload.apk';
        if (!/\.(?:apk|aab)$/i.test(name)) name += '.apk';
        const data = await readRawBody(req, UPLOAD_LIMIT_BYTES);
        if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
          sendError(res, 400, 'uploaded file is not a ZIP/APK');
          return;
        }
        const dir = await prepareUploadDir();
        const target = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
        await fsp.writeFile(target, data);
        sendJson(res, 200, { ok: true, ...(await instance.installApk(target)), upload: { fileName: name, bytes: data.length } });
        return;
      }
      if (rest.startsWith('debug/')) {
        const op = rest.slice('debug/'.length);
        if (op === 'info' && req.method === 'GET') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.deviceInfo());
          return;
        }
        if (op === 'shell' && req.method === 'POST') {
          if (!(await ready())) return;
          const body = await readJsonBody(req);
          sendJson(res, 200, await instance.shell(body.command, { timeoutMs: body.timeoutMs, root: body.root !== false }));
          return;
        }
        if (op === 'logcat' && req.method === 'GET') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.logcat({ lines: url.searchParams.get('lines'), filter: url.searchParams.get('filter') || '', buffer: url.searchParams.get('buffer') || '' }));
          return;
        }
        if (op === 'prop') {
          if (!(await ready())) return;
          if (req.method === 'GET') {
            sendJson(res, 200, await instance.getprop(url.searchParams.get('name') || ''));
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            sendJson(res, 200, await instance.setprop(body.name, body.value));
            return;
          }
        }
        if (op === 'packages' && req.method === 'GET') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.listPackages({ thirdPartyOnly: url.searchParams.get('all') !== '1' }));
          return;
        }
        if (op === 'root' && req.method === 'POST') {
          if (!(await ready())) return;
          sendJson(res, 200, { ok: await instance.ensureRoot(), root: instance.vm._root === true });
          return;
        }
        if (op === 'rotate' && req.method === 'POST') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.rotate((await readJsonBody(req)).orientation || 'landscape'));
          return;
        }
        if (op === 'ui' && req.method === 'GET') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.uiDump());
          return;
        }
        if (op === 'inspect' && req.method === 'GET') {
          if (!(await ready())) return;
          const dump = await instance.uiDump();
          let screen = null;
          try {
            screen = await instance.vm.screenSize();
          } catch {
            screen = null;
          }
          sendJson(res, 200, buildInspectorPayload(dump, screen));
          return;
        }
        if (op === 'proxy' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
          if (!(await ready())) return;
          try {
            if (req.method === 'GET') sendJson(res, 200, await instance.vm.getProxy());
            else if (req.method === 'DELETE') sendJson(res, 200, await instance.vm.setProxy({ enabled: false }));
            else sendJson(res, 200, await instance.vm.setProxy(await readJsonBody(req)));
          } catch (error) {
            sendError(res, 400, error.message);
          }
          return;
        }
        if (op === 'ca' && req.method === 'POST') {
          if (!(await ready())) return;
          try {
            const body = await readJsonBody(req);
            sendJson(res, 200, await instance.vm.installCaCertificate(body.path));
          } catch (error) {
            sendError(res, 400, error.message);
          }
          return;
        }
        if (op === 'record' && req.method === 'POST') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.screenRecord({ seconds: (await readJsonBody(req)).seconds }));
          return;
        }
        if (op === 'perf' && req.method === 'GET') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.perfSnapshot());
          return;
        }
        if (op === 'screenshot' && req.method === 'GET') {
          if (!(await ready())) return;
          const png = await instance.screenshot();
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': png.length,
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="apk-vm-${id}-${Date.now()}.png"`,
          });
          res.end(png);
          return;
        }
        if (op === 'action' && req.method === 'POST') {
          if (!(await ready())) return;
          const body = await readJsonBody(req);
          const action = String(body.action || '').toLowerCase();
          let result;
          if (action === 'force-stop') result = await instance.forceStop(body.packageName);
          else if (action === 'clear-data') result = await instance.clearData(body.packageName);
          else if (action === 'uninstall') result = await instance.uninstall(body.packageName);
          else if (action === 'launch') result = await instance.vm.launchPackage(body.packageName, body.activity);
          else if (action === 'open-url') result = await instance.vm.openUrl(body.url);
          else if (action === 'grant') result = await instance.vm.setPermission(body.packageName, body.permission, true);
          else if (action === 'revoke') result = await instance.vm.setPermission(body.packageName, body.permission, false);
          else {
            sendError(res, 400, `unsupported debug action: ${action || '(missing)'}`);
            return;
          }
          sendJson(res, 200, { ok: result.ok === true, action, result });
          return;
        }
        if (op === 'push' && req.method === 'POST') {
          if (!(await ready())) return;
          const body = await readJsonBody(req);
          const local = resolveDebugLocal(body.localPath, true);
          sendJson(res, 200, await instance.pushFile(local, body.remotePath));
          return;
        }
        if (op === 'pull' && req.method === 'POST') {
          if (!(await ready())) return;
          const body = await readJsonBody(req);
          const local = resolveDebugLocal(body.localPath, false);
          sendJson(res, 200, await instance.pullFile(body.remotePath, local));
          return;
        }
        if (op === 'reboot' && req.method === 'POST') {
          if (!(await ready())) return;
          sendJson(res, 200, await instance.reboot((await readJsonBody(req)).mode || ''));
          return;
        }
        sendError(res, 404, `unsupported extra-instance debug endpoint: ${op}`);
        return;
      }
      sendError(res, 404, `unsupported extra-instance endpoint: ${rest}`);
    }

    const extraRouteDisposers = new Map();
    function ensureExtraRouteSet(id) {
      if (extraRouteDisposers.has(id)) return;
      const suffixes = [
        '',
        'state',
        'frame',
        'vm',
        'input',
        'touch',
        'clipboard',
        'install',
        'upload',
        'debug/info',
        'debug/shell',
        'debug/logcat',
        'debug/prop',
        'debug/packages',
        'debug/root',
        'debug/rotate',
        'debug/ui',
        'debug/inspect',
        'debug/proxy',
        'debug/ca',
        'debug/record',
        'debug/perf',
        'debug/screenshot',
        'debug/action',
        'debug/push',
        'debug/pull',
        'debug/reboot',
        'flows',
        'network',
        'network/pcap',
        'snapshots',
      ];
      const disposers = [];
      for (const suffix of suffixes) {
        const pathname = `/apk-vm/instances/${id}${suffix ? `/${suffix}` : ''}`;
        disposers.push(
          webServer.register({
            kind: 'exact',
            path: pathname,
            handler: wrapHandler((req, res) => handleExtraRequest(req, res, id, suffix)),
          }),
        );
      }
      disposers.push(
        webServer.registerUpgrade({
          path: `/apk-vm/instances/${id}/ws`,
          handler: (req, socket, head) => {
            if (!isSameOrigin(req)) {
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
            const instance = instanceManager && instanceManager.get(id);
            if (!instance) {
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
            const client = acceptWebSocket(req, socket, head);
            if (!client) return;
            instance.handleVideoClient(client);
          },
        }),
      );
      extraRouteDisposers.set(id, disposers);
    }
    function disposeExtraRouteSet(id) {
      const disposers = extraRouteDisposers.get(id);
      if (!disposers) return;
      extraRouteDisposers.delete(id);
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    }
    registerInstanceRoutes = ensureExtraRouteSet;
    disposeInstanceRoutes = disposeExtraRouteSet;
    if (instanceManager) {
      for (const instance of instanceManager.instances.values()) ensureExtraRouteSet(instance.id);
    }

    register('/apk-vm/avds', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      const avds = await vm.listAvds();
      sendJson(res, 200, { ok: true, current: vm.avdName, avds });
    });

    register('/apk-vm/avd', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const avds = await vm.listAvds();
      const target = String(body.avdName || '').trim();
      if (!avds.includes(target)) {
        sendError(res, 400, `unknown AVD: ${target || '(missing)'}`);
        return;
      }
      await stopScrcpy();
      const result = await vm.setAvd(target);
      autoStartKicked = true;
      void ensureStarted();
      sendJson(res, 202, { ok: true, action: 'switch-avd', ...result, accepted: true });
    });

    register('/apk-vm/client-report', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
      lastClientReport = {
        version: text(body.version, 40),
        mode: text(body.mode, 20),
        webCodecs: body.webCodecs === true,
        h264Supported: body.h264Supported === true,
        h264Error: text(body.h264Error, 500),
        codec: text(body.codec, 80),
        decoderError: text(body.decoderError, 500),
        userAgent: text(body.userAgent, 300),
        location: text(body.location, 300),
        receivedAt: Date.now(),
      };
      vm._pushLog(
        `[client] v=${lastClientReport.version} mode=${lastClientReport.mode || '?'} ` +
          `webCodecs=${lastClientReport.webCodecs} h264=${lastClientReport.h264Supported}` +
          (lastClientReport.h264Error ? ` error=${lastClientReport.h264Error}` : ''),
      );
      sendJson(res, 200, { ok: true });
    });

    register('/apk-vm/apk-info', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const apkPath = resolveApkPath(url.searchParams.get('path'), rootsFor());
      const info = await vm.inspectApk(apkPath);
      sendJson(res, 200, { ok: true, path: apkPath, ...info });
    });

    register('/apk-vm/apk-icon', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET or HEAD only');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const apkPath = resolveApkPath(url.searchParams.get('path'), rootsFor());
      const icon = await vm.inspectApkIcon(apkPath);
      res.writeHead(200, {
        'content-type': icon.mime,
        'content-length': icon.data.length,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(icon.data);
    });

    register('/apk-vm/apks', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      const roots = rootsFor();
      const apks = await vm.listApks(roots);
      sendJson(res, 200, { ok: true, roots, apks });
    });

    register('/apk-vm/devices', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      sendJson(res, 200, { ok: true, ...(await vm.listDevices()), vm: await vm.status() });
    });

    register('/apk-vm/device', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
      await stopScrcpy();
      if (!serial) {
        await vm.detachDevice();
        frame.at = 0;
        frame.buffer = null;
        sendJson(res, 200, { ok: true, detached: true, vm: await vm.status(), devices: await vm.listDevices() });
        return;
      }
      try {
        await vm.attachDevice(serial);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error), devices: await vm.listDevices() });
        return;
      }
      frame.at = 0;
      frame.buffer = null;
      sendJson(res, 200, { ok: true, attached: serial, vm: await vm.status(), devices: await vm.listDevices() });
    });

    register('/apk-vm/remote', async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, tunnel: remoteTunnel ? remoteTunnel.status() : null });
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || 'connect').toLowerCase();
      try {
        if (action === 'disconnect') {
          if (remoteTunnel) {
            await remoteTunnel.stop();
            remoteTunnel = null;
          }
          await stopScrcpy();
          await vm.detachDevice();
          frame.buffer = null;
          frame.at = 0;
          sendJson(res, 200, { ok: true, detached: true, tunnel: null, vm: await vm.status() });
          return;
        }
        if (action !== 'connect') throw new Error(`unsupported remote action: ${action}`);
        if (remoteTunnel) {
          await remoteTunnel.stop();
          remoteTunnel = null;
        }
        const tunnel = new SshAdbTunnel({
          host: body.host,
          user: body.user,
          port: body.sshPort,
          keyPath: body.keyPath,
          remotePort: body.remotePort,
          localPort: body.localPort,
          sshPath: body.sshPath,
        });
        const started = await tunnel.start().catch(async (error) => {
          await tunnel.stop();
          throw error;
        });
        remoteTunnel = tunnel;
        try {
          await stopScrcpy();
          await vm.attachDevice(started.serial);
        } catch (error) {
          await tunnel.stop();
          remoteTunnel = null;
          throw error;
        }
        frame.buffer = null;
        frame.at = 0;
        sendJson(res, 200, { ok: true, tunnel: tunnel.status(), vm: await vm.status() });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/vm', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      if (action === 'start' || action === 'warm') {
        autoStartKicked = true;
        void ensureStarted();
        sendJson(res, 202, { ok: true, action, accepted: true, warm: true });
        return;
      }
      if (action === 'stop') {
        await stopScrcpy();
        const snapshot = await vm.stop();
        frame.buffer = null;
        frame.at = 0;
        screen.value = null;
        sendJson(res, 200, { ok: true, action, vm: snapshot });
        return;
      }
      if (action === 'restart') {
        await stopScrcpy();
        await vm.stop();
        frame.buffer = null;
        frame.at = 0;
        screen.value = null;
        autoStartKicked = true;
        void ensureStarted();
        sendJson(res, 202, { ok: true, action, accepted: true, warm: true });
        return;
      }
      if (action === 'snapshot') {
        try {
          const saved = await vm.saveSnapshot(body.name);
          sendJson(res, 200, { ok: true, action, ...saved });
        } catch (error) {
          sendError(res, 500, error.message);
        }
        return;
      }
      sendError(res, 400, `unsupported action: ${action || '(missing)'}`);
    });

    register('/apk-vm/install', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      if (installInFlight) {
        sendError(res, 409, 'another APK install is already running');
        return;
      }
      installInFlight = installApkFromPath(body.path);
      try {
        const installed = await installInFlight;
        sendJson(res, 200, { ok: true, ...installed });
      } catch (error) {
        sendError(res, 500, error.message);
      } finally {
        installInFlight = null;
      }
    });

    register('/apk-vm/upload', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (installInFlight) {
        sendError(res, 409, 'another APK install is already running');
        return;
      }
      let rawName = '';
      try {
        rawName = decodeURIComponent(String(req.headers['x-apk-name'] || ''));
      } catch {
        rawName = String(req.headers['x-apk-name'] || '');
      }
      let safeName = path.basename(rawName || 'upload.apk').replace(/[^A-Za-z0-9._-]+/g, '_');
      if (!safeName) safeName = 'upload.apk';
      if (!/\.(?:apk|apks|xapk|aab)$/i.test(safeName)) safeName += '.apk';
      let data;
      try {
        data = await readRawBody(req, UPLOAD_LIMIT_BYTES);
      } catch (error) {
        const tooLarge = /exceeds/.test(String(error && error.message));
        sendError(res, tooLarge ? 413 : 400, tooLarge ? 'APK upload is too large' : String(error && error.message));
        return;
      }
      if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
        sendError(res, 400, 'uploaded file is not a ZIP/APK');
        return;
      }
      const dir = await prepareUploadDir();
      const target = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
      await fsp.writeFile(target, data);
      installInFlight = installApkFromPath(target, { trustedPath: true });
      try {
        const installed = await installInFlight;
        sendJson(res, 200, {
          ok: true,
          ...installed,
          upload: { fileName: safeName, bytes: data.length },
        });
      } catch (error) {
        sendError(res, 500, error.message);
      } finally {
        installInFlight = null;
      }
    });

    register('/apk-vm/frame', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET only');
        return;
      }
      const status = await vm.status();
      if (!isReady(status)) {
        maybeAutoStart(status);
        sendJson(res, 409, { ok: false, error: `VM is not ready (state: ${status.state})` });
        return;
      }
      const png = await getFrame();
      frame.receivedAt.push(Date.now());
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Apk-Vm-Serial': status.serial || '',
        'X-Apk-Vm-Fps': String(streamFps),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(png);
    });

    register('/apk-vm/input', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const status = await vm.status();
      if (!isReady(status)) {
        sendError(res, 409, `VM is not ready (state: ${status.state})`);
        return;
      }
      flowRecorder.record('default', body);
      await vm.input(body);
      sendJson(res, 200, { ok: true });
    });

    register('/apk-vm/touch', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const session = scrcpyState && scrcpyState.session;
      if (!session || session.state !== 'running') {
        sendError(res, 409, 'H.264 control stream is not running; connect the video stream first');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      if (!['down', 'move', 'up', 'cancel'].includes(action)) {
        sendError(res, 400, 'action must be down|move|up|cancel');
        return;
      }
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        sendError(res, 400, 'x and y must be finite numbers');
        return;
      }
      const pointerId = body.pointerId === undefined ? undefined : Number(body.pointerId);
      if (pointerId !== undefined && !Number.isInteger(pointerId)) {
        sendError(res, 400, 'pointerId must be an integer');
        return;
      }
      await session.sendTouch({ action, pointerId, x, y });
      sendJson(res, 200, { ok: true });
    });

    register('/apk-vm/clipboard', async (req, res) => {
      const session = scrcpyState && scrcpyState.session;
      if (req.method === 'GET') {
        if (!session || session.state !== 'running') {
          sendError(res, 409, 'H.264 control stream is not running');
          return;
        }
        try {
          const text = await session.requestClipboard(2000);
          sendJson(res, 200, { ok: true, text });
        } catch (error) {
          sendError(res, 504, error && error.message ? error.message : String(error));
        }
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      if (!session || session.state !== 'running') {
        sendError(res, 409, 'H.264 control stream is not running');
        return;
      }
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string') {
        sendError(res, 400, 'text must be a string');
        return;
      }
      const result = await session.setClipboard(body.text, { paste: body.paste === true });
      sendJson(res, 200, { ok: true, ...result });
    });

    register('/apk-vm/stream', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const next = Number(body.fps);
      if (!Number.isFinite(next)) {
        sendError(res, 400, 'fps must be a number between 1 and 10');
        return;
      }
      streamFps = Math.min(10, Math.max(1, Math.round(next)));
      sendJson(res, 200, { ok: true, fps: streamFps });
    });

    register('/apk-vm/stream/quality', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      try {
        sendJson(res, 200, await setStreamQuality(body.preset));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    /* ---- rooted debug surface ---------------------------------------- *
     * These routes (and the `apk_vm` Agent tool) expose the guest's root
     * shell and low-level device operations to DSH. They are local-only,
     * same-origin routes; paths and output are bounded.                    */

    async function ensureDebugReady(res) {
      const status = await vm.status();
      if (!isReady(status)) {
        sendError(res, 409, `VM is not ready (state: ${status.state})`);
        return false;
      }
      return true;
    }

    register('/apk-vm/debug/info', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      sendJson(res, 200, await vm.deviceInfo());
    });

    register('/apk-vm/debug/shell', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const result = await vm.shell(body.command, {
        timeoutMs: body.timeoutMs,
        root: body.root !== false,
      });
      sendJson(res, 200, result);
    });

    register('/apk-vm/debug/logcat', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const url = new URL(req.url || '/', 'http://localhost');
      sendJson(
        res,
        200,
        await vm.logcat({
          lines: url.searchParams.get('lines'),
          filter: url.searchParams.get('filter') || '',
          buffer: url.searchParams.get('buffer') || '',
        }),
      );
    });

    register('/apk-vm/debug/prop', async (req, res) => {
      if (!(await ensureDebugReady(res))) return;
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost');
        sendJson(res, 200, await vm.getprop(url.searchParams.get('name') || ''));
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await vm.setprop(body.name, body.value));
        return;
      }
      sendError(res, 405, 'GET or POST only');
    });

    register('/apk-vm/ui-test', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const name = String(body.name || 'ui-check').slice(0, 80);
      const started = Date.now();
      try {
        const dump = await vm.uiDump();
        const assertions = runAssertions(dump.xml, Array.isArray(body.assertions) ? body.assertions : []);
        const png = await vm.screenshot();
        const visual = await compareScreenshot(
          png,
          path.join(os.tmpdir(), 'dsh-apk-vm-baselines'),
          name,
          { update: body.updateBaseline === true },
        );
        const report = createTestReport({
          name,
          instanceId: 'default',
          assertions,
          visual,
          durationMs: Date.now() - started,
        });
        const reportBody = report && report.report ? report.report : report;
        sendJson(res, 200, {
          ok: assertions.ok !== false && visual.ok !== false,
          report: reportBody,
          markdown: (report && report.markdown) || reportMarkdown(reportBody),
        });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/debug/packages', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const url = new URL(req.url || '/', 'http://localhost');
      sendJson(res, 200, await vm.listPackages({ thirdPartyOnly: url.searchParams.get('all') !== '1' }));
    });

    register('/apk-vm/debug/root', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const ok = await vm.ensureRoot();
      sendJson(res, 200, { ok, root: ok, debug: vm.debugStatus() });
    });

    register('/apk-vm/debug/push', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const localPath = resolveDebugLocal(body.localPath, true);
      sendJson(res, 200, await vm.pushFile(localPath, body.remotePath));
    });

    register('/apk-vm/debug/pull', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const localPath = resolveDebugLocal(body.localPath, false);
      sendJson(res, 200, await vm.pullFile(body.remotePath, localPath));
    });

    register('/apk-vm/debug/reboot', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await vm.reboot(body.mode || ''));
    });

    register('/apk-vm/debug/action', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      const packageName = body.packageName;
      let result;
      if (action === 'force-stop') result = await vm.forceStop(packageName);
      else if (action === 'clear-data') result = await vm.clearData(packageName);
      else if (action === 'uninstall') result = await vm.uninstall(packageName);
      else if (action === 'launch') result = await vm.launchPackage(packageName, body.activity);
      else if (action === 'open-url') result = await vm.openUrl(body.url);
      else if (action === 'grant') result = await vm.setPermission(packageName, body.permission, true);
      else if (action === 'revoke') result = await vm.setPermission(packageName, body.permission, false);
      else {
        sendError(res, 400, `unsupported debug action: ${action || '(missing)'}`);
        return;
      }
      sendJson(res, 200, { ok: result.ok === true, action, result });
    });

    register('/apk-vm/snapshots', async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, vm.listNamedSnapshots());
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      try {
        if (action === 'save') sendJson(res, 200, await vm.saveNamedSnapshot(body.name));
        else if (action === 'load') sendJson(res, 200, await vm.loadNamedSnapshot(body.name));
        else if (action === 'delete') sendJson(res, 200, await vm.deleteNamedSnapshot(body.name));
        else throw new Error(`unsupported snapshot action: ${action || '(missing)'}`);
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/debug/rotate', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await vm.rotate(body.orientation || 'landscape'));
    });

    register('/apk-vm/debug/ui', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      sendJson(res, 200, await vm.uiDump());
    });

    register('/apk-vm/debug/inspect', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const dump = await vm.uiDump();
      let screen = null;
      try {
        screen = await vm.screenSize();
      } catch {
        screen = null;
      }
      sendJson(res, 200, buildInspectorPayload(dump, screen));
    });

    register('/apk-vm/debug/proxy', async (req, res) => {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
        sendError(res, 405, 'GET, POST or DELETE only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, await vm.getProxy());
          return;
        }
        if (req.method === 'DELETE') {
          sendJson(res, 200, await vm.setProxy({ enabled: false }));
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, await vm.setProxy(body));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/debug/ca', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, await vm.installCaCertificate(body.path));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/network/har', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      try {
        const loaded = await readHarFile(body.path);
        const entries = filterHar(loaded.entries, {
          method: body.method,
          status: body.status,
          domain: body.domain,
          search: body.search,
        });
        const sliced = entries.slice(0, 500).map((entry) => ({
          ...entry,
          curl: toCurl(entry),
        }));
        sendJson(res, 200, {
          ok: true,
          path: loaded.file,
          bytes: loaded.bytes,
          summary: summarizeHar(loaded.entries),
          filtered: entries.length,
          entries: sliced,
        });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/network', async (req, res) => {
      if (req.method === 'GET') {
        if (!(await ensureDebugReady(res))) return;
        try {
          sendJson(res, 200, await vm.networkInfo());
        } catch (error) {
          sendError(res, 400, error.message);
        }
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      try {
        let result;
        if (action === 'mode') result = vm.setNetworkMode(body.mode);
        else if (action === 'dns') result = await vm.setDnsServers(body.servers);
        else if (action === 'hosts') result = await vm.setHosts(body.entries);
        else if (action === 'test') result = await vm.testNetwork(body);
        else if (action === 'pcap') result = vm.setTcpdumpPath(body.path);
        else if (action === 'forward-add') result = await vm.addPortForward(body.localPort, body.remotePort, { shared: body.shared === true });
        else if (action === 'forward-remove') result = await vm.removePortForward(body.localPort);
        else throw new Error(`unsupported network action: ${action || '(missing)'}`);
        sendJson(res, 200, result);
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    register('/apk-vm/network/pcap', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET or HEAD only');
        return;
      }
      if (!vm.tcpdumpPath || !existsSync(vm.tcpdumpPath)) {
        sendError(res, 404, 'pcap capture is not configured or has no file yet');
        return;
      }
      const stat = await fsp.stat(vm.tcpdumpPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.tcpdump.pcap',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${path.basename(vm.tcpdumpPath)}"`,
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(vm.tcpdumpPath).pipe(res);
    });

    register('/apk-vm/debug/record', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, await vm.screenRecord({ seconds: body.seconds }));
    });

    register('/apk-vm/artifacts', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET or HEAD only');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const name = String(url.searchParams.get('name') || '');
      // Only files this plugin wrote into the OS temp dir; never arbitrary paths.
      if (!/^(apk-vm-shot-|dsh-apk-vm-record-)[A-Za-z0-9._-]+\.(png|mp4)$/.test(name)) {
        sendError(res, 400, 'invalid artifact name');
        return;
      }
      const target = path.join(os.tmpdir(), name);
      if (path.dirname(target) !== os.tmpdir() || !existsSync(target)) {
        sendError(res, 404, 'artifact not found');
        return;
      }
      const stat = await fsp.stat(target);
      res.writeHead(200, {
        'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
        'content-length': stat.size,
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${name}"`,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(target).pipe(res);
    });

    register('/apk-vm/debug/perf', async (req, res) => {
      if (req.method !== 'GET') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      sendJson(res, 200, await vm.perfSnapshot());
    });

    register('/apk-vm/debug/screenshot', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'GET only');
        return;
      }
      if (!(await ensureDebugReady(res))) return;
      const png = await vm.screenshot();
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="apk-vm-${Date.now()}.png"`,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(png);
    });

    disposers.push(
      webServer.registerUpgrade({
        path: '/apk-vm/ws',
        handler: (req, socket, head) => {
          if (!isSameOrigin(req)) {
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
            return;
          }
          const client = acceptWebSocket(req, socket, head);
          if (!client) return;
          handleScrcpyClient(client);
        },
      }),
    );

    disposers.push(
      webServer.registerUpgrade({
        path: '/apk-vm/instances/ws',
        handler: (req, socket, head) => {
          if (!isSameOrigin(req)) {
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
            return;
          }
          const client = acceptWebSocket(req, socket, head);
          if (!client) return;
          client.sendText(
            JSON.stringify({
              type: 'error',
              error: 'extra instances use the PNG preview fallback; H.264 is currently reserved for the default VM',
            }),
          );
          client.close(1001, 'PNG fallback');
        },
      }),
    );

    return () => {
      void stopScrcpy();
      void cleanupUploads();
      for (const id of [...extraRouteDisposers.keys()]) disposeExtraRouteSet(id);
      void instanceManager?.dispose?.();
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
      void vm.dispose().catch(() => {});
    };
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountRoutes(host.webServer), 'dsh-apk-vm: http routes');
  });

  ctx.effect(() => {
    return () => {
      const tunnel = remoteTunnel;
      remoteTunnel = null;
      if (tunnel) void tunnel.stop().catch(() => {});
    };
  }, 'dsh-apk-vm: ssh tunnel');

  // Optional warm start: boot the VM right after the plugin activates so the
  // first panel/tab open lands on a running (or nearly booted) device. This is
  // what makes the visible "open the VM" step effectively instant; opt in with
  // `prewarm: true` because it consumes CPU/GPU while the plugin is loaded.
  if (cfg.prewarm === true && (cfg.emulatorPath || cfg.serial)) {
    ctx.effect(() => {
      const delay = Number.isFinite(cfg.prewarmDelayMs) && cfg.prewarmDelayMs >= 0 ? cfg.prewarmDelayMs : 3000;
      const timer = setTimeout(() => {
        autoStartKicked = true;
        void ensureStarted();
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearTimeout(timer);
    }, 'dsh-apk-vm: prewarm timer');
  }

  // Idle reaper for extra multi-agent instances: a VM whose owner/panel has
  // not touched it for `instanceIdleMs` is stopped (AVD kept for reuse). The
  // default VM is managed by the normal prewarm/auto-start lifecycle.
  if (instanceManager) {
    ctx.effect(() => {
      const intervalMs = Math.max(30_000, Number(cfg.instanceReapIntervalMs) || 60_000);
      const timer = setInterval(() => {
        void instanceManager.reapIdle().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'dsh-apk-vm: instance idle reaper');
  }

  /* ---- Agent tool: the same rooted debug surface the UI/HTTP use ---- *
   * Registered globally through the Host tools registry, so every DSH agent
   * can call `apk_vm` for root shell / logcat / props / packages / APK install
   * / push-pull / reboot, without duplicating plugin logic.                 */

  function defaultToolApi() {
    return {
      kind: 'default',
      id: 'default',
      status: () => vm.status(),
      start: () => vm.start(),
      stop: () => vm.stop(),
      deviceInfo: () => vm.deviceInfo(),
      ensureRoot: () => vm.ensureRoot(),
      shell: (command, options) => vm.shell(command, options),
      logcat: (options) => vm.logcat(options),
      getprop: (name) => vm.getprop(name),
      setprop: (name, value) => vm.setprop(name, value),
      listPackages: (options) => vm.listPackages(options),
      input: (payload) => {
        flowRecorder.record('default', payload);
        return vm.input(payload);
      },
      getClipboard: async () => {
        const session = scrcpyState && scrcpyState.session;
        if (!session || session.state !== 'running') throw new Error('H.264 control stream is not running');
        return session.requestClipboard(2000);
      },
      setClipboard: async (text, paste) => {
        const session = scrcpyState && scrcpyState.session;
        if (!session || session.state !== 'running') throw new Error('H.264 control stream is not running');
        return session.setClipboard(text, { paste: paste === true });
      },
      install: (apkPath) => installApkFromPath(apkPath),
      pushFile: (local, remote) => vm.pushFile(local, remote),
      pullFile: (remote, local) => vm.pullFile(remote, local),
      reboot: (mode) => vm.reboot(mode),
      forceStop: (pkg) => vm.forceStop(pkg),
      clearData: (pkg) => vm.clearData(pkg),
      uninstall: (pkg) => vm.uninstall(pkg),
      rotate: (orientation) => vm.rotate(orientation),
      uiDump: () => vm.uiDump(),
      screenSize: () => vm.screenSize(),
      getProxy: () => vm.getProxy(),
      setProxy: (options) => vm.setProxy(options),
      installCaCertificate: (certPath) => vm.installCaCertificate(certPath),
      networkInfo: () => vm.networkInfo(),
      setNetworkMode: (mode) => vm.setNetworkMode(mode),
      setTcpdumpPath: (filePath) => vm.setTcpdumpPath(filePath),
      setDnsServers: (servers) => vm.setDnsServers(servers),
      setHosts: (entries) => vm.setHosts(entries),
      testNetwork: (options) => vm.testNetwork(options),
      addPortForward: (local, remote, options) => vm.addPortForward(local, remote, options),
      removePortForward: (local) => vm.removePortForward(local),
      screenRecord: (options) => vm.screenRecord(options),
      perfSnapshot: () => vm.perfSnapshot(),
      screenshot: async () => {
        const buffer = await vm.screenshot();
        const target = path.join(os.tmpdir(), `apk-vm-shot-${Date.now()}.png`);
        await fsp.writeFile(target, buffer);
        return { path: target, bytes: buffer.length };
      },
    };
  }

  function extraToolApi(instance) {
    return {
      kind: 'extra',
      id: instance.id,
      status: () => instance.status(),
      start: () => instance.start(),
      stop: () => instance.stop(),
      deviceInfo: () => instance.deviceInfo(),
      ensureRoot: () => instance.ensureRoot(),
      shell: (command, options) => instance.shell(command, options),
      logcat: (options) => instance.logcat(options),
      getprop: (name) => instance.getprop(name),
      setprop: (name, value) => instance.setprop(name, value),
      listPackages: (options) => instance.listPackages(options),
      input: (payload) => {
        flowRecorder.record(instance.id, payload);
        return instance.input(payload);
      },
      getClipboard: () => instance.getClipboard(),
      setClipboard: (text, paste) => instance.setClipboard(text, paste),
      install: async (apkPath) => instance.installApk(resolveApkPath(apkPath, rootsFor())),
      pushFile: (local, remote) => instance.pushFile(local, remote),
      pullFile: (remote, local) => instance.pullFile(remote, local),
      reboot: (mode) => instance.reboot(mode),
      forceStop: (pkg) => instance.forceStop(pkg),
      clearData: (pkg) => instance.clearData(pkg),
      uninstall: (pkg) => instance.uninstall(pkg),
      rotate: (orientation) => instance.rotate(orientation),
      uiDump: () => instance.uiDump(),
      screenSize: () => instance.vm.screenSize(),
      getProxy: () => instance.vm.getProxy(),
      setProxy: (options) => instance.vm.setProxy(options),
      installCaCertificate: (certPath) => instance.vm.installCaCertificate(certPath),
      networkInfo: () => instance.vm.networkInfo(),
      setNetworkMode: (mode) => instance.vm.setNetworkMode(mode),
      setTcpdumpPath: (filePath) => instance.vm.setTcpdumpPath(filePath),
      setDnsServers: (servers) => instance.vm.setDnsServers(servers),
      setHosts: (entries) => instance.vm.setHosts(entries),
      testNetwork: (options) => instance.vm.testNetwork(options),
      addPortForward: (local, remote, options) => instance.vm.addPortForward(local, remote, options),
      removePortForward: (local) => instance.vm.removePortForward(local),
      screenRecord: (options) => instance.screenRecord(options),
      perfSnapshot: () => instance.perfSnapshot(),
      screenshot: async () => {
        const buffer = await instance.screenshot();
        const target = path.join(os.tmpdir(), `apk-vm-shot-${instance.id}-${Date.now()}.png`);
        await fsp.writeFile(target, buffer);
        return { path: target, bytes: buffer.length };
      },
    };
  }

  async function resolveToolApi(args, exec) {
    const requested = String((args && args.instance) || '').trim();
    if (requested) {
      if (requested === 'default') return defaultToolApi();
      if (!instanceManager) throw new Error('multi-instance support is disabled');
      const instance = instanceManager.get(requested);
      if (!instance) throw new Error(`unknown apk_vm instance: ${requested}`);
      return extraToolApi(instance);
    }
    if (instanceManager && exec && exec.agent) {
      const session = exec.agent.session;
      const header = session && session.header ? session.header : {};
      const key = header.id || header.sessionId || (session && session.id) || 'anonymous';
      const assigned = await instanceManager.forAgent(key);
      if (assigned && assigned.default === true) return defaultToolApi();
      if (assigned && assigned.id) registerInstanceRoutes?.(assigned.id);
      return extraToolApi(assigned);
    }
    return defaultToolApi();
  }

  async function ensureToolApiReady(api, action) {
    let status = await api.status();
    if (isReady(status)) return status;
    if (action !== 'stop' && action !== 'start') {
      // Tool calls are expected to operate on a running VM; boot on demand.
      await api.start();
      status = await api.status();
    }
    if (!isReady(status)) {
      throw new Error(`APK VM instance ${api.id} is not ready (state: ${status.state}); start it first`);
    }
    return status;
  }

  /** Parse UIAutomator XML into lightweight nodes for Agent UI assertions. */
  function parseUiNodes(xml) {
    const source = String(xml || '');
    const nodes = [];
    const nodeRe = /<node\b([^>]*?)\/?>/g;
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = nodeRe.exec(source))) {
      const attrs = {};
      let attr;
      while ((attr = attrRe.exec(match[1]))) {
        attrs[attr[1]] = attr[2]
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
      }
      const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds || '');
      nodes.push({
        text: attrs.text || '',
        resourceId: attrs['resource-id'] || '',
        contentDesc: attrs['content-desc'] || '',
        className: attrs.class || '',
        clickable: attrs.clickable === 'true',
        enabled: attrs.enabled === 'true',
        bounds: bounds
          ? { x1: Number(bounds[1]), y1: Number(bounds[2]), x2: Number(bounds[3]), y2: Number(bounds[4]) }
          : null,
        center: bounds
          ? {
              x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
              y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
            }
          : null,
      });
    }
    return nodes;
  }

  function uiNodeMatches(node, args) {
    if (!node) return false;
    if (args.text && !String(node.text || '').includes(String(args.text))) return false;
    if (args.resourceId && !String(node.resourceId || '').includes(String(args.resourceId))) return false;
    if (args.contentDesc && !String(node.contentDesc || '').includes(String(args.contentDesc))) return false;
    if (args.className && !String(node.className || '').includes(String(args.className))) return false;
    return Boolean(args.text || args.resourceId || args.contentDesc || args.className);
  }

  const apkVmTool = {
    name: 'apk_vm',
    description:
      'Operate the local rooted Android APK virtual machine (Android emulator) that the APK VM panel manages. ' +
      'The VM is usually already running (warm start); adbd runs as root once ready. ' +
      'Actions: info, shell, logcat, getprop, setprop, packages, install, push, pull, reboot, root, ' +
      'force_stop, clear_data, uninstall, rotate, ui_dump, inspect_ui, proxy, install_ca, network, record, perf, screenshot, tap, swipe, long_press, key, text, ' +
      'apk_info, find_ui, assert_text, tap_text, clipboard_get, clipboard_set, devices, attach_device, detach_device, start, stop, list_instances, create_instance, destroy_instance, flow_start, flow_stop, flow_list, flow_replay, storage, clean_storage. ' +
      'Multi-instance: pass `instance` to target an isolated VM; omit it to use the calling Agent\'s ' +
      'assigned instance (first Agent gets the default VM, later Agents get isolated instances). ' +
      'Use shell for low-level Android commands, logcat for logs, ' +
      'setprop for system properties, packages to list apps, install to install+launch an APK by local path, ' +
      'push/pull to move files (under /data/local/tmp, /sdcard or /storage/emulated/0), reboot to restart the guest, ' +
      'rotate to lock orientation, ui_dump for the accessibility tree, record for a short MP4, perf for CPU/memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: 'info|shell|logcat|getprop|setprop|packages|install|push|pull|reboot|root|force_stop|clear_data|uninstall|rotate|ui_dump|inspect_ui|proxy|install_ca|network|record|perf|screenshot|tap|swipe|long_press|key|text|apk_info|find_ui|assert_text|tap_text|clipboard_get|clipboard_set|devices|attach_device|detach_device|start|stop|list_instances|create_instance|destroy_instance|flow_start|flow_stop|flow_list|flow_replay|storage|clean_storage',
        },
        instance: { type: 'string', description: 'Target VM instance id (default or an extra instance from list_instances). Omit for the calling Agent\'s assigned instance.' },
        instanceName: { type: 'string', description: 'create_instance: optional name for the new isolated instance.' },
        start: { type: 'boolean', description: 'create_instance: start the new instance immediately when true.' },
        command: { type: 'string', description: 'Shell command for action=shell.' },
        timeoutMs: { type: 'integer', description: 'Optional shell timeout in ms (max 120000).' },
        lines: { type: 'integer', description: 'logcat line count (1-1000).' },
        filter: { type: 'string', description: 'Optional logcat filter/spec argument.' },
        buffer: { type: 'string', description: 'logcat buffer: main|system|crash|events|all (default main).' },
        name: { type: 'string', description: 'System property name for getprop/setprop.' },
        value: { type: 'string', description: 'System property value for setprop.' },
        path: { type: 'string', description: 'Local file path: APK for install, source for push, destination for pull.' },
        remotePath: { type: 'string', description: 'Device path for push/pull; must be under /data/local/tmp, /sdcard or /storage/emulated/0.' },
        packageName: { type: 'string', description: 'Package name for force_stop/clear_data/uninstall.' },
        mode: { type: 'string', description: 'Optional reboot mode (system|recovery|bootloader) or rotate orientation (portrait|landscape|left|right).' },
        seconds: { type: 'integer', description: 'record: clip length in seconds (1-60, default 5).' },
        all: { type: 'boolean', description: 'packages: include system packages when true.' },
        x: { type: 'integer', description: 'tap/long_press/swipe: device x coordinate.' },
        y: { type: 'integer', description: 'tap/long_press/swipe: device y coordinate.' },
        x1: { type: 'integer', description: 'swipe: start device x coordinate.' },
        y1: { type: 'integer', description: 'swipe: start device y coordinate.' },
        x2: { type: 'integer', description: 'swipe: end device x coordinate.' },
        y2: { type: 'integer', description: 'swipe: end device y coordinate.' },
        durationMs: { type: 'integer', description: 'swipe/long_press duration in ms (1-60000; long_press default 800).' },
        key: { type: 'string', description: 'key: Android keycode name or number, e.g. HOME, BACK, ENTER, 3.' },
        text: { type: 'string', description: 'text: text to type into the focused field (max 4096 chars).' },
        resourceId: { type: 'string', description: 'find_ui/assert_text/tap_text: substring of the Android resource-id.' },
        contentDesc: { type: 'string', description: 'find_ui/assert_text/tap_text: substring of content-desc.' },
        className: { type: 'string', description: 'find_ui: substring of the Android class name.' },
        paste: { type: 'boolean', description: 'clipboard_set: also paste immediately (scrcpy paste flag).' },
        serial: { type: 'string', description: 'attach_device: adb serial of an online physical/remote device; detach_device ignores it.' },
        host: { type: 'string', description: 'proxy: HTTP proxy host (the emulator host alias reaches the host machine).' },
        port: { type: 'integer', description: 'proxy: HTTP proxy port (1-65535).' },
        bypass: { type: 'string', description: 'proxy: optional no-proxy/exclusion list.' },
        flowId: { type: 'string', description: 'flow_replay: saved flow id from flow_list.' },
        storageAction: { type: 'string', description: 'clean_storage: temp|snapshots|orphan-avds.' },
        avdName: { type: 'string', description: 'clean_storage snapshots: target AVD (defaults to the active AVD).' },
        confirm: { type: 'boolean', description: 'clean_storage: required true for snapshot or orphan AVD deletion.' },
        networkAction: { type: 'string', description: 'network: info|mode|dns|hosts|test|pcap|forward-add|forward-remove.' },
        networkMode: { type: 'string', description: 'network mode: isolated|shared.' },
        localPort: { type: 'integer', description: 'port forward: host loopback port.' },
        remotePort: { type: 'integer', description: 'port forward: guest service port.' },
        shared: { type: 'boolean', description: 'port forward: expose to other VMs through the emulator host alias (requires shared mode).' },
        servers: { type: 'array', items: { type: 'string' }, description: 'network DNS: up to 4 IPv4/IPv6 DNS servers.' },
        entries: { type: 'array', items: { type: 'string' }, description: 'network hosts: lines such as "1.2.3.4 api.example.com".' },
        testHost: { type: 'string', description: 'network test: host to ping/TCP-test (default: emulator host alias).' },
        testPort: { type: 'integer', description: 'network test: TCP port.' },
        pcapPath: { type: 'string', description: 'network pcap: host path ending in .pcap; capture starts on the next emulator start.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          result: { type: 'object' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value && value.summary) ||
            JSON.stringify((value && value.result) || value, null, 2).slice(0, 20000),
        },
      ],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const action = String((args && args.action) || '').toLowerCase();

      if (action === 'list_instances') {
        const defaultStatus = await vm.status();
        const instances = [
          {
            id: 'default',
            kind: 'default',
            avdName: defaultStatus.avd || vm.avdName || null,
            port: vm.port || null,
            state: defaultStatus.state,
            serial: defaultStatus.serial || null,
            root: defaultStatus.root === true,
          },
          ...(instanceManager ? instanceManager.list() : []),
        ];
        return {
          ok: true,
          summary: instances.map((entry) => `${entry.id}:${entry.state}${entry.serial ? '@' + entry.serial : ''}`).join(', '),
          result: { instances, maxInstances: instanceManager ? instanceManager.maxInstances : 1 },
        };
      }
      if (action === 'create_instance') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const instance = await instanceManager.create({ name: args.instanceName || args.name });
        registerInstanceRoutes?.(instance.id);
        if (args.start === true) void instance.start();
        return {
          ok: true,
          summary: `created instance ${instance.id} (avd=${instance.avdName}, port=${instance.port})`,
          result: { id: instance.id, avdName: instance.avdName, port: instance.port },
        };
      }
      if (action === 'destroy_instance') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const id = args.instance || args.name;
        if (!id) throw new Error('destroy_instance requires instance');
        if (id === 'default') throw new Error('the default instance cannot be destroyed');
        const result = await instanceManager.destroy(id);
        disposeInstanceRoutes?.(id);
        return { ok: true, summary: `destroyed instance ${id}`, result };
      }

      if (action === 'apk_info') {
        if (!args.path) throw new Error('action=apk_info requires path (local .apk file)');
        const apkPath = resolveApkPath(args.path, rootsFor());
        const info = await vm.inspectApk(apkPath);
        return {
          ok: true,
          summary: `${info.label} (${info.packageName}) v${info.versionName || info.versionCode || '?'} targetSdk=${info.targetSdkVersion || '?'} permissions=${info.permissions.length}`,
          result: { path: apkPath, ...info },
        };
      }
      if (action === 'devices') {
        const listed = await vm.listDevices();
        return {
          ok: listed.ok !== false,
          summary: (listed.devices || []).map((entry) => `${entry.serial}:${entry.state}${entry.kind === 'physical' ? ' (physical)' : ''}`).join(', ') || '(no adb devices)',
          result: listed,
        };
      }
      if (action === 'attach_device') {
        if (!args.serial) throw new Error('action=attach_device requires serial');
        await stopScrcpy();
        await vm.attachDevice(args.serial);
        frame.at = 0;
        frame.buffer = null;
        return { ok: true, summary: `attached external device ${args.serial}`, result: await vm.status() };
      }
      if (action === 'detach_device') {
        await stopScrcpy();
        await vm.detachDevice();
        frame.at = 0;
        frame.buffer = null;
        return { ok: true, summary: 'detached external device; managed AVD identity restored', result: await vm.status() };
      }

      const api = await resolveToolApi(args, exec);
      if (action === 'flow_list') {
        return {
          ok: true,
          summary: `${(await flowRecorder.list(api.id)).length} saved flow(s) on ${api.id}`,
          result: { instance: api.id, recording: flowRecorder.isRecording(api.id), flows: await flowRecorder.list(api.id) },
        };
      }
      if (action === 'flow_start') {
        const flow = flowRecorder.start(api.id, args.name);
        return { ok: true, summary: `recording flow ${flow.name} (${flow.id}) on ${api.id}`, result: flow };
      }
      if (action === 'flow_stop') {
        const flow = await flowRecorder.stop(api.id);
        return { ok: true, summary: `saved flow ${flow.name} (${flow.id}, ${flow.events} events)`, result: flow };
      }
      if (action === 'flow_replay') {
        if (!args.flowId) throw new Error('action=flow_replay requires flowId from flow_list');
        await ensureToolApiReady(api, action);
        const replayed = await flowRecorder.replay(args.flowId, async (payload) => api.input(payload), {
          instanceId: api.id,
        });
        return { ok: true, summary: `replayed ${replayed.steps} step(s) from ${replayed.name}`, result: replayed };
      }
      if (action === 'storage') {
        const report = await collectStorage({
          sdkRoot: storageSdkRoot(),
          knownAvds: [
            vm.avdName,
            ...(instanceManager ? instanceManager.list().map((item) => item.avdName) : []),
          ].filter(Boolean),
          activeAvds: [
            ...(['ready', 'booting', 'starting'].includes(vm._state) ? [vm.avdName] : []),
            ...(instanceManager
              ? instanceManager
                  .list()
                  .filter((item) => ['ready', 'booting', 'starting'].includes(item.state))
                  .map((item) => item.avdName)
              : []),
          ].filter(Boolean),
        });
        return {
          ok: true,
          summary:
            `AVD ${formatBytes(report.totals.avdBytes)}, snapshots ` +
            `${formatBytes(report.totals.snapshotBytes)}, SDK ${formatBytes(report.totals.sdkBytes)}, ` +
            `temp ${formatBytes(report.totals.tempBytes)}, free ${formatBytes(report.totals.freeBytes)}`,
          result: report,
        };
      }
      if (action === 'clean_storage') {
        if (!args.storageAction) throw new Error('action=clean_storage requires storageAction');
        const storageAction = String(args.storageAction).toLowerCase();
        const knownAvds = [
          vm.avdName,
          ...(instanceManager ? instanceManager.list().map((item) => item.avdName) : []),
        ].filter(Boolean);
        const activeAvds = [
          ...(['ready', 'booting', 'starting'].includes(vm._state) ? [vm.avdName] : []),
          ...(instanceManager
            ? instanceManager
                .list()
                .filter((item) => ['ready', 'booting', 'starting'].includes(item.state))
                .map((item) => item.avdName)
            : []),
        ].filter(Boolean);
        let result;
        if (storageAction === 'temp') result = await cleanTempFiles();
        else if (storageAction === 'snapshots') {
          if (args.confirm !== true) throw new Error('clean_storage snapshots requires confirm=true');
          const target = String(args.avdName || vm.avdName || 'dsh_apk');
          if (activeAvds.includes(target)) throw new Error(`AVD ${target} is active; stop it first`);
          result = await cleanSnapshots({ avdName: target });
        } else if (storageAction === 'orphan-avds') {
          if (args.confirm !== true) throw new Error('clean_storage orphan-avds requires confirm=true');
          result = await cleanOrphanAvds({ knownAvds, activeAvds });
        } else throw new Error(`unsupported storageAction: ${storageAction}`);
        return {
          ok: true,
          summary: `${storageAction}: freed ${formatBytes(result.freedBytes)}`,
          result,
        };
      }
      if (action === 'network') {
        const networkAction = String(args.networkAction || 'info').toLowerCase();
        if (networkAction === 'mode') {
          const result = api.setNetworkMode(args.networkMode || args.mode);
          return { ok: true, summary: `network mode: ${result.mode}`, result };
        }
        if (networkAction === 'dns') {
          const servers = Array.isArray(args.servers) ? args.servers : String(args.servers || '').split(',');
          const result = await api.setDnsServers(servers);
          return { ok: true, summary: `DNS: ${(result.servers || []).join(', ') || '(default)'}`, result };
        }
        if (networkAction === 'pcap') {
          const result = api.setTcpdumpPath(args.pcapPath);
          return { ok: true, summary: result.enabled ? `pcap -> ${result.path}` : 'pcap disabled', result };
        }
        await ensureToolApiReady(api, action);
        if (networkAction === 'info') {
          const result = await api.networkInfo();
          return {
            ok: true,
            summary: `mode=${result.mode} proxy=${result.proxy || 'off'} forwards=${result.forwards.length} dns=${(result.dnsServers || []).join(',') || 'default'}`,
            result,
          };
        }
        if (networkAction === 'hosts') {
          const result = await api.setHosts(Array.isArray(args.entries) ? args.entries : []);
          return { ok: true, summary: `hosts applied: ${result.entries}`, result };
        }
        if (networkAction === 'test') {
          const result = await api.testNetwork({ host: args.testHost, port: args.testPort });
          return { ok: result.ok, summary: result.checks.map((item) => `${item.name}:${item.ok ? 'ok' : 'fail'}`).join(', '), result };
        }
        if (networkAction === 'forward-add') {
          if (!args.localPort || !args.remotePort) throw new Error('forward-add requires localPort and remotePort');
          const result = await api.addPortForward(args.localPort, args.remotePort, { shared: args.shared === true });
          return { ok: true, summary: `forward tcp:${result.localPort} -> ${result.remotePort}`, result };
        }
        if (networkAction === 'forward-remove') {
          if (!args.localPort) throw new Error('forward-remove requires localPort');
          const result = await api.removePortForward(args.localPort);
          return { ok: true, summary: `removed forward tcp:${result.localPort}`, result };
        }
        throw new Error(`unsupported networkAction: ${networkAction}`);
      }
      if (action === 'start') {
        const snapshot = await api.start();
        return { ok: true, summary: `started ${api.id}`, result: snapshot || {} };
      }
      if (action === 'stop') {
        const snapshot = await api.stop();
        return { ok: true, summary: `stopped ${api.id}`, result: snapshot || {} };
      }
      const status = await ensureToolApiReady(api, action);
      switch (action) {
        case 'info': {
          const result = await api.deviceInfo();
          await api.ensureRoot();
          return { ok: true, summary: `${api.id} ${status.serial}: Android ${result.identity?.release || '?'} root=${result.root}`, result };
        }
        case 'shell': {
          if (!args.command) throw new Error('action=shell requires command');
          const result = await api.shell(args.command, { timeoutMs: Math.min(120000, Number(args.timeoutMs) || 30000) });
          return { ok: result.ok, summary: `$ ${args.command}\n${result.stdout || result.stderr || ''}`.slice(0, 20000), result };
        }
        case 'logcat': {
          const result = await api.logcat({ lines: args.lines, filter: args.filter || '', buffer: args.buffer || '' });
          return { ok: result.ok, summary: result.lines.slice(-40).join('\n').slice(0, 20000), result };
        }
        case 'getprop': {
          const result = await api.getprop(args.name);
          return { ok: true, summary: `${result.name}=${result.value}`, result };
        }
        case 'setprop': {
          const result = await api.setprop(args.name, args.value);
          return { ok: true, summary: `set ${result.name}=${result.value} (root=${result.root})`, result };
        }
        case 'packages': {
          const result = await api.listPackages({ thirdPartyOnly: args.all !== true });
          return { ok: true, summary: `${result.packages.length} package(s): ${result.packages.slice(0, 20).map((p) => p.packageName).join(', ')}`, result };
        }
        case 'tap': {
          const x = Number(args.x);
          const y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('action=tap requires numeric x and y (device coordinates)');
          const result = await api.input({ type: 'tap', x, y });
          return { ok: result.ok, summary: `tap ${Math.round(x)},${Math.round(y)} on ${api.id}`, result };
        }
        case 'swipe': {
          const coords = [args.x1, args.y1, args.x2, args.y2].map(Number);
          if (!coords.every(Number.isFinite)) throw new Error('action=swipe requires numeric x1,y1,x2,y2');
          const durationMs = Math.max(1, Math.min(60000, Number(args.durationMs) || 300));
          const result = await api.input({ type: 'swipe', x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3], durationMs });
          return { ok: result.ok, summary: `swipe ${coords.slice(0, 2).join(',')} -> ${coords.slice(2).join(',')} (${durationMs}ms) on ${api.id}`, result };
        }
        case 'long_press': {
          const x = Number(args.x);
          const y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('action=long_press requires numeric x and y');
          const durationMs = Math.max(300, Math.min(60000, Number(args.durationMs) || 800));
          const result = await api.input({ type: 'swipe', x1: x, y1: y, x2: x, y2: y, durationMs });
          return { ok: result.ok, summary: `long-press ${Math.round(x)},${Math.round(y)} (${durationMs}ms) on ${api.id}`, result };
        }
        case 'key': {
          if (!args.key) throw new Error('action=key requires key (e.g. HOME, BACK, ENTER)');
          const result = await api.input({ type: 'key', key: args.key });
          return { ok: result.ok, summary: `key ${args.key} on ${api.id}`, result };
        }
        case 'text': {
          if (typeof args.text !== 'string' || !args.text) throw new Error('action=text requires a non-empty text string');
          const result = await api.input({ type: 'text', text: args.text });
          return { ok: result.ok, summary: `typed ${args.text.length} chars on ${api.id}`, result };
        }
        case 'install': {
          const installed = await api.install(args.path);
          return { ok: true, summary: `${api.id}: installed ${installed.packageName} (${installed.label})`, result: installed };
        }
        case 'push': {
          const localPath = resolveDebugLocal(args.path, true);
          const result = await api.pushFile(localPath, args.remotePath);
          return { ok: true, summary: `pushed ${localPath} -> ${result.remotePath}`, result };
        }
        case 'pull': {
          const localPath = resolveDebugLocal(args.path, false);
          const result = await api.pullFile(args.remotePath, localPath);
          return { ok: true, summary: `pulled ${args.remotePath} -> ${result.localPath}`, result };
        }
        case 'reboot': {
          const result = await api.reboot(args.mode || '');
          return { ok: true, summary: `rebooting ${api.id} (${result.mode})`, result };
        }
        case 'root': {
          const ok = await api.ensureRoot();
          const debug = await api.status();
          return { ok, summary: `${api.id}: adb root ${ok ? 'enabled' : 'unavailable'}`, result: debug };
        }
        case 'force_stop': {
          const result = await api.forceStop(args.packageName);
          return { ok: result.ok, summary: `force-stopped ${args.packageName}`, result };
        }
        case 'clear_data': {
          const result = await api.clearData(args.packageName);
          return { ok: result.ok, summary: `cleared data ${args.packageName}`, result };
        }
        case 'uninstall': {
          const result = await api.uninstall(args.packageName);
          return { ok: result.ok, summary: `uninstalled ${args.packageName}`, result };
        }
        case 'screenshot': {
          const result = await api.screenshot();
          return { ok: true, summary: `${api.id}: screenshot saved to ${result.path} (${result.bytes} bytes)`, result };
        }
        case 'rotate': {
          const result = await api.rotate(args.mode || args.orientation || 'landscape');
          return { ok: true, summary: `rotation locked to ${result.rotation}`, result };
        }
        case 'ui_dump': {
          const result = await api.uiDump();
          return { ok: true, summary: `UI dump: ${result.nodes} nodes, ${result.bytes} bytes`, result };
        }
        case 'inspect_ui': {
          const dump = await api.uiDump();
          let screen = null;
          try {
            screen = await api.screenSize();
          } catch {
            screen = null;
          }
          const inspector = buildInspectorPayload(dump, screen);
          const interactive = inspector.nodes.filter((node) => node.interactive);
          return {
            ok: true,
            summary:
              `${inspector.nodes.length} UI node(s), ${interactive.length} interactive; ` +
              `screen ${screen ? `${screen.width}x${screen.height}` : '?'}`,
            result: inspector,
          };
        }
        case 'proxy': {
          if (args.enabled === false || args.clear === true) {
            const cleared = await api.setProxy({ enabled: false });
            return { ok: true, summary: 'HTTP proxy cleared', result: cleared };
          }
          if (args.host !== undefined) {
            const applied = await api.setProxy({ host: args.host, port: args.port, bypass: args.bypass, enabled: true });
            return { ok: true, summary: `HTTP proxy set to ${applied.proxy}`, result: applied };
          }
          return { ok: true, summary: 'current HTTP proxy settings', result: await api.getProxy() };
        }
        case 'install_ca': {
          if (!args.path) throw new Error('action=install_ca requires path to a .pem/.crt certificate');
          const installed = await api.installCaCertificate(args.path);
          return {
            ok: true,
            summary: `installed CA ${installed.fileName}${installed.systemCa ? ' (system+user)' : ' (user store)'}`,
            result: installed,
          };
        }
        case 'find_ui': {
          const dump = await api.uiDump();
          const matches = parseUiNodes(dump.xml).filter((node) => uiNodeMatches(node, args)).slice(0, 20);
          return {
            ok: matches.length > 0,
            summary: matches.length
              ? matches.map((node) => `${node.text || node.contentDesc || node.resourceId || node.className} @ ${node.center ? `${node.center.x},${node.center.y}` : '?'}`).join('\n')
              : 'no matching UI node',
            result: { count: matches.length, matches },
          };
        }
        case 'assert_text': {
          const dump = await api.uiDump();
          const matches = parseUiNodes(dump.xml).filter((node) => uiNodeMatches(node, args));
          const found = matches.length > 0;
          return {
            ok: found,
            summary: found ? `found ${matches.length} matching UI node(s)` : `assertion failed: no matching UI node for ${args.text || args.resourceId || args.contentDesc || args.className || '?'}`,
            result: { found, count: matches.length, matches: matches.slice(0, 20) },
          };
        }
        case 'tap_text': {
          const dump = await api.uiDump();
          const target = parseUiNodes(dump.xml).find((node) => uiNodeMatches(node, args) && node.center);
          if (!target) throw new Error(`tap_text: no matching UI node for ${args.text || args.resourceId || args.contentDesc || ''}`);
          const result = await api.input({ type: 'tap', x: target.center.x, y: target.center.y });
          return {
            ok: result.ok,
            summary: `tapped ${target.text || target.contentDesc || target.resourceId || target.className} at ${target.center.x},${target.center.y}`,
            result: { target, input: result },
          };
        }
        case 'clipboard_get': {
          const text = await api.getClipboard();
          return { ok: true, summary: `clipboard (${String(text).length} chars): ${String(text).slice(0, 2000)}`, result: { text } };
        }
        case 'clipboard_set': {
          if (typeof args.text !== 'string') throw new Error('action=clipboard_set requires text');
          const result = await api.setClipboard(args.text, args.paste === true);
          return { ok: true, summary: `clipboard set (${args.text.length} chars${args.paste === true ? ', paste' : ''})`, result };
        }
        case 'record': {
          const result = await api.screenRecord({ seconds: args.seconds });
          return { ok: true, summary: `recorded ${result.seconds}s to ${result.localPath}`, result };
        }
        case 'perf': {
          const result = await api.perfSnapshot();
          return { ok: true, summary: `load ${result.loadavg}, mem ${result.memFreeKb || '?'}/${result.memTotalKb || '?'} kB free`, result };
        }
        default:
          throw new Error(`unsupported apk_vm action: ${action || '(missing)'}`);
      }
    },

  };

  ctx.inject(['tools'], (host) => {
    host.effect(() => {
      try {
        return host.tools.register(apkVmTool);
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[apk-vm] apk_vm tool registration failed', error);
        }
        throw error;
      }
    }, 'dsh-apk-vm: apk_vm tool');
  });
}

