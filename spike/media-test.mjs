/**
 * spike/media-test.mjs — hermetic checks for lib/media.js (virtual camera /
 * virtual microphone config + launch layer) and the small lib/android.js
 * `extraEmulatorArgs` / `enableAudio` additions.
 *
 * No emulator, adb, SSH, PulseAudio or network is used: filesystem checks run
 * against temporary files, command builders are pure string builders, and
 * lib/android.js is exercised via `_buildLaunchPlan()` with acceleration and
 * snapshot probes stubbed.
 *
 *   node spike/media-test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AndroidVm } from '../lib/android.js';
import {
  CAMERA_MODES,
  MAX_POSTERS,
  MIC_AUDIO_BACKENDS,
  REMOTE_MEDIA_ROOT,
  buildEmulatorMediaArgs,
  buildPulseMicStartCommand,
  buildPulseMicStatusCommand,
  buildPulseMicStopCommand,
  cameraCapabilities,
  checkPosterFile,
  mediaLaunchOptions,
  micCapabilities,
  micSourceName,
  normalizeCameraConfig,
  normalizeMicConfig,
  parseWebcamList,
  quotePosix,
  remoteAudioPath,
  remoteMediaDir,
  remoteMediaPaths,
  remotePosterPath,
  sanitizeMediaSlug,
  sniffImageFormat,
} from '../lib/media.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = Buffer.concat([PNG_SIGNATURE, Buffer.from('fake-png-body')]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);

const WEBCAM_LEGACY = [
  'List of web cameras connected to the computer:',
  ' Camera `webcam0` is connected to device `AndroidEmulatorVC0` on channel 0 using pixel format `BGR4`',
].join('\n');

const WEBCAM_MODERN = [
  'List of web cameras connected to the computer:',
  ' Camera `Integrated Camera` is connected to device `webcam0` on channel 1 using pixel format `MJPEG`',
  ' Camera `USB Camera` is connected to device `webcam1` on channel 0 using pixel format `YUY2`',
].join('\n');

/** Create a temp dir removed when the test finishes. */
function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkvm-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Decode one POSIX single-quoted word produced by quotePosix(). */
function decodeQuotedWord(quoted) {
  assert.equal(quoted[0], "'", 'quoted word must start with a single quote');
  assert.equal(quoted[quoted.length - 1], "'", 'quoted word must end with a single quote');
  const inner = quoted.slice(1, -1);
  const parts = inner.split(`'\\''`);
  return parts.join("'");
}

/** Count occurrences of a token in argv. */
function countArg(args, token) {
  return args.filter((arg) => arg === token).length;
}

/**
 * Map the POSIX single-quoted ranges of a generated shell command, honouring
 * the `'\''` escape emitted by quotePosix(). Used to prove that hostile input
 * only shows up inside literal (non-executable) quoted words.
 */
function quotedRanges(command) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i < command.length; i += 1) {
    if (start >= 0 && command.startsWith("'\\''", i)) {
      i += 3;
      continue;
    }
    if (command[i] === "'") {
      if (start >= 0) {
        ranges.push([start, i]);
        start = -1;
      } else {
        start = i;
      }
    }
  }
  return ranges;
}

/** True when index points strictly inside a quoted range. */
function insideQuoted(ranges, index) {
  return ranges.some(([from, to]) => index > from && index < to);
}

/** AndroidVm with acceleration/snapshot probes stubbed so no host probing runs. */
function makeVm(extra = {}) {
  const vm = new AndroidVm({
    avdName: 'dsh_apk',
    emulatorPath: '<android-sdk>\\emulator\\emulator.exe',
    port: 5558,
    ...extra,
  });
  vm._detectAcceleration = async () => true;
  vm._snapshotPresent = () => false;
  return vm;
}

// ---------------------------------------------------------------------------
// normalizeCameraConfig()
// ---------------------------------------------------------------------------

test('normalizeCameraConfig: empty input yields no flags', () => {
  const empty = { back: null, front: null, posters: [] };
  assert.deepEqual(normalizeCameraConfig(), empty);
  assert.deepEqual(normalizeCameraConfig({}), empty);
  assert.deepEqual(normalizeCameraConfig(null), empty);
  assert.deepEqual(normalizeCameraConfig(''), empty);
});

test('normalizeCameraConfig: valid modes, posters and case folding', () => {
  assert.deepEqual(CAMERA_MODES, ['none', 'emulated', 'virtualscene']);
  const camera = normalizeCameraConfig({
    back: 'VirtualScene',
    front: 'webcam3',
    posters: [
      { name: 'wall', path: '/tmp/apk-vm-media/wall.png' },
      { name: 'Side_Panel-2', path: 'C:\\state\\posters\\side.png' },
    ],
  });
  assert.equal(camera.back, 'virtualscene');
  assert.equal(camera.front, 'webcam3');
  assert.deepEqual(camera.posters, [
    { name: 'wall', path: '/tmp/apk-vm-media/wall.png' },
    { name: 'Side_Panel-2', path: 'C:\\state\\posters\\side.png' },
  ]);
});

