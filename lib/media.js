// lib/media.js
//
// Pure, dependency-free configuration/launch layer for the APK VM panel's
// virtual camera and virtual microphone controls.
//
// Design notes
// ------------
// * Everything here is data-in/data-out, so HTTP routes and the panel can
//   validate configuration without touching a device. Invalid input throws an
//   Error with an actionable message (same convention as
//   normalizeRemoteProfile() in lib/remote.js).
// * The emulator has no "file as camera" mode. Custom camera content is only
//   possible through the emulator's 3D virtual scene: a PNG/JPEG poster passed
//   as `-virtualscene-poster <name>=<file>` is rendered by the emulator itself,
//   works headless (Windows/Linux/macOS) and needs no host camera. Host webcams
//   (`webcamN`) require a real host camera or a virtual camera device such as
//   OBS Virtual Camera; they never work on a headless server.
// * Microphone input: `-allow-host-audio` lets the host's audio INPUT reach the
//   guest (otherwise the emulator zeroes input), and `-no-audio` must be
//   omitted for audio to work at all. For a "file microphone" on a Linux host,
//   PulseAudio `module-pipe-source` plus an ffmpeg loop exposes any
//   wav/mp3/ogg file as a microphone. The command builders below only RETURN
//   shell strings; they never execute anything.
//
// Typical local wiring (Lead-owned route code):
//   const media = mediaLaunchOptions({ camera, mic });
//   new AndroidVm({
//     ...opts,
//     extraEmulatorArgs: media.extraEmulatorArgs,
//     enableAudio: media.enableAudio,
//   });
//
// Typical remote wiring (Lead-owned SSH code):
//   const paths = remoteMediaPaths(stateDir);
//   // 1. upload the poster with scp to: remotePosterPath(stateDir, poster.name)
//   // 2. start a file microphone (Linux remote host, no sudo required):
//   const start = buildPulseMicStartCommand({
//     sourceName: paths.micSourceName,
//     fifoPath: paths.fifoPath,
//     pidFile: paths.pidFile,
//     audioFilePath: remoteAudioPath(stateDir, 'voice.wav'),
//     rate: 48000,
//     channels: 1,
//   });
//   // 3. run the remote emulator with media.extraEmulatorArgs / enableAudio.
//   // 4. stop with buildPulseMicStopCommand(...), inspect with
//   //    buildPulseMicStatusCommand(...).
//
// All remote helper paths live under /tmp/apk-vm-media/<sanitized stateDir> so
// they are stable across runs and never collide between VM instances.

import { promises as fsp } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Camera modes accepted by `-camera-back` / `-camera-front` (webcamN is extra). */
export const CAMERA_MODES = Object.freeze(['none', 'emulated', 'virtualscene']);
/** Highest supported host webcam index (emulator supports webcam0..webcam7). */
export const MAX_WEBCAM_INDEX = 7;
/** Maximum number of virtual-scene posters per camera configuration. */
export const MAX_POSTERS = 8;
/** Maximum accepted poster file size (the emulator decodes it at startup). */
export const MAX_POSTER_BYTES = 20 * 1024 * 1024;

/** Microphone modes: off (no input), host (host audio input), file (Linux loop). */
export const MIC_MODES = Object.freeze(['off', 'host', 'file']);
/** Emulator `-audio <backend>` values. Validated cross-platform on purpose:
 *  a panel running on Windows may configure a Linux emulator on a remote host. */
export const MIC_AUDIO_BACKENDS = Object.freeze(['none', 'pa', 'alsa', 'sdl', 'winmm', 'dsound']);
/** Sample rates a virtual microphone can be declared with. */
export const MIC_RATES = Object.freeze([8000, 16000, 44100, 48000]);
/** Remote media root (Linux host; the Lead uploads files there over SSH). */
export const REMOTE_MEDIA_ROOT = '/tmp/apk-vm-media';

