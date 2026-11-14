#!/usr/bin/env node
/**
 * Hermetic regression checks for the remote VM feature (SSH proxy).
 *
 * Covers:
 *   - profile normalization/validation + quoteRemoteArg injection safety;
 *   - the fixed remote emulator start/stop command builders;
 *   - the persisted profile store (save/load/clear, corrupt-file tolerance);
 *   - bounded `runSshCommand` with an injected exec (never spawns ssh);
 *   - the real /apk-vm/remote route mounted through apply() with a fake Host
 *     ctx: state payload, validation errors and save/forget profile round-trip.
 *
 * No SSH connection, emulator or HTTP server is started.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);

const {
  SshAdbTunnel,
  buildSshTunnelArgs,
  normalizeRemoteProfile,
  defaultRemoteProfilePath,
  defaultRemoteProfilesPath,
  RemoteProfileStore,
  RemoteProfileBook,
  RemoteSessionManager,
  quoteRemoteArg,
  normalizeExtraEmulatorArgs,
  buildRemoteEmulatorStartCommand,
  buildRemoteEmulatorStopCommand,
  buildSshCommandArgs,
  runSshCommand,
  parseRemoteListeningPorts,
  REMOTE_LISTEN_COMMAND,
} = await load('lib/remote.js');
const { apply } = await load('index.js');
const { InstanceManager } = await load('lib/instances.js');

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
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

// ---------------------------------------------------------------------------
// Fake Host ctx / webServer (same harness as spike/tool-core-test.mjs)
// ---------------------------------------------------------------------------

const routes = new Map();
const disposers = [];
let tool = null;
const pushDisposer = (dispose) => {
  if (typeof dispose === 'function') disposers.push(dispose);
};
const webServer = {
  getOrigin: () => 'http://127.0.0.1:0',
  register: (entry) => {
    routes.set(entry.path, entry.handler);
    return () => routes.delete(entry.path);
  },
  registerUpgrade: () => () => {},
};
const hostCtx = {
  get: () => undefined,
  inject: (names, install) => {
    const effect = (fn) => {
      const dispose = fn();
      pushDisposer(dispose);
      return dispose;
    };
    if (names.includes('webServer')) return install({ effect, webServer });
    if (names.includes('tools')) {
      return install({
        effect,
        tools: {
          register: (registered) => {
            tool = registered;
            return () => {
              tool = null;
            };
          },
        },
      });
    }
    if (names.includes('sessions')) return install({ effect, on: () => () => {} });
    install({ effect });
  },
  effect: (fn) => {
    const dispose = fn();
    pushDisposer(dispose);
    return dispose;
  },
};

function makeReq({ method = 'GET', url = '/', body = null } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:0', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return req;
    },
    destroy() {},
  };
  if (body !== null) {
    setImmediate(() => {
      const chunk = Buffer.from(JSON.stringify(body));
      for (const cb of listeners.get('data') || []) cb(chunk);
      for (const cb of listeners.get('end') || []) cb();
    });
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    setHeader(key, value) {
      res.headers[key] = value;
    },
    getHeader() {
      return undefined;
    },
    write() {},
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk);
      res.ended = true;
    },
  };
  return res;
}

async function callRoute(route, options) {
  const handler = routes.get(route);
  assert.ok(typeof handler === 'function', `route ${route} is registered`);
  const res = makeRes();
  await handler(makeReq(options), res);
  assert.ok(res.ended, `route ${route} sent a response`);
  return { status: res.statusCode, json: JSON.parse(res.body || 'null') };
}

// ---------------------------------------------------------------------------
// Unit checks: quoting + validation + command builders
// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-vm-remote-test-'));
const keyFile = path.join(root, 'id_test');
fs.writeFileSync(keyFile, 'test-key\n');

check('quoteRemoteArg single-quote escapes', () => {
  assert.equal(quoteRemoteArg("a'b"), `'a'\\''b'`);
  assert.equal(quoteRemoteArg('/opt/android/sdk'), `'/opt/android/sdk'`);
});

check('quoteRemoteArg rejects control characters', () => {
  assert.throws(() => quoteRemoteArg('bad\ncommand'), /control characters/);
  assert.throws(() => quoteRemoteArg(''), /empty/);
});

check('buildSshTunnelArgs uses loopback forwarding flags', () => {
  const args = buildSshTunnelArgs({ host: 'build.example', user: 'builder', remotePort: 5558 });
  const joined = args.join(' ');
  assert.match(joined, /-N/);
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /ExitOnForwardFailure=yes/);
  assert.match(joined, /-L 127\.0\.0\.1:15037:127\.0\.0\.1:5558/);
  assert.match(joined, /builder@build\.example$/);
});

check('buildSshTunnelArgs includes the key when given', () => {
  const args = buildSshTunnelArgs({ host: 'build.example', user: 'builder', keyPath: keyFile, sshPort: 2222 });
  const joined = args.join(' ');
  assert.ok(joined.includes(`-i ${keyFile}`), joined);
  assert.match(joined, /-p 2222/);
});

check('SshAdbTunnel status is null-serial before start and validates input', () => {
  const tunnel = new SshAdbTunnel({ host: 'build.example', user: 'builder' });
  assert.equal(tunnel.status().serial, null);
  assert.equal(tunnel.status().state, 'stopped');
  assert.throws(() => new SshAdbTunnel({ host: 'bad host!', user: 'builder' }), /invalid SSH host/);
  assert.throws(() => new SshAdbTunnel({ host: 'build.example', user: 'root', keyPath: path.join(root, 'missing') }), /SSH key not found/);
});

check('SshAdbTunnel rejects shell metacharacters in host/user', () => {
  assert.throws(() => new SshAdbTunnel({ host: 'host;touch /tmp/pwn', user: 'root' }), /invalid SSH host/);
  assert.throws(() => new SshAdbTunnel({ host: 'host', user: 'root;whoami' }), /invalid SSH user/);
});

check('SshAdbTunnel exposes a stable serial for an explicit local port', () => {
  const tunnel = new SshAdbTunnel({ host: 'vm.example.test', user: 'opencode', localPort: 15037 });
  const status = tunnel.status();
  assert.equal(status.serial, '127.0.0.1:15037');
  assert.equal(status.state, 'stopped');
});

check('normalizeRemoteProfile applies safe defaults', () => {
  const profile = normalizeRemoteProfile({ host: 'build.example' });
  assert.equal(profile.host, 'build.example');
  assert.equal(profile.user, 'root');
  assert.equal(profile.sshPort, 22);
  assert.equal(profile.remotePort, 5558);
  assert.equal(profile.localPort, 0);
  assert.equal(profile.keyPath, '');
  assert.equal(profile.sshPath, 'ssh');
  assert.equal(profile.avdName, '');
  assert.equal(profile.launch, false);
  assert.ok(profile.updatedAt > 0);
});

check('normalizeRemoteProfile keeps a full profile', () => {
  const profile = normalizeRemoteProfile({
    host: 'build.example',
    user: 'builder',
    sshPort: 2222,
    remotePort: 5556,
    localPort: 15999,
    keyPath: keyFile,
    avdName: 'Pixel_7',
    emulatorPath: '/opt/android/emulator',
    sdkRoot: '/opt/android/sdk',
    launch: true,
  });
  assert.equal(profile.user, 'builder');
  assert.equal(profile.sshPort, 2222);
  assert.equal(profile.remotePort, 5556);
  assert.equal(profile.localPort, 15999);
  assert.equal(profile.keyPath, keyFile);
  assert.equal(profile.avdName, 'Pixel_7');
  assert.equal(profile.emulatorPath, '/opt/android/emulator');
  assert.equal(profile.sdkRoot, '/opt/android/sdk');
  assert.equal(profile.launch, true);
});

check('normalizeRemoteProfile rejects injection-shaped values', () => {
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', avdName: 'bad name!' }), /invalid AVD name/);
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', emulatorPath: '/opt/x; rm -rf /' }), /invalid remote emulator path/);
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', sdkRoot: '/opt/$(id)' }), /invalid remote SDK root/);
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', sshPath: 'ssh; rm -rf /' }), /invalid ssh executable/);
  assert.throws(() => normalizeRemoteProfile({ host: 'bad host!' }), /invalid SSH host/);
});

check('buildRemoteEmulatorStartCommand builds the fixed headless command', () => {
  const start = buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7' });
  assert.equal(start.consolePort, 5554);
  assert.equal(start.adbPort, 5555);
  assert.equal(start.logPath, '/tmp/apk-vm-emulator-5554.log');
  assert.match(start.command, /^nohup 'emulator' -avd 'Pixel_7' /);
  assert.match(start.command, /-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -port 5554/);
  assert.match(start.command, /> '\/tmp\/apk-vm-emulator-5554\.log' 2>&1 & echo "started:\$!"$/);
});

check('buildRemoteEmulatorStartCommand uses explicit SDK/emulator paths', () => {
  const start = buildRemoteEmulatorStartCommand({
    avdName: 'Pixel_7',
    consolePort: 5556,
    emulatorPath: '/opt/android/sdk/emulator/emulator',
    sdkRoot: '/opt/android/sdk',
  });
  assert.match(start.command, /^ANDROID_SDK_ROOT='\/opt\/android\/sdk' ANDROID_HOME='\/opt\/android\/sdk' nohup '\/opt\/android\/sdk\/emulator\/emulator' -avd 'Pixel_7' /);
  assert.equal(start.adbPort, 5557);
});

check('buildRemoteEmulatorStartCommand rejects bad input', () => {
  assert.throws(() => buildRemoteEmulatorStartCommand({}), /launch requires a remote AVD name/);
  assert.throws(() => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', consolePort: 5555 }), /console port must be an even integer/);
  assert.throws(() => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', consolePort: 9999 }), /console port must be an even integer/);
});

check('buildRemoteEmulatorStopCommand targets the launched emulator', () => {
  const stop = buildRemoteEmulatorStopCommand({ consolePort: 5554 });
  assert.equal(stop.serial, 'emulator-5554');
  assert.equal(stop.command, "'adb' -s 'emulator-5554' emu kill 2>&1 || true");
  assert.equal(stop.adbPath, 'adb');
});

check('buildRemoteEmulatorStopCommand uses a profile adb path for non-interactive SSH', () => {
  const stop = buildRemoteEmulatorStopCommand({
    consolePort: 5558,
    adbPath: '/opt/android-sdk/platform-tools/adb',
  });
  assert.equal(stop.command, "'/opt/android-sdk/platform-tools/adb' -s 'emulator-5558' emu kill 2>&1 || true");
});

check('buildSshCommandArgs is bounded and non-interactive', () => {
  const args = buildSshCommandArgs({ host: 'build.example', user: 'builder', keyPath: keyFile }, 'true');
  const joined = args.join(' ');
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /ConnectTimeout=20/);
  assert.match(joined, /-i /);
  assert.match(joined, /builder@build\.example true$/);
});

check('runSshCommand reports success and passes bounded options', async () => {
  let seen = null;
  const result = await runSshCommand(
    { host: 'build.example', user: 'builder' },
    'echo hi',
    {
      timeoutMs: 1234,
      exec: async (file, args, options) => {
        seen = { file, args, options };
        return { code: 0, stdout: 'hi\n', stderr: '', error: null };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(seen.file, 'ssh');
  assert.equal(seen.options.timeoutMs, 1234);
  assert.equal(seen.options.maxBytes, 64 * 1024);
  assert.ok(seen.args.includes('echo hi'));
});

check('runSshCommand reports failures without throwing', async () => {
  const result = await runSshCommand(
    { host: 'build.example', user: 'builder' },
    'false',
    { exec: async () => ({ code: 255, stdout: '', stderr: 'denied', error: null }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 255);
  assert.equal(result.stderr, 'denied');
});

// ---------------------------------------------------------------------------
// Profile store checks
// ---------------------------------------------------------------------------

check('RemoteProfileStore save/load/clear round-trip', async () => {
  const file = path.join(root, 'profile-store', 'remote-profile.json');
  const store = new RemoteProfileStore({ file });
  const missing = await store.load();
  assert.equal(missing.ok, true);
  assert.equal(missing.profile, null);

  const profile = normalizeRemoteProfile({ host: 'build.example', user: 'builder', keyPath: keyFile });
  const saved = await store.save(profile);
  assert.equal(saved.ok, true);
  assert.equal(saved.file, file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.profile.host, 'build.example');

  const loaded = await store.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.profile.host, 'build.example');
  assert.equal(loaded.profile.user, 'builder');

  fs.writeFileSync(file, '{not json');
  const corrupt = await store.load();
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.error, /remote profile is invalid/);

  const cleared = await store.clear();
  assert.equal(cleared.ok, true);
  assert.equal(fs.existsSync(file), false);
});

check('defaultRemoteProfilePath follows the data-dir convention', () => {
  assert.equal(defaultRemoteProfilePath('/tmp/data'), path.join('/tmp/data', '.apk-vm', 'remote-profile.json'));
  assert.ok(defaultRemoteProfilePath('').endsWith(path.join('.apk-vm', 'remote-profile.json')));
});

// ---------------------------------------------------------------------------
// HTTP route checks (fake Host ctx; never spawns ssh/emulator)
// ---------------------------------------------------------------------------

apply(hostCtx, {
  autoSetup: false,
  autoStart: false,
  multiInstance: false,
  prewarm: false,
  roots: [root],
  activityDir: path.join(root, 'activity'),
});

check('GET /apk-vm/remote exposes the remote state shape', async () => {
  const state = await callRoute('/apk-vm/remote', { method: 'GET', url: '/apk-vm/remote' });
  assert.equal(state.status, 200);
  for (const key of ['ok', 'tunnel', 'launch', 'profile', 'profileError', 'vm', 'devices']) {
    assert.ok(key in state.json, `remote state has ${key}`);
  }
  assert.equal(state.json.ok, true);
  assert.equal(state.json.tunnel, null);
  assert.equal(state.json.profile, null);
  assert.ok(Array.isArray(state.json.devices));
});

check('POST /apk-vm/remote connect rejects an empty host', async () => {
  const result = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'connect', host: '', user: 'builder' },
  });
  assert.equal(result.status, 400);
  assert.match(String(result.json.error), /invalid SSH host/);
});

check('POST /apk-vm/remote connect launch requires an AVD name', async () => {
  const result = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'connect', host: 'build.example', user: 'builder', launch: true },
  });
  assert.equal(result.status, 400);
  assert.match(String(result.json.error), /launch requires a remote AVD name/);
});

check('POST /apk-vm/remote connect validates the SSH key path', async () => {
  const result = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'connect', host: 'build.example', user: 'builder', keyPath: path.join(root, 'missing-key') },
  });
  assert.equal(result.status, 400);
  assert.match(String(result.json.error), /SSH key not found/);
});

check('POST /apk-vm/remote save-profile persists and GET reads it back', async () => {
  const saved = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: {
      action: 'save-profile',
      profile: { host: 'build.example', user: 'builder', remotePort: 5556, keyPath: keyFile },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved, true);
  assert.equal(saved.json.profile.host, 'build.example');
  assert.equal(saved.json.profile.remotePort, 5556);

  const state = await callRoute('/apk-vm/remote', { method: 'GET', url: '/apk-vm/remote' });
  assert.equal(state.json.profile.host, 'build.example');
  assert.equal(state.json.profile.user, 'builder');
});

check('POST /apk-vm/remote forget-profile clears the saved host', async () => {
  const cleared = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'forget-profile' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.profile, null);
  const state = await callRoute('/apk-vm/remote', { method: 'GET', url: '/apk-vm/remote' });
  assert.equal(state.json.profile, null);
});

check('POST /apk-vm/remote disconnect is safe without a tunnel', async () => {
  const result = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'disconnect' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.detached, true);
  assert.equal(result.json.tunnel, null);
});

check('POST /apk-vm/remote rejects unknown actions', async () => {
  const result = await callRoute('/apk-vm/remote', {
    method: 'POST',
    url: '/apk-vm/remote',
    body: { action: 'explode' },
  });
  assert.equal(result.status, 400);
  assert.match(String(result.json.error), /unsupported remote action/);
});

// ---------------------------------------------------------------------------
// Media launch args (camera/mic): contract update from the Lead
// ---------------------------------------------------------------------------

check('buildRemoteEmulatorStartCommand appends extraEmulatorArgs before -port', () => {
  const start = buildRemoteEmulatorStartCommand({
    avdName: 'Pixel_7',
    consolePort: 5556,
    extraEmulatorArgs: ['-camera-back', 'virtualscene', '-camera-front', 'emulated'],
  });
  assert.match(
    start.command,
    /-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect '-camera-back' 'virtualscene' '-camera-front' 'emulated' -port 5556/,
  );
  assert.deepEqual(start.extraArgs, ['-camera-back', 'virtualscene', '-camera-front', 'emulated']);
  // Extra args must never be able to override the fixed launch flags.
  assert.throws(
    () => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', extraEmulatorArgs: ['-port', '9999'] }),
    /must not override -port/,
  );
  assert.throws(
    () => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', extraEmulatorArgs: ['-avd', 'other'] }),
    /must not override -avd/,
  );
  assert.throws(
    () => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', extraEmulatorArgs: ['-no-window'] }),
    /must not override -no-window/,
  );
});

check('buildRemoteEmulatorStartCommand enableAudio drops -no-audio only', () => {
  const quiet = buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7' });
  assert.match(quiet.command, /-no-window -no-audio -no-boot-anim/);
  const loud = buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', enableAudio: true });
  assert.doesNotMatch(loud.command, /-no-audio/);
  assert.match(loud.command, /-no-window -no-boot-anim -gpu swiftshader_indirect -port 5554/);
});

check('normalizeExtraEmulatorArgs validates and de-duplicates', () => {
  assert.deepEqual(normalizeExtraEmulatorArgs(undefined), []);
  assert.deepEqual(normalizeExtraEmulatorArgs(['-camera-back', 'virtualscene', '-camera-back']), ['-camera-back', 'virtualscene']);
  assert.throws(() => normalizeExtraEmulatorArgs('-camera-back virtualscene'), /array of strings/);
  assert.throws(() => normalizeExtraEmulatorArgs(['']), /non-empty strings/);
  assert.throws(() => normalizeExtraEmulatorArgs(['bad\nflag']), /control characters/);
  assert.throws(() => normalizeExtraEmulatorArgs(['x'.repeat(201)]), /too long/);
  assert.throws(
    () => buildRemoteEmulatorStartCommand({ avdName: 'Pixel_7', extraEmulatorArgs: [''] }),
    /non-empty strings/,
  );
});

// ---------------------------------------------------------------------------
// Multi-profile store (<dataDir>/.apk-vm/remote-profiles.json)
// ---------------------------------------------------------------------------

check('defaultRemoteProfilesPath follows the data-dir convention', () => {
  assert.equal(defaultRemoteProfilesPath('/tmp/data'), path.join('/tmp/data', '.apk-vm', 'remote-profiles.json'));
  assert.ok(defaultRemoteProfilesPath('').endsWith(path.join('.apk-vm', 'remote-profiles.json')));
});

check('RemoteProfileBook multi-profile round-trip + atomic file', async () => {
  const file = path.join(root, 'book', 'remote-profiles.json');
  const book = new RemoteProfileBook({ file });
  const empty = await book.list();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.profiles, []);

  const first = normalizeRemoteProfile({ host: 'book-a.example', user: 'builder', avdName: 'Pixel_7', keyPath: keyFile });
  const saved = await book.save(first);
  assert.equal(saved.ok, true);
  assert.ok(saved.id, 'profile got an id');
  const second = normalizeRemoteProfile({ host: 'book-b.example', user: 'builder', avdName: 'Pixel_8', keyPath: keyFile });
  const savedSecond = await book.save(second, { id: 'pixel-8' });
  assert.equal(savedSecond.id, 'pixel-8');

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.profiles.length, 2);
  assert.ok(raw.profiles.every((entry) => typeof entry.id === 'string' && entry.profile.host));

  const listed = await book.list();
  assert.equal(listed.profiles.length, 2);
  const got = await book.get(saved.id);
  assert.equal(got.ok, true);
  assert.equal(got.profile.host, 'book-a.example');

  const removed = await book.forget(saved.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.removed, [saved.id]);
  assert.equal((await book.get(saved.id)).profile, null);
  const missing = await book.forget('');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /forget requires a remote profile id/);
  assert.deepEqual((await book.forget('missing-id')).removed, []);

  // Saving the same host+avd again upserts instead of duplicating.
  const again = normalizeRemoteProfile({ host: 'book-b.example', user: 'builder', avdName: 'Pixel_8', keyPath: keyFile });
  await book.save(again);
  assert.equal((await book.list()).profiles.length, 1);
});

check('RemoteProfileBook tolerates corrupt files and legacy single-profile JSON', async () => {
  const file = path.join(root, 'book-legacy', 'remote-profiles.json');
  const book = new RemoteProfileBook({ file });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const corrupt = await book.list();
  assert.equal(corrupt.ok, true);
  assert.match(String(corrupt.error), /invalid/);
  assert.deepEqual(corrupt.profiles, []);

  fs.writeFileSync(file, JSON.stringify({ version: 1, profile: { host: 'legacy.example', user: 'builder' } }));
  const legacy = await book.list();
  assert.equal(legacy.ok, true);
  assert.equal(legacy.profiles.length, 1);
  assert.equal(legacy.profiles[0].host, 'legacy.example');
  assert.equal(legacy.profiles[0].user, 'builder');

  // Saving over a legacy book keeps the migrated entry and appends the new one.
  await book.save(normalizeRemoteProfile({ host: 'recovered.example', user: 'builder', keyPath: keyFile }));
  const recovered = await book.list();
  assert.equal(recovered.profiles.length, 2);
  assert.ok(recovered.profiles.some((entry) => entry.host === 'recovered.example'));
  assert.ok(recovered.profiles.some((entry) => entry.host === 'legacy.example'));
});

check('normalizeRemoteProfile accepts consolePort and a profile name', () => {
  const profile = normalizeRemoteProfile({ host: 'build.example', name: 'Pixel build box', consolePort: 5556 });
  assert.equal(profile.name, 'Pixel build box');
  assert.equal(profile.consolePort, 5556);
  assert.equal(normalizeRemoteProfile({ host: 'build.example' }).consolePort, 0);
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', consolePort: 5555 }), /console port/);
  assert.throws(() => normalizeRemoteProfile({ host: 'build.example', name: 'bad\nname' }), /invalid remote profile name/);
});

check('parseRemoteListeningPorts reads ss/netstat LISTEN lines', () => {
  const ss = [
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
    'LISTEN 0      128    0.0.0.0:22               0.0.0.0:*',
    'ESTAB  0      0      203.0.113.5:22        198.51.100.9:51000',
    'LISTEN 0      4096   *:5554                   *:*',
  ].join('\n');
  assert.deepEqual(parseRemoteListeningPorts(ss), [53, 22, 5554]);
  const netstat = 'tcp 0 0 0.0.0.0:5556 0.0.0.0:* LISTEN';
  assert.deepEqual(parseRemoteListeningPorts(netstat), [5556]);
  assert.deepEqual(parseRemoteListeningPorts(''), []);
});

// ---------------------------------------------------------------------------
// RemoteSessionManager: hermetic multi-session engine (fake tunnel/instance)
// ---------------------------------------------------------------------------

function makeManagerHarness({ listenPorts = [], maxSessions = 8, tunnelStartError = null } = {}) {
  const events = [];
  const registry = new Map();
  const tunnels = [];
  const instances = [];
  const sshCommands = [];
  let localPort = 16000;
  const manager = new RemoteSessionManager({
    dataDir: root,
    profilesFile: path.join(root, 'manager-harness', 'remote-profiles.json'),
    maxSessions,
    tunnelFactory: (config) => {
      const tunnel = {
        config,
        state: 'stopped',
        startCount: 0,
        stopCount: 0,
        status() {
          return {
            state: this.state,
            localPort: config.localPort,
            remotePort: config.remotePort,
            serial: `127.0.0.1:${config.localPort}`,
            sshHost: config.host,
            sshUser: config.user,
          };
        },
        async start() {
          this.startCount += 1;
          events.push('tunnel.start');
          if (tunnelStartError) throw new Error(tunnelStartError);
          this.state = 'running';
          return { ok: true, ...this.status() };
        },
        async stop() {
          this.stopCount += 1;
          events.push('tunnel.stop');
          this.state = 'stopped';
          return { ok: true, ...this.status() };
        },
      };
      tunnels.push(tunnel);
      return tunnel;
    },
    instanceFactory: (args) => {
      const instance = {
        id: args.id,
        kind: 'remote',
        args,
        startCount: 0,
        stopCount: 0,
        lastStartOptions: null,
        lastStopOptions: null,
        async start(options = {}) {
          this.startCount += 1;
          this.lastStartOptions = options;
          events.push('instance.start');
          return { state: 'starting' };
        },
        async stop(options = {}) {
          this.stopCount += 1;
          this.lastStopOptions = options;
          events.push('instance.stop');
          return { ok: true };
        },
        async dispose() {
          events.push('instance.dispose');
        },
        async status() {
          return { state: 'ready', serial: args.tunnel.status().serial };
        },
        snapshotApk: () => null,
        vm: { _state: 'ready' },
        stream: null,
      };
      instances.push(instance);
      return instance;
    },
    instances: {
      addRemoteInstance: (instance) => {
        events.push(`register:${instance.id}`);
        registry.set(instance.id, instance);
      },
      removeInstance: (id) => {
        events.push(`unregister:${id}`);
        registry.delete(id);
      },
    },
    runSsh: async (profile, command, execOptions = {}) => {
      sshCommands.push({ profile, command, execOptions });
      events.push('ssh');
      if (command === REMOTE_LISTEN_COMMAND) {
        const stdout = listenPorts.map((port) => `LISTEN 0 4096 *:${port} *:*`).join('\n');
        return { ok: true, code: 0, stdout, stderr: '', error: null };
      }
      return { ok: true, code: 0, stdout: 'started:4242\n', stderr: '', error: null };
    },
    exec: async () => ({ code: 0, stdout: '', stderr: '', error: null }),
    findFreePort: async () => {
      localPort += 1;
      return localPort;
    },
    sleep: async () => {},
    now: () => 1700000000000,
    log: () => {},
  });
  return { manager, events, registry, tunnels, instances, sshCommands, listenPorts };
}

check('RemoteSessionManager saves/lists/forgets multiple profiles', async () => {
  const { manager } = makeManagerHarness();
  const before = await manager.state();
  assert.equal(before.ok, true);
  assert.deepEqual(before.sessions, []);
  assert.deepEqual(before.profiles, []);
  assert.match(before.profilesFile, /remote-profiles\.json$/);
  assert.equal(before.maxSessions, 8);

  const saved = await manager.saveProfile(
    normalizeRemoteProfile({ host: 'book.example', user: 'builder', avdName: 'Pixel_7', keyPath: keyFile }),
  );
  assert.equal(saved.ok, true);
  assert.ok(saved.id);
  const listed = await manager.listProfiles();
  assert.equal(listed.profiles.length, 1);
  const after = await manager.state();
  assert.equal(after.profiles.length, 1);
  assert.equal(after.profiles[0].host, 'book.example');

  const removed = await manager.forgetProfile(saved.id);
  assert.deepEqual(removed.removed, [saved.id]);
  assert.equal((await manager.listProfiles()).profiles.length, 0);
  await assert.rejects(() => manager.forgetProfile(''), /forget requires a remote profile id/);
});

check('RemoteSessionManager createSession launches remotely, tunnels and registers', async () => {
  const harness = makeManagerHarness({ listenPorts: [5554] });
  const { manager } = harness;
  const summary = await manager.createSession({
    profile: { host: 'build.example', user: 'builder', avdName: 'Pixel_7', launch: true },
    options: {
      extraEmulatorArgs: ['-camera-back', 'virtualscene'],
      enableAudio: true,
    },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.kind, 'remote');
  assert.equal(summary.state, 'connected');
  assert.equal(summary.host, 'build.example');
  assert.equal(summary.avdName, 'Pixel_7');
  assert.equal(summary.consolePort, 5556);
  assert.equal(summary.remotePort, 5557);
  assert.equal(summary.localPort, 16001);
  assert.equal(summary.serial, '127.0.0.1:16001');
  assert.ok(summary.tunnel);
  assert.equal(summary.tunnel.state, 'running');

  const launch = harness.sshCommands.find((entry) => entry.command.includes('-avd'));
  assert.ok(launch, 'launch command was sent over SSH');
  assert.match(launch.command, /'-camera-back' 'virtualscene'/);
  assert.doesNotMatch(launch.command, /-no-audio/);
  assert.match(launch.command, /-port 5556/);
  assert.equal(launch.execOptions.timeoutMs, 30000);

  assert.equal(harness.tunnels[0].config.remotePort, 5557);
  assert.equal(harness.tunnels[0].config.localPort, 16001);
  assert.equal(harness.tunnels[0].startCount, 1);
  assert.equal(harness.instances[0].args.tunnel.status().serial, '127.0.0.1:16001');
  assert.equal(harness.instances[0].args.tunnel, harness.tunnels[0]);
  assert.equal(harness.instances[0].args.launchInfo.consolePort, 5556);
  assert.equal(harness.instances[0].lastStartOptions.wait, false);
  assert.equal(harness.instances[0].lastStartOptions.attachInBackground, true);
  assert.equal(harness.registry.size, 1);
  assert.equal(harness.registry.get(summary.id), harness.instances[0]);

  const state = await manager.state();
  assert.equal(state.counts.sessions, 1);
  assert.equal(state.counts.connected, 1);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.getInstance(summary.id), harness.instances[0]);

  await manager.dispose();
  assert.equal(harness.registry.size, 0);
  assert.equal(manager.list().length, 0);
});

check('RemoteSessionManager allocates unique console ports and skips listeners', async () => {
  const harness = makeManagerHarness({ listenPorts: [5554] });
  const { manager } = harness;
  const first = await manager.createSession({ profile: { host: 'build.example', user: 'builder', avdName: 'Pixel_7', launch: true } });
  const second = await manager.createSession({ profile: { host: 'build.example', user: 'builder', avdName: 'Pixel_8', launch: true } });
  assert.equal(first.consolePort, 5556);
  assert.equal(second.consolePort, 5558);
  assert.notEqual(second.localPort, first.localPort);
  await assert.rejects(
    () => manager.createSession({ profile: { host: 'build.example', user: 'builder', avdName: 'Pixel_7', launch: true } }),
    /already used by session/,
  );
  await manager.dispose();
});

check('RemoteSessionManager disconnect/reconnect/remove keeps the session bookkeeping', async () => {
  const harness = makeManagerHarness();
  const { manager } = harness;
  const created = [];
  const summary = await manager.createSession({
    profile: { host: 'matrix.example', user: 'builder', remotePort: 5555 },
    options: { onCreated: (instance) => created.push(instance) },
  });
  assert.equal(created.length, 1, 'options.onCreated receives the new instance');
  assert.equal(created[0], harness.instances[0]);
  assert.equal(summary.consolePort, null);
  assert.equal(summary.remotePort, 5555);
  assert.equal(harness.tunnels[0].config.remotePort, 5555);

  const disconnected = await manager.disconnectSession(summary.id, { killRemote: true });
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.disconnected, true);
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.serial, null);
  assert.equal(disconnected.removed, false);
  assert.equal(harness.instances[0].lastStopOptions.killRemote, true);
  assert.equal(harness.registry.size, 1, 'the disconnected session stays routable for reconnect');
  assert.equal(manager.list().length, 1);

  const reconnected = await manager.reconnect(summary.id);
  assert.equal(reconnected.state, 'connected');
  assert.equal(harness.instances[0].startCount, 2);

  const removed = await manager.removeSession(summary.id, { killRemote: true });
  assert.equal(removed.removed, true);
  assert.equal(manager.list().length, 0);
  assert.equal(harness.registry.size, 0);
  assert.ok(harness.events.some((event) => event.startsWith('unregister:')));
  const missing = await manager.disconnectSession('nope');
  assert.equal(missing.disconnected, false);
  await manager.dispose();
});

check('RemoteSessionManager createSession cleans up when the tunnel fails', async () => {
  const harness = makeManagerHarness({ tunnelStartError: 'connection refused' });
  const { manager } = harness;
  await assert.rejects(
    () => manager.createSession({ profile: { host: 'fail.example', user: 'builder', remotePort: 5556 } }),
    /SSH tunnel from fail\.example failed: connection refused/,
  );
  assert.equal(manager.list().length, 0);
  assert.equal(harness.registry.size, 0);
  assert.ok(harness.events.includes('tunnel.stop'), 'failed tunnel is stopped');
  await manager.dispose();
});

check('RemoteSessionManager enforces maxSessions', async () => {
  const harness = makeManagerHarness({ maxSessions: 1 });
  const { manager } = harness;
  await manager.createSession({ profile: { host: 'one.example', user: 'builder', remotePort: 5555 } });
  await assert.rejects(
    () => manager.createSession({ profile: { host: 'two.example', user: 'builder', remotePort: 5556 } }),
    /max remote sessions reached \(1\)/,
  );
  await manager.dispose();
});

check('RemoteSessionManager attachInBackground:false waits in start()', async () => {
  const harness = makeManagerHarness();
  const { manager } = harness;
  await manager.createSession({
    profile: { host: 'boot.example', user: 'builder', remotePort: 5557 },
    options: { attachInBackground: false },
  });
  assert.deepEqual(harness.instances[0].lastStartOptions, {});
  await manager.dispose();
});

// ---------------------------------------------------------------------------
// InstanceManager integration (remote kind + media launch options)
// ---------------------------------------------------------------------------

check('InstanceManager lists remote kind and never reaps it', async () => {
  const manager = new InstanceManager({ maxInstances: 3 });
  const stops = [];
  const staleAt = Date.now() - 20 * 60 * 1000;
  manager.instances.set('remote-1', {
    id: 'remote-1',
    kind: 'remote',
    avdName: 'Pixel_7',
    port: null,
    vm: { _state: 'ready', serial: '127.0.0.1:5555' },
    stream: null,
    installInFlight: null,
    lastUsedAt: staleAt,
    snapshotApk: () => null,
    async stop() { stops.push('remote-1'); },
  });
  manager.instances.set('local-1', {
    id: 'local-1',
    kind: 'extra',
    avdName: 'local_avd',
    port: 5556,
    vm: { _state: 'ready', serial: 'emulator-5556' },
    stream: null,
    installInFlight: null,
    lastUsedAt: staleAt,
    snapshotApk: () => null,
    async stop() { stops.push('local-1'); },
  });
  const listed = manager.list();
  assert.equal(listed.find((entry) => entry.id === 'remote-1').kind, 'remote');
  assert.equal(listed.find((entry) => entry.id === 'local-1').kind, 'extra');
  assert.deepEqual(manager.remoteInstances().map((instance) => instance.id), ['remote-1']);
  const stopped = await manager.reapIdle(Date.now());
  assert.deepEqual(stopped.map((entry) => entry.id), ['local-1']);
  assert.deepEqual(stops, ['local-1']);
  manager.removeInstance('remote-1');
  assert.equal(manager.get('remote-1'), null);
  assert.equal(manager.remoteInstances().length, 0);
});

check('InstanceManager applyMediaOptions updates existing VMs tolerantly', () => {
  const provider = () => ({ extraEmulatorArgs: ['-camera-back', 'virtualscene'], enableAudio: true });
  const manager = new InstanceManager({ maxInstances: 3, mediaOptionsProvider: provider });
  assert.equal(manager.mediaOptionsProvider, provider);
  const fakeVm = { extraEmulatorArgs: [], enableAudio: false };
  manager.instances.set('fake-extra', {
    id: 'fake-extra',
    kind: 'extra',
    vm: fakeVm,
    lastUsedAt: Date.now(),
    stream: null,
    installInFlight: null,
    snapshotApk: () => null,
  });
  const applied = manager.applyMediaOptions({ extraEmulatorArgs: ['-camera-back', 'virtualscene'], enableAudio: true });
  assert.deepEqual(applied, {
    ok: true,
    applied: 1,
    media: { extraEmulatorArgs: ['-camera-back', 'virtualscene'], enableAudio: true },
  });
  assert.deepEqual(fakeVm.extraEmulatorArgs, ['-camera-back', 'virtualscene']);
  assert.equal(fakeVm.enableAudio, true);

  // A frozen VM must not break the sweep; it is simply skipped.
  const frozenVm = Object.freeze({ extraEmulatorArgs: [] });
  manager.instances.set('frozen', {
    id: 'frozen',
    kind: 'extra',
    vm: frozenVm,
    lastUsedAt: Date.now(),
    stream: null,
    installInFlight: null,
    snapshotApk: () => null,
  });
  const cleared = manager.applyMediaOptions(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.applied, 1);
  assert.equal(cleared.media, null);
  assert.equal(fakeVm.enableAudio, false);
  assert.deepEqual(fakeVm.extraEmulatorArgs, []);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const passed = await runChecks();
console.log(`\nremote-test: ${passed}/${checks.length} checks passed`);
process.exitCode = process.exitCode || 0;

for (const dispose of disposers.reverse()) {
  try {
    await dispose();
  } catch {
    /* ignore */
  }
}
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* ignore */
}