test('normalizeCameraConfig: all webcam indices 0..7 accepted, 8 rejected', () => {
  for (let index = 0; index <= 7; index += 1) {
    assert.equal(normalizeCameraConfig({ back: `webcam${index}` }).back, `webcam${index}`);
  }
  assert.throws(() => normalizeCameraConfig({ back: 'webcam8' }), /webcam0\.\.webcam7/);
  assert.throws(() => normalizeCameraConfig({ front: 'usb-camera' }), /webcam0\.\.webcam7/);
});

test('normalizeCameraConfig: rejects adversarial values', () => {
  assert.throws(() => normalizeCameraConfig(42), /must be an object/);
  assert.throws(() => normalizeCameraConfig([]), /must be an object/);
  assert.throws(() => normalizeCameraConfig({ back: 'virtual-scene' }), /camera\.back/);
  assert.throws(() => normalizeCameraConfig({ back: ['virtualscene'] }), /camera\.back must be a string/);
  assert.throws(() => normalizeCameraConfig({ posters: 'wall' }), /must be an array/);
  assert.throws(() => normalizeCameraConfig({ posters: [{ name: 'a/b', path: '/tmp/x.png' }] }), /name/);
  assert.throws(() => normalizeCameraConfig({ posters: [{ name: 'wall', path: '' }] }), /path is required/);
  assert.throws(
    () => normalizeCameraConfig({ posters: [{ name: 'wall', path: '/tmp/a=b.png' }] }),
    /must not contain "="/,
  );
  assert.throws(
    () => normalizeCameraConfig({ posters: [{ name: 'wall', path: '/tmp/a\nb.png' }] }),
    /control characters/,
  );
  assert.throws(() => normalizeCameraConfig({ posters: [{ name: 'wall' }] }), /required/);
  const tooMany = Array.from({ length: MAX_POSTERS + 1 }, (_, index) => ({
    name: `poster${index}`,
    path: '/tmp/apk-vm-media/poster.png',
  }));
  assert.throws(() => normalizeCameraConfig({ posters: tooMany }), /at most 8/);
});

test('normalizeCameraConfig: duplicate poster names rejected case-insensitively', () => {
  assert.throws(
    () =>
      normalizeCameraConfig({
        posters: [
          { name: 'wall', path: '/tmp/a.png' },
          { name: 'Wall', path: '/tmp/b.png' },
        ],
      }),
    /duplicate poster name/,
  );
});

test('normalizeCameraConfig: idempotent and poster paths may contain spaces', () => {
  const raw = {
    back: 'virtualscene',
    front: 'emulated',
    posters: [{ name: 'wall', path: '/tmp/apk-vm media/my wall.png' }],
  };
  const once = normalizeCameraConfig(raw);
  assert.deepEqual(normalizeCameraConfig(once), once);
  assert.equal(once.posters[0].path, '/tmp/apk-vm media/my wall.png');
});

// ---------------------------------------------------------------------------
// normalizeMicConfig()
// ---------------------------------------------------------------------------

test('normalizeMicConfig: defaults are off / 48000 / mono', () => {
  assert.deepEqual(normalizeMicConfig(), {
    mode: 'off',
    filePath: undefined,
    backend: undefined,
    channels: 1,
    rate: 48000,
  });
  assert.deepEqual(normalizeMicConfig({}), {
    mode: 'off',
    filePath: undefined,
    backend: undefined,
    channels: 1,
    rate: 48000,
  });
});

test('normalizeMicConfig: host + backend + channels/rate', () => {
  const mic = normalizeMicConfig({ mode: 'HOST', backend: 'pa', channels: 2, rate: 16000 });
  assert.equal(mic.mode, 'host');
  assert.equal(mic.filePath, undefined);
  assert.equal(mic.backend, 'pa');
  assert.equal(mic.channels, 2);
  assert.equal(mic.rate, 16000);
});

test('normalizeMicConfig: file mode requires a supported audio extension', () => {
  const wav = normalizeMicConfig({ mode: 'file', filePath: '/tmp/apk-vm-media/audio/voice.WAV' });
  assert.equal(wav.mode, 'file');
  assert.equal(wav.filePath, '/tmp/apk-vm-media/audio/voice.WAV');
  assert.equal(wav.channels, 1);
  assert.equal(wav.rate, 48000);

  assert.ok(normalizeMicConfig({ mode: 'file', filePath: '/tmp/a.mp3' }).filePath.endsWith('.mp3'));
  assert.ok(normalizeMicConfig({ mode: 'file', filePath: '/tmp/a.ogg' }).filePath.endsWith('.ogg'));
  assert.throws(() => normalizeMicConfig({ mode: 'file' }), /filePath is required/);
  assert.throws(() => normalizeMicConfig({ mode: 'file', filePath: '/tmp/a.txt' }), /\.wav, \.mp3 or \.ogg/);
  assert.throws(() => normalizeMicConfig({ mode: 'file', filePath: '/tmp/a\n.wav' }), /control characters/);
});