const POSTER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const WEBCAM_MODE_RE = /^webcam([0-7])$/;
const PULSE_SOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AUDIO_FILE_EXT_RE = /\.(wav|mp3|ogg)$/i;
const MAX_PATH_LENGTH = 1000;
const MAX_FILE_NAME_LENGTH = 128;

// ---------------------------------------------------------------------------
// Small shared validation helpers
// ---------------------------------------------------------------------------

function asPlainObject(value, label) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonish(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}

function assertFilePathValue(value, label) {
  const text = trimmedString(value);
  if (!text) throw new Error(`${label} is required`);
  if (text.length > MAX_PATH_LENGTH) throw new Error(`${label} is longer than ${MAX_PATH_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function assertPosterFilePath(value, label) {
  const text = assertFilePathValue(value, label);
  // `-virtualscene-poster` uses `name=file`; an unbracketed `=` in the path is
  // ambiguous for the emulator's own parser, so reject it early.
  if (text.includes('=')) throw new Error(`${label} must not contain "=" (part of the -virtualscene-poster name=file syntax)`);
  return text;
}

function assertPosterName(value, label = 'poster name') {
  const text = trimmedString(value);
  if (!text) throw new Error(`${label} is required`);
  if (!POSTER_NAME_RE.test(text)) throw new Error(`${label} must match [A-Za-z0-9_-]{1,32}`);
  return text;
}

function assertAbsolutePosixPath(value, label) {
  const text = assertFilePathValue(value, label);
  if (!text.startsWith('/')) {
    throw new Error(`${label} must be an absolute POSIX path on the remote Linux host`);
  }
  return text;
}

function optionalAbsolutePosixPath(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return assertAbsolutePosixPath(value, label);
}

function posixDirname(filePath) {
  const index = filePath.lastIndexOf('/');
  if (index <= 0) return '/';
  return filePath.slice(0, index);
}

function assertPulseSourceName(value) {
  const text = trimmedString(value);
  if (!text) throw new Error('mic sourceName is required');
  if (!PULSE_SOURCE_NAME_RE.test(text)) {
    throw new Error('mic sourceName must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}');
  }
  return text;
}

function normalizeMicRate(value) {
  const number = typeof value === 'number' ? value : Number(trimmedString(value));
  if (!MIC_RATES.includes(number)) {
    throw new Error(`mic.rate must be one of ${MIC_RATES.join(', ')} (got ${jsonish(value)})`);
  }
  return number;
}

function normalizeMicChannels(value) {
  const number = typeof value === 'number' ? value : Number(trimmedString(value));
  if (!Number.isInteger(number) || number < 1 || number > 2) {
    throw new Error(`mic.channels must be 1 or 2 (got ${jsonish(value)})`);
  }
  return number;
}

function normalizePlatform(value) {
  const text = trimmedString(value).toLowerCase();
  return text || process.platform;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function assertDistinctPaths(entries) {
  const seen = new Map();
  for (const [label, value] of entries) {
    if (!value) continue;
    if (seen.has(value)) throw new Error(`${label} must differ from ${seen.get(value)}`);
    seen.set(value, label);
  }
}

// ---------------------------------------------------------------------------
// Camera configuration
// ---------------------------------------------------------------------------

function normalizeCameraMode(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (CAMERA_MODES.includes(text)) return text;
  if (WEBCAM_MODE_RE.test(text)) return text;
  throw new Error(
    `${label} must be one of none, emulated, virtualscene, webcam0..webcam7 (got ${jsonish(text)})`,
  );
}

/**
 * Normalize/validate a camera configuration (throws on invalid input).
 *
 * Input shape: `{ back?, front?, posters? }` where posters are
 * `{ name, path }` entries. Missing/empty back/front mean "leave the emulator
 * default in place" (no flag is emitted). The returned object is idempotent:
 * passing it back in yields the same result.
 *
 * @returns {{back: string|null, front: string|null, posters: {name: string, path: string}[]}}
 */
export function normalizeCameraConfig(input = {}) {
  const source = asPlainObject(input, 'camera config');
  const posters = source.posters === undefined || source.posters === null ? [] : source.posters;
  if (!Array.isArray(posters)) throw new Error('camera.posters must be an array');
  if (posters.length > MAX_POSTERS) throw new Error(`camera.posters supports at most ${MAX_POSTERS} entries`);

  const camera = {
    back: normalizeCameraMode(source.back, 'camera.back'),
    front: normalizeCameraMode(source.front, 'camera.front'),
    posters: [],
  };
  const seenNames = new Set();
  for (let index = 0; index < posters.length; index += 1) {
    const entry = posters[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`camera.posters[${index}] must be an object with {name, path}`);
    }
    const name = assertPosterName(entry.name, `camera.posters[${index}].name`);
    const key = name.toLowerCase();
    if (seenNames.has(key)) throw new Error(`duplicate poster name: ${jsonish(name)}`);
    seenNames.add(key);
    camera.posters.push({
      name,
      path: assertPosterFilePath(entry.path, `camera.posters[${index}].path`),
    });
  }
  return camera;
}

// ---------------------------------------------------------------------------
// Poster file validation
// ---------------------------------------------------------------------------

/**
 * Sniff an image format from its leading bytes.
 * @param {Buffer|Uint8Array} bytes
 * @returns {'png'|'jpeg'|null}
 */
export function sniffImageFormat(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4) return null;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= pngSignature.length && pngSignature.every((byte, index) => bytes[index] === byte)) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/**
 * Validate a *local* poster file that is about to be uploaded to a remote host
 * (or used by a local emulator): exists, is a regular file, size is sane, and
 * the leading bytes are a PNG or JPEG signature.
 *
 * Filesystem and format problems are returned as `{ok:false, reason}`; only a
 * structurally invalid path argument throws. `options.stat` / `options.readFile`
 * can be injected for tests.
 *
 * @returns {Promise<{ok: true, path: string, format: 'png'|'jpeg', size: number}
 *   | {ok: false, path: string, reason: string, size?: number}>}
 */
export async function checkPosterFile(filePath, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const target = assertFilePathValue(filePath, 'poster path');
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_POSTER_BYTES;
  const stat = typeof opts.stat === 'function' ? opts.stat : fsp.stat;
  const readFile = typeof opts.readFile === 'function' ? opts.readFile : fsp.readFile;

  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    return { ok: false, path: target, reason: `poster file is not readable (${(error && error.code) || 'error'})` };
  }
  if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
    return { ok: false, path: target, reason: 'poster path is not a regular file' };
  }
  if (!Number.isFinite(stats.size) || stats.size <= 0) {
    return { ok: false, path: target, reason: 'poster file is empty' };
  }
  if (stats.size > maxBytes) {
    return { ok: false, path: target, size: stats.size, reason: `poster file is larger than ${maxBytes} bytes` };
  }
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    return { ok: false, path: target, reason: `poster file is not readable (${(error && error.code) || 'error'})` };
  }
  const format = sniffImageFormat(bytes);
  if (!format) {
    return { ok: false, path: target, size: stats.size, reason: 'not a PNG or JPEG image (magic bytes mismatch)' };
  }
  return { ok: true, path: target, format, size: stats.size };
}

// ---------------------------------------------------------------------------
// Microphone configuration
// ---------------------------------------------------------------------------

/**
 * Normalize/validate a microphone configuration (throws on invalid input).
 *
 * Input shape: `{mode: 'off'|'host'|'file', filePath?, backend?, channels?, rate?}`.
 * Defaults: mode 'off', channels 1, rate 48000, backend unset (emulator's
 * platform default). `filePath` is required in file mode and rejected in every
 * other mode (a stale path is a configuration bug, not something to silently
 * ignore).
 *
 * @returns {{mode: 'off'|'host'|'file', filePath: string|undefined,
 *   backend: string|undefined, channels: number, rate: number}}
 */
export function normalizeMicConfig(input = {}) {
  const source = asPlainObject(input, 'mic config');
  const rawMode = trimmedString(source.mode).toLowerCase();
  const mode = rawMode || 'off';
  if (!MIC_MODES.includes(mode)) {
    throw new Error(`mic.mode must be one of ${MIC_MODES.join(', ')} (got ${jsonish(mode)})`);
  }

  const channels = normalizeMicChannels(source.channels === undefined ? 1 : source.channels);
  const rate = normalizeMicRate(source.rate === undefined ? 48000 : source.rate);

  let backend;
  if (source.backend !== undefined && source.backend !== null && source.backend !== '') {
    const text = trimmedString(source.backend).toLowerCase();
    if (!MIC_AUDIO_BACKENDS.includes(text)) {
      throw new Error(`mic.backend must be one of ${MIC_AUDIO_BACKENDS.join(', ')} (got ${jsonish(text)})`);
    }
    backend = text;
  }

  let filePath;
  if (mode === 'file') {
    if (source.filePath === undefined || source.filePath === null || trimmedString(source.filePath) === '') {
      throw new Error('mic.filePath is required when mic.mode is "file"');
    }
    filePath = assertFilePathValue(source.filePath, 'mic.filePath');
    if (!AUDIO_FILE_EXT_RE.test(filePath)) {
      throw new Error('mic.filePath must be a .wav, .mp3 or .ogg file');
    }
  } else if (source.filePath !== undefined && source.filePath !== null && trimmedString(source.filePath) !== '') {
    throw new Error(`mic.filePath is only valid when mic.mode is "file" (mode is ${jsonish(mode)})`);
  }

  return { mode, filePath, backend, channels, rate };
}

// ---------------------------------------------------------------------------
// Emulator argv + launch options
// ---------------------------------------------------------------------------

function normalizeMediaConfigInput(config) {
  if (config === undefined || config === null || config === '') return { camera: null, mic: null };
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('media config must be an object with optional {camera, mic}');
  }
  return {
    camera: config.camera === undefined || config.camera === null || config.camera === '' ? null : normalizeCameraConfig(config.camera),
    mic: config.mic === undefined || config.mic === null || config.mic === '' ? null : normalizeMicConfig(config.mic),
  };
}

function mediaArgsFromNormalized({ camera, mic }) {
  const args = [];
  if (camera) {
    if (camera.back) args.push('-camera-back', camera.back);
    if (camera.front) args.push('-camera-front', camera.front);
    for (const poster of camera.posters) {
      args.push('-virtualscene-poster', `${poster.name}=${poster.path}`);
    }
  }
  if (mic && mic.mode !== 'off') {
    // Required for host audio INPUT; without it the guest receives zeros.
    args.push('-allow-host-audio');
    if (mic.backend) args.push('-audio', mic.backend);
  }
  return args;
}

/**
 * Compose the extra emulator argv for the configured virtual camera / mic.
 *
 * Deterministic order: `-camera-back`, `-camera-front`, one
 * `-virtualscene-poster <name>=<path>` per poster, then mic flags
 * (`-allow-host-audio` and, when configured, `-audio <backend>`).
 *
 * `-no-audio` is deliberately NOT emitted here: the launcher decides that via
 * `enableAudio` (see mediaLaunchOptions()).
 *
 * @param {{camera?: object|string|null, mic?: object|string|null}} config raw or
 *   already-normalized config; `{}`/null yields `[]`.
 * @returns {string[]}
 */
export function buildEmulatorMediaArgs(config = {}) {
  return mediaArgsFromNormalized(normalizeMediaConfigInput(config));
}

/**
 * One-call helper for the launcher: returns both the extra argv for the
 * emulator and whether audio must be enabled (`-no-audio` omitted).
 *
 * `enableAudio` is true exactly when a microphone is configured
 * (mic.mode !== 'off'), matching the Lead's integration contract.
 *
 * @param {{camera?: object, mic?: object}} config
 * @returns {{extraEmulatorArgs: string[], enableAudio: boolean}}
 */
export function mediaLaunchOptions(config = {}) {
  const normalized = normalizeMediaConfigInput(config);
  return {
    extraEmulatorArgs: mediaArgsFromNormalized(normalized),
    enableAudio: Boolean(normalized.mic && normalized.mic.mode !== 'off'),
  };
}

// ---------------------------------------------------------------------------
// Capability reporting (pure parsers; no device probing here)
// ---------------------------------------------------------------------------

/**
 * Parse `emulator -webcam-list` output.
 *
 * Accepted shapes (the emulator has used both over the years):
 *   List of web cameras connected to the computer:
 *   Camera `webcam0` is connected to device `AndroidEmulatorVC0` on channel 0 using pixel format `BGR4`
 *   Camera `Integrated Camera` is connected to device `webcam0` on channel 1 using pixel format `MJPEG`
 *
 * @param {string} text
 * @returns {{index: number, name: string}[]} sorted by index
 */
export function parseWebcamList(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const cameras = new Map();
  const pattern = /camera\s+(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s]+))\s+is\s+connected\s+to\s+device\s+(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s]+))/i;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    const cameraLabel = (match[1] || match[2] || match[3] || match[4] || '').trim();
    const device = (match[5] || match[6] || match[7] || match[8] || '').trim();
    const deviceIndex = /^webcam(\d+)$/i.exec(device);
    const labelIndex = /webcam(\d+)/i.exec(cameraLabel);
    const rawIndex = deviceIndex ? deviceIndex[1] : labelIndex ? labelIndex[1] : null;
    if (rawIndex === null) continue;
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index > MAX_WEBCAM_INDEX || cameras.has(index)) continue;
    cameras.set(index, { index, name: cameraLabel || `webcam${index}` });
  }
  return [...cameras.values()].sort((left, right) => left.index - right.index);
}

/**
 * Describe camera capabilities for a target platform.
 *
 * `virtualscene` works headless and is the recommended custom-content path;
 * `webcamN` entries are added only when `emulator -webcam-list` reported them.
 *
 * @param {{platform?: string, webcamListText?: string}} input
 * @returns {{platform: string, webcams: {index: number, name: string}[],
 *   modes: string[], note: string}}
 */
export function cameraCapabilities(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const platform = normalizePlatform(opts.platform);
  const webcams = parseWebcamList(opts.webcamListText);
  const modes = [...CAMERA_MODES, ...webcams.map((camera) => `webcam${camera.index}`)];
  const notes = [
    'Virtual-scene posters (-virtualscene-poster) are rendered by the emulator itself, so they work headless and need no host camera.',
    'webcamN modes require a real host camera, or a virtual camera device (for example OBS Virtual Camera) that the emulator can see.',
  ];
  notes.push(
    webcams.length
      ? `${webcams.length} host camera(s) detected via emulator -webcam-list.`
      : 'No host cameras were reported by emulator -webcam-list; use virtualscene posters for custom camera content.',
  );
  return { platform, webcams, modes, note: notes.join(' ') };
}

function micBackendChoices(platform) {
  switch (platform) {
    case 'win32':
      return ['none', 'sdl', 'winmm', 'dsound'];
    case 'linux':
      return ['none', 'pa', 'alsa', 'sdl'];
    case 'darwin':
      return ['none', 'sdl'];
    default:
      return ['none', 'sdl'];
  }
}

/**
 * Describe microphone capabilities for a target platform.
 *
 * @param {{platform?: string, remote?: boolean}} input `remote:true` means the
 *   emulator runs on a remote Linux host reached over SSH.
 * @returns {{platform: string, hostPassthrough: true, fileLoop: boolean,
 *   backendChoices: string[], note: string}}
 */
export function micCapabilities(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const platform = normalizePlatform(opts.platform);
  const remote = opts.remote === true;
  const fileLoop = platform === 'linux' || remote;
  const notes = [
    'Host audio input requires -allow-host-audio plus a microphone on the machine that runs the emulator; otherwise audio input is zeroed.',
    '-no-audio must be omitted for any audio input (pass the enableAudio launch option).',
  ];
  notes.push(
    fileLoop
      ? 'File-loop microphones need a Linux host with PulseAudio (pactl) and ffmpeg; module-pipe-source needs no sudo and is created with buildPulseMicStartCommand().'
      : 'File-loop microphones are only supported on a Linux host (including a remote Linux host over SSH); use mode "host" on this platform.',
  );
  return {
    platform,
    hostPassthrough: true,
    fileLoop,
    backendChoices: micBackendChoices(platform),
    note: notes.join(' '),
  };
}

// ---------------------------------------------------------------------------
// POSIX shell quoting + PulseAudio virtual microphone commands
// ---------------------------------------------------------------------------

/**
 * Quote one argument for a POSIX `sh` command line using single quotes.
 * Embedded single quotes become `'\''`, so no input can break out of the
 * quoted string. Control characters are rejected.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function quotePosix(value, label = 'command argument') {
  const text = value === undefined || value === null ? '' : String(value);
  if (!text) throw new Error(`${label} is empty`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} contains control characters`);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Build the `pactl ... | grep -F ... | cut -f1` lookup shared by the builders. */
function unloadBySourceExpr(sourceName) {
  const rawSourceArg = `source_name=${sourceName}`;
  return (
    `_apkvm_idx=$(pactl list short modules 2>/dev/null | grep -F ${quotePosix(rawSourceArg)} | cut -f1 | head -n 1); ` +
    'if [ -n "$_apkvm_idx" ]; then pactl unload-module "$_apkvm_idx" >/dev/null 2>&1 || true; fi'
  );
}

/**
 * Build the shell command that starts a *file-backed* PulseAudio microphone:
 *
 *  1. mkdir -p the FIFO/pid/log directories (best effort),
 *  2. clean up a previous instance (kill pid, unload old pipe-source),
 *  3. `mkfifo`, then loop the audio file through ffmpeg into the FIFO as raw
 *     s16le at the configured rate/channels (PID recorded in the pid file),
 *  4. wait briefly, then `pactl load-module module-pipe-source` pointing at the
 *     FIFO so the guest sees a microphone.
 *
 * The command is a single line and never executed here; run it over SSH on the
 * Linux host (see lib/remote.js runSshCommand). Requires ffmpeg + pactl on the
 * remote host. No sudo is needed for module-pipe-source.
 *
 * @param {{sourceName: string, fifoPath: string, pidFile: string,
 *   audioFilePath: string, rate?: number, channels?: number, logFile?: string}} options
 * @returns {string}
 */
export function buildPulseMicStartCommand(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sourceName = assertPulseSourceName(opts.sourceName);
  const fifoPath = assertAbsolutePosixPath(opts.fifoPath, 'mic FIFO path');
  const pidFile = assertAbsolutePosixPath(opts.pidFile, 'mic pid file path');
  const audioFilePath = assertAbsolutePosixPath(opts.audioFilePath, 'mic audio file path');
  const rate = opts.rate === undefined ? 48000 : normalizeMicRate(opts.rate);
  const channels = opts.channels === undefined ? 1 : normalizeMicChannels(opts.channels);
  const logFile =
    opts.logFile === undefined || opts.logFile === ''
      ? `${fifoPath}.ffmpeg.log`
      : assertAbsolutePosixPath(opts.logFile, 'mic ffmpeg log path');
  assertDistinctPaths([
    ['mic FIFO path', fifoPath],
    ['mic pid file path', pidFile],
    ['mic audio file path', audioFilePath],
    ['mic ffmpeg log path', logFile],
  ]);

  const quotedFifo = quotePosix(fifoPath);
  const quotedPid = quotePosix(pidFile);
  const quotedAudio = quotePosix(audioFilePath);
  const quotedLog = quotePosix(logFile);
  const directories = uniqueStrings([posixDirname(fifoPath), posixDirname(pidFile), posixDirname(logFile)]);

  const statements = [
    'set -u',
    `mkdir -p -- ${directories.map((directory) => quotePosix(directory)).join(' ')}`,
    `if [ -f ${quotedPid} ]; then kill "$(cat ${quotedPid})" 2>/dev/null || true; rm -f ${quotedPid}; fi`,
    unloadBySourceExpr(sourceName),
    `rm -f ${quotedFifo}`,
    `mkfifo ${quotedFifo} || exit 1`,
    `chmod 600 ${quotedFifo} || true`,
    `ffmpeg -nostdin -hide_banner -loglevel error -re -stream_loop -1 -i ${quotedAudio}` +
      ` -f s16le -ar ${rate} -ac ${channels} - > ${quotedFifo} 2> ${quotedLog} & echo $! > ${quotedPid}`,
    'sleep 1',
    `pactl load-module module-pipe-source ${quotePosix(`source_name=${sourceName}`)}` +
      ` ${quotePosix(`file=${fifoPath}`)} ${quotePosix('format=s16le')}` +
      ` ${quotePosix(`rate=${rate}`)} ${quotePosix(`channels=${channels}`)}`,
  ];
  return statements.join('; ');
}

/**
 * Build the shell command that stops a file-backed PulseAudio microphone:
 * kills the ffmpeg loop (TERM then KILL), removes the pid file and FIFO, and
 * unloads the matching module-pipe-source by module index (best effort).
 *
 * `pidFile` / `fifoPath` are optional — when omitted, only the PulseAudio
 * module is unloaded by source name.
 *
 * @param {{sourceName: string, pidFile?: string, fifoPath?: string}} options
 * @returns {string}
 */
export function buildPulseMicStopCommand(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sourceName = assertPulseSourceName(opts.sourceName);
  const pidFile = optionalAbsolutePosixPath(opts.pidFile, 'mic pid file path');
  const fifoPath = optionalAbsolutePosixPath(opts.fifoPath, 'mic FIFO path');
  assertDistinctPaths([
    ['mic pid file path', pidFile],
    ['mic FIFO path', fifoPath],
  ]);

  const statements = ['set -u'];
  if (pidFile) {
    const quotedPid = quotePosix(pidFile);
    statements.push(
      `if [ -f ${quotedPid} ]; then kill "$(cat ${quotedPid})" 2>/dev/null || true; sleep 1;` +
        ` kill -9 "$(cat ${quotedPid})" 2>/dev/null || true; rm -f ${quotedPid}; fi`,
    );
  }
  if (fifoPath) statements.push(`rm -f ${quotePosix(fifoPath)}`);
  statements.push(unloadBySourceExpr(sourceName));
  statements.push('true');
  return statements.join('; ');
}

/**
 * Build the shell command that reports virtual-microphone status: matching
 * `pactl list short sources` line, ffmpeg pid state and FIFO presence.
 *
 * @param {{sourceName: string, pidFile?: string, fifoPath?: string}} options
 * @returns {string}
 */
export function buildPulseMicStatusCommand(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sourceName = assertPulseSourceName(opts.sourceName);
  const pidFile = optionalAbsolutePosixPath(opts.pidFile, 'mic pid file path');
  const fifoPath = optionalAbsolutePosixPath(opts.fifoPath, 'mic FIFO path');

  const statements = [
    'set -u',
    `printf 'source: '; pactl list short sources 2>/dev/null | grep -F ${quotePosix(sourceName)} || echo '(not found)'`,
  ];
  if (pidFile) {
    const quotedPid = quotePosix(pidFile);
    statements.push(
      `printf 'pidfile: '; if [ -f ${quotedPid} ]; then cat ${quotedPid};` +
        ` kill -0 "$(cat ${quotedPid})" 2>/dev/null && echo ' (running)' || echo ' (stale)';` +
        ` else echo '(missing)'; fi`,
    );
  }
  if (fifoPath) {
    const quotedFifo = quotePosix(fifoPath);
    statements.push(`printf 'fifo: '; if [ -p ${quotedFifo} ]; then echo '(present)'; else echo '(missing)'; fi`);
  }
  statements.push('true');
  return statements.join('; ');
}

// ---------------------------------------------------------------------------
// Remote media path convention
// ---------------------------------------------------------------------------

function fnv1aHex(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Turn an arbitrary local state directory into a stable, shell-safe slug used
 * in remote media paths. Deterministic: the same stateDir always maps to the
 * same slug (the short hash suffix keeps distinct directories distinct even
 * after sanitization).
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function sanitizeMediaSlug(stateDir) {
  const raw = String(stateDir === undefined || stateDir === null ? '' : stateDir).trim();
  let base = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_ .-]+/, '')
    .replace(/[_ .-]+$/, '')
    .slice(0, 40)
    .replace(/^[_ .-]+/, '')
    .replace(/[_ .-]+$/, '');
  if (!base) base = 'state';
  return `${base}-${fnv1aHex(raw || base)}`;
}

