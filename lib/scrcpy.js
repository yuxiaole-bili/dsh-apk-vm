/**
 * lib/scrcpy.js — headless scrcpy v5.0.1 relay for the APK VM preview plugin.
 *
 * Talks directly to the official open-source `scrcpy-server.jar` (Genymobile/scrcpy,
 * Apache-2.0) running on an Android device. No scrcpy desktop client, no SDL, no FFmpeg,
 * no npm dependencies: only Node built-ins (`node:net`, `node:child_process`, `node:fs`).
 *
 * Protocol reference (byte-level tables, read from the real v5.0.1 sources):
 *   spike/scrcpy/PROTOCOL.md
 *   vendored sources: spike/scrcpy/src/scrcpy-5.0.1/{app,server}
 *
 * What it does
 *   - pushes scrcpy-server.jar to /data/local/tmp/ and starts it with app_process
 *   - creates an adb forward tunnel (or reverse, by option), connects video + control sockets
 *   - validates the handshake (dummy byte, 64-byte device name)
 *   - parses the video stream: codec id, 12-byte session packets, 12-byte frame headers,
 *     Annex-B access units with PTS / keyframe / config flags
 *   - extracts SPS/PPS from codec-config packets and builds WebCodecs metadata:
 *     `avcC` (AVCDecoderConfigurationRecord) and codec string (`avc1.PPCCLL`)
 *   - serializes scrcpy control messages: touch (v5 32-byte layout), keycode, text, scroll,
 *     back-or-screen-on, display power, and arbitrary control messages
 *   - parses device → host messages (clipboard / clipboard ack / uhid output)
 *   - cleans everything up (sockets, child process, adb tunnel) in stop()
 *
 * Usage:
 *   import { ScrcpySession } from './scrcpy.js';
 *
 *   const session = new ScrcpySession({
 *     adbPath: 'D:/Android/sdk/platform-tools/adb.exe',
 *     serial: 'emulator-5558',
 *     serverJarPath: 'D:/滚木/apk-vm-preview/spike/scrcpy/vendor/scrcpy-server-v5.0.1.jar',
 *     maxSize: 720,
 *     videoBitRate: 4_000_000,
 *   });
 *   session.onInit(({ codec, width, height }) => { ... });
 *   session.onVideo(({ isConfig, isKeyFrame, pts, data, recvTimeMs }) => { ... });
 *   session.onConfig(({ avcC, codecString }) => {
 *     // VideoDecoder.configure({ codec: codecString, description: avcC, ... })
 *   });
 *   session.onError((err) => { ... });
 *   await session.start();
 *
 *   await session.sendTouch({ action: 'down', x: 100, y: 200 });
 *   await session.sendTouch({ action: 'up', x: 100, y: 200 });
 *   await session.stop();
 *
 * Testing hooks (optional, used by spike/scrcpy/test-fake-device.js):
 *   - `spawn`: replacement for child_process.spawn
 *   - `runAdb`: replacement for the adb command runner
 * These are never needed in production.
 */

import net from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Constants from scrcpy-server v5.0.1 (see PROTOCOL.md §2, §4, §5)
// ---------------------------------------------------------------------------

/** Version string that must match the server's BuildConfig.VERSION_NAME exactly. */
export const SCRCPY_VERSION = '5.0.1';

export const SCRCPY_SERVER_CLASS = 'com.genymobile.scrcpy.Server';
export const DEFAULT_DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

/** 4-byte ASCII codec ids (`Streamer.writeVideoHeader`, `VideoCodec.java`). */
export const CODEC_ID = Object.freeze({
  H264: 0x68323634, // "h264"
  H265: 0x68323635, // "h265"
  AV1: 0x00617631, // "av1"
  VP8: 0x00767038, // "vp8"
  VP9: 0x00767039, // "vp9"
  OPUS: 0x6f707573, // "opus"
  AAC: 0x00616163, // "aac"
  FLAC: 0x666c6163, // "flac"
  RAW: 0x00726177, // "raw"
});

const CODEC_NAMES = Object.freeze({
  [CODEC_ID.H264]: 'h264',
  [CODEC_ID.H265]: 'h265',
  [CODEC_ID.AV1]: 'av1',
  [CODEC_ID.VP8]: 'vp8',
  [CODEC_ID.VP9]: 'vp9',
});

/** Frame-header flags, as BigInt over the u64 `pts_and_flags` field (PROTOCOL.md §4.3). */
export const FRAME_FLAG_CONFIG = 1n << 62n;
export const FRAME_FLAG_KEY_FRAME = 1n << 61n;
export const FRAME_PTS_MASK = (1n << 61n) - 1n;
/** Session-packet flag = bit 31 of the first u32 (bit 63 of the u64 view). */
export const SESSION_FLAG = 0x80000000;

/** Control message types client → device (`ControlMessage.java`, PROTOCOL.md §5.1). */
export const CONTROL_MESSAGE_TYPE = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
});

const EMPTY_CONTROL_MESSAGES = new Set([
  CONTROL_MESSAGE_TYPE.EXPAND_NOTIFICATION_PANEL,
  CONTROL_MESSAGE_TYPE.EXPAND_SETTINGS_PANEL,
  CONTROL_MESSAGE_TYPE.COLLAPSE_PANELS,
  CONTROL_MESSAGE_TYPE.ROTATE_DEVICE,
  CONTROL_MESSAGE_TYPE.OPEN_HARD_KEYBOARD_SETTINGS,
  CONTROL_MESSAGE_TYPE.RESET_VIDEO,
  CONTROL_MESSAGE_TYPE.CAMERA_ZOOM_IN,
  CONTROL_MESSAGE_TYPE.CAMERA_ZOOM_OUT,
]);

/** MotionEvent actions (`android/input.h`). */
export const MOTION_ACTION = Object.freeze({
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  OUTSIDE: 4,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
  HOVER_MOVE: 7,
  SCROLL: 8,
  HOVER_ENTER: 9,
  HOVER_EXIT: 10,
  BUTTON_PRESS: 11,
  BUTTON_RELEASE: 12,
});

/** KeyEvent actions (`android/input.h`). */
export const KEY_ACTION = Object.freeze({ DOWN: 0, UP: 1, MULTIPLE: 2 });

/**
 * Well-known pointer ids (`control_msg.h`): mouse = -1, generic finger = -2,
 * virtual finger = -3, encoded as two's-complement u64 on the wire.
 */
export const POINTER_ID = Object.freeze({
  MOUSE: -1n,
  GENERIC_FINGER: -2n,
  VIRTUAL_FINGER: -3n,
});

/** Common Android keycodes (`android.view.KeyEvent`) for the plugin UI. */
export const KEYCODES = Object.freeze({
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  MOVE_HOME: 122,
  MOVE_END: 123,
  MEDIA_PLAY_PAUSE: 85,
  TAB: 61,
  SPACE: 62,
  APP_SWITCH: 187,
  WAKEUP: 224,
  SLEEP: 223,
});

const TEXT_MAX_BYTES = 300; // ControlMessageReader.INJECT_TEXT_MAX_LENGTH

const MOTION_ACTION_NAMES = {
  down: MOTION_ACTION.DOWN,
  up: MOTION_ACTION.UP,
  move: MOTION_ACTION.MOVE,
  cancel: MOTION_ACTION.CANCEL,
  outside: MOTION_ACTION.OUTSIDE,
  pointerdown: MOTION_ACTION.POINTER_DOWN,
  'pointer-down': MOTION_ACTION.POINTER_DOWN,
  pointerup: MOTION_ACTION.POINTER_UP,
  'pointer-up': MOTION_ACTION.POINTER_UP,
  hovermove: MOTION_ACTION.HOVER_MOVE,
  'hover-move': MOTION_ACTION.HOVER_MOVE,
  scroll: MOTION_ACTION.SCROLL,
  hoverenter: MOTION_ACTION.HOVER_ENTER,
  hoverexit: MOTION_ACTION.HOVER_EXIT,
  buttonpress: MOTION_ACTION.BUTTON_PRESS,
  'button-press': MOTION_ACTION.BUTTON_PRESS,
  buttonrelease: MOTION_ACTION.BUTTON_RELEASE,
  'button-release': MOTION_ACTION.BUTTON_RELEASE,
};