test('normalizeMicConfig: rejects adversarial values', () => {
  assert.throws(() => normalizeMicConfig(7), /must be an object/);
  assert.throws(() => normalizeMicConfig({ mode: 'microphone' }), /mic\.mode/);
  assert.throws(() => normalizeMicConfig({ mode: 'host', backend: 'pulseaudio' }), /mic\.backend/);
  assert.throws(() => normalizeMicConfig({ mode: 'host', filePath: '/tmp/a.wav' }), /only valid when mic\.mode is "file"/);
  assert.throws(() => normalizeMicConfig({ channels: 0 }), /channels must be 1 or 2/);
  assert.throws(() => normalizeMicConfig({ channels: 3 }), /channels must be 1 or 2/);
  assert.throws(() => normalizeMicConfig({ channels: 1.5 }), /channels must be 1 or 2/);
  assert.throws(() => normalizeMicConfig({ rate: 22050 }), /mic\.rate/);
  assert.throws(() => normalizeMicConfig({ rate: 'fast' }), /mic\.rate/);
  assert.deepEqual(MIC_AUDIO_BACKENDS, ['none', 'pa', 'alsa', 'sdl', 'winmm', 'dsound']);
});

test('normalizeMicConfig: idempotent', () => {
  for (const raw of [
    { mode: 'host', backend: 'alsa', channels: 2, rate: 44100 },
    { mode: 'file', filePath: '/tmp/apk-vm-media/audio/voice.wav' },
    {},
  ]) {
    const once = normalizeMicConfig(raw);
    assert.deepEqual(normalizeMicConfig(once), once);
  }
});

// ---------------------------------------------------------------------------
// buildEmulatorMediaArgs() + mediaLaunchOptions()
// ---------------------------------------------------------------------------

test('buildEmulatorMediaArgs: empty config yields no argv', () => {
  assert.deepEqual(buildEmulatorMediaArgs(), []);
  assert.deepEqual(buildEmulatorMediaArgs({}), []);
  assert.deepEqual(buildEmulatorMediaArgs(null), []);
  assert.deepEqual(buildEmulatorMediaArgs({ camera: null, mic: null }), []);
  assert.deepEqual(buildEmulatorMediaArgs({ mic: { mode: 'off', backend: 'pa' } }), []);
});

test('buildEmulatorMediaArgs: camera flags and posters in deterministic order', () => {
  const args = buildEmulatorMediaArgs({
    camera: {
      back: 'virtualscene',
      front: 'emulated',
      posters: [
        { name: 'wall', path: '/tmp/apk-vm-media/posters/wall.png' },
        { name: 'table', path: '/tmp/apk-vm-media/posters/table.jpg' },
      ],
    },
  });
  assert.deepEqual(args, [
    '-camera-back',
    'virtualscene',
    '-camera-front',
    'emulated',
    '-virtualscene-poster',
    'wall=/tmp/apk-vm-media/posters/wall.png',
    '-virtualscene-poster',
    'table=/tmp/apk-vm-media/posters/table.jpg',
  ]);
});

test('buildEmulatorMediaArgs: mic flags after camera flags', () => {
  assert.deepEqual(buildEmulatorMediaArgs({ mic: { mode: 'host' } }), ['-allow-host-audio']);
  assert.deepEqual(buildEmulatorMediaArgs({ mic: { mode: 'file', filePath: '/tmp/a.wav', backend: 'pa' } }), [
    '-allow-host-audio',
    '-audio',
    'pa',
  ]);
  const full = buildEmulatorMediaArgs({
    camera: { back: 'virtualscene', posters: [{ name: 'wall', path: '/tmp/wall.png' }] },
    mic: { mode: 'file', filePath: '/tmp/a.wav' },
  });
  assert.deepEqual(full, [
    '-camera-back',
    'virtualscene',
    '-virtualscene-poster',
    'wall=/tmp/wall.png',
    '-allow-host-audio',
  ]);
  assert.ok(!full.includes('-no-audio'), 'media args must never force -no-audio');
});

test('buildEmulatorMediaArgs: accepts already-normalized config', () => {
  const camera = normalizeCameraConfig({ back: 'webcam1' });
  const mic = normalizeMicConfig({ mode: 'host', backend: 'sdl' });
  assert.deepEqual(buildEmulatorMediaArgs({ camera, mic }), [
    '-camera-back',
    'webcam1',
    '-allow-host-audio',
    '-audio',
    'sdl',
  ]);
  assert.throws(() => buildEmulatorMediaArgs('camera'), /media config must be an object/);
  assert.throws(() => buildEmulatorMediaArgs({ camera: { back: 'bogus' } }), /camera\.back/);
});

test('mediaLaunchOptions: one-call launcher wiring', () => {
  assert.deepEqual(mediaLaunchOptions(), { extraEmulatorArgs: [], enableAudio: false });
  assert.deepEqual(mediaLaunchOptions({ camera: { back: 'virtualscene' } }), {
    extraEmulatorArgs: ['-camera-back', 'virtualscene'],
    enableAudio: false,
  });
  assert.deepEqual(mediaLaunchOptions({ mic: { mode: 'host' } }), {
    extraEmulatorArgs: ['-allow-host-audio'],
    enableAudio: true,
  });
  const fileMic = mediaLaunchOptions({ mic: { mode: 'file', filePath: '/tmp/a.wav', backend: 'pa' } });
  assert.equal(fileMic.enableAudio, true);
  assert.deepEqual(fileMic.extraEmulatorArgs, ['-allow-host-audio', '-audio', 'pa']);
  assert.deepEqual(mediaLaunchOptions({ mic: { mode: 'off' } }).extraEmulatorArgs, []);
});