/**
 * Remote directory for one VM's media files:
 * `/tmp/apk-vm-media/<sanitized stateDir>`.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function remoteMediaDir(stateDir) {
  return `${REMOTE_MEDIA_ROOT}/${sanitizeMediaSlug(stateDir)}`;
}

/**
 * Remote path where the Lead should upload a virtual-scene poster. The poster
 * file name must follow the poster-name rules; `extension` is png/jpg/jpeg.
 *
 * Example: scp ./wall.png <host>:`remotePosterPath(stateDir, 'wall')`, then pass
 * `{name: 'wall', path: remotePosterPath(stateDir, 'wall')}` to the emulator.
 *
 * @param {string} stateDir
 * @param {string} posterName
 * @param {'png'|'jpg'|'jpeg'} [extension]
 * @returns {string}
 */
export function remotePosterPath(stateDir, posterName, extension = 'png') {
  const name = assertPosterName(posterName);
  const ext = trimmedString(extension).toLowerCase() || 'png';
  if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg') {
    throw new Error(`poster extension must be png, jpg or jpeg (got ${jsonish(ext)})`);
  }
  return `${remoteMediaDir(stateDir)}/posters/${name}.${ext}`;
}

/**
 * Remote path where the Lead should upload an audio file used by a file-loop
 * microphone. Only wav/mp3/ogg are accepted by normalizeMicConfig().
 *
 * @param {string} stateDir
 * @param {string} fileName
 * @returns {string}
 */
