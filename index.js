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
import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AndroidVm } from './lib/android.js';
import { InstanceManager } from './lib/instances.js';
import { OWNER_SCOPE, normalizeScope } from './lib/vm-ownership.js';
import { checkOwnerAccess, ownerFromHttp } from './lib/http-owner.js';
import { ScrcpySession, annexbToAvcc, CONTROL_MESSAGE_TYPE } from './lib/scrcpy.js';
import { detectEnvironment, createAvd, installSystemImage, installSdkPackages, bootstrapSdk, DEFAULT_SYSTEM_IMAGE } from './lib/setup.js';
import { createAutoSetup } from './lib/autosetup.js';
import { ensureJdk, defaultJdkRoot } from './lib/jdk.js';
import { acceptWebSocket } from './lib/ws.js';
import { parseUiHierarchy, decorateUiNodes, buildInspectorPayload, snapshotIdForXml } from './lib/ui-inspector.js';
import { annotateScreenshot } from './lib/png-annotate.js';
import { FlowRecorder } from './lib/flows.js';
import { normalizeCodebook, resolveControl, suggestFeatures } from './lib/control-codebook.js';
import { attachNodeImageFeatures } from './lib/image-features.js';
import { SkillStore, SkillRecorder, runSkill, normalizeSkill, skillSummary } from './lib/app-skills.js';
import { collectStorage, cleanTempFiles, cleanSnapshots, cleanOrphanAvds, formatBytes } from './lib/storage.js';
import { buildApksFromAab, aabInfo, detectBundletool } from './lib/aab.js';
import { readHarFile, summarizeHar, filterHar, toCurl } from './lib/har.js';
import { runAssertions, compareScreenshot, createTestReport, reportMarkdown } from './lib/ui-tests.js';
import { SshAdbTunnel } from './lib/remote.js';
import { CdpBridge, previewJsValue } from './lib/cdp.js';
import { losslessJson } from './lib/json-safe.js';
import { ActivityLog } from './lib/activity-log.js';
import { InstalledAppRegistry, defaultInstalledAppsPath, reinstallMissingApps, summarizeReinstallResult } from './lib/installed-apps.js';

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