// ---------------------------------------------------------------------------
// sniffImageFormat() + checkPosterFile()
// ---------------------------------------------------------------------------

test('sniffImageFormat: PNG / JPEG / garbage / short input', () => {
  assert.equal(sniffImageFormat(PNG_BYTES), 'png');
  assert.equal(sniffImageFormat(JPEG_BYTES), 'jpeg');
  assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), 'jpeg');
  assert.equal(sniffImageFormat(Buffer.from('GIF89a')), null);
  assert.equal(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e])), null);
  assert.equal(sniffImageFormat(Buffer.alloc(0)), null);
  assert.equal(sniffImageFormat(null), null);
  assert.equal(sniffImageFormat('not bytes'), null);
  assert.equal(sniffImageFormat(new Uint8Array(PNG_SIGNATURE)), 'png');
});

test('checkPosterFile: accepts real PNG/JPEG files', async (t) => {
  const dir = makeTempDir(t);
  const pngPath = path.join(dir, 'wall.png');
  const jpegPath = path.join(dir, 'table.jpg');
  fs.writeFileSync(pngPath, PNG_BYTES);
  fs.writeFileSync(jpegPath, JPEG_BYTES);

  const png = await checkPosterFile(pngPath);
  assert.deepEqual(png, { ok: true, path: pngPath, format: 'png', size: PNG_BYTES.length });
  const jpeg = await checkPosterFile(jpegPath);
  assert.deepEqual(jpeg, { ok: true, path: jpegPath, format: 'jpeg', size: JPEG_BYTES.length });
});

test('checkPosterFile: reports bad magic, empty, missing and directory paths', async (t) => {
  const dir = makeTempDir(t);
  const badPath = path.join(dir, 'fake.png');
  fs.writeFileSync(badPath, Buffer.from('this is not an image at all'));
  const bad = await checkPosterFile(badPath);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /magic bytes mismatch/);

  const emptyPath = path.join(dir, 'empty.png');
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  assert.match((await checkPosterFile(emptyPath)).reason, /empty/);

  const missing = await checkPosterFile(path.join(dir, 'nope.png'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not readable/);

  assert.match((await checkPosterFile(dir)).reason, /not a regular file/);
});