const KEY_ACTION_NAMES = { down: KEY_ACTION.DOWN, up: KEY_ACTION.UP, multiple: KEY_ACTION.MULTIPLE };

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function assertBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name} must be a Buffer`);
  }
  return value;
}

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function assertInteger(value, name, min, max) {
  if (typeof value === 'bigint') {
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new RangeError(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new RangeError(`${name} must be <= ${max}`);
  }
  return value;
}

function assertScreenDimension(value, name) {
  return assertInteger(value, name, 1, 0xffff);
}

function resolveMotionAction(action) {
  if (typeof action === 'number') {
    return assertInteger(action, 'action', 0, 0xff);
  }
  if (typeof action === 'string') {
    const resolved = MOTION_ACTION_NAMES[action.toLowerCase()];
    if (resolved === undefined) {
      throw new RangeError(`unknown motion action: ${JSON.stringify(action)}`);
    }
    return resolved;
  }
  throw new TypeError('action must be a number or a string');
}

function resolveKeyAction(action) {
  if (typeof action === 'number') {
    return assertInteger(action, 'action', 0, 0xff);
  }
  if (typeof action === 'string') {
    const resolved = KEY_ACTION_NAMES[action.toLowerCase()];
    if (resolved === undefined) {
      throw new RangeError(`unknown key action: ${JSON.stringify(action)}`);
    }
    return resolved;
  }
  throw new TypeError('action must be a number or a string');
}

function toUnsignedBigInt(value, name) {
  if (typeof value === 'bigint') {
    return BigInt.asUintN(64, value);
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt.asUintN(64, BigInt(value));
  }
  throw new TypeError(`${name} must be an integer (number or bigint)`);
}

/** u16 fixed point: trunc(f * 2^16), 1.0 saturates to 0xFFFF (app/src/util/binary.h). */
function floatToU16fp(value) {
  const f = Math.min(1, Math.max(0, assertFiniteNumber(value, 'pressure')));
  if (f >= 1) {
    return 0xffff;
  }
  return Math.trunc(f * 0x10000);
}

/** i16 fixed point: trunc(f * 2^15), ±1 saturate to 0x7FFF/-0x8000 (app/src/util/binary.h). */
function floatToI16fp(value) {
  const f = Math.min(1, Math.max(-1, assertFiniteNumber(value, 'scroll')));
  if (f >= 1) {
    return 0x7fff;
  }
  return Math.trunc(f * 0x8000);
}

function stripAnnexBStartCode(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 1) {
    return buffer.subarray(4);
  }
  if (buffer.length >= 3 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1) {
    return buffer.subarray(3);
  }
  return buffer;
}

function hex2(value) {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

// ---------------------------------------------------------------------------
// Annex-B / AVCC / avcC helpers (PROTOCOL.md §7)
// ---------------------------------------------------------------------------

/**
 * Split an Annex-B byte stream into NAL units (start codes removed, NAL header byte included).
 * Accepts 3-byte (`00 00 01`) and 4-byte (`00 00 00 01`) start codes, tolerates leading /
 * trailing zero padding. A buffer without any start code is returned as a single raw NAL unit.
 *
 * @param {Buffer} buffer
 * @returns {Buffer[]} NAL units as subarray views of `buffer`
 */
export function splitAnnexBNals(buffer) {
  assertBuffer(buffer, 'buffer');
  const nals = [];
  const len = buffer.length;
  let start = -1;
  let i = 0;

  while (i + 2 < len) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        // trailing_zero_8bits before the next start code are not part of the NAL unit
        while (end > start && buffer[end - 1] === 0) {
          end--;
        }
        if (end > start) {
          nals.push(buffer.subarray(start, end));
        }
      }
      i += 3;
      start = i;
      continue;
    }
    i++;
  }

  if (start >= 0) {
    let end = len;
    while (end > start && buffer[end - 1] === 0) {
      end--;
    }
    if (end > start) {
      nals.push(buffer.subarray(start, end));
    }
  }

  if (nals.length === 0) {
    const raw = stripAnnexBStartCode(buffer);
    if (raw.length > 0) {
      nals.push(raw);
    }
  }

  return nals;
}

/** NAL unit type (low 5 bits of the NAL header byte). */
function nalUnitType(nal) {
  return nal[0] & 0x1f;
}

/** Remove H.264 emulation-prevention bytes (`00 00 03` → `00 00`, next byte < 4). */
function removeEmulationPrevention(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (zeros >= 2 && b === 3 && i + 1 < buffer.length && buffer[i + 1] < 4) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bitPos = 0;
  }

  bit() {
    if (this.bitPos >= this.buffer.length * 8) {
      throw new Error('SPS bit reader out of data');
    }
    const byte = this.buffer[this.bitPos >> 3];
    const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos++;
    return bit;
  }

  bits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.bit();
    }
    return value;
  }

  /** unsigned Exp-Golomb, ue(v) */
  ue() {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) {
        throw new Error('invalid Exp-Golomb code in SPS');
      }
    }
    if (leadingZeros === 0) {
      return 0;
    }
    return (2 ** leadingZeros - 1 + this.bits(leadingZeros)) >>> 0;
  }
}

/**
 * Parse the High-profile SPS fields needed by the avcC extension
 * (chroma_format_idc, bit_depth_*_minus8). Returns null when the SPS is not parseable.
 */
function parseHighProfileSpsExtras(sps) {
  try {
    const rbsp = removeEmulationPrevention(sps.subarray(1)); // skip NAL header byte
    if (rbsp.length < 4) {
      return null;
    }
    const profileIdc = rbsp[0];
    if (!isHighProfile(profileIdc)) {
      return null;
    }
    const reader = new BitReader(rbsp);
    reader.bits(8 * 3); // profile_idc, constraint flags, level_idc
    reader.ue(); // seq_parameter_set_id
    let chromaFormatIdc = reader.ue();
    if (chromaFormatIdc === 3) {
      reader.bit(); // separate_colour_plane_flag
    }
    const bitDepthLumaMinus8 = reader.ue();
    const bitDepthChromaMinus8 = reader.ue();
    return { chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8 };
  } catch {
    return null;
  }
}

const HIGH_PROFILES = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244]);

function isHighProfile(profileIdc) {
  return HIGH_PROFILES.has(profileIdc);
}

/**
 * Build an AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1) from SPS and PPS NAL
 * units, as required by `VideoDecoder.configure({ description })` for `avc1.*` codecs.
 *
 * `sps`/`pps` may include Annex-B start codes (they are stripped). `lengthSizeMinusOne` is
 * fixed to 3 (4-byte NAL lengths in the AVCC sample format).
 *
 * @param {Buffer} sps H.264 SPS NAL unit (type 7), with or without start code
 * @param {Buffer} pps H.264 PPS NAL unit (type 8), with or without start code
 * @returns {Buffer} avcC record
 */
export function buildAvcC(sps, pps) {
  const s = stripAnnexBStartCode(assertBuffer(sps, 'sps'));
  const p = stripAnnexBStartCode(assertBuffer(pps, 'pps'));

  if (s.length < 4) {
    throw new Error('SPS too short to build avcC');
  }
  if (nalUnitType(s) !== 7) {
    throw new Error(`expected an SPS NAL unit (type 7), got type ${nalUnitType(s)}`);
  }
  if (p.length < 2) {
    throw new Error('PPS too short to build avcC');
  }
  if (nalUnitType(p) !== 8) {
    throw new Error(`expected a PPS NAL unit (type 8), got type ${nalUnitType(p)}`);
  }

  const profileIdc = s[1];
  const highProfile = isHighProfile(profileIdc);
  const extras = highProfile ? parseHighProfileSpsExtras(s) : null;

  const header = Buffer.alloc(6);
  header[0] = 0x01; // configurationVersion
  header[1] = s[1]; // AVCProfileIndication
  header[2] = s[2]; // profile_compatibility
  header[3] = s[3]; // AVCLevelIndication
  header[4] = 0xff; // 6 bits reserved (111111) + lengthSizeMinusOne = 3
  header[5] = 0xe1; // 3 bits reserved (111) + numOfSequenceParameterSets = 1

  const spsLength = Buffer.alloc(2);
  spsLength.writeUInt16BE(s.length);
  const ppsCount = Buffer.from([0x01]);
  const ppsLength = Buffer.alloc(2);
  ppsLength.writeUInt16BE(p.length);

  const parts = [header, spsLength, s, ppsCount, ppsLength, p];

  if (highProfile) {
    const chromaFormatIdc = (extras && extras.chromaFormatIdc) || 1; // 4:2:0
    const bitDepthLumaMinus8 = (extras && extras.bitDepthLumaMinus8) || 0;
    const bitDepthChromaMinus8 = (extras && extras.bitDepthChromaMinus8) || 0;
    parts.push(
      Buffer.from([
        0xfc | (chromaFormatIdc & 0x03),
        0xf8 | (bitDepthLumaMinus8 & 0x03),
        0xf8 | (bitDepthChromaMinus8 & 0x03),
        0x00, // numOfSequenceParameterSetExt
      ]),
    );
  }

  return Buffer.concat(parts);
}

const PROFILE_NAMES = Object.freeze({
  44: 'CAVLC 4:4:4',
  66: 'Baseline',
  77: 'Main',
  83: 'Scalable Baseline',
  86: 'Scalable High',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  118: 'Multiview High',
  122: 'High 4:2:2',
  128: 'Stereo High',
  134: 'High 4:4:4 Predictive',
  135: 'High 4:4:4',
  138: 'Multiview Depth High',
  139: 'Enhanced Multiview Depth High',
  144: 'High 4:4:4',
  244: 'High 4:4:4',
});

/**
 * Derive a WebCodecs / RFC 6381 codec string (`avc1.PPCCLL`) and readable profile/level
 * information from a raw H.264 SPS NAL unit (start code optional).
 *
 * @param {Buffer} sps
 * @returns {{codec:'h264', codecString:string, profileIdc:number, profile:string,
 *            constraintFlags:number, levelIdc:number, level:number|string}}
 */
export function describeCodec(sps) {
  const s = stripAnnexBStartCode(assertBuffer(sps, 'sps'));
  if (s.length < 4) {
    throw new Error('SPS too short to describe codec');
  }
  if (nalUnitType(s) !== 7) {
    throw new Error(`expected an SPS NAL unit (type 7), got type ${nalUnitType(s)}`);
  }
  const profileIdc = s[1];
  const constraintFlags = s[2];
  const levelIdc = s[3];
  const codecString = `avc1.${hex2(profileIdc)}${hex2(constraintFlags)}${hex2(levelIdc)}`;

  let level;
  if (levelIdc === 11 && (constraintFlags & 0x08) !== 0) {
    level = '1b';
  } else {
    level = Math.round((levelIdc / 10) * 10) / 10;
  }

  return {
    codec: 'h264',
    codecString,
    profileIdc,
    profile: PROFILE_NAMES[profileIdc] || `Unknown(${profileIdc})`,
    constraintFlags,
    levelIdc,
    level,
  };
}

/**
 * Convert an Annex-B byte stream to AVCC sample format: every NAL unit prefixed by a big-endian
 * length (4 bytes by default, matching the avcC produced by `buildAvcC`).
 * This is what an `EncodedVideoChunk` must contain when a `description` (avcC) is configured.
 *
 * @param {Buffer} buffer Annex-B data
 * @param {number} [lengthSize=4] 1..4
 * @returns {Buffer}
 */
export function annexbToAvcc(buffer, lengthSize = 4) {
  const size = assertInteger(lengthSize, 'lengthSize', 1, 4);
  const nals = splitAnnexBNals(assertBuffer(buffer, 'buffer'));
  const parts = [];
  for (const nal of nals) {
    const length = Buffer.alloc(size);
    if (size === 4) {
      length.writeUInt32BE(nal.length, 0);
    } else if (size === 2) {
      length.writeUInt16BE(nal.length & 0xffff, 0);
    } else if (size === 1) {
      length.writeUInt8(nal.length & 0xff, 0);
    } else {
      length.writeUIntBE(nal.length, 0, 3);
    }
    parts.push(length, nal);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Control message encoders (PROTOCOL.md §5)
// ---------------------------------------------------------------------------

/**
 * Encode an `INJECT_KEYCODE` message (14 bytes).
 * @param {{action:number|string, keycode:number, repeat?:number, metaState?:number}} message
 * @returns {Buffer}
 */
export function buildKeycodeMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('message object required');
  }
  const action = resolveKeyAction(message.action);
  const keycode = assertInteger(message.keycode, 'keycode', -0x80000000, 0x7fffffff);
  const repeat = assertInteger(message.repeat ?? 0, 'repeat', 0, 0xffffffff);
  const metaState = assertInteger(message.metaState ?? 0, 'metaState', 0, 0xffffffff);
  const buffer = Buffer.alloc(14);
  buffer[0] = CONTROL_MESSAGE_TYPE.INJECT_KEYCODE;
  buffer[1] = action;
  buffer.writeInt32BE(keycode, 2);
  buffer.writeUInt32BE(repeat, 6);
  buffer.writeUInt32BE(metaState, 10);
  return buffer;
}

/**
 * Encode an `INJECT_TOUCH_EVENT` message (v5 32-byte layout, PROTOCOL.md §5.2).
 * Coordinates are in video-frame pixels of the current session (not device pixels).
 *
 * @param {{action:number|string, x:number, y:number, screenWidth:number, screenHeight:number,
 *          pressure?:number, buttons?:number, actionButton?:number,
 *          pointerId?:number|bigint}} message
 * @returns {Buffer}
 */
export function buildTouchMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('message object required');
  }
  const action = resolveMotionAction(message.action);
  const x = Math.round(assertFiniteNumber(message.x, 'x'));
  const y = Math.round(assertFiniteNumber(message.y, 'y'));
  const screenWidth = assertScreenDimension(message.screenWidth, 'screenWidth');
  const screenHeight = assertScreenDimension(message.screenHeight, 'screenHeight');
  const defaultPressure = action === MOTION_ACTION.UP || action === MOTION_ACTION.CANCEL ? 0 : 1;
  const pressure = floatToU16fp(message.pressure ?? defaultPressure);
  const actionButton = assertInteger(message.actionButton ?? 0, 'actionButton', 0, 0xffffffff);
  const buttons = assertInteger(message.buttons ?? 0, 'buttons', 0, 0xffffffff);
  const pointerId = toUnsignedBigInt(message.pointerId ?? POINTER_ID.GENERIC_FINGER, 'pointerId');

  const buffer = Buffer.alloc(32);
  buffer[0] = CONTROL_MESSAGE_TYPE.INJECT_TOUCH_EVENT;
  buffer[1] = action;
  buffer.writeBigUInt64BE(pointerId, 2);
  buffer.writeInt32BE(x, 10);
  buffer.writeInt32BE(y, 14);
  buffer.writeUInt16BE(screenWidth, 18);
  buffer.writeUInt16BE(screenHeight, 20);
  buffer.writeUInt16BE(pressure, 22);
  buffer.writeUInt32BE(actionButton, 24);
  buffer.writeUInt32BE(buttons, 28);
  return buffer;
}

/**
 * Encode an `INJECT_SCROLL_EVENT` message (21 bytes, PROTOCOL.md §5.3).
 * `scrollX`/`scrollY` use scrcpy's unit range [-16, 16] (one notch ≈ 1); 0 = no scroll.
 *
 * @param {{x:number, y:number, screenWidth:number, screenHeight:number,
 *          scrollX?:number, scrollY?:number, buttons?:number}} message
 * @returns {Buffer}
 */
export function buildScrollMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('message object required');
  }
  const x = Math.round(assertFiniteNumber(message.x, 'x'));
  const y = Math.round(assertFiniteNumber(message.y, 'y'));
  const screenWidth = assertScreenDimension(message.screenWidth, 'screenWidth');
  const screenHeight = assertScreenDimension(message.screenHeight, 'screenHeight');
  const hscroll = floatToI16fp((message.scrollX ?? 0) / 16);
  const vscroll = floatToI16fp((message.scrollY ?? 0) / 16);
  const buttons = assertInteger(message.buttons ?? 0, 'buttons', 0, 0xffffffff);

  const buffer = Buffer.alloc(21);
  buffer[0] = CONTROL_MESSAGE_TYPE.INJECT_SCROLL_EVENT;
  buffer.writeInt32BE(x, 1);
  buffer.writeInt32BE(y, 5);
  buffer.writeUInt16BE(screenWidth, 9);
  buffer.writeUInt16BE(screenHeight, 11);
  buffer.writeInt16BE(hscroll, 13);
  buffer.writeInt16BE(vscroll, 15);
  buffer.writeUInt32BE(buttons, 17);
  return buffer;
}

/**
 * Encode an `INJECT_TEXT` message from a UTF-8 string fragment (≤ 300 bytes).
 * Use `buildTextMessages` for arbitrary length input.
 * @param {string} text
 * @returns {Buffer}
 */
export function buildTextMessage(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > TEXT_MAX_BYTES) {
    throw new RangeError(`text fragment exceeds ${TEXT_MAX_BYTES} UTF-8 bytes`);
  }
  const buffer = Buffer.alloc(5 + payload.length);
  buffer[0] = CONTROL_MESSAGE_TYPE.INJECT_TEXT;
  buffer.writeUInt32BE(payload.length, 1);
  payload.copy(buffer, 5);
  return buffer;
}

/**
 * Split a string into `INJECT_TEXT` messages of ≤ 300 UTF-8 bytes each, without splitting a
 * multi-byte UTF-8 character (matches `ControlMessageReader.INJECT_TEXT_MAX_LENGTH`).
 * @param {string} text
 * @returns {Buffer[]}
 */
export function buildTextMessages(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  const chunks = [];
  let parts = [];
  let bytes = 0;
  for (const char of text) {
    const encoded = Buffer.from(char, 'utf8');
    if (bytes + encoded.length > TEXT_MAX_BYTES) {
      chunks.push(Buffer.concat(parts, bytes));
      parts = [];
      bytes = 0;
    }
    parts.push(encoded);
    bytes += encoded.length;
  }
  if (bytes > 0) {
    chunks.push(Buffer.concat(parts, bytes));
  }
  return chunks.map((payload) => {
    const buffer = Buffer.alloc(5 + payload.length);
    buffer[0] = CONTROL_MESSAGE_TYPE.INJECT_TEXT;
    buffer.writeUInt32BE(payload.length, 1);
    payload.copy(buffer, 5);
    return buffer;
  });
}

/**
 * Encode `SET_CLIPBOARD` (client → device):
 * u8 type=9 + u64 sequence + u8 paste + i32 utf8 length + utf8 text.
 * @param {{sequence?:number|bigint, text:string, paste?:boolean}} message
 * @returns {Buffer}
 */
export function buildSetClipboardMessage(message) {
  if (!message || typeof message !== 'object') throw new TypeError('message object required');
  const text = String(message.text == null ? '' : message.text);
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 256 * 1024) throw new RangeError('clipboard text is limited to 256 KiB');
  const sequence = toUnsignedBigInt(message.sequence ?? 0, 'sequence');
  const buffer = Buffer.alloc(1 + 8 + 1 + 4 + payload.length);
  buffer[0] = CONTROL_MESSAGE_TYPE.SET_CLIPBOARD;
  buffer.writeBigUInt64BE(sequence, 1);
  buffer[9] = message.paste === true ? 1 : 0;
  buffer.writeInt32BE(payload.length, 10);
  payload.copy(buffer, 14);
  return buffer;
}

/**
 * Encode `BACK_OR_SCREEN_ON` (2 bytes): while the screen is on the server injects KEYCODE_BACK;
 * while it is off, only an ACTION_DOWN powers the screen on.
 * @param {number|string} action key event action
 * @returns {Buffer}
 */
export function buildBackOrScreenOnMessage(action) {
  return Buffer.from([CONTROL_MESSAGE_TYPE.BACK_OR_SCREEN_ON, resolveKeyAction(action)]);
}

/** Encode one of the payload-less control messages (1 byte). */
export function buildEmptyMessage(type) {
  assertInteger(type, 'type', 0, 255);
  if (!EMPTY_CONTROL_MESSAGES.has(type)) {
    throw new RangeError(`control message type ${type} is not a payload-less message`);
  }
  return Buffer.from([type]);
}

/** Encode `SET_DISPLAY_POWER` (2 bytes). */
export function buildDisplayPowerMessage(on) {
  return Buffer.from([CONTROL_MESSAGE_TYPE.SET_DISPLAY_POWER, on ? 1 : 0]);
}

// ---------------------------------------------------------------------------
// Video demuxer (PROTOCOL.md §4)
// ---------------------------------------------------------------------------

const DEMUX_STATE = Object.freeze({ CODEC: 0, SESSION: 1, HEADER: 2, PAYLOAD: 3, ERROR: 4 });

/**
 * Incremental parser for the scrcpy v5.0.1 video stream (after the handshake). Feed arbitrary
 * chunks with `push()`; callbacks are invoked as complete units become available.
 *
 * Emits:
 *  - onInit({codec:'h264', width, height})                      once, from the first session packet
 *  - onSession({width, height, clientResized, recvTimeMs})      on every session packet
 *  - onVideo({codec, isConfig, isKeyFrame, pts, data, size, recvTimeMs}) for every packet
 *  - onConfig({avcC, codecString, sps, pps, profile, level,...}) when a SPS/PPS pair is parsed
 *  - onError(error)                                              on fatal protocol errors
 *  - onWarning(error)                                            non-fatal SPS/avcC issues
 */
export class ScrcpyVideoDemuxer {
  constructor(options = {}) {
    this.maxPacketSize = options.maxPacketSize ?? 16 * 1024 * 1024;
    this._onInit = options.onInit || null;
    this._onSession = options.onSession || null;
    this._onVideo = options.onVideo || null;
    this._onConfig = options.onConfig || null;
    this._onError = options.onError || null;
    this._onWarning = options.onWarning || null;

    this.codec = null;
    this.width = 0;
    this.height = 0;
    this.sps = null;
    this.pps = null;
    this.avcC = null;
    this.codecString = null;
    this.codecInfo = null;

    this._state = DEMUX_STATE.CODEC;
    this._buffer = Buffer.alloc(0);
    this._pendingSize = 0;
    this._pendingPtsAndFlags = 0n;
    this._initSent = false;
  }

  /** Append a chunk of the raw video stream. */
  push(chunk) {
    if (this._state === DEMUX_STATE.ERROR) {
      return;
    }
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return;
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    // Loose upper bound only: a payload may be followed by more units inside the same chunk.
    if (this._buffer.length > this.maxPacketSize * 2 + 12) {
      this._fail(new Error(`video receive buffer exceeded ${this.maxPacketSize} bytes`));
      return;
    }
    try {
      this._drain();
    } catch (error) {
      this._fail(error);
    }
  }

  /** Cached WebCodecs configuration (null until a complete SPS/PPS config packet was seen). */
  getVideoConfig() {
    if (!this.avcC) {
      return null;
    }
    return {
      codec: 'h264',
      codecString: this.codecString,
      avcC: this.avcC,
      sps: this.sps,
      pps: this.pps,
      width: this.width,
      height: this.height,
      info: this.codecInfo,
    };
  }

  _drain() {
    for (;;) {
      switch (this._state) {
        case DEMUX_STATE.CODEC: {
          if (this._buffer.length < 4) {
            return;
          }
          const codecId = this._buffer.readUInt32BE(0);
          this._consume(4);
          if (codecId === 0) {
            this._fail(new Error('video stream explicitly disabled by the device (codec id 0)'));
            return;
          }
          if (codecId === 1) {
            this._fail(new Error('video stream configuration error on the device (codec id 1)'));
            return;
          }
          if (codecId !== CODEC_ID.H264) {
            const name = CODEC_NAMES[codecId] || `0x${codecId.toString(16)}`;
            this._fail(new Error(`unsupported video codec from device: ${name} (relay supports h264 only)`));
            return;
          }
          this.codec = 'h264';
          this._state = DEMUX_STATE.SESSION;
          continue;
        }

        case DEMUX_STATE.SESSION: {
          const header = this._peek(12);
          if (!header) {
            return;
          }
          if ((header[0] & 0x80) === 0) {
            this._fail(new Error('invalid video stream: expected a session packet after the codec id'));
            return;
          }
          this._consume(12);
          this._applySession(header);
          this._state = DEMUX_STATE.HEADER;
          continue;
        }

        case DEMUX_STATE.HEADER: {
          const header = this._peek(12);
          if (!header) {
            return;
          }
          if ((header[0] & 0x80) !== 0) {
            // session packet (12 bytes only)
            this._consume(12);
            this._applySession(header);
            continue;
          }
          const ptsAndFlags = header.readBigUInt64BE(0);
          const size = header.readUInt32BE(8);
          this._consume(12);
          if (size === 0) {
            this._fail(new Error('invalid video packet length: 0'));
            return;
          }
          if (size > this.maxPacketSize) {
            this._fail(new Error(`video packet too large: ${size} > ${this.maxPacketSize}`));
            return;
          }
          this._pendingPtsAndFlags = ptsAndFlags;
          this._pendingSize = size;
          this._state = DEMUX_STATE.PAYLOAD;
          continue;
        }

        case DEMUX_STATE.PAYLOAD: {
          if (this._buffer.length < this._pendingSize) {
            return;
          }
          const data = Buffer.from(this._buffer.subarray(0, this._pendingSize));
          this._consume(this._pendingSize);
          this._handlePacket(this._pendingPtsAndFlags, data);
          this._pendingSize = 0;
          this._pendingPtsAndFlags = 0n;
          this._state = DEMUX_STATE.HEADER;
          continue;
        }

        default:
          return;
      }
    }
  }

  _peek(size) {
    return this._buffer.length >= size ? this._buffer.subarray(0, size) : null;
  }

  _consume(size) {
    this._buffer = size >= this._buffer.length ? Buffer.alloc(0) : this._buffer.subarray(size);
  }

  _applySession(header) {
    const flags = header.readUInt32BE(0);
    const width = header.readUInt32BE(4);
    const height = header.readUInt32BE(8);
    if (!width || !height) {
      throw new Error(`invalid video session size: ${width}x${height}`);
    }
    const clientResized = (flags & 0x1) !== 0;
    this.width = width;
    this.height = height;
    const payload = { codec: 'h264', width, height, clientResized, recvTimeMs: Date.now() };
    if (!this._initSent) {
      this._initSent = true;
      this._emit(this._onInit, payload);
    }
    this._emit(this._onSession, payload);
  }

  _handlePacket(ptsAndFlags, data) {
    const isConfig = (ptsAndFlags & FRAME_FLAG_CONFIG) !== 0n;
    const isKeyFrame = (ptsAndFlags & FRAME_FLAG_KEY_FRAME) !== 0n;
    const pts = Number(ptsAndFlags & FRAME_PTS_MASK);
    const packet = {
      codec: this.codec || 'h264',
      isConfig,
      isKeyFrame,
      pts,
      data,
      size: data.length,
      recvTimeMs: Date.now(),
    };
    this._emit(this._onVideo, packet);
    if (isConfig) {
      this._extractConfig(data);
    }
  }

  _extractConfig(payload) {
    let nals;
    try {
      nals = splitAnnexBNals(payload);
    } catch (error) {
      this._warn(new Error(`could not split codec config NAL units: ${error.message}`));
      return;
    }
    const sps = nals.find((nal) => nal.length >= 4 && nalUnitType(nal) === 7) || null;
    const pps = nals.find((nal) => nal.length >= 2 && nalUnitType(nal) === 8) || null;
    if (sps) {
      this.sps = sps;
    }
    if (pps) {
      this.pps = pps;
    }
    if (!this.sps || !this.pps) {
      return;
    }
    try {
      const info = describeCodec(this.sps);
      const avcC = buildAvcC(this.sps, this.pps);
      this.avcC = avcC;
      this.codecString = info.codecString;
      this.codecInfo = info;
      this._emit(this._onConfig, {
        codec: 'h264',
        codecString: info.codecString,
        avcC,
        sps: this.sps,
        pps: this.pps,
        width: this.width,
        height: this.height,
        info,
      });
    } catch (error) {
      this._warn(new Error(`could not build avcC from SPS/PPS: ${error.message}`));
    }
  }

  _fail(error) {
    if (this._state === DEMUX_STATE.ERROR) {
      return;
    }
    this._state = DEMUX_STATE.ERROR;
    this._buffer = Buffer.alloc(0);
    this._emit(this._onError, error instanceof Error ? error : new Error(String(error)));
  }

  _warn(error) {
    this._emit(this._onWarning, error);
  }

  _emit(handler, payload) {
    if (!handler) {
      return;
    }
    try {
      handler(payload);
    } catch {
      // a consumer callback must never break the parser
    }
  }
}

// ---------------------------------------------------------------------------
// Device → host message parser (PROTOCOL.md §6)
// ---------------------------------------------------------------------------

const DEVICE_MSG_MAX_SIZE = 1 << 18; // 256 KiB

/**
 * Incremental parser for the control socket in the device → host direction
 * (clipboard, clipboard ack, uhid output). Unknown types are protocol errors.
 *
 * Emits `onMessage({type:'clipboard'|'ack_clipboard'|'uhid_output', ...})` and `onError`.
 */
export class ScrcpyDeviceMessageParser {
  constructor(options = {}) {
    this.maxMessageSize = options.maxMessageSize ?? DEVICE_MSG_MAX_SIZE;
    this._onMessage = options.onMessage || null;
    this._onError = options.onError || null;
    this._buffer = Buffer.alloc(0);
    this._failed = false;
  }

  push(chunk) {
    if (this._failed || !Buffer.isBuffer(chunk) || chunk.length === 0) {
      return;
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    if (this._buffer.length > this.maxMessageSize) {
      this._fail(new Error(`device message buffer exceeded ${this.maxMessageSize} bytes`));
      return;
    }
    try {
      this._drain();
    } catch (error) {
      this._fail(error);
    }
  }

  _drain() {
    for (;;) {
      if (this._buffer.length < 1) {
        return;
      }
      const type = this._buffer[0];
      if (type === 0) {
        // clipboard: u8 type + u32 length + utf8
        if (this._buffer.length < 5) {
          return;
        }
        const length = this._buffer.readUInt32BE(1);
        if (length > this.maxMessageSize - 5) {
          throw new Error(`device clipboard message too large: ${length}`);
        }
        if (this._buffer.length < 5 + length) {
          return;
        }
        const text = this._buffer.subarray(5, 5 + length).toString('utf8');
        this._consume(5 + length);
        this._emit({ type: 'clipboard', text });
        continue;
      }
      if (type === 1) {
        // ack clipboard: u8 type + u64 sequence
        if (this._buffer.length < 9) {
          return;
        }
        const sequence = this._buffer.readBigUInt64BE(1);
        this._consume(9);
        this._emit({ type: 'ack_clipboard', sequence });
        continue;
      }
      if (type === 2) {
        // uhid output: u8 type + u16 id + u16 size + data
        if (this._buffer.length < 5) {
          return;
        }
        const id = this._buffer.readUInt16BE(1);
        const size = this._buffer.readUInt16BE(3);
        if (this._buffer.length < 5 + size) {
          return;
        }
        const data = Buffer.from(this._buffer.subarray(5, 5 + size));
        this._consume(5 + size);
        this._emit({ type: 'uhid_output', id, data });
        continue;
      }
      throw new Error(`unknown device message type: ${type}`);
    }
  }

  _consume(size) {
    this._buffer = size >= this._buffer.length ? Buffer.alloc(0) : this._buffer.subarray(size);
  }

  _fail(error) {
    if (this._failed) {
      return;
    }
    this._failed = true;
    if (this._onError) {
      this._onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _emit(message) {
    if (message && this._onMessage) {
      try {
        this._onMessage(message);
      } catch {
        // ignore consumer errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

/**
 * Buffered reader for a TCP socket: `readExactly()` for fixed-size handshake fields, then
 * `startStream()` to hand the (already buffered) remaining bytes to a streaming consumer.
 */
class SocketStream {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.error = null;
    this.ended = false;
    this._buffer = Buffer.alloc(0);
    this._readWaiters = [];
    this._streamHandler = null;
    this._onError = options.onError || null;
    this._onClose = options.onClose || null;
    this._maxBuffered = options.maxBuffered ?? 16 * 1024 * 1024;

    socket.on('data', (chunk) => this._handleData(chunk));
    socket.on('error', (error) => this._handleError(error));
    socket.on('close', () => this._handleClose());
    if (typeof socket.resume === 'function') {
      socket.resume();
    }
  }

  get bufferedLength() {
    return this._buffer.length;
  }

  /** Prepend bytes that were already read from the socket before this stream was created. */
  prepend(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return;
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([chunk, this._buffer]);
    this._drainBuffered();
  }

  readExactly(size, timeoutMs = 10_000) {
    if (size <= 0 || !Number.isInteger(size)) {
      return Promise.reject(new RangeError('size must be a positive integer'));
    }
    if (this._buffer.length >= size) {
      const result = this._buffer.subarray(0, size);
      this._buffer = this._buffer.subarray(size);
      return Promise.resolve(result);
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.ended) {
      return Promise.reject(new Error('socket closed before all expected bytes were received'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { size, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this._readWaiters.indexOf(waiter);
        if (index >= 0) {
          this._readWaiters.splice(index, 1);
        }
        reject(new Error(`timeout waiting for ${size} bytes from device`));
      }, timeoutMs);
      this._readWaiters.push(waiter);
    });
  }

  startStream(handler) {
    this._streamHandler = handler;
    this._drainBuffered();
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }

  _handleData(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    if (this._buffer.length > this._maxBuffered) {
      this._handleError(new Error(`socket receive buffer exceeded ${this._maxBuffered} bytes`));
      this.socket.destroy();
      return;
    }
    this._drainBuffered();
  }

  _drainBuffered() {
    while (this._readWaiters.length > 0 && this._buffer.length >= this._readWaiters[0].size) {
      const waiter = this._readWaiters.shift();
      clearTimeout(waiter.timer);
      const result = this._buffer.subarray(0, waiter.size);
      this._buffer = this._buffer.subarray(waiter.size);
      waiter.resolve(result);
    }
    if (this._streamHandler && this._buffer.length > 0) {
      const chunk = this._buffer;
      this._buffer = Buffer.alloc(0);
      try {
        this._streamHandler(chunk);
      } catch (error) {
        this._handleError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  _handleError(error) {
    if (this.error) {
      return;
    }
    this.error = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this._readWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.error);
    }
    if (this._onError) {
      this._onError(this.error);
    }
  }

  _handleClose() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this._readWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('socket closed by device'));
    }
    if (this._onClose) {
      this._onClose();
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// ScrcpySession
// ---------------------------------------------------------------------------

/**
 * One headless scrcpy relay session against an Android device.
 *
 * Lifecycle: `new ScrcpySession(options)` → register `on*` callbacks → `await start()` →
 * consume video/control → `await stop()`.
 */
export class ScrcpySession {
  constructor(options = {}) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('options object required');
    }

    this.adbPath = options.adbPath || process.env.ADB_PATH || 'adb';
    this.serial = options.serial || null;
    this.serverJarPath = options.serverJarPath || null;
    this.deviceServerPath = options.deviceServerPath || DEFAULT_DEVICE_SERVER_PATH;

    this.port = options.port ?? 27183;
    this.transport = options.transport === 'reverse' ? 'reverse' : 'forward';
    this.scid = options.scid ?? Math.floor(Math.random() * 0x7fffffff);
    if (typeof this.scid !== 'number' || !Number.isInteger(this.scid) || this.scid < 0 || this.scid > 0x7fffffff) {
      throw new RangeError('scid must be a 31-bit non-negative integer');
    }

    this.maxSize = options.maxSize ?? 720;
    this.videoBitRate = options.videoBitRate ?? 4_000_000;
    this.maxFps = options.maxFps ?? 0;
    this.logLevel = options.logLevel || 'info';
    this.extraServerArgs = Array.isArray(options.extraServerArgs) ? options.extraServerArgs.slice() : [];

    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.connectAttempts = options.connectAttempts ?? 100;
    this.connectRetryDelayMs = options.connectRetryDelayMs ?? 100;
    this.adbTimeoutMs = options.adbTimeoutMs ?? 30_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3_000;
    this.maxPacketSize = options.maxPacketSize ?? 16 * 1024 * 1024;
    this.maxLogTail = options.maxLogTail ?? 120;
    this.log = typeof options.log === 'function' ? options.log : null;

    // testing hooks (see file header)
    this._spawnImpl = typeof options.spawn === 'function' ? options.spawn : spawnProcess;
    this._runAdbImpl = typeof options.runAdb === 'function' ? options.runAdb : null;

    this.state = 'idle';
    this.deviceName = null;
    this.videoSize = null;
    this.lastError = null;
    this.logTail = [];
    this.serverCommand = null;

    this._videoSocket = null;
    this._videoStream = null;
    this._controlSocket = null;
    this._controlStream = null;
    this._serverProcess = null;
    this._serverExited = null;
    this._stopping = false;
    this._failed = null;
    this._cleanupPromise = null;
    this._tunnelCreated = false;
    this._listener = null;
    this._acceptQueue = null;
    this._deviceMessageParser = null;
    this._clipboardSequence = 0n;
    this._lastClipboard = '';
    this._clipboardWaiters = [];
    this._handlers = {
      init: [],
      video: [],
      config: [],
      session: [],
      error: [],
      deviceMessage: [],
      log: [],
    };

    this._demuxer = new ScrcpyVideoDemuxer({
      maxPacketSize: this.maxPacketSize,
      onInit: (payload) => {
        this.videoSize = { width: payload.width, height: payload.height };
        this._emit('init', payload);
      },
      onSession: (payload) => {
        this.videoSize = { width: payload.width, height: payload.height };
        this._emit('session', payload);
      },
      onVideo: (packet) => this._emit('video', packet),
      onConfig: (config) => this._emit('config', config),
      onWarning: (error) => this._log('warn', `video metadata warning: ${error.message}`),
      onError: (error) => this._fail(error),
    });
  }

  // -- public event registration -------------------------------------------------------------

  /** One-time: called when the first session packet is parsed. */
  onInit(handler) {
    return this._register('init', handler);
  }

  /** Called for every video packet (config and media). */
  onVideo(handler) {
    return this._register('video', handler);
  }

  /** Called whenever a complete SPS/PPS pair produced WebCodecs metadata. */
  onConfig(handler) {
    return this._register('config', handler);
  }

  /** Called on every session packet (size may change on rotation/resize). */
  onSession(handler) {
    return this._register('session', handler);
  }

  /** Called once on a fatal relay/protocol/device error; the session then stops itself. */
  onError(handler) {
    return this._register('error', handler);
  }

  /** Called for parsed device → host control messages (clipboard / ack / uhid output). */
  onDeviceMessage(handler) {
    return this._register('deviceMessage', handler);
  }

  /** Called with relay diagnostics (level, message). Also kept in `logTail`. */
  onLog(handler) {
    return this._register('log', handler);
  }

  /** Cached WebCodecs metadata: `{codec, codecString, avcC, sps, pps, width, height, info}` */
  getVideoConfig() {
    return this._demuxer.getVideoConfig();
  }

  /** Current session size `{width, height}` once known. */
  getVideoSize() {
    return this.videoSize ? { ...this.videoSize } : null;
  }

  // -- lifecycle -----------------------------------------------------------------------------

  /**
   * Push the server jar, create the adb tunnel, start the server, connect and handshake.
   * Resolves once the video stream has started (i.e. the first bytes may arrive asynchronously).
   * Rejects on failure (and the resources created so far are cleaned up).
   */
  async start() {
    if (this.state !== 'idle') {
      throw new Error(`cannot start a session in state "${this.state}"`);
    }
    this.state = 'starting';
    this.lastError = null;

    try {
      if (!this.serverJarPath) {
        throw new Error('serverJarPath is required (path to scrcpy-server-v5.0.1.jar)');
      }
      let stat;
      try {
        stat = fs.statSync(this.serverJarPath);
      } catch {
        throw new Error(`scrcpy server jar not found: ${this.serverJarPath}`);
      }
      if (!stat.isFile() || stat.size < 1024) {
        throw new Error(`scrcpy server jar is not a valid file: ${this.serverJarPath}`);
      }

      this.serial = await this._resolveSerial();
      this._log('info', `using device ${this.serial}`);
      await this._checkDeviceReady();
      await this._installServerJar();
      await this._openTunnel();

      const serverArgs = this._buildServerArgs();
      this._log('info', `starting server: ${serverArgs.join(' ')}`);
      await this._startServerProcess(serverArgs);
      await this._connectSockets();
      if (this._failed) {
        throw this._failed;
      }
      this.state = 'running';
      this._log('info', `session running (scid=0x${this._scidHex()}, video socket ready)`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this._failed = failure;
      this.lastError = failure;
      this.state = 'error';
      await this._cleanup();
      throw failure;
    }
  }

  /** Stop the session, close sockets, kill the server process and remove the adb tunnel. */
  async stop() {
    if (this.state === 'stopped') {
      return;
    }
    this._stopping = true;
    await this._cleanup();
    if (!this._failed) {
      this.state = 'stopped';
    }
    this._stopping = false;
  }

  // -- control messages ----------------------------------------------------------------------

  /**
   * Send an `INJECT_TOUCH_EVENT` (down/up/move/cancel…). Coordinates are video-frame pixels;
   * `screenWidth`/`screenHeight` default to the current session size.
   */
  async sendTouch(message) {
    if (!message || typeof message !== 'object') {
      throw new TypeError('sendTouch expects an object');
    }
    const size = this.videoSize;
    const buffer = buildTouchMessage({
      ...message,
      screenWidth: message.screenWidth ?? (size && size.width),
      screenHeight: message.screenHeight ?? (size && size.height),
    });
    await this._writeControl(buffer);
  }

  /** Send an `INJECT_KEYCODE`. `action` is `'down'`/`'up'` (or 0/1). */
  async sendKeycode(message) {
    await this._writeControl(buildKeycodeMessage(message));
  }

  /** Send a `SET_CLIPBOARD` message (client → device) and return the sequence. */
  async setClipboard(text, options = {}) {
    const sequence = this._clipboardSequence++;
    await this._writeControl(buildSetClipboardMessage({ sequence, text, paste: options.paste === true }));
    return { sequence: sequence.toString(), text: String(text == null ? '' : text) };
  }

  /** Request the current device clipboard and resolve with its text (timeout-bounded). */
  requestClipboard(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const waiter = {
        resolve: (text) => {
          if (timer) clearTimeout(timer);
          resolve(text);
        },
      };
      timer = setTimeout(() => {
        const index = this._clipboardWaiters.indexOf(waiter);
        if (index >= 0) this._clipboardWaiters.splice(index, 1);
        reject(new Error('clipboard request timed out'));
      }, timeoutMs);
      this._clipboardWaiters.push(waiter);
      // GET_CLIPBOARD payload is a single copyKey byte (0 = read clipboard).
      this._writeControl(Buffer.from([CONTROL_MESSAGE_TYPE.GET_CLIPBOARD, 0])).catch((error) => {
        if (timer) clearTimeout(timer);
        const index = this._clipboardWaiters.indexOf(waiter);
        if (index >= 0) this._clipboardWaiters.splice(index, 1);
        reject(error);
      });
    });
  }

  get lastClipboard() {
    return this._lastClipboard;
  }

  /** Convenience: press and release a keycode. */
  async pressKey(keycode) {
    await this.sendKeycode({ action: 'down', keycode });
    await this.sendKeycode({ action: 'up', keycode });
  }

  /** Send arbitrary text, split into ≤300-byte `INJECT_TEXT` messages. */
  async sendText(text) {
    const messages = buildTextMessages(text);
    for (const message of messages) {
      await this._writeControl(message);
    }
    return messages.length;
  }

  /** Send an `INJECT_SCROLL_EVENT`; scroll values are in scrcpy's [-16, 16] unit range. */
  async sendScroll(message) {
    if (!message || typeof message !== 'object') {
      throw new TypeError('sendScroll expects an object');
    }
    const size = this.videoSize;
    await this._writeControl(
      buildScrollMessage({
        ...message,
        screenWidth: message.screenWidth ?? (size && size.width),
        screenHeight: message.screenHeight ?? (size && size.height),
      }),
    );
  }

  /** Send `BACK_OR_SCREEN_ON`. `action` is `'down'`/`'up'` (or 0/1). */
  async sendBackOrScreenOn(action) {
    await this._writeControl(buildBackOrScreenOnMessage(action));
  }

  /** Send one of the payload-less control messages (type from CONTROL_MESSAGE_TYPE). */
  async sendEmptyMessage(type) {
    await this._writeControl(buildEmptyMessage(type));
  }

  /** Send `SET_DISPLAY_POWER`. */
  async sendDisplayPower(on) {
    await this._writeControl(buildDisplayPowerMessage(on));
  }

  /** Raw control-message escape hatch: `type` byte + pre-encoded payload (without type byte). */
  async sendControlMessage(type, payload = Buffer.alloc(0)) {
    assertInteger(type, 'type', 0, 255);
    assertBuffer(payload, 'payload');
    await this._writeControl(Buffer.concat([Buffer.from([type]), payload]));
  }

  // -- adb plumbing --------------------------------------------------------------------------

  async _resolveSerial() {
    if (this.serial) {
      return this.serial;
    }
    const result = await this._runAdb(['devices']);
    const online = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => /^(\S+)\s+device$/.exec(line))
      .filter(Boolean)
      .map((match) => match[1]);
    if (online.length === 0) {
      throw new Error(`no adb device online (adb devices output: ${result.stdout.trim() || '<empty>'})`);
    }
    if (online.length > 1) {
      this._log('warn', `multiple adb devices online, using ${online[0]} (pass serial explicitly to override)`);
    }
    return online[0];
  }

  async _checkDeviceReady() {
    const args = ['-s', this.serial, 'get-state'];
    const result = await this._runAdb(args, { timeoutMs: this.adbTimeoutMs });
    const state = result.stdout.trim();
    if (result.code !== 0 || state !== 'device') {
      throw new Error(
        `device ${this.serial} is not ready (get-state=${JSON.stringify(state || result.stderr.trim())})`,
      );
    }
  }

  async _installServerJar() {
    const pushArgs = (localPath) => ['-s', this.serial, 'push', localPath, this.deviceServerPath];
    let result = await this._runAdb(pushArgs(this.serverJarPath), {
      timeoutMs: Math.max(this.adbTimeoutMs, 60_000),
    });
    if (result.code !== 0 && /[^\x00-\x7f]/.test(this.serverJarPath)) {
      // Some adb builds mangle non-ASCII local paths on Windows (e.g. a workspace path with
      // non-ASCII characters), so normalize the pushed path handling here.
      // Fall back to an ASCII temporary copy, then remove it.
      const tempRoot = process.env.TEMP || process.env.TMP || '.';
      const tempPath = `${tempRoot.replace(/\\+$/, '')}/scrcpy-server-v5.0.1-${process.pid}.jar`;
      try {
        fs.copyFileSync(this.serverJarPath, tempPath);
        this._log('warn', `adb push failed for a non-ASCII path, retrying via ${tempPath}`);
        result = await this._runAdb(pushArgs(tempPath), {
          timeoutMs: Math.max(this.adbTimeoutMs, 60_000),
        });
      } catch (error) {
        this._log('warn', `temporary copy for adb push failed: ${error.message}`);
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
      }
    }
    if (result.code !== 0) {
      throw new Error(`adb push failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    this._log('info', `pushed server jar to ${this.deviceServerPath}`);
  }

  _socketName() {
    return `scrcpy_${this._scidHex()}`;
  }

  _scidHex() {
    return (this.scid >>> 0).toString(16).padStart(8, '0');
  }

  async _openTunnel() {
    if (this.port === 0) {
      this.port = await this._findFreePort();
    }
    if (this.transport === 'forward') {
      const result = await this._runAdb([
        '-s',
        this.serial,
        'forward',
        `tcp:${this.port}`,
        `localabstract:${this._socketName()}`,
      ]);
      if (result.code !== 0) {
        throw new Error(`adb forward failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
      }
      this._tunnelCreated = true;
      this._log('info', `adb forward tcp:${this.port} -> localabstract:${this._socketName()}`);
    } else {
      // reverse: the relay listens, the device connects (PROTOCOL.md §1)
      this._listener = net.createServer();
      this._acceptQueue = [];
      this._acceptWaiters = [];
      this._listener.on('connection', (socket) => this._pushAcceptedSocket(socket));
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this._listener.removeListener('listening', onListening);
          reject(new Error(`could not listen on 127.0.0.1:${this.port}: ${error.message}`));
        };
        const onListening = () => {
          this._listener.removeListener('error', onError);
          resolve();
        };
        this._listener.once('error', onError);
        this._listener.once('listening', onListening);
        this._listener.listen({ host: '127.0.0.1', port: this.port });
      });
      const result = await this._runAdb([
        '-s',
        this.serial,
        'reverse',
        `localabstract:${this._socketName()}`,
        `tcp:${this.port}`,
      ]);
      if (result.code !== 0) {
        throw new Error(`adb reverse failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
      }
      this._tunnelCreated = true;
      this._log('info', `adb reverse localabstract:${this._socketName()} -> tcp:${this.port}`);
    }
  }

  async _findFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  _buildServerArgs() {
    const args = [
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=${this.deviceServerPath}`,
      'app_process',
      '/',
      SCRCPY_SERVER_CLASS,
      SCRCPY_VERSION,
      `scid=${this._scidHex()}`,
      `log_level=${this.logLevel}`,
      'audio=false',
      'control=true',
      'clipboard_autosync=false',
      `max_size=${this.maxSize}`,
      `video_bit_rate=${this.videoBitRate}`,
    ];
    if (this.maxFps > 0) {
      args.push(`max_fps=${this.maxFps}`);
    }
    if (this.transport === 'forward') {
      args.push('tunnel_forward=true');
    }
    for (const extra of this.extraServerArgs) {
      args.push(String(extra));
    }
    this.serverCommand = args;
    return args;
  }

  async _startServerProcess(args) {
    const child = this._spawnImpl(this.adbPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child || typeof child.on !== 'function') {
      throw new Error('failed to spawn the scrcpy server process');
    }
    this._serverProcess = child;

    const onData = (chunk) => this._appendServerLog(chunk.toString('utf8'));
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', onData);
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', onData);
    }
    child.on('error', (error) => {
      this._log('error', `server process error: ${error.message}`);
      if (!this._stopping) {
        this._fail(new Error(`could not spawn adb shell for scrcpy-server: ${error.message}`));
      }
    });
    child.on('exit', (code, signal) => {
      this._serverExited = { code, signal };
      this._log('info', `server process exited (code=${code}${signal ? `, signal=${signal}` : ''})`);
      if (this._stopping || this.state === 'idle' || this.state === 'stopped' || this._failed) {
        return;
      }
      if (this.state === 'starting') {
        return; // the connect loop notices _serverExited and reports the log tail
      }
      const tail = this.logTail.slice(-8).join('\n');
      this._fail(
        new Error(
          `scrcpy server exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})` +
            (tail ? `\nserver log:\n${tail}` : ''),
        ),
      );
    });

    // Give the process a moment to fail fast (bad version, no encoder, adb error) before connecting.
    await delay(50);
  }

  _appendServerLog(text) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this._log('server', trimmed);
    }
  }

  async _connectSockets() {
    if (this.transport === 'forward') {
      await this._connectSocketsForward();
    } else {
      await this._connectSocketsReverse();
    }

    // Both sockets are connected: the scrcpy client removes the adb tunnel at this point
    // (existing TCP connections survive `adb forward --remove`; see PROTOCOL.md §2.1).
    await this._removeTunnel();

    // Read the 64-byte device metadata from the video socket (PROTOCOL.md §3.3).
    let meta;
    try {
      meta = await this._videoStream.readExactly(64, this.connectTimeoutMs);
    } catch (error) {
      const tail = this.logTail.slice(-8).join('\n');
      throw new Error(
        `handshake failed while reading the device metadata: ${error.message}` +
          (tail ? `\nserver log:\n${tail}` : ''),
      );
    }
    this.deviceName = meta.toString('utf8').replace(/\u0000.*$/s, '').trim() || null;
    this._log('info', `device name: ${this.deviceName}`);

    this._videoStream.startStream((chunk) => this._demuxer.push(chunk));

    this._controlStream = new SocketStream(this._controlSocket, {
      onError: (error) => {
        if (!this._stopping && this.state === 'running') {
          this._fail(new Error(`control socket error: ${error.message}`));
        }
      },
      onClose: () => {
        if (!this._stopping && !this._failed) {
          this._fail(new Error('control socket closed by the device'));
        }
      },
    });
    this._deviceMessageParser = new ScrcpyDeviceMessageParser({
      onMessage: (message) => {
        if (message && message.type === 'clipboard') {
          this._lastClipboard = message.text;
          const waiters = this._clipboardWaiters.splice(0);
          for (const waiter of waiters) waiter.resolve(message.text);
        }
        this._emit('deviceMessage', message);
      },
      onError: (error) => this._fail(new Error(`device message protocol error: ${error.message}`)),
    });
    this._controlStream.startStream((chunk) => this._deviceMessageParser.push(chunk));
  }

  /** Remove the adb forward/reverse rule (best effort; called after connect and from cleanup). */
  async _removeTunnel() {
    if (!this._tunnelCreated || !this.serial) {
      return;
    }
    this._tunnelCreated = false;
    try {
      if (this.transport === 'forward') {
        await this._runAdb(['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`], {
          timeoutMs: 10_000,
        });
      } else {
        await this._runAdb(
          ['-s', this.serial, 'reverse', '--remove', `localabstract:${this._socketName()}`],
          { timeoutMs: 10_000 },
        );
      }
    } catch {
      // best effort
    }
  }

  async _connectSocketsForward() {
    const deadline = Date.now() + this.connectTimeoutMs;
    let video = null;
    for (let attempt = 1; attempt <= this.connectAttempts && Date.now() < deadline; attempt++) {
      if (this._serverExited) {
        break;
      }
      video = await this._probeForwardSocket();
      if (video) {
        break;
      }
      await delay(this.connectRetryDelayMs);
    }
    if (!video) {
      const tail = this.logTail.slice(-8).join('\n');
      throw new Error(
        `could not connect to scrcpy-server video socket on 127.0.0.1:${this.port}` +
          (this._serverExited ? ' (server exited)' : ' (timeout)') +
          (tail ? `\nserver log:\n${tail}` : ''),
      );
    }

    this._videoSocket = video.socket;
    this._videoStream = new SocketStream(video.socket, {
      onError: (error) => {
        if (!this._stopping && this.state === 'running') {
          this._fail(new Error(`video socket error: ${error.message}`));
        }
      },
      onClose: () => {
        if (!this._stopping && !this._failed) {
          this._fail(new Error('video socket closed by the device'));
        }
      },
    });
    if (video.extra.length > 0) {
      // bytes that arrived in the same TCP segment as the dummy byte
      this._videoStream.prepend(video.extra);
    }

    this._controlSocket = await this._connectPlain(deadline);
  }

  /**
   * Forward-mode probe: `connect()` + read exactly 1 dummy byte (see PROTOCOL.md §3.2).
   * `adb forward` accepts connections even when the device server is not listening yet, so the
   * only reliable "is the server up?" signal is this first byte.
   */
  _probeForwardSocket() {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let socket = null;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (!result && socket) {
          socket.destroy();
        } else if (result && socket) {
          socket.pause(); // buffered until SocketStream attaches
        }
        resolve(result);
      };

      try {
        socket = net.connect({ host: '127.0.0.1', port: this.port });
      } catch {
        resolve(null);
        return;
      }
      socket.setNoDelay(true);
      socket.on('error', () => finish(null));
      socket.once('close', () => finish(null));
      socket.once('data', (chunk) => {
        const extra = chunk.length > 1 ? Buffer.from(chunk.subarray(1)) : Buffer.alloc(0);
        finish({ socket, extra });
      });
      timer = setTimeout(() => finish(null), 3000);
    });
  }

  async _connectPlain(deadline) {
    let lastError = null;
    while (Date.now() < deadline) {
      if (this._serverExited) {
        break;
      }
      try {
        return await new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port: this.port });
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('connect timeout'));
          }, Math.min(1500, Math.max(200, deadline - Date.now())));
          socket.setNoDelay(true);
          socket.once('connect', () => {
            clearTimeout(timer);
            socket.removeAllListeners('error');
            // keep a no-op error listener until SocketStream takes over, otherwise an early
            // reset would crash the process with an unhandled 'error' event
            socket.on('error', () => {});
            resolve(socket);
          });
          socket.once('error', (error) => {
            clearTimeout(timer);
            lastError = error;
            reject(error);
          });
        });
      } catch (error) {
        lastError = error;
        await delay(this.connectRetryDelayMs);
      }
    }
    throw new Error(
      `could not connect to scrcpy-server control socket on 127.0.0.1:${this.port}` +
        (lastError ? `: ${lastError.message}` : ''),
    );
  }

  async _connectSocketsReverse() {
    const deadline = Date.now() + this.connectTimeoutMs;
    const videoSocket = await this._acceptSocket(deadline, 'video');
    this._videoSocket = videoSocket;
    this._videoStream = new SocketStream(videoSocket, {
      onError: (error) => {
        if (!this._stopping && this.state === 'running') {
          this._fail(new Error(`video socket error: ${error.message}`));
        }
      },
      onClose: () => {
        if (!this._stopping && !this._failed) {
          this._fail(new Error('video socket closed by the device'));
        }
      },
    });
    this._controlSocket = await this._acceptSocket(deadline, 'control');
  }

  _pushAcceptedSocket(socket) {
    socket.setNoDelay(true);
    if (this._acceptWaiters.length > 0) {
      this._acceptWaiters.shift()(socket);
    } else {
      this._acceptQueue.push(socket);
    }
  }

  _acceptSocket(deadline, name) {
    if (this._acceptQueue.length > 0) {
      return Promise.resolve(this._acceptQueue.shift());
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new Error(`timeout waiting for the ${name} socket from the device`));
    }
    return new Promise((resolve, reject) => {
      const waiter = (socket) => {
        clearTimeout(timer);
        resolve(socket);
      };
      const timer = setTimeout(() => {
        const index = this._acceptWaiters.indexOf(waiter);
        if (index >= 0) {
          this._acceptWaiters.splice(index, 1);
        }
        reject(new Error(`timeout waiting for the ${name} socket from the device`));
      }, remaining);
      this._acceptWaiters.push(waiter);
    });
  }

  async _writeControl(buffer) {
    if (!this._controlSocket || this._controlSocket.destroyed) {
      throw new Error('control socket is not connected (session not running)');
    }
    if (this._controlSocket.writableLength > 4 * 1024 * 1024) {
      throw new Error('control socket backpressure: too much data queued');
    }
    await new Promise((resolve, reject) => {
      this._controlSocket.write(buffer, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // -- internal helpers ----------------------------------------------------------------------

  _register(kind, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`${kind} handler must be a function`);
    }
    this._handlers[kind].push(handler);
    return this;
  }

  _emit(kind, payload) {
    for (const handler of this._handlers[kind]) {
      try {
        handler(payload);
      } catch (error) {
        this._log('error', `${kind} handler threw: ${error.message}`);
      }
    }
  }

  _log(level, message) {
    const line = `[scrcpy-relay] ${message}`;
    this.logTail.push(line);
    if (this.logTail.length > this.maxLogTail) {
      this.logTail.splice(0, this.logTail.length - this.maxLogTail);
    }
    if (this.log) {
      try {
        this.log(level, line);
      } catch {
        // ignore logging errors
      }
    }
    this._emit('log', { level, message: line });
  }

  _fail(error) {
    if (this._failed || this._stopping) {
      return;
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    this._failed = failure;
    this.lastError = failure;
    if (this.state === 'starting' || this.state === 'running') {
      this.state = 'error';
    }
    this._emit('error', failure);
    void this._cleanup();
  }

  _cleanup() {
    if (this._cleanupPromise) {
      return this._cleanupPromise;
    }
    this._cleanupPromise = (async () => {
      if (this._videoStream) {
        this._videoStream.destroy();
      } else if (this._videoSocket) {
        try {
          this._videoSocket.destroy();
        } catch {
          // ignore
        }
      }
      if (this._controlStream) {
        this._controlStream.destroy();
      } else if (this._controlSocket) {
        try {
          this._controlSocket.destroy();
        } catch {
          // ignore
        }
      }
      if (this._listener) {
        try {
          this._listener.close();
        } catch {
          // ignore
        }
        this._listener = null;
      }
      const child = this._serverProcess;
      this._serverProcess = null;
      if (child) {
        try {
          child.kill();
        } catch {
          // ignore
        }
        const exited = await this._waitForChildExit(child, this.stopTimeoutMs);
        if (!exited) {
          this._log('warn', 'scrcpy server process did not exit in time');
        }
      }
      if (this._tunnelCreated) {
        await this._removeTunnel();
      }
      this._videoSocket = null;
      this._videoStream = null;
      this._controlSocket = null;
      this._controlStream = null;
    })();
    return this._cleanupPromise;
  }

  _waitForChildExit(child, timeoutMs) {
    if (!child || this._serverExited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof child.once === 'function') {
        child.once('exit', () => finish(true));
      }
    });
  }

  _runAdb(args, options = {}) {
    if (this._runAdbImpl) {
      return Promise.resolve(this._runAdbImpl(args, options));
    }
    const timeoutMs = options.timeoutMs ?? this.adbTimeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawnImpl(this.adbPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`failed to spawn adb (${this.adbPath}): ${error.message}`));
        return;
      }
      const stdout = [];
      const stderr = [];
      let timeoutTimer = null;
      const collect = (sink) => (chunk) => {
        if (sink.bytes < 128 * 1024) {
          sink.push(chunk);
          sink.bytes += chunk.length;
        }
      };
      const outSink = { push: (chunk) => stdout.push(chunk), bytes: 0 };
      const errSink = { push: (chunk) => stderr.push(chunk), bytes: 0 };
      if (child.stdout) {
        child.stdout.on('data', collect(outSink));
      }
      if (child.stderr) {
        child.stderr.on('data', collect(errSink));
      }
      child.once('error', (error) => {
        clearTimeout(timeoutTimer);
        reject(new Error(`failed to run adb (${this.adbPath} ${args.join(' ')}): ${error.message}`));
      });
      child.once('close', (code) => {
        clearTimeout(timeoutTimer);
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      timeoutTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error(`adb command timed out after ${timeoutMs} ms: ${args.join(' ')}`));
      }, timeoutMs);
    });
  }
}

export default ScrcpySession;