/**
 * Tool results must survive a lossless JSON round-trip. The shared helper
 * converts values that JSON cannot represent without failing the whole action.
 */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  // Request-level activity logging reads ok/error from the final payload.
  try {
    res._apkvmResponseBody = body;
  } catch {
    /* ignore */
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendError(res, status, message) {
  const text = String(message || 'unknown error');
  // Request-level activity logging attaches this message to a failed entry.
  try {
    res._apkvmErrorMessage = text;
  } catch {
    /* ignore */
  }
  sendJson(res, status, { ok: false, error: text });
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
        req._apkvmJsonBody = {};
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'));
          return;
        }
        req._apkvmJsonBody = parsed;
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
          leaseTtlMs: cfg.leaseTtlMs || 30 * 60 * 1000,
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
  const cdpBridges = new Map();
  if (instanceManager) {
    instanceManager.onCreated = (id) => {
      registerInstanceRoutes?.(id);
    };
    // A closed conversation must not keep the default VM claimed forever.
    // TTL expiry is the fallback when the sessions service is unavailable.
    ctx.inject(['sessions'], (host) => {
      host.effect(() => {
        if (typeof host.on !== 'function') return () => {};
        const off = host.on('session/disposed', (session) => {
          const id = session && (session.id || (session.header && session.header.id));
          if (!id) return;
          const released = instanceManager.releaseBySession(id);
          if (released.length) vm._pushLog(`released VM lease(s) after session ${id}: ${released.map((entry) => entry.instanceId).join(', ')}`);
        });
        return () => {
          if (typeof off === 'function') off();
        };
      }, 'dsh-apk-vm: release VM leases when a session is disposed');
    });
  }
  let installInFlight = null;
  let remoteTunnel = null;
  let startKick = null;
  let autoStartKicked = false;
  // Provisioning completion gets its own one-shot kick: a partially configured host can
  // consume utoStartKicked from an earlier (failed) manual/auto start attempt.
  let provisionAutoStarted = false;
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
  // The managed JDK directory lib/jdk.js downloads into. Passing it explicitly
  // keeps detection/installs consistent when cfg.jdkRoot overrides the default.
  const configuredJdkRoot = cfg.jdkRoot ? String(cfg.jdkRoot) : defaultJdkRoot({ platform: process.platform });
  async function loadSetup(force = false) {
    const now = Date.now();
    if (!force && setupCache && now - setupCacheAt < 15000) return setupCache;
    setupCache = await detectEnvironment({
      sdkRoot: cfg.sdkRoot || undefined,
      adbPath: cfg.adbPath || undefined,
      emulatorPath: cfg.emulatorPath || undefined,
      avdName: cfg.avdName || undefined,
      systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
      jdkRoot: configuredJdkRoot,
    });
    setupCacheAt = now;
    return setupCache;
  }

  /* ---- "即装即用" auto-provisioning ---------------------------------- *
   * On FIRST USE (GET /apk-vm/state or GET /apk-vm/setup) an incomplete
   * environment is provisioned in the background: managed JDK -> command-line
   * tools -> SDK packages -> system image -> AVD. The chain reports progress on
   * the HTTP status payloads, can be cancelled between steps and retried
   * explicitly. Multiple triggers share one run (single-flight inside
   * lib/autosetup.js); a failed/cancelled run is not retried by polling.     */
  const autoSetupEnabled = cfg.autoSetup !== false;
  let lastAutoSetupState = null;

  function autoSetupLog(line) {
    try {
      vm._pushLog(String(line));
    } catch {
      /* logging must never break provisioning */
    }
  }

  let autoSetupReadyHandled = false; // provisioning adoption / auto-start fire once

  /**
   * After auto-provisioning completes, let the already-constructed VM and the
   * multi-instance manager see the freshly installed SDK, emulator and AVD, and
   * boot the VM once. On a fresh install none of that existed when apply() ran,
   * so the normal auto-start guard (vm fields) could not fire on its own.
   */
  async function adoptProvisionedEnvironment() {
    try {
      const report = await loadSetup(true); // force a fresh detection after provisioning
      try {
        vm.applyEnvironment({
          sdkRoot: report && report.sdkRoot,
          adbPath: report && report.adbPath,
          emulatorPath: report && report.emulatorPath,
          avdName: report && report.avdName,
        });
      } catch (error) {
        autoSetupLog(`[auto-setup] VM environment adoption failed: ${error && error.message ? error.message : error}`);
      }
      if (instanceManager && report) {
        try {
          if (!instanceManager.sdkRoot && report.sdkRoot) instanceManager.sdkRoot = String(report.sdkRoot);
          if (!instanceManager.adbPath && report.adbPath) instanceManager.adbPath = String(report.adbPath);
          if (!instanceManager.emulatorPath && report.emulatorPath) {
            instanceManager.emulatorPath = String(report.emulatorPath);
          }
        } catch (error) {
          autoSetupLog(
            `[auto-setup] instance manager environment adoption failed: ${error && error.message ? error.message : error}`,
          );
        }
      }
      // Boot once: the VM only becomes startable now that it knows its paths. Use a dedicated
      // one-shot flag (not autoStartKicked) so a partially configured host that already tried to
      // start before provisioning finished still boots after the environment becomes ready.
      if (preferAutoStart && !provisionAutoStarted && report && report.ok && vm.emulatorPath) {
        provisionAutoStarted = true;
        autoStartKicked = true;
        void ensureStarted();
      }
    } catch (error) {
      autoSetupLog(`[auto-setup] post-provisioning setup failed: ${error && error.message ? error.message : error}`);
    }
  }

  function buildAutoSetup(enabled) {
    return createAutoSetup({
      enabled,
      sdkRoot: cfg.sdkRoot || undefined,
      adbPath: cfg.adbPath || undefined,
      emulatorPath: cfg.emulatorPath || undefined,
      avdName: cfg.avdName || 'dsh_apk',
      systemImage: cfg.systemImage || DEFAULT_SYSTEM_IMAGE,
      platform: process.platform,
      jdkRoot: configuredJdkRoot,
      jdkMirror: cfg.jdkMirror,
      jdkVersion: cfg.jdkVersion,
      log: autoSetupLog,
      onUpdate: (snapshot) => {
        if (snapshot.state === lastAutoSetupState) return;
        lastAutoSetupState = snapshot.state;
        if (snapshot.state === 'ready') {
          setupCache = null; // next GET re-detects
          if (!autoSetupReadyHandled) {
            autoSetupReadyHandled = true;
            void adoptProvisionedEnvironment();
          }
        }
        autoSetupLog(`[auto-setup] ${snapshot.state}: ${snapshot.message}`);
        if (snapshot.state === 'failed' && snapshot.error) autoSetupLog(`[auto-setup] ${snapshot.error}`);
      },
      deps: {
        detectEnvironment,
        ensureJdk,
        bootstrapSdk,
        installSdkPackages,
        installSystemImage,
        createAvd,
      },
    });
  }

  const autoSetup = buildAutoSetup(autoSetupEnabled);
  // cfg.autoSetup === false means "do not provision automatically"; an explicit
  // POST /apk-vm/setup { action:'auto-setup', confirmDownload:true } may still
  // start one run (in that case an enabled second instance is built lazily).
  let autoSetupOverride = null;
  function activeAutoSetup() {
    return autoSetupOverride || autoSetup;
  }

  /**
   * Kick provisioning on first use. Deliberately not repeated on every poll:
   * failed/cancelled runs require an explicit retry via POST /apk-vm/setup so
   * the panel's state polling cannot hammer a failing download in a loop.
   */
  function maybeAutoSetup(reason) {
    if (!autoSetupEnabled) return;
    const current = activeAutoSetup().status();
    if (current.state === 'failed' || current.state === 'cancelled') return;
    void activeAutoSetup().start(reason).catch(() => {});
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

  // Clipboard/text tools must work even when no panel client is connected.
  // Start the scrcpy control stream lazily, then let the normal idle timer stop it.
  async function ensureControlSession() {
    const st = await ensureScrcpy();
    const session = st && st.session;
    if (!session || session.state !== 'running') {
      throw new Error('H.264 control stream is not running');
    }
    return session;
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
  // Semantic App Skills live in the workspace (not the OS temp dir), so a
  // recorded "go to checkout" recipe survives VM restarts and can be reviewed.
  const skillStore = new SkillStore({
    dir: cfg.skillsDir
      ? path.resolve(String(cfg.skillsDir))
      : path.join(rootsFor()[0] || process.cwd(), '.apk-vm', 'skills'),
  });
  const skillRecorder = new SkillRecorder({ store: skillStore });
  // Graphical agent activity timeline ("what did the Agent do in the VM?"):
  // every apk_vm tool call is appended to a small JSONL ring, optionally with
  // a screenshot for mutating actions, and the panel renders it as a timeline.
  const activityLog = new ActivityLog(
    cfg.activityDir
      ? { rootDir: path.resolve(String(cfg.activityDir)) }
      : { dataDir: rootsFor()[0] || process.cwd() },
  );
  // APKs installed through the plugin are remembered locally so a reset VM can
  // get them back automatically (see reinstallRememberedApps below).
  const appRegistry = new InstalledAppRegistry({
    file: defaultInstalledAppsPath(rootsFor()[0] || process.cwd()),
  });
  const snapshotApk = () => (lastApk ? { ...lastApk } : null);

  function rememberInstalledApp(apkPath, meta, instanceId = 'default') {
    if (!apkPath) return;
    void appRegistry
      .record({
        apkPath,
        packageName: (meta && meta.packageName) || null,
        label: (meta && meta.label) || path.basename(apkPath),
        launchActivity: (meta && meta.launchActivity) || null,
        instanceId,
      })
      .catch(() => {});
  }

  let reinstallKick = null;
  let reinstallOnReadyKicked = false;

  /**
   * Reinstall remembered APKs whose package is missing on the ready VM. Runs
   * once per plugin start when an already-running VM is observed, and after
   * every background start. Writes one `source: system` activity entry when it
   * actually reinstall anything (or fails).
   */
  async function reinstallRememberedApps(reason) {
    if (cfg.autoReinstall === false) return { skipped: 'disabled' };
    if (reinstallKick) return reinstallKick;
    reinstallKick = (async () => {
      try {
        const status = await vm.status();
        if (!isReady(status)) return { skipped: 'not-ready' };
        const result = await reinstallMissingApps({
          registry: appRegistry,
          listPackages: () => vm.listPackages({ thirdPartyOnly: false }),
          installApk: (apkPath) => vm.installApk(apkPath),
        });
        if (result.reinstalled.length || result.failed.length) {
          void activityLog.record({
            action: 'reinstall',
            source: 'system',
            tool: 'apk-vm',
            summary: summarizeReinstallResult(result),
            ok: result.ok && result.failed.length === 0,
            error: result.failed.length
              ? result.failed.map((item) => item.error).filter(Boolean).join('; ').slice(0, 800)
              : result.error || null,
            durationMs: null,
          });
          if (typeof console !== 'undefined' && typeof console.log === 'function') {
            console.log(`[apk-vm] auto-reinstall (${reason}): ${summarizeReinstallResult(result)}`);
          }
        }
        return result;
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.log === 'function') {
          console.log(`[apk-vm] auto-reinstall (${reason}) failed: ${error && error.message ? error.message : error}`);
        }
        return { ok: false, error: String((error && error.message) || error) };
      } finally {
        reinstallKick = null;
      }
    })();
    return reinstallKick;
  }

  function maybeReinstallOnReady(status) {
    if (reinstallOnReadyKicked) return;
    if (!status || status.state !== 'ready') return;
    reinstallOnReadyKicked = true;
    void reinstallRememberedApps('ready');
  }

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
    if (options.trustedPath === true) {
      // Uploads live in the OS temp dir and are pruned; keep a copy so the
      // reinstall registry still has a usable APK after a VM reset.
      const archived = await persistUploadedApk(apkPath, meta);
      rememberInstalledApp(archived || apkPath, meta, 'default');
    } else {
      rememberInstalledApp(apkPath, meta, 'default');
    }
    return { ...lastApk };
  }

  /**
   * Copy an uploaded APK into `<dataDir>/.apk-vm/apks` (keeping the newest 10)
   * so auto-reinstall survives temp-dir cleanup. Best effort: returns the
   * original path when the copy fails.
   */
  async function persistUploadedApk(apkPath, meta) {
    try {
      const archiveDir = path.join(rootsFor()[0] || process.cwd(), '.apk-vm', 'apks');
      await fsp.mkdir(archiveDir, { recursive: true });
      const stem = String((meta && meta.packageName) || 'app').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'app';
      const target = path.join(archiveDir, `${stem}-${Date.now()}.apk`);
      await fsp.copyFile(apkPath, target);
      try {
        const names = (await fsp.readdir(archiveDir)).filter((name) => name.toLowerCase().endsWith('.apk'));
        if (names.length > 10) {
          const stats = [];
          for (const name of names) {
            const stat = await fsp.stat(path.join(archiveDir, name)).catch(() => null);
            if (stat) stats.push({ name, mtimeMs: stat.mtimeMs });
          }
          stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
          for (const stale of stats.slice(10)) {
            await fsp.rm(path.join(archiveDir, stale.name), { force: true }).catch(() => {});
          }
        }
      } catch {
        /* pruning is best effort */
      }
      return target;
    } catch {
      return apkPath;
    }
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

  /**
   * Canonicalize a path for containment checks: resolve symlinks/junctions when
   * the path exists, otherwise canonicalize the deepest existing parent. This
   * makes Windows drive-letter case and slash direction irrelevant.
   */
  function canonicalLocalPath(value) {
    const resolved = path.resolve(value);
    try {
      return realpathSync.native(resolved);
    } catch {
      const parent = path.dirname(resolved);
      if (parent === resolved) return resolved;
      try {
        return path.join(canonicalLocalPath(parent), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  }

  /** Comparison key for allowed-root checks (case-insensitive separators on win32). */
  function localPathKey(value) {
    let key = canonicalLocalPath(value);
    if (process.platform === 'win32') key = key.replace(/\//g, '\\').toLowerCase();
    // Keep filesystem roots ('/' or 'c:\') intact; then drop a trailing separator.
    if (key.length > 1 && key.endsWith(path.sep)) key = key.slice(0, -1);
    return key;
  }

  function localPathInside(key, rootKey) {
    if (key === rootKey) return true;
    return key.startsWith(rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`);
  }

  function describeDebugRoots(roots) {
    return roots.map((root) => `  - ${path.resolve(root)}`).join('\n');
  }

  /** Resolve a host-side path for debug push/pull, confined to the scan roots + temp. */
  function resolveDebugLocal(candidate, mustExist) {
    const raw = String(candidate || '').trim();
    if (!raw) throw new Error('local path is required');
    const roots = [...rootsFor(), os.tmpdir()];
    const rootKeys = roots.map((root) => localPathKey(root));
    const candidates = [raw];
    if (!path.isAbsolute(raw)) for (const root of roots) candidates.push(path.join(root, raw));
    let outside = null;
    for (const value of candidates) {
      try {
        const resolved = path.resolve(value);
        const key = localPathKey(resolved);
        if (!rootKeys.some((rootKey) => localPathInside(key, rootKey))) {
          if (!outside) outside = resolved;
          continue;
        }
        if (!mustExist || existsSync(resolved)) return resolved;
      } catch {
        /* try next */
      }
    }
    if (outside) {
      throw new Error(
        `local path is outside the allowed roots: ${outside}\nAllowed roots:\n${describeDebugRoots(roots)}\n` +
          'Move the file under one of these roots, or add its directory to the plugin `roots` config.',
      );
    }
    throw new Error(`local file not found: ${raw}\nAllowed roots:\n${describeDebugRoots(roots)}`);
  }

  /** Idempotent background start used by prewarm / auto-start / the Start button. */
  function ensureStarted() {
    if (startKick) return startKick;
    startKick = vm
      .start()
      .then(() => {
        // A fresh boot may have lost installed apps (snapshot reset / recreated
        // AVD); put back the ones this plugin installed.
        void reinstallRememberedApps('start');
      })
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
    if (!vm.emulatorPath && !vm.serial) return; // nothing this plugin can start
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
    maybeReinstallOnReady(status);
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
      rememberedApps: await appRegistry.summary(),
      installing: Boolean(installInFlight),
      warming: Boolean(startKick),
      stream: { fps: streamFps, hostFps: measuredFrameFps(), h264: scrcpyStatus() },
      origin: serverOrigin,
      multiInstance: Boolean(instanceManager),
      client: lastClientReport,
      owner: instanceManager ? instanceManager.ownerInfo('default') : null,
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
          ownerInfo: instanceManager ? instanceManager.ownerInfo('default') : null,
          ownerLabel: instanceManager && instanceManager.ownerInfo('default') ? instanceManager.ownerInfo('default').label : null,
          scope: instanceManager && instanceManager.ownerInfo('default') ? instanceManager.ownerInfo('default').scope : null,
          lastUsedAt: null,
          idleMs: null,
          videoClients: null,
        },
        ...(instanceManager ? instanceManager.list() : []),
      ],
      setup: { autoSetup: activeAutoSetup().status() },
      roots: rootsFor(),
    };
  }

  /** Android SDK root shared by the storage route and the apk_vm storage action. */
  function storageSdkRoot() {
    if (vm.sdkRoot) return vm.sdkRoot;
    if (vm.adbPath) return path.dirname(path.dirname(vm.adbPath));
    return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
  }

  function mountRoutes(webServer) {
    try {
      serverOrigin = webServer.getOrigin();
    } catch {
      serverOrigin = null;
    }
    const disposers = [];
    const wrapHandler = (handler, describeActivity) => async (req, res) => {
      if (!isSameOrigin(req)) {
        sendError(res, 403, 'cross-origin request rejected');
        return;
      }
      const record = describeActivity && req.method === 'POST' ? describeActivity : null;
      const startedAt = record ? Date.now() : 0;
      let failure = null;
      try {
        await handler(req, res);
      } catch (error) {
        failure = error;
        sendError(res, 500, error && error.message ? error.message : error);
      }
      if (record) {
        try {
          await recordUserActivity(describeActivity(req), req, res, startedAt, failure);
        } catch {
          /* activity logging must never break a request */
        }
      }
    };
    // HTTP callers identify themselves with x-apk-vm-owner/scope/session/
    // workspace/label headers (query parameters are accepted too). A POST that
    // controls a running VM must match the current lease; reads stay read-only.
    const OWNER_GUARDED_POST_PATHS = new Set([
      '/apk-vm/controls',
      '/apk-vm/skills',
      '/apk-vm/flows',
      '/apk-vm/input',
      '/apk-vm/touch',
      '/apk-vm/clipboard',
      '/apk-vm/vm',
      '/apk-vm/device',
      '/apk-vm/remote',
      '/apk-vm/install',
      '/apk-vm/upload',
      '/apk-vm/stream',
      '/apk-vm/stream/quality',
      '/apk-vm/ui-test',
      '/apk-vm/snapshots',
      '/apk-vm/network',
      '/apk-vm/network/har',
      '/apk-vm/debug/shell',
      '/apk-vm/debug/prop',
      '/apk-vm/debug/push',
      '/apk-vm/debug/pull',
      '/apk-vm/debug/reboot',
      '/apk-vm/debug/action',
      '/apk-vm/debug/rotate',
      '/apk-vm/debug/proxy',
      '/apk-vm/debug/ca',
      '/apk-vm/debug/record',
      '/apk-vm/debug/env',
    ]);

    function requestQuery(req) {
      try {
        return new URL(String(req.url || '/'), 'http://apk-vm.local').searchParams;
      } catch {
        return new URLSearchParams();
      }
    }

    function isLoopbackRequest(req) {
      const address = String((req && req.socket && req.socket.remoteAddress) || '');
      return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
    }

    function httpOwnerFromRequest(req) {
      const values = ownerFromHttp(req.headers || {}, requestQuery(req));
      if (!values) return null;
      const owner = instanceManager.ownerFor(values);
      // Admin is a local-panel privilege only. A remote/forwarded request may
      // still identify itself, but it is downgraded to a normal owner.
      if (owner.role === 'admin' && !isLoopbackRequest(req)) owner.role = 'user';
      return owner;
    }

    function assertHttpOwner(req, res, instanceId = 'default') {
      if (!instanceManager) return true;
      const lease = instanceManager.ownerInfo(instanceId);
      const incoming = httpOwnerFromRequest(req);
      const access = checkOwnerAccess(lease, incoming, instanceId);
      if (!access.ok) {
        sendJson(res, access.status || 409, {
          ok: false,
          error: access.error,
          code: access.code || 'vm-busy',
          owner: access.owner || lease,
        });
        return false;
      }
      if (access.autoClaim) {
        try {
          instanceManager.claimOwner(instanceId, incoming);
        } catch (error) {
          sendJson(res, error.status === 409 ? 409 : 400, {
            ok: false,
            error: error.message,
            code: error.code || null,
            owner: error.owner || null,
          });
          return false;
        }
      }
      if (access.touch) instanceManager.touchOwner(instanceId, incoming.key);
      return true;
    }

    // Mutating panel/HTTP routes whose requests are journaled as user activity.
    // Read-only routes (state/frame/screenshots/...) stay out of the journal.
    const USER_ACTIVITY_PATHS = new Set([
      '/apk-vm/controls',
      '/apk-vm/skills',
      '/apk-vm/flows',
      '/apk-vm/ui-test',
      '/apk-vm/setup',
      '/apk-vm/ownership',
      '/apk-vm/instances',
      '/apk-vm/avds',
      '/apk-vm/avd',
      '/apk-vm/devices',
      '/apk-vm/device',
      '/apk-vm/remote',
      '/apk-vm/vm',
      '/apk-vm/install',
      '/apk-vm/upload',
      '/apk-vm/input',
      '/apk-vm/touch',
      '/apk-vm/clipboard',
      '/apk-vm/stream',
      '/apk-vm/stream/quality',
      '/apk-vm/debug/env',
      '/apk-vm/debug/shell',
      '/apk-vm/debug/prop',
      '/apk-vm/debug/push',
      '/apk-vm/debug/pull',
      '/apk-vm/debug/reboot',
      '/apk-vm/debug/action',
      '/apk-vm/snapshots',
      '/apk-vm/debug/rotate',
      '/apk-vm/debug/proxy',
      '/apk-vm/debug/ca',
      '/apk-vm/network/har',
      '/apk-vm/network',
      '/apk-vm/network/pcap',
      '/apk-vm/debug/record',
      '/apk-vm/apks',
    ]);

    function activityText(value, max) {
      const text = value == null ? '' : String(value);
      return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
    }

    function activityNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : '?';
    }

    function httpActivityTool(req) {
      let tool = 'panel';
      try {
        const owner = httpOwnerFromRequest(req);
        if (owner) {
          tool = String(owner.label || owner.session || owner.key || owner.owner || 'http-client');
        }
      } catch {
        /* ignore */
      }
      return tool.slice(0, 80);
    }

    // One mutating HTTP request -> one journal entry. Everything is
    // best-effort: unknown routes fall back to a generic label.
    function userActivitySpec(pathname, req, body, query, instanceId) {
      const b = body && typeof body === 'object' ? body : {};
      const key =
        String(pathname || '')
          .replace(/^\/apk-vm\/instances\/[^/]+/, '')
          .replace(/^\/apk-vm/, '') || '/';
      let action = 'http';
      let summary = `${String((req && req.method) || 'POST')} ${pathname}`;
      let shotAction = null;
      let argsPreview = null;
      if (key === '/input') {
        const type = String(b.type || b.action || 'input').toLowerCase();
        if (type === 'tap') {
          action = 'tap';
          summary = `tap (${activityNumber(b.x)}, ${activityNumber(b.y)})`;
          shotAction = 'tap';
        } else if (type === 'swipe') {
          action = 'swipe';
          summary = `swipe (${activityNumber(b.x1)}, ${activityNumber(b.y1)}) -> (${activityNumber(b.x2)}, ${activityNumber(b.y2)})`;
          shotAction = 'swipe';
        } else if (type === 'long_press') {
          action = 'long_press';
          summary = `long press (${activityNumber(b.x)}, ${activityNumber(b.y)})`;
          shotAction = 'long_press';
        } else if (type === 'key') {
          action = 'key';
          summary = `key ${activityText(b.key, 60)}`;
          shotAction = 'key';
        } else if (type === 'text') {
          action = 'text';
          // Never journal the raw text: password fields and personal data would
          // otherwise leak into the local journal. Record only its length.
          const typedLength = String(b.text == null ? '' : b.text).length;
          summary = `type ${typedLength} char${typedLength === 1 ? '' : 's'}`;
          shotAction = 'text';
          argsPreview = JSON.stringify({ type: 'text', text: `<${typedLength} chars>` });
        } else {
          action = 'input';
          summary = `input ${type}`;
        }
      } else if (key === '/touch') {
        action = 'touch';
        summary = `touch ${activityText(b.action, 20)} (${activityNumber(b.x)}, ${activityNumber(b.y)})`;
      } else if (key === '/clipboard') {
        action = 'clipboard';
        const text = String(b.text == null ? '' : b.text);
        summary = text ? `set clipboard (${text.length} chars)` : 'clipboard request';
      } else if (key === '/vm') {
        action = 'vm';
        summary = `VM ${activityText(b.action, 30) || 'request'}`;
      } else if (key === '/install') {
        action = 'install';
        summary = `install ${activityText(String(b.path || '').split(/[\\/]/).pop(), 100) || 'APK'}`;
        shotAction = 'install';
      } else if (key === '/upload') {
        action = 'install';
        const length = Number((req && req.headers && req.headers['content-length']) || 0);
        summary = `upload APK${length > 0 ? ` (${Math.round(length / 1024)} KB)` : ''}`;
        shotAction = 'install';
      } else if (key === '/setup') {
        action = 'setup';
        summary = `setup ${activityText(b.action, 40) || 'refresh'}`;
      } else if (key === '/snapshots') {
        action = 'snapshot';
        const name = activityText(b.name, 60);
        summary = `snapshot ${activityText(b.action, 20) || 'save'}${name ? ` ${name}` : ''}`;
      } else if (key === '/network' || key === '/network/har' || key === '/network/pcap') {
        action = key === '/network' ? 'network' : key === '/network/har' ? 'network.har' : 'network.pcap';
        summary = `${action.replace('network.', '')} ${activityText(b.action, 30) || 'request'}`.trim();
      } else if (key === '/debug/shell') {
        action = 'shell';
        summary = `shell ${activityText(b.command || b.cmd, 90)}`;
      } else if (key === '/debug/prop') {
        action = 'prop';
        summary = `prop ${activityText(b.name, 60)}${b.value !== undefined ? ` = ${activityText(b.value, 60)}` : ''}`;
      } else if (key === '/debug/push' || key === '/debug/pull') {
        action = key === '/debug/push' ? 'push' : 'pull';
        const local = activityText(b.local || b.path, 80);
        const remote = activityText(b.remote, 80);
        summary = key === '/debug/pull' ? `pull ${remote} -> ${local}` : `push ${local} -> ${remote}`;
      } else if (key === '/debug/reboot') {
        action = 'reboot';
        summary = `reboot ${activityText(b.mode || '', 20)}`.trim();
      } else if (key === '/debug/rotate') {
        action = 'rotate';
        summary = `rotate ${activityText(b.mode || b.orientation, 30)}`;
      } else if (key === '/debug/proxy') {
        action = 'proxy';
        summary = b.host ? `proxy ${activityText(b.host, 60)}${b.port ? `:${activityText(b.port, 10)}` : ''}` : 'proxy change';
      } else if (key === '/debug/ca') {
        action = 'install_ca';
        summary = 'install CA certificate';
      } else if (key === '/debug/record') {
        action = 'record';
        summary = `record ${activityText(b.seconds, 10)}s`;
      } else if (key === '/debug/action' || key === '/debug/env') {
        action = 'debug';
        summary = `debug ${activityText(b.action, 40)}`;
      } else if (key === '/controls') {
        action = 'control';
        summary = `control ${activityText(b.action, 40)}`;
      } else if (key === '/skills') {
        action = 'skill';
        summary = `skill ${activityText(b.action, 30)} ${activityText(b.skillId || b.name, 60)}`.trim();
      } else if (key === '/flows') {
        action = 'flow';
        summary = `flow ${activityText(b.action, 30)} ${activityText(b.flowId || b.name, 60)}`.trim();
      } else if (key === '/ui-test') {
        action = 'ui_test';
        summary = `UI test ${activityText(b.name || b.action, 60)}`.trim();
      } else if (key === '/device') {
        action = 'device';
        summary = `device ${activityText(b.action, 30)} ${activityText(b.serial, 80)}`.trim();
      } else if (key === '/remote') {
        action = 'remote';
        summary = `remote ${activityText(b.action, 30)}`;
      } else if (key === '/ownership') {
        action = 'ownership';
        summary = `ownership ${activityText(b.action, 30)}`;
      } else if (key === '/instances') {
        action = 'instances';
        summary = `instances ${activityText(b.action, 30)} ${activityText(b.id || b.avdName, 60)}`.trim();
      } else if (key === '/avd' || key === '/avds') {
        action = 'avd';
        summary = `avd ${activityText(b.action, 30)} ${activityText(b.name || b.avdName, 60)}`.trim();
      } else if (key === '/stream' || key === '/stream/quality') {
        action = 'stream';
        summary = `stream ${activityText(b.action || b.quality, 30)}`.trim();
      }
      if (!argsPreview) {
        try {
          const text = JSON.stringify(b);
          argsPreview = text.length > 700 ? `${text.slice(0, 700)}…` : text;
        } catch {
          argsPreview = null;
        }
      }
      return {
        action,
        summary,
        tool: httpActivityTool(req),
        instanceId: instanceId || 'default',
        argsPreview,
        shotAction: shotAction && ACTIVITY_SHOT_ACTIONS.has(shotAction) ? shotAction : null,
      };
    }

    async function captureActivityShotBound(spec) {
      let timer = null;
      try {
        const shot = await Promise.race([
          captureActivityShot({ instance: spec && spec.instanceId }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), 3000);
          }),
        ]);
        return shot || null;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function recordUserActivity(spec, req, res, startedAt, failure) {
      try {
        const specSafe = spec && typeof spec === 'object' ? spec : {};
        const status = Number(res && res.statusCode) || 200;
        const responseBody = res && res._apkvmResponseBody;
        const responseOk = !(
          responseBody &&
          typeof responseBody === 'object' &&
          responseBody.ok === false
        );
        const ok = !failure && status < 400 && responseOk;
        const error = ok
          ? null
          : String(
              (failure && (failure.message || failure)) ||
                (res && res._apkvmErrorMessage) ||
                (responseBody && typeof responseBody === 'object' && responseBody.error) ||
                `HTTP ${status}`,
            );
        let shot = null;
        // Screenshots are nice-to-have: cap the wait so a wedged guest can
        // never delay the request path (that is the 1.0.0 bug class).
        if (ok && specSafe.shotAction) {
          shot = await captureActivityShotBound(specSafe);
        }
        await activityLog.record({
          action: String(specSafe.action || 'http').slice(0, 100),
          source: 'http',
          tool: String(specSafe.tool || 'panel').slice(0, 100),
          instanceId: String(specSafe.instanceId || 'default'),
          summary: String(specSafe.summary || '').slice(0, 500),
          ok,
          error: error ? error.slice(0, 800) : null,
          durationMs: Math.max(0, Date.now() - startedAt),
          argsPreview: specSafe.argsPreview || null,
          shot: shot || undefined,
        });
      } catch {
        /* activity logging must never break a request */
      }
    }

    const register = (pathname, handler) => {
      const describeActivity = USER_ACTIVITY_PATHS.has(pathname)
        ? (req) => userActivitySpec(pathname, req, req._apkvmJsonBody || {}, requestQuery(req), 'default')
        : null;
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: pathname,
          handler: wrapHandler(async (req, res) => {
            if (req.method === 'POST' && OWNER_GUARDED_POST_PATHS.has(pathname) && !assertHttpOwner(req, res, 'default')) {
              return;
            }
            await handler(req, res);
          }, describeActivity),
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

    function activeSkill(instanceId) {
      return skillRecorder.active(instanceId);
    }

    function codebookForRequest(instanceId, supplied) {
      const active = activeSkill(instanceId);
      if (active) return active.skill.codebook;
      if (supplied) return normalizeCodebook(supplied);
      throw new Error('no codebook: start a Skill recording first or pass codebook');
    }

    async function resolveControlOnDevice(api, codebook, code, options = {}) {
      const value = String(code || '').trim();
      if (!value) throw new Error('control code is required');
      const dump = await api.uiDump();
      const parsed = parseUiHierarchy(dump.xml);
      const wantsImage = options.withImage === true
        || (codebook.entries || []).some((entry) => entry.features && entry.features.image);
      if (wantsImage && typeof api.screenshotBuffer === 'function') {
        try {
          attachNodeImageFeatures(await api.screenshotBuffer(), parsed.nodes);
        } catch {
          // Image matching will report a clear "no screenshot image features" error.
        }
      }
      let screen = null;
      try {
        screen = await api.screenSize();
      } catch {
        screen = null;
      }
      const result = resolveControl(codebook, value, parsed.nodes, { screen });
      if (!result.node || !result.node.bounds || !result.node.bounds.center) {
        throw new Error(`control ${value} has no usable bounds on the current screen`);
      }
      return { ...result, snapshotId: snapshotIdForXml(dump.xml), screen };
    }

    function recordControlStep(instanceId, step, body) {
      if (body && body.record === false) return false;
      if (!activeSkill(instanceId)) return false;
      skillRecorder.add(instanceId, step);
      return true;
    }

    async function handleControlRequest(req, res, instanceId, apiFactory) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase().replace(/-/g, '_');
      const api = apiFactory();
      try {
        await ensureToolApiReady(api, 'control');
        if (action === 'ui') {
          const inspector = buildInspectorPayload(await api.uiDump(), await api.screenSize().catch(() => null));
          sendJson(res, 200, { ok: true, ...inspector });
          return;
        }
        if (action === 'codebook') {
          const active = activeSkill(instanceId);
          if (active) {
            const codebook = await skillRecorder.updateCodebook(instanceId, body.codebook || {});
            sendJson(res, 200, { ok: true, codebook, recording: true });
            return;
          }
          const skillId = String(body.skillId || body.id || '').trim();
          if (!skillId) throw new Error('no active recording; codebook needs skillId');
          const skill = await skillStore.get(skillId);
          if (!skill) throw new Error(`unknown Skill: ${skillId}`);
          skill.codebook = normalizeCodebook(body.codebook || {});
          const saved = await skillStore.save(skill);
          sendJson(res, 200, { ok: true, skill: skillSummary(saved), codebook: saved.codebook });
          return;
        }
        if (action === 'launch') {
          const pkg = String(body.packageName || body.package || '').trim();
          if (!pkg) throw new Error('control launch requires package');
          const result = await api.launchPackage(pkg);
          recordControlStep(instanceId, { action: 'launch', package: pkg }, body);
          sendJson(res, 200, { ok: true, action, package: pkg, result, recorded: Boolean(activeSkill(instanceId)) });
          return;
        }
        const codebook = codebookForRequest(instanceId, body.codebook);
        if (action === 'features') {
          const code = String(body.code || '').trim();
          if (!code) throw new Error('control features requires code');
          const target = await resolveControlOnDevice(api, codebook, code, { withImage: true });
          const image = target.node && target.node.imageFeatures
            ? {
                name: String(body.imageName || code).slice(0, 120),
                hash: target.node.imageFeatures.hash,
                avgColor: target.node.imageFeatures.avgColor,
                dominantColor: target.node.imageFeatures.dominantColor,
                maxDistance: body.maxDistance,
                colorTolerance: body.colorTolerance,
              }
            : null;
          const entry = {
            code,
            ...(body.name ? { name: String(body.name) } : {}),
            features: { ...suggestFeatures(target.node), ...(image ? { image } : {}) },
          };
          sendJson(res, 200, {
            ok: true,
            action,
            code: target.code,
            snapshotId: target.snapshotId,
            features: target.node.features || suggestFeatures(target.node),
            imageFeatures: target.node.imageFeatures || null,
            suggestedEntry: entry,
          });
          return;
        }
        if (action === 'assert' || action === 'wait') {
          const code = String(body.code || '').trim();
          const exists = body.exists !== false;
          let target = null;
          let error = null;
          try {
            target = await resolveControlOnDevice(api, codebook, code);
          } catch (caught) {
            error = caught;
          }
          if (exists && !target) throw error || new Error(`control ${code} is not visible`);
          if (!exists && target) throw new Error(`control ${code} is visible; exists=false assertion failed`);
          const step = { action: action === 'wait' ? 'waitFor' : 'assert', code };
          if (!exists) step.exists = false;
          const recorded = recordControlStep(instanceId, step, body);
          sendJson(res, 200, {
            ok: true,
            action,
            code,
            exists,
            snapshotId: target ? target.snapshotId : null,
            recorded,
          });
          return;
        }
        if (action === 'swipe') {
          const fromCode = String(body.fromCode || body.from || '').trim();
          const toCode = String(body.toCode || body.to || '').trim();
          let from = null;
          let to = null;
          if (fromCode) from = await resolveControlOnDevice(api, codebook, fromCode);
          if (toCode) to = await resolveControlOnDevice(api, codebook, toCode);
          let x1 = from ? from.node.bounds.center.x : Number(body.x1);
          let y1 = from ? from.node.bounds.center.y : Number(body.y1);
          let x2 = to ? to.node.bounds.center.x : Number(body.x2);
          let y2 = to ? to.node.bounds.center.y : Number(body.y2);
          if (![x1, y1, x2, y2].every(Number.isFinite)) {
            throw new Error('control swipe needs fromCode/toCode or numeric x1,y1,x2,y2');
          }
          const durationMs = Math.max(1, Math.min(60000, Number(body.durationMs) || 300));
          await api.input({ type: 'swipe', x1, y1, x2, y2, durationMs });
          const step = fromCode || toCode
            ? { action: 'swipe', fromCode: fromCode || undefined, toCode: toCode || undefined, durationMs }
            : { action: 'swipe', x1, y1, x2, y2, durationMs };
          const recorded = recordControlStep(instanceId, step, body);
          sendJson(res, 200, { ok: true, action, fromCode: fromCode || null, toCode: toCode || null, x1, y1, x2, y2, recorded });
          return;
        }
        const code = String(body.code || '').trim();
        const target = await resolveControlOnDevice(api, codebook, code);
        const center = target.node.bounds.center;
        if (action === 'tap') {
          await api.input({ type: 'tap', x: center.x, y: center.y });
          const recorded = recordControlStep(instanceId, { action: 'tap', code }, body);
          sendJson(res, 200, { ok: true, action, code: target.code, x: center.x, y: center.y, snapshotId: target.snapshotId, recorded });
          return;
        }
        if (action === 'input') {
          const text = body.text === undefined ? (body.value === undefined ? '' : String(body.value)) : String(body.text);
          const submit = body.submit === true;
          await api.input({ type: 'tap', x: center.x, y: center.y });
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (text) await api.input({ type: 'text', text: text.slice(0, 4096) });
          if (submit) await api.input({ type: 'key', key: 'ENTER' });
          const recorded = recordControlStep(instanceId, { action: 'input', code, value: text, ...(submit ? { submit: true } : {}) }, body);
          sendJson(res, 200, { ok: true, action, code: target.code, chars: text.length, submit, snapshotId: target.snapshotId, recorded });
          return;
        }
        if (action === 'long_press') {
          const durationMs = Math.max(300, Math.min(60000, Number(body.durationMs) || 800));
          await api.input({ type: 'swipe', x1: center.x, y1: center.y, x2: center.x, y2: center.y, durationMs });
          const recorded = recordControlStep(instanceId, { action: 'longPress', code, durationMs }, body);
          sendJson(res, 200, { ok: true, action, code: target.code, durationMs, snapshotId: target.snapshotId, recorded });
          return;
        }
        throw new Error(`unsupported control action: ${action || '(missing)'}`);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          candidates: error && error.candidates ? error.candidates : [],
          codebookCodes: error && error.codebookCodes ? error.codebookCodes : [],
        });
      }
    }

    async function handleSkillsRequest(req, res, instanceId, apiFactory) {
      if (req.method === 'GET') {
        const active = activeSkill(instanceId);
        sendJson(res, 200, {
          ok: true,
          instance: instanceId,
          skills: (await skillStore.list()).map(skillSummary),
          recording: active ? { ...skillSummary(active.skill), codebook: active.skill.codebook } : null,
        });
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase().replace(/-/g, '_');
      try {
        if (action === 'start') {
          const started = await skillRecorder.start(instanceId, {
            name: body.name || body.skillName,
            id: body.skillId || body.id,
            package: body.packageName || body.package,
            description: body.description,
            target: body.targetCode || body.target,
            codebook: body.codebook,
          });
          sendJson(res, 200, { ok: true, action, recording: started });
          return;
        }
        if (action === 'stop') {
          const saved = await skillRecorder.stop(instanceId, {
            name: body.name || body.skillName,
            package: body.packageName || body.package,
            description: body.description,
          });
          sendJson(res, 200, { ok: true, action, skill: skillSummary(saved), result: saved });
          return;
        }
        if (action === 'cancel') {
          const cancelled = skillRecorder.cancel(instanceId);
          sendJson(res, 200, { ok: true, action, cancelled });
          return;
        }
        if (action === 'save') {
          const source = body.skill && typeof body.skill === 'object' ? { ...body.skill } : { ...body };
          if (!source.id && body.skillId) source.id = body.skillId;
          if (!source.name && body.skillName) source.name = body.skillName;
          delete source.action;
          const saved = await skillStore.save(normalizeSkill(source));
          sendJson(res, 200, { ok: true, action, skill: skillSummary(saved), result: saved });
          return;
        }
        if (action === 'get') {
          const id = String(body.skillId || body.id || '').trim();
          if (!id) throw new Error('get requires skillId');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          sendJson(res, 200, { ok: true, action, result: skill });
          return;
        }
        if (action === 'delete') {
          const id = String(body.skillId || body.id || '').trim();
          if (!id) throw new Error('delete requires skillId');
          const removed = await skillStore.remove(id);
          sendJson(res, 200, { ok: true, action, removed });
          return;
        }
        if (action === 'codebook') {
          const id = String(body.skillId || body.id || '').trim();
          if (!id) throw new Error('codebook requires skillId (or use /apk-vm/controls while recording)');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          skill.codebook = normalizeCodebook(body.codebook || {});
          const saved = await skillStore.save(skill);
          sendJson(res, 200, { ok: true, action, skill: skillSummary(saved), codebook: saved.codebook });
          return;
        }
        if (action === 'run') {
          const id = String(body.skillId || body.id || '').trim();
          if (!id) throw new Error('run requires skillId');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          const api = apiFactory();
          await ensureToolApiReady(api, 'skill_run');
          const result = await runSkill(skill, api, {
            speed: body.speed,
            untilCode: body.untilCode || body.targetCode,
            variables: body.variables,
            dryRun: body.dryRun === true,
            timeoutMs: body.timeoutMs,
            package: body.packageName || body.package,
          });
          sendJson(res, 200, { ok: true, action, result });
          return;
        }
        throw new Error(`unsupported Skill action: ${action || '(missing)'}`);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          candidates: error && error.candidates ? error.candidates : [],
          stepsRun: error && error.stepsRun,
          stepIndex: error && error.stepIndex,
          events: error && error.events ? error.events : [],
        });
      }
    }

    register('/apk-vm/flows', async (req, res) => {
      await handleFlowRequest(req, res, 'default', async (payload) => {
        const status = await vm.status();
        if (!isReady(status)) throw new Error(`VM is not ready (state: ${status.state})`);
        return vm.input(payload);
      });
    });

    register('/apk-vm/skills', async (req, res) => {
      await handleSkillsRequest(req, res, 'default', () => defaultToolApi());
    });

    register('/apk-vm/controls', async (req, res) => {
      await handleControlRequest(req, res, 'default', () => defaultToolApi());
    });

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
      const body = await stateBody();
      sendJson(res, 200, body);
      maybeAutoSetup('state');
    });

    register('/apk-vm/setup', async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost');
        const report = await loadSetup(url.searchParams.get('force') === '1');
        sendJson(res, 200, { ...report, autoSetup: activeAutoSetup().status(), autoSetupEnabled });
        maybeAutoSetup('setup');
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      if (action === 'auto-setup') {
        if (!autoSetupEnabled && body.confirmDownload !== true) {
          sendError(res, 403, 'automatic environment setup is disabled; set autoSetup: true or pass confirmDownload: true');
          return;
        }
        if (!autoSetupEnabled && !autoSetupOverride) autoSetupOverride = buildAutoSetup(true);
        const runner = activeAutoSetup();
        // Do not await: a full JDK + SDK download can take minutes. The caller
        // polls /apk-vm/state (or GET /apk-vm/setup) for progress.
        void runner.start('api').catch(() => {});
        sendJson(res, 200, { ok: true, autoSetup: runner.status() });
        return;
      }
      if (action === 'cancel-auto-setup') {
        const runner = activeAutoSetup();
        runner.cancel();
        sendJson(res, 200, { ok: true, autoSetup: runner.status() });
        return;
      }
      if (action === 'refresh') {
        sendJson(res, 200, { ok: true, setup: await loadSetup(true) });
        return;
      }
      if (action === 'create-avd') {
        const result = await createAvd({
          sdkRoot: cfg.sdkRoot || undefined,
          jdkRoot: configuredJdkRoot,
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
          jdkRoot: configuredJdkRoot,
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
          jdkRoot: configuredJdkRoot,
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
          jdkRoot: configuredJdkRoot,
          packages: Array.isArray(body.packages) ? body.packages : undefined,
          acceptLicenses: true,
        });
        setupCache = null;
        sendJson(res, 200, { ok: result.ok === true, action, result });
        return;
      }
      sendError(res, 400, `unsupported setup action: ${action || '(missing)'}`);
    });

    register('/apk-vm/ownership', async (req, res) => {
      if (!instanceManager) {
        sendError(res, 503, 'multi-instance support is disabled');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const query = requestQuery(req);
        const instanceId = String(query.get('instanceId') || query.get('id') || 'default');
        sendJson(res, 200, {
          ok: true,
          instanceId,
          owner: instanceManager.ownerInfo(instanceId),
          default: instanceManager.ownerInfo('default'),
          owners: instanceManager.ownerList(),
        });
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || 'status').toLowerCase();
      const instanceId = String(body.instanceId || body.id || 'default');
      const owner = instanceManager.ownerFor({
        key: body.ownerKey || body.key || (body.owner && body.owner.key) || undefined,
        scope: body.ownerScope || body.scope || (body.owner && body.owner.scope) || 'shared',
        sessionId: body.sessionId || (body.owner && body.owner.sessionId) || null,
        workspace: body.workspace || (body.owner && body.owner.workspace) || null,
        label: body.ownerLabel || body.label || (body.owner && body.owner.label) || '桌面面板',
        role: body.role || body.ownerRole || (body.owner && body.owner.role) || 'user',
        source: 'panel',
      });
      try {
        const admin = owner.role === 'admin';
        if (action === 'claim') {
          const result = instanceManager.claimOwner(instanceId, owner, { force: body.force === true || admin });
          sendJson(res, 200, { ok: true, instanceId, ...result });
          return;
        }
        if (action === 'release') {
          const released = instanceManager.releaseOwner(instanceId, owner, { force: body.force === true || admin });
          sendJson(res, 200, { ok: true, instanceId, released });
          return;
        }
        if (action === 'touch') {
          sendJson(res, 200, { ok: true, owner: instanceManager.touchOwner(instanceId, owner.key) });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          default: instanceManager.ownerInfo('default'),
          owners: instanceManager.ownerList(),
        });
      } catch (error) {
        sendError(res, error.status === 409 ? 409 : 400, error.message);
      }
    });

    register('/apk-vm/instances', async (req, res) => {
      if (!instanceManager) {
        sendError(res, 503, 'multi-instance support is disabled');
        return;
      }
      if (req.method === 'GET') {
        const defaultStatus = await vm.status();
        const defaultOwnerInfo = instanceManager ? instanceManager.ownerInfo('default') : null;
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
              owner: defaultOwnerInfo ? defaultOwnerInfo.key : null,
              ownerInfo: defaultOwnerInfo,
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
          const owner = body.ownerKey || body.ownerScope
            ? instanceManager.ownerFor({
                key: body.ownerKey || undefined,
                scope: body.ownerScope || body.scope || 'shared',
                sessionId: body.sessionId || null,
                workspace: body.workspace || null,
                label: body.ownerLabel || body.label || 'panel',
                source: 'panel',
              })
            : null;
          if (owner) instanceManager.claimOwner(instance.id, owner, { force: body.force === true });
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
              owner: owner ? owner.key : null,
              ownerInfo: owner ? instanceManager.ownerInfo(instance.id) : null,
            },
            maxInstances: instanceManager.maxInstances,
          });
        } catch (error) {
          sendError(res, error.status === 409 ? 409 : 400, error.message);
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
      if (req.method === 'POST' && !assertHttpOwner(req, res, id)) return;
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
      if (rest === 'skills') {
        await handleSkillsRequest(req, res, id, () => extraToolApi(instance));
        return;
      }
      if (rest === 'controls') {
        await handleControlRequest(req, res, id, () => extraToolApi(instance));
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
          else if (action === 'validate') result = await instance.vm.networkValidation();
          else if (action === 'pcap') result = instance.vm.setTcpdumpPath(body.path);
          else if (action === 'forward-add') result = await instance.vm.addPortForward(body.localPort, body.remotePort, { shared: body.shared === true });
          else if (action === 'forward-remove') result = await instance.vm.removePortForward(body.localPort);
          else if (action === 'reverse-add') result = await instance.vm.addReverse(body.localPort, body.hostPort || body.remotePort);
          else if (action === 'reverse-remove') result = await instance.vm.removeReverse(body.localPort);
          else if (action === 'reverse-list') result = { ok: true, reverses: instance.vm.listReverseForwards() };
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
        const meta = await instance.installApk(apkPath);
        rememberInstalledApp(apkPath, meta, instance.id);
        sendJson(res, 200, { ok: true, ...meta });
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
        const meta = await instance.installApk(target);
        const archived = await persistUploadedApk(target, meta);
        rememberInstalledApp(archived || target, meta, instance.id);
        sendJson(res, 200, { ok: true, ...meta, upload: { fileName: name, bytes: data.length } });
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
        'skills',
        'controls',
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
            handler: wrapHandler(
              (req, res) => handleExtraRequest(req, res, id, suffix),
              (req) =>
                userActivitySpec(
                  suffix ? `/apk-vm/${suffix}` : '/apk-vm/state',
                  req,
                  req._apkvmJsonBody || {},
                  requestQuery(req),
                  id,
                ),
            ),
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

    // ---- Agent activity log ------------------------------------------------
    // One prefix route: the host router matches exact paths literally, and the
    // panel needs /activity, /activity/<id>/shot and /activity/clear.
    const activityPrefix = '/apk-vm/activity';
    disposers.push(
      webServer.register({
        kind: 'prefix',
        path: activityPrefix,
        handler: wrapHandler(async (req, res) => {
          const pathname = new URL(String(req.url || '/'), 'http://localhost').pathname;
          const rest = pathname.slice(activityPrefix.length).replace(/^\/+/, '');
          try {
            if (req.method === 'POST' && rest === 'clear') {
              sendJson(res, 200, { ok: true, action: 'clear', ...(await activityLog.clear()) });
              return;
            }
            if (req.method !== 'GET') {
              sendError(res, 405, 'GET only (POST /apk-vm/activity/clear clears the log)');
              return;
            }
            if (rest === '' || rest === 'list') {
              const query = requestQuery(req);
              const okParam = query.get('ok');
              const page = await activityLog.list({
                limit: query.get('limit') ? Number(query.get('limit')) : undefined,
                beforeId: query.get('beforeId') || undefined,
                action: query.get('action') || undefined,
                instanceId: query.get('instanceId') || undefined,
                source: query.get('source') || undefined,
                ok:
                  okParam === null || okParam === ''
                    ? undefined
                    : okParam === 'true' || okParam === '1',
              });
              sendJson(res, 200, { ok: true, enabled: true, ...page });
              return;
            }
            const shotMatch = /^([A-Za-z0-9_-]{1,128})\/shot$/.exec(rest);
            if (shotMatch) {
              const shot = await activityLog.shot(shotMatch[1]);
              if (!shot) {
                sendError(res, 404, 'activity shot not found');
                return;
              }
              res.writeHead(200, {
                'content-type': shot.mediaType || 'image/png',
                'content-length': shot.buffer.length,
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              });
              res.end(shot.buffer);
              return;
            }
            const entryMatch = /^([A-Za-z0-9_-]{1,128})$/.exec(rest);
            if (entryMatch) {
              const entry = await activityLog.get(entryMatch[1]);
              if (!entry) {
                sendError(res, 404, 'activity entry not found');
                return;
              }
              sendJson(res, 200, { ok: true, entry });
              return;
            }
            sendError(res, 404, `unknown activity route: /apk-vm/activity/${rest}`);
          } catch (error) {
            sendError(res, 500, `activity log failed: ${(error && error.message) || error}`);
          }
        }),
      }),
    );

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
        maybeAutoSetup('vm-start');
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
      if (req.method === 'GET') {
        let session;
        try {
          session = await ensureControlSession();
        } catch (error) {
          sendError(res, 409, error && error.message ? error.message : String(error));
          return;
        }
        try {
          const text = await session.requestClipboard(2000);
          sendJson(res, 200, { ok: true, text });
        } catch (error) {
          sendError(res, 504, error && error.message ? error.message : String(error));
        } finally {
          scheduleScrcpyIdleStop();
        }
        return;
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'GET or POST only');
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, error && error.message ? error.message : String(error));
        return;
      }
      if (typeof body.text !== 'string') {
        sendError(res, 400, 'text must be a string');
        return;
      }
      try {
        const session = await ensureControlSession();
        try {
          const result = await session.setClipboard(body.text, { paste: body.paste === true });
          sendJson(res, 200, { ok: true, ...result });
        } finally {
          scheduleScrcpyIdleStop();
        }
      } catch (error) {
        sendError(res, 409, error && error.message ? error.message : String(error));
      }
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

    register('/apk-vm/debug/env', async (req, res) => {
      if (req.method !== 'POST') {
        sendError(res, 405, 'POST only');
        return;
      }
      const body = await readJsonBody(req);
      const action = String(body.action || '').toLowerCase();
      try {
        if (action === 'capture') {
          sendJson(res, 200, { ok: true, snapshot: await vm.captureEnv() });
        } else if (action === 'restore') {
          if (!body.envSnapshot || typeof body.envSnapshot !== 'object') throw new Error('restore requires envSnapshot');
          sendJson(res, 200, await vm.restoreEnv(body.envSnapshot));
        } else {
          throw new Error('action must be capture or restore');
        }
      } catch (error) {
        sendError(res, 400, error.message);
      }
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
        else if (action === 'validate') result = await vm.networkValidation();
        else if (action === 'pcap') result = vm.setTcpdumpPath(body.path);
        else if (action === 'forward-add') result = await vm.addPortForward(body.localPort, body.remotePort, { shared: body.shared === true });
        else if (action === 'forward-remove') result = await vm.removePortForward(body.localPort);
        else if (action === 'reverse-add') result = await vm.addReverse(body.localPort, body.hostPort || body.remotePort);
        else if (action === 'reverse-remove') result = await vm.removeReverse(body.localPort);
        else if (action === 'reverse-list') result = { ok: true, reverses: vm.listReverseForwards() };
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
      let png = await vm.screenshot();
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.searchParams.get('overlay') === '1') {
          const dump = await vm.uiDump();
          png = annotateScreenshot(png, parseUiHierarchy(dump.xml).nodes).buffer;
        }
      } catch {
        /* keep the plain screenshot on overlay failure */
      }
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
      activeAutoSetup().cancel();
      void stopScrcpy();
      void cleanupUploads();
      for (const id of [...extraRouteDisposers.keys()]) disposeExtraRouteSet(id);
      for (const bridge of cdpBridges.values()) void bridge.close().catch(() => {});
      cdpBridges.clear();
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
  if (cfg.prewarm === true && (vm.emulatorPath || vm.serial)) {
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

  function cdpFor(api) {
    const key = `${api.kind}:${api.id}`;
    let bridge = cdpBridges.get(key);
    if (!bridge) {
      bridge = new CdpBridge({
        adb: (args, options) => api.adb(args, options),
        serial: () => api.serial(),
        timeoutMs: 15_000,
      });
      cdpBridges.set(key, bridge);
    }
    return bridge;
  }

  function webviewDescriptor(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return value >= 1 ? value - 1 : value;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return Math.max(0, Number(text) - 1);
    if (/^(https?|file|about):/i.test(text)) return { urlContains: text };
    return text;
  }

  async function withCdpSession(api, options, fn) {
    const bridge = cdpFor(api);
    const session = await bridge.open(webviewDescriptor(options && options.target));
    try {
      return await fn(session, bridge);
    } finally {
      session.close();
    }
  }

  function webviewApi(api) {
    return {
      webviewTargets: () => cdpFor(api).targets(),
      webviewQuery: (selector, options) => cdpFor(api).query(selector, {
        target: webviewDescriptor(options && options.target),
      }),
      webviewEval: (script, options) => withCdpSession(api, options, (session) => session.evaluateJson(script)),
      webviewClick: (selector, options) => withCdpSession(api, options, (session) => session.click(selector)),
      webviewWaitFor: (selector, options) => withCdpSession(api, options, (session) => session.waitFor(selector, {
        timeoutMs: options && options.timeoutMs,
      })),
      webviewInsertText: (text, options) => withCdpSession(api, options, (session) => session.insertText(text, {
        selector: options && options.selector,
      })),
    };
  }

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
        const session = await ensureControlSession();
        try {
          return await session.requestClipboard(2000);
        } finally {
          scheduleScrcpyIdleStop();
        }
      },
      setClipboard: async (text, paste) => {
        const session = await ensureControlSession();
        try {
          return await session.setClipboard(text, { paste: paste === true });
        } finally {
          scheduleScrcpyIdleStop();
        }
      },
      typeText: async (text) => {
        const session = await ensureControlSession();
        try {
          const count = await session.sendText(String(text));
          return { ok: true, chars: String(text).length, messages: count };
        } finally {
          scheduleScrcpyIdleStop();
        }
      },
      install: (apkPath) => installApkFromPath(apkPath),
      pushFile: (local, remote) => vm.pushFile(local, remote),
      pullFile: (remote, local) => vm.pullFile(remote, local),
      reboot: (mode, options) => vm.reboot(mode, options),
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
      networkValidation: () => vm.networkValidation(),
      setNetworkMode: (mode) => vm.setNetworkMode(mode),
      setTcpdumpPath: (filePath) => vm.setTcpdumpPath(filePath),
      setDnsServers: (servers) => vm.setDnsServers(servers),
      setHosts: (entries) => vm.setHosts(entries),
      testNetwork: (options) => vm.testNetwork(options),
      addPortForward: (local, remote, options) => vm.addPortForward(local, remote, options),
      removePortForward: (local) => vm.removePortForward(local),
      addReverse: (local, host) => vm.addReverse(local, host),
      removeReverse: (local) => vm.removeReverse(local),
      listReverse: () => vm.listReverseForwards(),
      captureEnv: () => vm.captureEnv(),
      restoreEnv: (snapshot) => vm.restoreEnv(snapshot),
      adb: (args, options) => vm.adb(args, options),
      screenRecord: (options) => vm.screenRecord(options),
      perfSnapshot: () => vm.perfSnapshot(),
      screenshotBuffer: () => vm.screenshot(),
      ...webviewApi({
        kind: 'default',
        id: 'default',
        adb: (args, options) => vm.adb(args, options),
        serial: () => vm.serial,
      }),
      screenshot: async () => {
        const buffer = await vm.screenshot();
        const target = path.join(os.tmpdir(), `apk-vm-shot-${Date.now()}.png`);
        await fsp.writeFile(target, buffer);
        return { path: target, bytes: buffer.length };
      },
      screenshotAnnotated: async () => {
        const [buffer, dump] = await Promise.all([vm.screenshot(), vm.uiDump()]);
        const nodes = parseUiHierarchy(dump.xml).nodes;
        const annotated = annotateScreenshot(buffer, nodes);
        const target = path.join(os.tmpdir(), `apk-vm-shot-overlay-${Date.now()}.png`);
        await fsp.writeFile(target, annotated.buffer);
        return {
          path: target,
          bytes: annotated.buffer.length,
          width: annotated.width,
          height: annotated.height,
          nodes: nodes.length,
          boxes: annotated.boxes,
        };
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
      typeText: (text) => instance.sendText(text),
      install: async (apkPath) => {
        const resolved = resolveApkPath(apkPath, rootsFor());
        const meta = await instance.installApk(resolved);
        rememberInstalledApp(resolved, meta, instance.id);
        return meta;
      },
      pushFile: (local, remote) => instance.pushFile(local, remote),
      pullFile: (remote, local) => instance.pullFile(remote, local),
      reboot: (mode, options) => instance.reboot(mode, options),
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
      networkValidation: () => instance.vm.networkValidation(),
      setNetworkMode: (mode) => instance.vm.setNetworkMode(mode),
      setTcpdumpPath: (filePath) => instance.vm.setTcpdumpPath(filePath),
      setDnsServers: (servers) => instance.vm.setDnsServers(servers),
      setHosts: (entries) => instance.vm.setHosts(entries),
      testNetwork: (options) => instance.vm.testNetwork(options),
      addPortForward: (local, remote, options) => instance.vm.addPortForward(local, remote, options),
      removePortForward: (local) => instance.vm.removePortForward(local),
      addReverse: (local, host) => instance.vm.addReverse(local, host),
      removeReverse: (local) => instance.vm.removeReverse(local),
      listReverse: () => instance.vm.listReverseForwards(),
      captureEnv: () => instance.vm.captureEnv(),
      restoreEnv: (snapshot) => instance.vm.restoreEnv(snapshot),
      adb: (args, options) => instance.vm.adb(args, options),
      screenRecord: (options) => instance.screenRecord(options),
      perfSnapshot: () => instance.perfSnapshot(),
      screenshotBuffer: () => instance.screenshot(),
      ...webviewApi({
        kind: 'extra',
        id: instance.id,
        adb: (args, options) => instance.vm.adb(args, options),
        serial: () => instance.vm.serial,
      }),
      screenshot: async () => {
        const buffer = await instance.screenshot();
        const target = path.join(os.tmpdir(), `apk-vm-shot-${instance.id}-${Date.now()}.png`);
        await fsp.writeFile(target, buffer);
        return { path: target, bytes: buffer.length };
      },
      screenshotAnnotated: async () => {
        const [buffer, dump] = await Promise.all([instance.screenshot(), instance.uiDump()]);
        const nodes = parseUiHierarchy(dump.xml).nodes;
        const annotated = annotateScreenshot(buffer, nodes);
        const target = path.join(os.tmpdir(), `apk-vm-shot-overlay-${instance.id}-${Date.now()}.png`);
        await fsp.writeFile(target, annotated.buffer);
        return {
          path: target,
          bytes: annotated.buffer.length,
          width: annotated.width,
          height: annotated.height,
          nodes: nodes.length,
          boxes: annotated.boxes,
        };
      },
    };
  }

  function toolOwnerContext(args, exec) {
    const session = exec && exec.agent ? exec.agent.session : null;
    const header = session && session.header ? session.header : {};
    const sessionId = header.id || header.sessionId || (session && session.id) ||
      (exec && (exec.sessionId || exec.agentId || (exec.agent && exec.agent.id))) || null;
    const workspace = header.cwd || (exec && exec.agent && exec.agent.cwd) ||
      (exec && exec.cwd) || null;
    return {
      scope: normalizeScope((args && (args.ownerScope || args.owner_scope)) || OWNER_SCOPE.SHARED),
      sessionId,
      workspace,
      label: (args && (args.ownerLabel || args.owner_label)) || null,
      source: 'tool',
    };
  }

  function ownerTakeoverRequested(args) {
    return Boolean(args && (args.ownerForce === true || args.takeover === true));
  }

  async function resolveToolApi(args, exec) {
    const requested = String((args && args.instance) || '').trim();
    const action = String((args && args.action) || '');
    // Ownership inspection/list is intentionally read-only: an Agent must be
    // able to see why a VM is busy without claiming or forcing it.
    if (action === 'owner_status' || action === 'list_instances') {
      if (requested && requested !== 'default') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const instance = instanceManager.get(requested);
        if (!instance) throw new Error(`unknown apk_vm instance: ${requested}`);
        return extraToolApi(instance);
      }
      return defaultToolApi();
    }
    const owner = toolOwnerContext(args, exec);
    const force = ownerTakeoverRequested(args);
    if (requested) {
      if (requested === 'default') {
        if (instanceManager) instanceManager.claimOwner('default', owner, { force });
        return defaultToolApi();
      }
      if (!instanceManager) throw new Error('multi-instance support is disabled');
      const instance = instanceManager.get(requested);
      if (!instance) throw new Error(`unknown apk_vm instance: ${requested}`);
      instanceManager.claimOwner(instance.id, owner, { force });
      return extraToolApi(instance);
    }
    if (instanceManager && exec && (exec.agent || owner.sessionId)) {
      const assigned = await instanceManager.forOwner(owner, { force });
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

  function toolCodebook(instanceId, args) {
    const active = skillRecorder.active(instanceId);
    if (active) return active.skill.codebook;
    if (args && args.codebook) return normalizeCodebook(args.codebook);
    throw new Error('no active Skill codebook; start skill_start first or pass codebook');
  }

  async function toolResolveControl(api, codebook, code, options = {}) {
    const value = String(code || '').trim();
    if (!value) throw new Error('control code is required');
    const dump = await api.uiDump();
    const parsed = parseUiHierarchy(dump.xml);
    const wantsImage = options.withImage === true
      || (codebook.entries || []).some((entry) => entry.features && entry.features.image);
    if (wantsImage && typeof api.screenshotBuffer === 'function') {
      try {
        attachNodeImageFeatures(await api.screenshotBuffer(), parsed.nodes);
      } catch {
        // Image matching will report a clear "no screenshot image features" error.
      }
    }
    let screen = null;
    try {
      screen = await api.screenSize();
    } catch {
      screen = null;
    }
    const result = resolveControl(codebook, value, parsed.nodes, { screen });
    if (!result.node || !result.node.bounds || !result.node.bounds.center) {
      throw new Error(`control ${value} has no usable bounds on the current screen`);
    }
    return { ...result, snapshotId: snapshotIdForXml(dump.xml), screen };
  }

  function toolRecordControl(instanceId, step, args) {
    if (args && args.record === false) return false;
    if (!skillRecorder.active(instanceId)) return false;
    skillRecorder.add(instanceId, step);
    return true;
  }

  async function toolControlAction(api, action, args) {
    await ensureToolApiReady(api, action);
    if (action === 'control_ui') {
      const payload = buildInspectorPayload(await api.uiDump(), await api.screenSize().catch(() => null));
      return { ok: true, summary: `${payload.controls.length} control(s), snapshot ${payload.snapshotId || '?'}`, result: payload };
    }
    if (action === 'control_launch') {
      const pkg = String(args.packageName || args.package || '').trim();
      if (!pkg) throw new Error('control_launch requires packageName');
      const result = await api.launchPackage(pkg);
      const recorded = toolRecordControl(api.id, { action: 'launch', package: pkg }, args);
      return { ok: true, summary: `launched ${pkg}${recorded ? ' (recorded)' : ''}`, result: { package: pkg, result, recorded } };
    }
    if (action === 'control_codebook') {
      const active = skillRecorder.active(api.id);
      if (active) {
        const codebook = await skillRecorder.updateCodebook(api.id, args.codebook || {});
        return { ok: true, summary: `updated recording codebook (${codebook.entries.length} codes)`, result: { codebook } };
      }
      const id = String(args.skillId || '').trim();
      if (!id) throw new Error('control_codebook needs skillId when no recording is active');
      const skill = await skillStore.get(id);
      if (!skill) throw new Error(`unknown Skill: ${id}`);
      skill.codebook = normalizeCodebook(args.codebook || {});
      const saved = await skillStore.save(skill);
      return { ok: true, summary: `saved codebook for ${saved.name} (${saved.codebook.entries.length} codes)`, result: { skill: saved } };
    }
    const codebook = toolCodebook(api.id, args);
    if (action === 'control_features') {
      const code = String(args.code || '').trim();
      if (!code) throw new Error('control_features requires code');
      const target = await toolResolveControl(api, codebook, code, { withImage: true });
      const image = target.node && target.node.imageFeatures
        ? {
            name: String(args.imageName || code).slice(0, 120),
            hash: target.node.imageFeatures.hash,
            avgColor: target.node.imageFeatures.avgColor,
            dominantColor: target.node.imageFeatures.dominantColor,
            maxDistance: args.maxDistance,
            colorTolerance: args.colorTolerance,
          }
        : null;
      const entry = {
        code,
        ...(args.name ? { name: String(args.name) } : {}),
        features: { ...suggestFeatures(target.node), ...(image ? { image } : {}) },
      };
      return {
        ok: true,
        summary: `features for ${target.code}${image ? ` + image ${image.name}` : ''}`,
        result: {
          code: target.code,
          snapshotId: target.snapshotId,
          features: target.node.features || suggestFeatures(target.node),
          imageFeatures: target.node.imageFeatures || null,
          suggestedEntry: entry,
        },
      };
    }
    if (action === 'control_assert' || action === 'control_wait') {
      const code = String(args.code || '').trim();
      const exists = args.exists !== false;
      let target = null;
      let error = null;
      try {
        target = await toolResolveControl(api, codebook, code);
      } catch (caught) {
        error = caught;
      }
      if (exists && !target) throw error || new Error(`control ${code} is not visible`);
      if (!exists && target) throw new Error(`control ${code} is visible; exists=false assertion failed`);
      const recordAction = action === 'control_wait' ? 'waitFor' : 'assert';
      const recorded = toolRecordControl(api.id, { action: recordAction, code, ...(exists ? {} : { exists: false }) }, args);
      return {
        ok: true,
        summary: `${code} ${exists ? 'visible' : 'absent'}${recorded ? ' (recorded)' : ''}`,
        result: { code, exists, snapshotId: target ? target.snapshotId : null, recorded },
      };
    }
    if (action === 'control_swipe') {
      const fromCode = String(args.fromCode || '').trim();
      const toCode = String(args.toCode || '').trim();
      const from = fromCode ? await toolResolveControl(api, codebook, fromCode) : null;
      const to = toCode ? await toolResolveControl(api, codebook, toCode) : null;
      const x1 = from ? from.node.bounds.center.x : Number(args.x1);
      const y1 = from ? from.node.bounds.center.y : Number(args.y1);
      const x2 = to ? to.node.bounds.center.x : Number(args.x2);
      const y2 = to ? to.node.bounds.center.y : Number(args.y2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('control_swipe needs fromCode/toCode or x1,y1,x2,y2');
      const durationMs = Math.max(1, Math.min(60000, Number(args.durationMs) || 300));
      await api.input({ type: 'swipe', x1, y1, x2, y2, durationMs });
      const step = fromCode || toCode
        ? { action: 'swipe', fromCode: fromCode || undefined, toCode: toCode || undefined, durationMs }
        : { action: 'swipe', x1, y1, x2, y2, durationMs };
      const recorded = toolRecordControl(api.id, step, args);
      return { ok: true, summary: `swiped ${fromCode || `${x1},${y1}`} -> ${toCode || `${x2},${y2}`}${recorded ? ' (recorded)' : ''}`, result: { x1, y1, x2, y2, recorded } };
    }
    const code = String(args.code || '').trim();
    const target = await toolResolveControl(api, codebook, code);
    const center = target.node.bounds.center;
    if (action === 'control_tap') {
      await api.input({ type: 'tap', x: center.x, y: center.y });
      const recorded = toolRecordControl(api.id, { action: 'tap', code }, args);
      return { ok: true, summary: `tapped ${target.code} at ${center.x},${center.y}${recorded ? ' (recorded)' : ''}`, result: { code: target.code, x: center.x, y: center.y, snapshotId: target.snapshotId, recorded } };
    }
    if (action === 'control_long_press') {
      const durationMs = Math.max(300, Math.min(60000, Number(args.durationMs) || 800));
      await api.input({ type: 'swipe', x1: center.x, y1: center.y, x2: center.x, y2: center.y, durationMs });
      const recorded = toolRecordControl(api.id, { action: 'longPress', code, durationMs }, args);
      return { ok: true, summary: `long-pressed ${target.code}${recorded ? ' (recorded)' : ''}`, result: { code: target.code, durationMs, recorded } };
    }
    if (action === 'control_input') {
      const text = args.text === undefined ? (args.value === undefined ? '' : String(args.value)) : String(args.text);
      const submit = args.submit === true;
      await api.input({ type: 'tap', x: center.x, y: center.y });
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (text) await api.input({ type: 'text', text: text.slice(0, 4096) });
      if (submit) await api.input({ type: 'key', key: 'ENTER' });
      const recorded = toolRecordControl(api.id, { action: 'input', code, value: text, ...(submit ? { submit: true } : {}) }, args);
      return { ok: true, summary: `typed ${text.length} char(s) into ${target.code}${submit ? ' + ENTER' : ''}${recorded ? ' (recorded)' : ''}`, result: { code: target.code, chars: text.length, submit, recorded } };
    }
    throw new Error(`unsupported control action: ${action}`);
  }

  // Mutating actions get a best-effort frame in the activity timeline so the
  // panel can show what the screen looked like after the Agent's input.
  const ACTIVITY_SHOT_ACTIONS = new Set([
    'tap',
    'swipe',
    'long_press',
    'key',
    'text',
    'install',
    'type_text',
    'tap_selector',
    'tap_css',
    'control_tap',
    'control_input',
    'control_long_press',
    'control_swipe',
  ]);

  function activityArgsPreview(args) {
    try {
      const text = JSON.stringify(args && typeof args === 'object' ? args : {});
      return text.length > 700 ? `${text.slice(0, 700)}…` : text;
    } catch {
      return null;
    }
  }

  async function captureActivityShot(args) {
    const requested = String((args && args.instance) || '').trim();
    try {
      let png = null;
      if (requested && requested !== 'default') {
        const instance = instanceManager ? instanceManager.get(requested) : null;
        png = instance ? await instance.screenshot() : null;
      } else {
        png = await vm.screenshot();
      }
      return png && png.length ? Buffer.from(png) : null;
    } catch {
      return null;
    }
  }

  async function recordToolActivity(args, outcome, startedAt) {
    try {
      const action = String((args && args.action) || '').toLowerCase() || '(missing)';
      const ok = !(outcome && outcome.ok === false);
      const failure = outcome && outcome.result && outcome.result.error;
      let shot = null;
      if (ACTIVITY_SHOT_ACTIONS.has(action)) shot = await captureActivityShot(args);
      await activityLog.record({
        action,
        source: 'tool',
        tool: 'apk_vm',
        instanceId: String((args && args.instance) || 'default'),
        summary: outcome && outcome.summary ? String(outcome.summary).slice(0, 500) : ok ? 'ok' : 'failed',
        ok,
        error: failure ? String((failure && failure.message) || failure).slice(0, 800) : null,
        durationMs: Math.max(0, Date.now() - startedAt),
        argsPreview: activityArgsPreview(args),
        shot: shot || undefined,
      });
    } catch {
      /* activity logging must never break the tool */
    }
  }

  const apkVmTool = {
    name: 'apk_vm',
    description:
      'Operate the local rooted Android APK virtual machine (Android emulator) that the APK VM panel manages. ' +
      'The VM is usually already running (warm start); adbd runs as root once ready. ' +
      'Actions: info, shell, logcat, getprop, setprop, packages, install, push, pull, reboot, root, ' +
      'force_stop, clear_data, uninstall, rotate, ui_dump, inspect_ui, proxy, install_ca, network, record, perf, screenshot, tap, swipe, long_press, key, text, ' +
      'apk_info, find_ui, assert_text, tap_text, clipboard_get, clipboard_set, devices, attach_device, detach_device, start, stop, list_instances, create_instance, destroy_instance, owner_status, claim_vm, release_vm, flow_start, flow_stop, flow_list, flow_replay, storage, clean_storage, ' +
      'skill_list, skill_get, skill_save, skill_delete, skill_start, skill_stop, skill_cancel, skill_run, skill_codebook, control_ui, control_features, control_codebook, control_tap, control_input, control_long_press, control_swipe, control_assert, control_wait, control_launch, ' +
      'webview, tap_css, tap_selector, type_text, wait_for, env_snapshot, env_restore, adb. ' +
      'WebView actions use Chrome DevTools Protocol (CDP): webview list|eval|click|wait_for|insert_text over the app WebView. ' +
      'tap_selector clicks a DOM selector through CDP so CSS/dpr/status-bar math is not needed; type_text injects UTF-8 (including Chinese) through the scrcpy control stream. ' +
      'App-operation Skills use a persisted Control Codebook (stable codes such as LOGIN_BTN or A01) instead of raw coordinates; record once with skill_start + control_* then replay with skill_run to reach a page quickly. ' +
      'VM ownership: pass ownerScope=conversation or project to use a dedicated VM for this session/project; shared is the default. owner_status / claim_vm / release_vm inspect or change the current lease. A VM owned by another conversation is never taken silently: the tool returns a vm-busy error unless ownerForce=true (explicit takeover). ' +
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
          description: 'info|shell|logcat|getprop|setprop|packages|install|push|pull|reboot|root|force_stop|clear_data|uninstall|rotate|ui_dump|inspect_ui|proxy|install_ca|network|record|perf|screenshot|tap|swipe|long_press|key|text|apk_info|find_ui|assert_text|tap_text|clipboard_get|clipboard_set|devices|attach_device|detach_device|start|stop|list_instances|create_instance|destroy_instance|owner_status|claim_vm|release_vm|flow_start|flow_stop|flow_list|flow_replay|storage|clean_storage|skill_list|skill_get|skill_save|skill_delete|skill_start|skill_stop|skill_cancel|skill_run|skill_codebook|control_ui|control_features|control_codebook|control_tap|control_input|control_long_press|control_swipe|control_assert|control_wait|control_launch|webview|tap_css|tap_selector|type_text|wait_for|env_snapshot|env_restore|adb',
        },
        instance: { type: 'string', description: 'Target VM instance id (default or an extra instance from list_instances). Omit for the calling Agent\'s assigned instance.' },
        ownerScope: { type: 'string', enum: ['shared', 'conversation', 'project'], description: 'VM ownership scope: shared (default), conversation (dedicated per DSH session), or project (dedicated per workspace).' },
        ownerLabel: { type: 'string', description: 'Optional human-readable owner label shown in the VM panel.' },
        ownerForce: { type: 'boolean', description: 'Explicitly take over a VM owned by another conversation/project (default false; conflicts return vm-busy).' },
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
        selector: { type: 'string', description: 'webview/tap_selector/type_text: CSS selector, or testid:VALUE for [data-testid="VALUE"]; open shadow roots are supported.' },
        script: { type: 'string', description: 'webview eval: single JavaScript expression evaluated in the page; returns result.value (values that do not survive JSON by value come back as a property snapshot). Use an IIFE to return a value from a sequence.' },
        targetId: { type: 'string', description: 'webview: optional DevTools target id from action=webview webviewAction=list.' },
        webviewAction: { type: 'string', description: 'webview: list|eval|click|wait_for|insert_text|info.' },
        webviewTarget: { type: 'string', description: 'webview: target id, URL substring, title substring, or 1-based index.' },
        dpr: { type: 'number', description: 'tap_css: optional devicePixelRatio override; defaults to info.coordinateMap.dpr.' },
        offsetX: { type: 'number', description: 'tap_css: optional device-pixel x offset of the page viewport; defaults to info.coordinateMap.offsetX.' },
        offsetY: { type: 'number', description: 'tap_css: optional device-pixel y offset of the page viewport; defaults to info.coordinateMap.offsetY.' },
        statusBar: { type: 'number', description: 'tap_css: optional status-bar height in device pixels; alias for offsetY.' },
        cssX: { type: 'number', description: 'tap_css: CSS x coordinate (viewport CSS pixels).' },
        cssY: { type: 'number', description: 'tap_css: CSS y coordinate (viewport CSS pixels).' },
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
        networkAction: { type: 'string', description: 'network: info|mode|dns|hosts|test|validate|pcap|proxy|forward-add|forward-remove|reverse-add|reverse-remove|reverse-list.' },
        networkMode: { type: 'string', description: 'network mode: isolated|shared.' },
        localPort: { type: 'integer', description: 'port forward: host loopback port.' },
        remotePort: { type: 'integer', description: 'port forward: guest service port.' },
        envSnapshot: { type: 'object', additionalProperties: true, description: 'env_restore: snapshot returned by action=env_snapshot.' },
        adbArgs: { type: 'array', items: { type: 'string' }, description: 'adb: raw adb argument list, e.g. ["devices"] or ["-s","emulator-5554","shell","pidof","app"].' },
        adbCommand: { type: 'string', description: 'adb: convenience raw command string split on whitespace; prefer adbArgs for paths with spaces.' },
        restoreEnv: { type: 'boolean', description: 'reboot: capture and restore network/proxy/forwards after boot (default true).' },
        overlay: { type: 'boolean', description: 'screenshot: draw UIAutomator node boxes on the PNG and return boxes/labels.' },
        http: { type: 'string', description: 'wait_for: URL polled until any 2xx response.' },
        pollMs: { type: 'integer', description: 'wait_for: polling interval in ms (default 250).' },
        shared: { type: 'boolean', description: 'port forward: expose to other VMs through the emulator host alias (requires shared mode).' },
        servers: { type: 'array', items: { type: 'string' }, description: 'network DNS: up to 4 IPv4/IPv6 DNS servers.' },
        entries: { type: 'array', items: { type: 'string' }, description: 'network hosts: lines such as "1.2.3.4 api.example.com".' },
        testHost: { type: 'string', description: 'network test: host to ping/TCP-test (default: emulator host alias).' },
        testPort: { type: 'integer', description: 'network test: TCP port.' },
        pcapPath: { type: 'string', description: 'network pcap: host path ending in .pcap; capture starts on the next emulator start.' },
        code: { type: 'string', description: 'Control Codebook code or semantic name (e.g. A01, LOGIN_BTN); used by control_* and Skill steps.' },
        imageName: { type: 'string', description: 'control_features: human name for the captured image feature (e.g. star-icon).' },
        maxDistance: { type: 'number', description: 'control_features: optional image dHash distance tolerance (default 10).' },
        colorTolerance: { type: 'number', description: 'control_features: optional RGB colour tolerance (default 36).' },
        skillId: { type: 'string', description: 'Skill id for skill_get/skill_save/skill_delete/skill_run/skill_codebook.' },
        skillName: { type: 'string', description: 'Human name for skill_start/skill_stop.' },
        skillSteps: { type: 'array', description: 'skill_save: array of semantic steps (each uses code/selector, never raw coordinates).', items: { type: 'object', additionalProperties: true } },
        codebook: { type: 'object', description: 'Control Codebook: { entries: [{ code, name, aliases, features: {...} }] } or an entries array.', additionalProperties: true },
        targetCode: { type: 'string', description: 'Skill target code; skill_run stops successfully once it is visible.' },
        untilCode: { type: 'string', description: 'skill_run: alias for targetCode.' },
        fromCode: { type: 'string', description: 'control_swipe: code of the start control.' },
        toCode: { type: 'string', description: 'control_swipe: code of the end control.' },
        speed: { type: 'number', description: 'Skill replay delay multiplier (1 = recorded speed, 2 = twice as fast).' },
        variables: { type: 'object', description: 'Skill replay variables interpolated into {{name}} placeholders.', additionalProperties: true },
        dryRun: { type: 'boolean', description: 'skill_run: resolve checks without touching the device.' },
        exists: { type: 'boolean', description: 'control_assert: expected visibility (default true; false asserts absent).' },
        record: { type: 'boolean', description: 'control_*: record the step while a Skill recording is active (default true).' },
        description: { type: 'string', description: 'skill_start/skill_save: optional human description.' },
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
      const startedAt = Date.now();
      let outcome;
      try {
        outcome = losslessJson(await this.executeInner(args, exec));
      } catch (error) {
        // Tool results must survive a lossless JSON round-trip, so surface a
        // thrown failure as the structured { ok:false, summary, result } result
        // the host tool boundary (and the renderer) already understands.
        const action = String((args && args.action) || '').toLowerCase() || '(missing)';
        const failure = losslessJson(error);
        const message = (failure && failure.message) || String(failure);
        outcome = losslessJson({
          ok: false,
          summary: `apk_vm ${action} failed: ${message}`,
          result: { action, error: failure },
        });
      }
      // Fire-and-forget: the timeline must never slow down the Agent's call.
      void recordToolActivity(args, outcome, startedAt);
      return outcome;
    },

    async executeInner(args, exec) {
      const action = String((args && args.action) || '').toLowerCase();

      // Resolve the VM handle lazily: only actions that actually reach the
      // device should trigger owner assignment/leasing.
      let toolApiPromise = null;
      const getToolApi = () => {
        if (!toolApiPromise) toolApiPromise = resolveToolApi(args, exec);
        return toolApiPromise;
      };

      if (action === 'list_instances') {
        const defaultStatus = await vm.status();
        const defaultOwnerInfo = instanceManager ? instanceManager.ownerInfo('default') : null;
        const instances = [
          {
            id: 'default',
            kind: 'default',
            avdName: defaultStatus.avd || vm.avdName || null,
            port: vm.port || null,
            state: defaultStatus.state,
            serial: defaultStatus.serial || null,
            root: defaultStatus.root === true,
            owner: instanceManager ? instanceManager.defaultOwner : null,
            ownerInfo: defaultOwnerInfo,
            ownerLabel: defaultOwnerInfo ? defaultOwnerInfo.label : null,
            scope: defaultOwnerInfo ? defaultOwnerInfo.scope : null,
          },
          ...(instanceManager ? instanceManager.list() : []),
        ];
        return {
          ok: true,
          summary: instances.map((entry) => `${entry.id}:${entry.state}${entry.serial ? '@' + entry.serial : ''}${entry.ownerInfo ? ' owned:' + entry.ownerInfo.label : ''}`).join(', '),
          result: { instances, maxInstances: instanceManager ? instanceManager.maxInstances : 1 },
        };
      }
      if (action === 'create_instance') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const instance = await instanceManager.create({ name: args.instanceName || args.name });
        registerInstanceRoutes?.(instance.id);
        if (args.ownerScope) {
          const owner = toolOwnerContext(args, exec);
          instanceManager.claimOwner(instance.id, owner, { force: ownerTakeoverRequested(args) });
        }
        if (args.start === true) void instance.start();
        const ownerInfo = instanceManager.ownerInfo(instance.id);
        return {
          ok: true,
          summary: `created instance ${instance.id} (avd=${instance.avdName}, port=${instance.port})${ownerInfo ? ' for ' + ownerInfo.label : ''}`,
          result: { id: instance.id, avdName: instance.avdName, port: instance.port, owner: ownerInfo },
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

      if (action === 'env_snapshot') {
        const api = await getToolApi();
        const snapshot = await api.captureEnv();
        return {
          ok: true,
          summary: `env: mode=${snapshot.networkMode} forwards=${snapshot.forwards.length} reverses=${snapshot.reverses.length} dns=${snapshot.dnsServers.length} hosts=${snapshot.hostsEntries.length}`,
          result: snapshot,
        };
      }
      if (action === 'env_restore') {
        if (!args.envSnapshot || typeof args.envSnapshot !== 'object') throw new Error('env_restore requires envSnapshot');
        const api = await getToolApi();
        const result = await api.restoreEnv(args.envSnapshot);
        return { ok: result.ok === true, summary: `restored ${result.applied.length} env item(s)${result.errors.length ? `; ${result.errors.length} failed` : ''}`, result };
      }
      if (action === 'adb') {
        const adbArgs = Array.isArray(args.adbArgs)
          ? args.adbArgs.map(String)
          : String(args.adbCommand || '').trim().split(/\s+/).filter(Boolean);
        if (!adbArgs.length) throw new Error('adb requires adbArgs or adbCommand');
        const api = await getToolApi();
        const raw = await api.adb(adbArgs, { timeoutMs: Math.min(120000, Number(args.timeoutMs) || 30000), maxBytes: 2 * 1024 * 1024 });
        const asText = (value) => {
          if (value == null) return '';
          if (Buffer.isBuffer(value)) return value.toString('utf8');
          if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
          return String(value);
        };
        const stdout = asText(raw.stdout).slice(0, 200000);
        const stderr = asText(raw.stderr).slice(0, 20000);
        return {
          ok: raw.code === 0 && !raw.timedOut,
          summary: `adb ${adbArgs[0] || ''} exit ${raw.code}${raw.timedOut ? ' (timeout)' : ''}`,
          result: { code: raw.code, timedOut: raw.timedOut === true, stdout, stderr },
        };
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
      if (action === 'owner_status') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        return {
          ok: true,
          summary: instanceManager.ownerList().length
            ? instanceManager.ownerList().map((entry) => `${entry.id}:${entry.label}`).join(', ')
            : 'no VM leases',
          result: { default: instanceManager.ownerInfo('default'), owners: instanceManager.ownerList() },
        };
      }
      if (action === 'claim_vm') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const id = String(args.instance || 'default');
        if (id !== 'default' && !instanceManager.get(id)) throw new Error(`unknown instance: ${id}`);
        const owner = toolOwnerContext(args, exec);
        const result = instanceManager.claimOwner(id, owner, { force: ownerTakeoverRequested(args) });
        return {
          ok: true,
          summary: `claimed ${id} for ${result.lease.label}${result.previous ? ` (took over from ${result.previous.label})` : ''}`,
          result: { instanceId: id, ...result },
        };
      }
      if (action === 'release_vm') {
        if (!instanceManager) throw new Error('multi-instance support is disabled');
        const id = String(args.instance || 'default');
        if (id !== 'default' && !instanceManager.get(id)) throw new Error(`unknown instance: ${id}`);
        const owner = toolOwnerContext(args, exec);
        const released = instanceManager.releaseOwner(id, owner, { force: ownerTakeoverRequested(args) });
        return {
          ok: true,
          summary: released ? `released ${id} (was ${released.label})` : `${id} is not leased`,
          result: { instanceId: id, released },
        };
      }

      const api = await getToolApi();
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
      if (action.startsWith('skill_')) {
        if (action === 'skill_list') {
          const skills = await skillStore.list();
          const active = skillRecorder.active(api.id);
          return {
            ok: true,
            summary: `${skills.length} Skill(s) on ${api.id}${active ? `; recording ${active.skill.name}` : ''}`,
            result: { instance: api.id, skills: skills.map(skillSummary), recording: active ? skillSummary(active.skill) : null },
          };
        }
        if (action === 'skill_get') {
          const id = String(args.skillId || '').trim();
          if (!id) throw new Error('skill_get requires skillId');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          return { ok: true, summary: `${skill.name}: ${skill.steps.length} step(s), ${skill.codebook.entries.length} code(s)`, result: skill };
        }
        if (action === 'skill_delete') {
          const id = String(args.skillId || '').trim();
          if (!id) throw new Error('skill_delete requires skillId');
          const removed = await skillStore.remove(id);
          return { ok: true, summary: `deleted Skill ${id}`, result: { removed } };
        }
        if (action === 'skill_start') {
          const started = await skillRecorder.start(api.id, {
            name: args.skillName || args.name,
            id: args.skillId,
            package: args.packageName,
            description: args.description,
            target: args.targetCode,
            codebook: args.codebook,
          });
          return { ok: true, summary: `recording Skill ${started.name}; use control_* with codes, then skill_stop`, result: started };
        }
        if (action === 'skill_stop') {
          const saved = await skillRecorder.stop(api.id, {
            name: args.skillName || args.name,
            package: args.packageName,
            description: args.description,
          });
          return { ok: true, summary: `saved Skill ${saved.name} (${saved.id}, ${saved.steps.length} steps)`, result: saved };
        }
        if (action === 'skill_cancel') {
          return { ok: true, summary: `cancelled recording on ${api.id}`, result: { cancelled: skillRecorder.cancel(api.id) } };
        }
        if (action === 'skill_save') {
          const id = String(args.skillId || '').trim();
          const existing = id ? await skillStore.get(id) : null;
          const source = {
            ...(existing || {}),
            ...(id ? { id } : {}),
            ...(args.skillName ? { name: args.skillName } : {}),
            ...(args.description ? { description: args.description } : {}),
            ...(args.packageName ? { package: args.packageName } : {}),
            ...(args.targetCode ? { target: args.targetCode } : {}),
            ...(args.codebook ? { codebook: args.codebook } : {}),
            ...(Array.isArray(args.skillSteps) ? { steps: args.skillSteps } : {}),
          };
          const saved = await skillStore.save(normalizeSkill(source));
          return { ok: true, summary: `saved Skill ${saved.name} (${saved.id}, ${saved.steps.length} steps)`, result: saved };
        }
        if (action === 'skill_codebook') {
          const active = skillRecorder.active(api.id);
          if (active) {
            const codebook = await skillRecorder.updateCodebook(api.id, args.codebook || {});
            return { ok: true, summary: `updated recording codebook (${codebook.entries.length} codes)`, result: { codebook } };
          }
          const id = String(args.skillId || '').trim();
          if (!id) throw new Error('skill_codebook requires skillId when no recording is active');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          skill.codebook = normalizeCodebook(args.codebook || {});
          const saved = await skillStore.save(skill);
          return { ok: true, summary: `saved codebook for ${saved.name} (${saved.codebook.entries.length} codes)`, result: saved };
        }
        if (action === 'skill_run') {
          const id = String(args.skillId || '').trim();
          if (!id) throw new Error('skill_run requires skillId');
          const skill = await skillStore.get(id);
          if (!skill) throw new Error(`unknown Skill: ${id}`);
          await ensureToolApiReady(api, action);
          const result = await runSkill(skill, api, {
            speed: args.speed,
            untilCode: args.untilCode || args.targetCode,
            variables: args.variables,
            dryRun: args.dryRun === true,
            timeoutMs: args.timeoutMs,
            package: args.packageName,
          });
          return {
            ok: true,
            summary: `ran ${skill.name}: ${result.stepsRun}/${result.stepsTotal} step(s) in ${result.durationMs}ms${result.reached ? `, reached ${result.untilCode}` : result.untilCode ? `, target ${result.untilCode} not reached` : ''}`,
            result,
          };
        }
        throw new Error(`unsupported skill action: ${action}`);
      }
      if (action.startsWith('control_')) {
        return toolControlAction(api, action, args);
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
        // `proxy` already exists as a top-level action; accept it here too because
        // callers naturally try `action=network, networkAction=proxy`.
        if (networkAction === 'proxy') {
          if (args.enabled === false || args.clear === true) {
            const result = await api.setProxy({ enabled: false });
            return { ok: true, summary: 'proxy cleared', result };
          }
          const result = await api.setProxy({ host: args.host, port: args.port, bypass: args.bypass, enabled: true });
          return { ok: true, summary: result.proxy ? `proxy=${result.proxy}` : 'proxy set', result };
        }
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
        if (networkAction === 'reverse-add') {
          if (!args.localPort || !args.remotePort) throw new Error('reverse-add requires localPort (guest) and remotePort (host)');
          const result = await api.addReverse(args.localPort, args.remotePort);
          return { ok: true, summary: `reverse guest 127.0.0.1:${result.localPort} -> host 127.0.0.1:${result.hostPort}`, result };
        }
        if (networkAction === 'reverse-remove') {
          if (!args.localPort) throw new Error('reverse-remove requires localPort');
          const result = await api.removeReverse(args.localPort);
          return { ok: true, summary: `removed reverse tcp:${result.localPort}`, result };
        }
        if (networkAction === 'reverse-list') {
          const result = await api.listReverse();
          return { ok: true, summary: `${result.length} reverse forward(s)`, result: { reverses: result, count: result.length } };
        }
        if (networkAction === 'validate') {
          const result = await api.networkValidation();
          return { ok: result.validated === true, summary: result.validated ? 'network is VALIDATED' : 'network is not VALIDATED', result };
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
          return {
            ok: true,
            setup: { autoSetup: activeAutoSetup().status() },
            summary: `${api.id} ${status.serial}: Android ${result.identity?.release || '?'} root=${result.root}`,
            result,
          };
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
          if (/[^\x00-\x7f]/.test(args.text) && typeof api.typeText === 'function') {
            const result = await api.typeText(args.text);
            return { ok: true, summary: `typed ${args.text.length} Unicode chars on ${api.id}`, result };
          }
          const result = await api.input({ type: 'text', text: args.text });
          return { ok: result.ok, summary: `typed ${args.text.length} chars on ${api.id}`, result };
        }
        case 'webview': {
          const action = String(args.webviewAction || 'list').toLowerCase();
          const target = args.webviewTarget || args.targetId;
          if (action === 'list' || action === 'info') {
            if (typeof api.webviewTargets !== 'function') throw new Error('webview: CDP bridge is unavailable');
            const targets = await api.webviewTargets();
            return { ok: true, summary: `${targets.length} WebView target(s) on ${api.id}`, result: { targets, count: targets.length } };
          }
          if (action === 'eval') {
            if (!args.script) throw new Error('webview eval requires script');
            const value = await api.webviewEval(args.script, { target });
            const preview = previewJsValue(value, 240);
            return { ok: true, summary: `evaluated JS in WebView on ${api.id} => ${preview}`, result: { value } };
          }
          if (action === 'click') {
            if (!args.selector) throw new Error('webview click requires selector');
            await api.webviewClick(args.selector, { target });
            return { ok: true, summary: `clicked WebView selector ${args.selector}`, result: { selector: args.selector } };
          }
          if (action === 'wait_for' || action === 'waitfor') {
            if (!args.selector) throw new Error('webview wait_for requires selector');
            const timeoutMs = Math.max(1, Math.min(120000, Number(args.timeoutMs) || 10000));
            await api.webviewWaitFor(args.selector, { target, timeoutMs });
            return { ok: true, summary: `WebView selector ${args.selector} appeared within ${timeoutMs}ms`, result: { selector: args.selector } };
          }
          if (action === 'insert_text' || action === 'inserttext' || action === 'type') {
            if (typeof args.text !== 'string' || !args.text) throw new Error('webview insert_text requires text');
            await api.webviewInsertText(args.text, { target, selector: args.selector });
            return { ok: true, summary: `inserted ${args.text.length} chars into WebView on ${api.id}`, result: { chars: args.text.length } };
          }
          throw new Error(`webview: unknown webviewAction ${action}; use list|eval|click|wait_for|insert_text`);
        }
        case 'type_text': {
          if (typeof args.text !== 'string' || !args.text) throw new Error('action=type_text requires a non-empty text string');
          if (args.selector) {
            if (typeof api.webviewInsertText !== 'function') throw new Error('type_text with selector requires a CDP/WebView bridge');
            await api.webviewInsertText(args.text, { target: args.webviewTarget || args.targetId, selector: args.selector });
            return { ok: true, summary: `inserted ${args.text.length} Unicode chars into ${args.selector} on ${api.id}` };
          }
          if (typeof api.typeText === 'function') {
            const result = await api.typeText(args.text);
            return {
              ok: true,
              summary: `typed ${args.text.length} Unicode chars on ${api.id}`,
              result,
            };
          }
          throw new Error('type_text: H.264 control stream is unavailable; open the VM panel once to start streaming, or pass a WebView selector');
        }
        case 'tap_css': {
          const x = Number(args.cssX !== undefined ? args.cssX : args.x);
          const y = Number(args.cssY !== undefined ? args.cssY : args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('action=tap_css requires numeric cssX/cssY (viewport CSS pixels)');
          const info = await api.deviceInfo();
          const map = info.coordinateMap || {};
          const dpr = Number(args.dpr !== undefined ? args.dpr : map.dpr);
          const offsetX = Number(args.offsetX !== undefined ? args.offsetX : map.offsetX || 0);
          const offsetY = Number(
            args.offsetY !== undefined
              ? args.offsetY
              : args.statusBar !== undefined
                ? args.statusBar
                : map.offsetY || 0,
          );
          if (!Number.isFinite(dpr) || dpr <= 0) throw new Error('tap_css: devicePixelRatio is unknown; pass dpr explicitly');
          const dx = Math.round(x * dpr + offsetX);
          const dy = Math.round(y * dpr + offsetY);
          const result = await api.input({ type: 'tap', x: dx, y: dy });
          return {
            ok: result.ok,
            summary: `tap CSS ${x},${y} -> device ${dx},${dy} (dpr=${dpr}, offset=${offsetX},${offsetY}) on ${api.id}`,
            result: { css: { x, y }, device: { x: dx, y: dy }, dpr, offset: { x: offsetX, y: offsetY }, input: result },
          };
        }
        case 'tap_selector': {
          if (!args.selector) throw new Error('action=tap_selector requires selector');
          if (typeof api.webviewClick !== 'function') throw new Error('tap_selector: no CDP/WebView bridge is available');
          const result = await api.webviewClick(args.selector, { target: args.webviewTarget || args.targetId });
          return { ok: true, summary: `clicked selector ${args.selector}`, result };
        }
        case 'wait_for': {
          const timeoutMs = Math.max(0, Math.min(120000, Number(args.timeoutMs) || 10000));
          const pollMs = Math.max(25, Math.min(2000, Number(args.pollMs) || 250));
          const started = Date.now();
          const deadline = started + timeoutMs;
          const mode = args.selector ? 'selector' : args.http ? 'http' : args.text ? 'text' : 'seconds';
          let last = null;
          while (Date.now() <= deadline) {
            if (mode === 'seconds') {
              const waitMs = Math.min(timeoutMs, Math.max(0, Number(args.seconds || 0) * 1000));
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              return { ok: true, summary: `waited ${waitMs}ms on ${api.id}`, result: { waitedMs: waitMs } };
            }
            try {
              if (mode === 'selector') {
                if (typeof api.webviewQuery === 'function') {
                  last = await api.webviewQuery(args.selector, { target: args.webviewTarget || args.targetId });
                  if (last && last.found) return { ok: true, summary: `selector appeared after ${Date.now() - started}ms`, result: last };
                }
              } else if (mode === 'http') {
                const response = await fetch(String(args.http), { redirect: 'manual' });
                last = { status: response.status, ok: response.ok, url: response.url };
                if (response.ok) return { ok: true, summary: `HTTP ${response.status} after ${Date.now() - started}ms`, result: last };
              } else if (mode === 'text') {
                const dump = await api.uiDump();
                const needle = String(args.text);
                last = { nodes: dump.nodes, matched: String(dump.xml || '').includes(needle) };
                if (last.matched) return { ok: true, summary: `UI text appeared after ${Date.now() - started}ms`, result: last };
              }
            } catch (error) {
              last = { error: error.message };
            }
            if (Date.now() + pollMs > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
          throw new Error(`wait_for timed out after ${timeoutMs}ms (${mode}): ${JSON.stringify(last)}`);
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
          const result = await api.reboot(args.mode || '', { restoreEnv: args.restoreEnv !== false });
          return {
            ok: true,
            summary: `rebooting ${api.id} (${result.mode})${result.restoreScheduled ? '; env restore scheduled' : ''}`,
            result,
          };
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
          if (args.overlay === true) {
            const result = await api.screenshotAnnotated();
            return { ok: true, summary: `annotated screenshot (${result.nodes} nodes) saved to ${result.path}`, result };
          }
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