test('checkPosterFile: honours maxBytes and supports injected fs', async (t) => {
  const dir = makeTempDir(t);
  const pngPath = path.join(dir, 'wall.png');
  fs.writeFileSync(pngPath, PNG_BYTES);
  const tooBig = await checkPosterFile(pngPath, { maxBytes: 4 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /larger than 4 bytes/);

  const injected = await checkPosterFile('/virtual/wall.png', {
    stat: async () => ({ isFile: () => true, size: PNG_BYTES.length }),
    readFile: async () => PNG_BYTES,
  });
  assert.deepEqual(injected, { ok: true, path: '/virtual/wall.png', format: 'png', size: PNG_BYTES.length });

  await assert.rejects(() => checkPosterFile('/tmp/a\u0000b.png'), /control characters/);
});

// ---------------------------------------------------------------------------
// Webcam list parsing + camera capabilities
// ---------------------------------------------------------------------------

test('parseWebcamList: empty and unrelated output', () => {
  assert.deepEqual(parseWebcamList(''), []);
  assert.deepEqual(parseWebcamList('List of web cameras connected to the computer:\n'), []);
  assert.deepEqual(parseWebcamList(undefined), []);
  assert.deepEqual(parseWebcamList('avdmanager output that mentions nothing relevant'), []);
});

test('parseWebcamList: legacy and modern emulator output', () => {
  assert.deepEqual(parseWebcamList(WEBCAM_LEGACY), [{ index: 0, name: 'webcam0' }]);
  assert.deepEqual(parseWebcamList(WEBCAM_MODERN), [
    { index: 0, name: 'Integrated Camera' },
    { index: 1, name: 'USB Camera' },
  ]);
});

test('parseWebcamList: tolerates single quotes, ordering and duplicate lines', () => {
  const text = [
    "Camera 'USB Camera' is connected to device 'webcam1' on channel 0 using pixel format 'YUY2'",
    'Camera `webcam0` is connected to device `AndroidEmulatorVC0` on channel 1 using pixel format `BGR4`',
    'Camera "Duplicated Entry" is connected to device `webcam1` on channel 2 using pixel format `MJPEG`',
    'Camera `Far Too High` is connected to device `webcam9` on channel 3 using pixel format `MJPEG`',
  ].join('\n');
  assert.deepEqual(parseWebcamList(text), [
    { index: 0, name: 'webcam0' },
    { index: 1, name: 'USB Camera' },
  ]);
});

test('cameraCapabilities: headless virtualscene is the custom-content path', () => {
  const withoutCameras = cameraCapabilities({ platform: 'win32', webcamListText: '' });
  assert.equal(withoutCameras.platform, 'win32');
  assert.deepEqual(withoutCameras.webcams, []);
  assert.deepEqual(withoutCameras.modes, ['none', 'emulated', 'virtualscene']);
  assert.match(withoutCameras.note, /work headless/);
  assert.match(withoutCameras.note, /No host cameras/);
  assert.match(withoutCameras.note, /OBS Virtual Camera/);

  const withCameras = cameraCapabilities({ platform: 'linux', webcamListText: WEBCAM_MODERN });
  assert.deepEqual(withCameras.webcams, [
    { index: 0, name: 'Integrated Camera' },
    { index: 1, name: 'USB Camera' },
  ]);
  assert.deepEqual(withCameras.modes, ['none', 'emulated', 'virtualscene', 'webcam0', 'webcam1']);
  assert.match(withCameras.note, /2 host camera\(s\) detected/);

  assert.equal(cameraCapabilities().platform, process.platform);
});

// ---------------------------------------------------------------------------
// Microphone capabilities
// ---------------------------------------------------------------------------

test('micCapabilities: platform-specific file-loop support', () => {
  const win = micCapabilities({ platform: 'win32' });
  assert.equal(win.platform, 'win32');
  assert.equal(win.hostPassthrough, true);
  assert.equal(win.fileLoop, false);
  assert.deepEqual(win.backendChoices, ['none', 'sdl', 'winmm', 'dsound']);
  assert.match(win.note, /only supported on a Linux host/);
  assert.match(win.note, /allow-host-audio/);

  const linux = micCapabilities({ platform: 'linux' });
  assert.equal(linux.fileLoop, true);
  assert.deepEqual(linux.backendChoices, ['none', 'pa', 'alsa', 'sdl']);
  assert.match(linux.note, /PulseAudio/);
  assert.match(linux.note, /no sudo/);

  const remoteFromWindows = micCapabilities({ platform: 'win32', remote: true });
  assert.equal(remoteFromWindows.fileLoop, true);
  assert.match(remoteFromWindows.note, /PulseAudio/);

  assert.deepEqual(micCapabilities({ platform: 'darwin' }).backendChoices, ['none', 'sdl']);
  assert.equal(micCapabilities({ platform: 'plan9' }).fileLoop, false);
  assert.equal(micCapabilities().hostPassthrough, true);
});

// ---------------------------------------------------------------------------
// POSIX quoting + PulseAudio command builders
// ---------------------------------------------------------------------------

test('quotePosix: escapes single quotes and rejects control characters', () => {
  assert.equal(quotePosix('/tmp/plain.wav'), "'/tmp/plain.wav'");
  assert.equal(quotePosix('/tmp/a b.wav'), "'/tmp/a b.wav'");
  assert.equal(quotePosix("it's"), "'it'\\''s'");
  assert.equal(quotePosix('a`id`b$(x);c|d'), "'a`id`b$(x);c|d'");
  assert.throws(() => quotePosix(''), /empty/);
  assert.throws(() => quotePosix('a\nb'), /control characters/);
  assert.throws(() => quotePosix('a\u0000b'), /control characters/);
});

test('buildPulseMicStartCommand: full command shape', () => {
  const command = buildPulseMicStartCommand({
    sourceName: 'apkvm_mic_state-1234',
    fifoPath: '/tmp/apk-vm-media/state-1234/mic.fifo',
    pidFile: '/tmp/apk-vm-media/state-1234/mic.pid',
    audioFilePath: '/tmp/apk-vm-media/state-1234/audio/voice.wav',
    rate: 16000,
    channels: 2,
  });
  assert.match(command, /^set -u; mkdir -p -- /);
  assert.ok(command.includes('mkfifo '), 'creates a FIFO');
  assert.ok(command.includes('chmod 600 '), 'restricts FIFO permissions');
  assert.ok(command.includes('ffmpeg -nostdin -hide_banner -loglevel error -re -stream_loop -1 -i'), 'loops ffmpeg');
  assert.ok(command.includes('-f s16le -ar 16000 -ac 2 - >'), 'writes raw s16le to the FIFO');
  assert.ok(command.includes('echo $! > '), 'records the ffmpeg PID');
  assert.ok(command.includes('sleep 1'), 'waits before loading the module');
  assert.ok(command.includes('pactl list short modules'), 'cleans up a previous module');
  assert.ok(command.includes('pactl load-module module-pipe-source'), 'loads module-pipe-source');
  assert.ok(command.includes("'source_name=apkvm_mic_state-1234'"));
  assert.ok(command.includes("'file=/tmp/apk-vm-media/state-1234/mic.fifo'"));
  assert.ok(command.includes("'rate=16000'"));
  assert.ok(command.includes("'channels=2'"));
  assert.ok(command.includes('/tmp/apk-vm-media/state-1234/mic.fifo.ffmpeg.log'));
  assert.equal(command.includes('\n'), false, 'command is a single line for SSH');
});

test('buildPulseMicStartCommand: defaults and custom log path', () => {
  const command = buildPulseMicStartCommand({
    sourceName: 'mic_a',
    fifoPath: '/tmp/m/a.fifo',
    pidFile: '/tmp/m/a.pid',
    audioFilePath: '/tmp/m/a.wav',
    logFile: '/tmp/m/ffmpeg.log',
  });
  assert.ok(command.includes("'rate=48000'"));
  assert.ok(command.includes("'channels=1'"));
  assert.ok(command.includes("2> '/tmp/m/ffmpeg.log'"));
});

test('buildPulseMicStartCommand: hostile file names stay inside quoted words', () => {
  const hostileAudio = "/tmp/apk vm/$HOME/voice 'raw' $(touch PWNED); `id`.wav";
  const hostileFifo = '/tmp/apk vm/fifo $(reboot) `x`.fifo';
  const hostilePid = '/tmp/apk vm/pid;rm -rf /.pid';
  const command = buildPulseMicStartCommand({
    sourceName: 'mic_safe',
    fifoPath: hostileFifo,
    pidFile: hostilePid,
    audioFilePath: hostileAudio,
  });
  for (const value of [hostileAudio, hostileFifo, hostilePid]) {
    assert.ok(command.includes(quotePosix(value)), `quoted form embedded for ${JSON.stringify(value.slice(0, 24))}`);
  }
  // Every embedded value round-trips through the POSIX single-quote decoder.
  assert.equal(decodeQuotedWord(quotePosix(hostileAudio)), hostileAudio);
  assert.equal(decodeQuotedWord(quotePosix(hostileFifo)), hostileFifo);
  // Every occurrence of a hostile payload fragment must sit inside a single
  // quoted word: there it is a literal string, never a shell operator,
  // command substitution or glob. (The quoted words are still valid POSIX;
  // decodeQuotedWord above proves they round-trip to the exact input.)
  const ranges = quotedRanges(command);
  for (const needle of ['$(touch PWNED)', '$(reboot)', '`id`', '`x`', ';rm -rf /', '$HOME']) {
    let at = command.indexOf(needle);
    assert.ok(at >= 0, `fixture should embed ${needle}`);
    while (at >= 0) {
      assert.ok(
        insideQuoted(ranges, at),
        `${needle} must stay inside a quoted word, found at ${at}: ${JSON.stringify(command.slice(Math.max(0, at - 60), at + 80))}`,
      );
      at = command.indexOf(needle, at + 1);
    }
  }
});

test('buildPulseMicStartCommand: rejects invalid options', () => {
  const base = {
    sourceName: 'mic_a',
    fifoPath: '/tmp/m/a.fifo',
    pidFile: '/tmp/m/a.pid',
    audioFilePath: '/tmp/m/a.wav',
  };
  assert.throws(() => buildPulseMicStartCommand({ ...base, sourceName: 'bad name' }), /sourceName/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, sourceName: "x'; touch pwned; '" }), /sourceName/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, fifoPath: 'tmp/a.fifo' }), /absolute POSIX path/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, fifoPath: 'C:\\state\\a.fifo' }), /absolute POSIX path/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, audioFilePath: '/tmp/a\n.wav' }), /control characters/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, pidFile: base.fifoPath }), /must differ/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, rate: 22050 }), /mic\.rate/);
  assert.throws(() => buildPulseMicStartCommand({ ...base, channels: 3 }), /channels/);
  assert.throws(() => buildPulseMicStartCommand({}), /sourceName is required/);
});