export function remoteAudioPath(stateDir, fileName) {
  const name = trimmedString(fileName);
  if (!name) throw new Error('audio file name is required');
  if (name.length > MAX_FILE_NAME_LENGTH) throw new Error(`audio file name is longer than ${MAX_FILE_NAME_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('audio file name contains control characters');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !AUDIO_FILE_EXT_RE.test(name)) {
    throw new Error('audio file name must match [A-Za-z0-9._-]+ and end in .wav, .mp3 or .ogg');
  }
  return `${remoteMediaDir(stateDir)}/audio/${name}`;
}

/**
 * PulseAudio source name derived from the VM state directory. The name is
 * stable per VM, matches PulseAudio's source-name rules, and is used to find
 * and unload the module later.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function micSourceName(stateDir) {
  return `apkvm_mic_${sanitizeMediaSlug(stateDir)}`;
}

/**
 * Convenience bundle of the remote media paths for one VM. The Lead can use
 * these directly with the command builders and scp uploads.
 *
 * @param {string} stateDir
 * @returns {{stateDir: string, dir: string, postersDir: string,
 *   audioDir: string, micSourceName: string, fifoPath: string,
 *   pidFile: string, logFile: string}}
 */
export function remoteMediaPaths(stateDir) {
  const dir = remoteMediaDir(stateDir);
  return {
    stateDir: String(stateDir === undefined || stateDir === null ? '' : stateDir),
    dir,
    postersDir: `${dir}/posters`,
    audioDir: `${dir}/audio`,
    micSourceName: micSourceName(stateDir),
    fifoPath: `${dir}/mic.fifo`,
    pidFile: `${dir}/mic.pid`,
    logFile: `${dir}/mic-ffmpeg.log`,
  };
}