test('buildPulseMicStopCommand: kills pid, removes FIFO and unloads module', () => {
  const command = buildPulseMicStopCommand({
    sourceName: 'apkvm_mic_state-1',
    pidFile: '/tmp/apk-vm-media/state-1/mic.pid',
    fifoPath: '/tmp/apk-vm-media/state-1/mic.fifo',
  });
  assert.match(command, /^set -u; if \[ -f /);
  assert.ok(command.includes('kill "$(cat '), 'kills the recorded ffmpeg PID');
  assert.ok(command.includes('sleep 1; kill -9 '), 'escalates to SIGKILL');
  assert.ok(command.includes("rm -f '/tmp/apk-vm-media/state-1/mic.pid'"));
  assert.ok(command.includes("rm -f '/tmp/apk-vm-media/state-1/mic.fifo'"));
  assert.ok(command.includes('pactl unload-module'));
  assert.match(command, /; true$/);

  const moduleOnly = buildPulseMicStopCommand({ sourceName: 'apkvm_mic_state-1' });
  assert.equal(moduleOnly.includes('kill '), false);
  assert.ok(moduleOnly.includes('pactl unload-module'));
  assert.match(moduleOnly, /; true$/);

  assert.throws(
    () => buildPulseMicStopCommand({ sourceName: 'mic_a', pidFile: '/tmp/a.pid', fifoPath: '/tmp/a.pid' }),
    /must differ/,
  );
});

test('buildPulseMicStatusCommand: reports source line, pid state and FIFO', () => {
  const command = buildPulseMicStatusCommand({
    sourceName: 'apkvm_mic_state-1',
    pidFile: '/tmp/apk-vm-media/state-1/mic.pid',
    fifoPath: '/tmp/apk-vm-media/state-1/mic.fifo',
  });
  assert.ok(command.includes("printf 'source: '; pactl list short sources"));
  assert.ok(command.includes("grep -F 'apkvm_mic_state-1'"));
  assert.ok(command.includes("printf 'pidfile: '"));
  assert.ok(command.includes('kill -0 "$(cat '));
  assert.ok(command.includes("printf 'fifo: '; if [ -p "));
  assert.match(command, /; true$/);

  const sourceOnly = buildPulseMicStatusCommand({ sourceName: 'apkvm_mic_state-1' });
  assert.equal(sourceOnly.includes('pidfile'), false);
  assert.equal(sourceOnly.includes('fifo'), false);
  assert.ok(sourceOnly.includes('pactl list short sources'));
});

// ---------------------------------------------------------------------------
// Remote path convention
// ---------------------------------------------------------------------------

test('sanitizeMediaSlug/remoteMediaDir: stable, shell-safe remote paths', () => {
  const slug = sanitizeMediaSlug('C:\\state\\vm one');
  assert.match(slug, /^[A-Za-z0-9._-]+$/);
  assert.ok(slug.length <= 49, `slug length ${slug.length}`);
  assert.equal(sanitizeMediaSlug('C:\\state\\vm one'), slug);
  assert.notEqual(sanitizeMediaSlug('C:\\state\\vm two'), slug);

  const dir = remoteMediaDir('/tmp/instance-a');
  assert.match(dir, /^\/tmp\/apk-vm-media\/[A-Za-z0-9._-]+$/);
  assert.equal(dir.startsWith(`${REMOTE_MEDIA_ROOT}/`), true);
  assert.equal(remoteMediaDir('/tmp/instance-a'), dir);
  assert.notEqual(remoteMediaDir('/tmp/instance-b'), dir);
  assert.equal(remoteMediaDir('').startsWith(`${REMOTE_MEDIA_ROOT}/`), true);
  assert.equal(sanitizeMediaSlug('session/实例 state'), sanitizeMediaSlug('session/实例 state'));
});

test('remotePosterPath/remoteAudioPath: upload targets', () => {
  const dir = remoteMediaDir('/tmp/instance-a');
  assert.equal(remotePosterPath('/tmp/instance-a', 'wall'), `${dir}/posters/wall.png`);
  assert.equal(remotePosterPath('/tmp/instance-a', 'wall', 'jpeg'), `${dir}/posters/wall.jpeg`);
  assert.equal(remotePosterPath('/tmp/instance-a', 'wall', 'JPG'), `${dir}/posters/wall.jpg`);
  assert.throws(() => remotePosterPath('/tmp/instance-a', 'a/b'), /poster name/);
  assert.throws(() => remotePosterPath('/tmp/instance-a', 'wall', 'gif'), /extension/);
  assert.throws(() => remotePosterPath('/tmp/instance-a', 'a'.repeat(33)), /poster name/);

  assert.equal(remoteAudioPath('/tmp/instance-a', 'voice.wav'), `${dir}/audio/voice.wav`);
  assert.equal(remoteAudioPath('/tmp/instance-a', 'loop.MP3'), `${dir}/audio/loop.MP3`);
  assert.throws(() => remoteAudioPath('/tmp/instance-a', 'notes.txt'), /\.wav/);
  assert.throws(() => remoteAudioPath('/tmp/instance-a', 'bad name.wav'), /must match/);
  assert.throws(() => remoteAudioPath('/tmp/instance-a', '../escape.wav'), /must match/);
});

test('remoteMediaPaths: one bundle for the SSH wiring', () => {
  const paths = remoteMediaPaths('/tmp/instance-a');
  assert.ok(paths.dir.startsWith(`${REMOTE_MEDIA_ROOT}/`));
  assert.equal(paths.postersDir, `${paths.dir}/posters`);
  assert.equal(paths.audioDir, `${paths.dir}/audio`);
  assert.equal(paths.fifoPath, `${paths.dir}/mic.fifo`);
  assert.equal(paths.pidFile, `${paths.dir}/mic.pid`);
  assert.equal(paths.logFile, `${paths.dir}/mic-ffmpeg.log`);
  assert.match(paths.micSourceName, /^apkvm_mic_[A-Za-z0-9._-]{1,49}$/);
  assert.equal(paths.micSourceName, micSourceName('/tmp/instance-a'));
  assert.deepEqual(remoteMediaPaths('/tmp/instance-a'), paths);

  // Paths from the bundle are accepted by the command builders end to end.
  const command = buildPulseMicStartCommand({
    sourceName: paths.micSourceName,
    fifoPath: paths.fifoPath,
    pidFile: paths.pidFile,
    audioFilePath: remoteAudioPath('/tmp/instance-a', 'voice.wav'),
  });
  assert.ok(command.includes('pactl load-module module-pipe-source'));
});

// ---------------------------------------------------------------------------
// lib/android.js: extraEmulatorArgs / enableAudio launch-plan integration
// ---------------------------------------------------------------------------

test('AndroidVm: default launch plan keeps -no-audio and current argv order', async () => {
  const vm = makeVm();
  const plan = await vm._buildLaunchPlan();
  assert.deepEqual(plan.args.slice(0, 5), ['-avd', 'dsh_apk', '-no-window', '-no-audio', '-no-boot-anim']);
  assert.equal(plan.fatal, undefined);
  assert.equal(countArg(plan.args, '-no-audio'), 1);
  assert.equal(plan.args.includes('-allow-host-audio'), false);
});

test('AndroidVm: enableAudio omits -no-audio but keeps the rest', async () => {
  const vm = makeVm({ enableAudio: true });
  const plan = await vm._buildLaunchPlan();
  assert.equal(plan.args.includes('-no-audio'), false);
  assert.deepEqual(plan.args.slice(0, 4), ['-avd', 'dsh_apk', '-no-window', '-no-boot-anim']);
  assert.ok(plan.args.includes('-no-metrics'));
});

test('AndroidVm: extraEmulatorArgs are appended after built-in args', async () => {
  const vm = makeVm({
    enableAudio: true,
    extraEmulatorArgs: ['-camera-back', 'virtualscene', '-virtualscene-poster', 'wall=/tmp/wall.png'],
  });
  const plan = await vm._buildLaunchPlan();
  assert.deepEqual(plan.args.slice(-4), [
    '-camera-back',
    'virtualscene',
    '-virtualscene-poster',
    'wall=/tmp/wall.png',
  ]);
});

test('AndroidVm: mediaLaunchOptions() wires straight into the launch plan', async () => {
  const media = mediaLaunchOptions({
    camera: {
      back: 'virtualscene',
      front: 'emulated',
      posters: [{ name: 'wall', path: '/tmp/apk-vm-media/state/posters/wall.png' }],
    },
    mic: { mode: 'file', filePath: '/tmp/apk-vm-media/state/audio/voice.wav', backend: 'pa' },
  });
  assert.equal(media.enableAudio, true);
  const vm = makeVm({ extraEmulatorArgs: media.extraEmulatorArgs, enableAudio: media.enableAudio });
  const plan = await vm._buildLaunchPlan();
  assert.equal(plan.args.includes('-no-audio'), false);
  assert.deepEqual(plan.args.slice(-9), [
    '-camera-back',
    'virtualscene',
    '-camera-front',
    'emulated',
    '-virtualscene-poster',
    'wall=/tmp/apk-vm-media/state/posters/wall.png',
    '-allow-host-audio',
    '-audio',
    'pa',
  ]);
});

test('AndroidVm: duplicate switches already present in argv are not re-appended', async () => {
  const vm = makeVm({
    emulatorArgs: ['-camera-back', 'emulated'],
    extraEmulatorArgs: ['-camera-back', 'virtualscene', '-camera-front', 'webcam0'],
  });
  const plan = await vm._buildLaunchPlan();
  assert.equal(countArg(plan.args, '-camera-back'), 1);
  assert.equal(plan.args[plan.args.indexOf('-camera-back') + 1], 'emulated');
  assert.equal(countArg(plan.args, '-camera-front'), 1);
  assert.equal(plan.args[plan.args.indexOf('-camera-front') + 1], 'webcam0');
});

test('AndroidVm: repeated switches inside extraEmulatorArgs are preserved', async () => {
  const vm = makeVm({
    extraEmulatorArgs: [
      '-virtualscene-poster',
      'a=/tmp/a.png',
      '-virtualscene-poster',
      'b=/tmp/b.png',
    ],
  });
  const plan = await vm._buildLaunchPlan();
  assert.equal(countArg(plan.args, '-virtualscene-poster'), 2);
  assert.equal(countArg(plan.args, 'a=/tmp/a.png'), 1);
  assert.equal(countArg(plan.args, 'b=/tmp/b.png'), 1);
});

test('AndroidVm: extraEmulatorArgs option validation and runtime mutation', async () => {
  const invalid = makeVm({ extraEmulatorArgs: 'not-an-array' });
  assert.deepEqual(invalid.extraEmulatorArgs, []);
  const dirty = makeVm({ extraEmulatorArgs: ['', '   ', '-camera-back', 'virtualscene'] });
  assert.deepEqual(dirty.extraEmulatorArgs, ['-camera-back', 'virtualscene']);

  dirty.extraEmulatorArgs.push('-camera-front', 'webcam0');
  const plan = await dirty._buildLaunchPlan();
  assert.deepEqual(plan.args.slice(-4), ['-camera-back', 'virtualscene', '-camera-front', 'webcam0']);
});

test('AndroidVm: status()/debugStatus() shapes are unaffected', async () => {
  const vm = makeVm({ enableAudio: true, extraEmulatorArgs: ['-camera-back', 'virtualscene'] });
  const debugKeys = Object.keys(vm.debugStatus()).sort();
  assert.deepEqual(debugKeys, ['adb', 'identity', 'prepared', 'root', 'toolkit']);

  const snapshot = vm._snapshot();
  assert.equal('extraEmulatorArgs' in snapshot, false);
  assert.equal('enableAudio' in snapshot, false);
  assert.equal(typeof snapshot.state, 'string');
});
