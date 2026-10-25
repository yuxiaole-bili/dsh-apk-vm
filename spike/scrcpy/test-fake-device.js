/**
 * Fake-device end-to-end + protocol unit test for lib/scrcpy.js (no Android device needed).
 *
 * Run:  node spike/scrcpy/test-fake-device.js
 *
 * It verifies:
 *  - Annex-B splitting, avcC construction, codec string, AVCC conversion
 *  - control message encoders against the exact v5.0.1 byte layouts
 *  - the incremental video demuxer (codec id → session → config/media packets, odd chunking)
 *  - the device-message parser
 *  - a full ScrcpySession lifecycle against a fake scrcpy-server v5.0.1 speaking the real wire
 *    protocol over TCP: adb push/forward/get-state, dummy byte probe, control socket, 64-byte
 *    device name, codec id, session header, SPS/PPS config packet, 40+ media packets, control
 *    message delivery, device→host message parsing and clean stop().
 *
 * Writes report.json (marked as fake-device verification) and capture-fake.h264 for inspection.
 */

import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ScrcpySession,
  ScrcpyVideoDemuxer,
  ScrcpyDeviceMessageParser,
  splitAnnexBNals,
  buildAvcC,
  describeCodec,
  annexbToAvcc,
  buildKeycodeMessage,
  buildTouchMessage,
  buildScrollMessage,
  buildTextMessages,
  buildEmptyMessage,
  buildDisplayPowerMessage,
  CONTROL_MESSAGE_TYPE,
  FRAME_FLAG_CONFIG,
  FRAME_FLAG_KEY_FRAME,
  KEYCODES,
  POINTER_ID,
  SCRCPY_VERSION,
} from '../../lib/scrcpy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const JAR_PATH = join(HERE, 'vendor', 'scrcpy-server-v5.0.1.jar');

// ---------------------------------------------------------------------------
// tiny assertion framework
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function ok(condition, label) {
  if (!condition) {
    throw new Error(`assertion failed: ${label}`);
  }
  passed++;
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  passed++;
}

function bufEq(actual, expected, label) {
  ok(Buffer.isBuffer(actual), `${label}: actual is a Buffer`);
  ok(Buffer.isBuffer(expected), `${label}: expected is a Buffer`);
  if (!actual.equals(expected)) {
    throw new Error(`assertion failed: ${label}\n  actual   ${actual.toString('hex')}\n  expected ${expected.toString('hex')}`);
  }
  passed++;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

const hex = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await tick(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// fixtures: real-looking H.264 SPS/PPS + stream builders
// ---------------------------------------------------------------------------

const SPS_BASELINE = hex('67 42 00 1E 95 A8 14 01 6E 9B 80 80 80 A0');
const PPS = hex('68 CE 3C 80');
const HIGH_SPS = hex('67 64 00 1E AC D9 40 50 05 BB 01 10 00 00 03 00 10 00 00 03 03 20 F1 83 19 60');

function sessionHeader(width, height, clientResized = false) {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE((0x80000000 | (clientResized ? 1 : 0)) >>> 0, 0);
  buffer.writeUInt32BE(width, 4);
  buffer.writeUInt32BE(height, 8);
  return buffer;
}

function frameHeader(size, { config = false, keyFrame = false, pts = 0 } = {}) {
  const buffer = Buffer.alloc(12);
  let flags = BigInt(pts);
  if (config) {
    flags |= FRAME_FLAG_CONFIG;
  }
  if (keyFrame) {
    flags |= FRAME_FLAG_KEY_FRAME;
  }
  buffer.writeBigUInt64BE(flags, 0);
  buffer.writeUInt32BE(size, 8);
  return buffer;
}

function annexBSpsPps() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    SPS_BASELINE,
    Buffer.from([0, 0, 0, 1]),
    PPS,
  ]);
}

function mediaPayload(isKeyFrame, index) {
  const header = Buffer.from([isKeyFrame ? 0x65 : 0x41, 0x88, 0x84, index & 0xff]);
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), header, Buffer.alloc(32 + (index % 7) * 16, 0x5a)]);
}

function buildFakeVideoStream({ frames = 40, width = 720, height = 1280 } = {}) {
  const chunks = [];
  const packets = [];
  chunks.push(sessionHeader(width, height));
  const configPayload = annexBSpsPps();
  const configPacket = Buffer.concat([frameHeader(configPayload.length, { config: true }), configPayload]);
  chunks.push(configPacket);
  packets.push({ config: true, payload: configPayload, header: configPacket.subarray(0, 12) });
  for (let i = 0; i < frames; i++) {
    const isKeyFrame = i % 10 === 0;
    const payload = mediaPayload(isKeyFrame, i);
    const pts = 1000 + i * 33333;
    const header = frameHeader(payload.length, { keyFrame: isKeyFrame, pts });
    const packet = Buffer.concat([header, payload]);
    chunks.push(packet);
    packets.push({ config: false, keyFrame: isKeyFrame, payload, header, pts });
  }
  return { stream: Buffer.concat(chunks), packets, configPayload, width, height };
}

// ---------------------------------------------------------------------------
// unit tests
// ---------------------------------------------------------------------------

async function unitTests() {
  await test('splitAnnexBNals handles 3/4-byte start codes and trailing zeros', () => {
    const data = Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      SPS_BASELINE,
      Buffer.from([0, 0, 0, 0, 1]),
      PPS,
      Buffer.from([0, 0, 1, 0x65, 1, 2, 3, 0, 0]),
    ]);
    const nals = splitAnnexBNals(data);
    eq(nals.length, 3, 'nal count');
    bufEq(nals[0], SPS_BASELINE, 'sps nal');
    bufEq(nals[1], PPS, 'pps nal');
    bufEq(nals[2], Buffer.from([0x65, 1, 2, 3]), 'idr nal');
    eq(splitAnnexBNals(PPS).length, 1, 'raw nal fallback');
    eq(splitAnnexBNals(Buffer.alloc(0)).length, 0, 'empty buffer');
  });

  await test('describeCodec produces RFC 6381 codec strings', () => {
    const baseline = describeCodec(SPS_BASELINE);
    eq(baseline.codecString, 'avc1.42001E', 'baseline codec string');
    eq(baseline.profile, 'Baseline', 'baseline profile name');
    eq(baseline.levelIdc, 30, 'baseline level idc');
    eq(baseline.level, 3, 'baseline level');
    const high = describeCodec(HIGH_SPS);
    eq(high.codecString, 'avc1.64001E', 'high codec string');
    eq(high.profile, 'High', 'high profile name');
  });

  await test('buildAvcC builds an AVCDecoderConfigurationRecord', () => {
    const avcC = buildAvcC(SPS_BASELINE, PPS);
    eq(avcC[0], 1, 'configurationVersion');
    eq(avcC[1], 0x42, 'profile indication');
    eq(avcC[2], 0x00, 'profile compatibility');
    eq(avcC[3], 0x1e, 'level indication');
    eq(avcC[4], 0xff, 'reserved + lengthSizeMinusOne=3');
    eq(avcC[5], 0xe1, 'numOfSPS=1');
    eq(avcC.readUInt16BE(6), SPS_BASELINE.length, 'sps length');
    bufEq(avcC.subarray(8, 8 + SPS_BASELINE.length), SPS_BASELINE, 'sps bytes');
    const ppsCountOffset = 8 + SPS_BASELINE.length;
    eq(avcC[ppsCountOffset], 1, 'numOfPPS=1');
    eq(avcC.readUInt16BE(ppsCountOffset + 1), PPS.length, 'pps length');
    bufEq(avcC.subarray(ppsCountOffset + 3), PPS, 'pps bytes');
    eq(avcC.length, 6 + 2 + SPS_BASELINE.length + 1 + 2 + PPS.length, 'baseline avcC length');
    // start codes are stripped if the caller passes NALs with one
    bufEq(buildAvcC(Buffer.concat([Buffer.from([0, 0, 0, 1]), SPS_BASELINE]), PPS), avcC, 'start code tolerated');
  });

  await test('buildAvcC emits High-profile extension fields', () => {
    const avcC = buildAvcC(HIGH_SPS, PPS);
    eq(avcC[1], 0x64, 'high profile idc');
    const extension = avcC.subarray(avcC.length - 4);
    eq(extension.length, 4, 'extension length');
    eq(extension[0] & 0x03, 1, 'chroma_format_idc=1 (4:2:0)');
    eq(extension[1] & 0x03, 0, 'bit_depth_luma_minus8=0');
    eq(extension[2] & 0x03, 0, 'bit_depth_chroma_minus8=0');
    eq(extension[3], 0, 'numOfSequenceParameterSetExt=0');
  });

  await test('annexbToAvcc converts to 4-byte length-prefixed samples', () => {
    const annexb = Buffer.concat([Buffer.from([0, 0, 1]), PPS, Buffer.from([0, 0, 0, 1, 0x65, 1, 2])]);
    const avcc = annexbToAvcc(annexb);
    eq(avcc.readUInt32BE(0), PPS.length, 'first length');
    bufEq(avcc.subarray(4, 4 + PPS.length), PPS, 'first nal');
    const offset = 4 + PPS.length;
    eq(avcc.readUInt32BE(offset), 3, 'second length');
    bufEq(avcc.subarray(offset + 4), Buffer.from([0x65, 1, 2]), 'second nal');
  });

  await test('control encoders match the v5.0.1 byte layouts', () => {
    const touch = buildTouchMessage({ action: 'down', x: 100, y: 200, screenWidth: 720, screenHeight: 1280 });
    eq(touch.length, 32, 'touch size');
    eq(touch[0], 2, 'touch type');
    eq(touch[1], 0, 'touch ACTION_DOWN');
    eq(touch.readBigUInt64BE(2), 2n ** 64n - 2n, 'generic finger pointer id');
    eq(touch.readInt32BE(10), 100, 'touch x');
    eq(touch.readInt32BE(14), 200, 'touch y');
    eq(touch.readUInt16BE(18), 720, 'touch screen width');
    eq(touch.readUInt16BE(20), 1280, 'touch screen height');
    eq(touch.readUInt16BE(22), 0xffff, 'touch pressure 1.0');
    eq(touch.readUInt32BE(24), 0, 'touch actionButton');
    eq(touch.readUInt32BE(28), 0, 'touch buttons');
    eq(buildTouchMessage({ action: 'up', x: 1, y: 2, screenWidth: 720, screenHeight: 1280 }).readUInt16BE(22), 0, 'up pressure 0');

    const key = buildKeycodeMessage({ action: 'down', keycode: KEYCODES.BACK });
    eq(key.length, 14, 'keycode size');
    eq(key[0], 0, 'keycode type');
    eq(key[1], 0, 'keycode ACTION_DOWN');
    eq(key.readInt32BE(2), 4, 'keycode BACK');
    eq(key.readUInt32BE(6), 0, 'repeat');
    eq(key.readUInt32BE(10), 0, 'metaState');

    const scroll = buildScrollMessage({ x: 10, y: 20, screenWidth: 720, screenHeight: 1280, scrollY: -3 });
    eq(scroll.length, 21, 'scroll size');
    eq(scroll[0], 3, 'scroll type');
    eq(scroll.readInt32BE(1), 10, 'scroll x');
    eq(scroll.readInt32BE(5), 20, 'scroll y');
    eq(scroll.readUInt16BE(9), 720, 'scroll screen width');
    eq(scroll.readUInt16BE(11), 1280, 'scroll screen height');
    eq(scroll.readInt16BE(13), 0, 'hscroll');
    eq(scroll.readInt16BE(15), -6144, 'vscroll = -3/16 * 32768');
    eq(scroll.readUInt32BE(17), 0, 'buttons');

    const texts = buildTextMessages(`${'a'.repeat(250)}${'é'.repeat(30)}`);
    eq(texts.length, 2, 'text message count');
    eq(texts[0].length, 305, 'first text message size (300 byte payload)');
    eq(texts[0][0], CONTROL_MESSAGE_TYPE.INJECT_TEXT, 'text type');
    eq(texts[0].readUInt32BE(1), 300, 'first text payload length');
    eq(texts[1].readUInt32BE(1), 10, 'second text payload length (5 x 2-byte chars)');
    bufEq(buildEmptyMessage(CONTROL_MESSAGE_TYPE.ROTATE_DEVICE), Buffer.from([11]), 'empty message');
    bufEq(buildDisplayPowerMessage(true), Buffer.from([10, 1]), 'display power on');
  });

  await test('ScrcpyVideoDemuxer parses a synthetic stream fed in tiny chunks', () => {
    const { stream, packets, configPayload, width, height } = buildFakeVideoStream({ frames: 5 });
    const events = { init: [], session: [], video: [], config: [], errors: [], warnings: [] };
    const demuxer = new ScrcpyVideoDemuxer({
      onInit: (payload) => events.init.push(payload),
      onSession: (payload) => events.session.push(payload),
      onVideo: (packet) => events.video.push(packet),
      onConfig: (config) => events.config.push(config),
      onError: (error) => events.errors.push(error),
      onWarning: (error) => events.warnings.push(error),
    });
    const streamWithCodecId = Buffer.concat([Buffer.from([0x68, 0x32, 0x36, 0x34]), stream]);
    let offset = 0;
    let step = 1;
    while (offset < streamWithCodecId.length) {
      const size = Math.min(streamWithCodecId.length - offset, ((step * 7) % 23) + 1);
      demuxer.push(streamWithCodecId.subarray(offset, offset + size));
      offset += size;
      step++;
    }
    eq(events.errors.length, 0, 'no demux errors');
    eq(events.init.length, 1, 'single init event');
    eq(events.init[0].codec, 'h264', 'init codec');
    eq(events.init[0].width, width, 'init width');
    eq(events.init[0].height, height, 'init height');
    eq(events.video.length, packets.length, 'video packet count');
    bufEq(events.video[0].data, configPayload, 'first packet is the config payload');
    ok(events.video[0].isConfig, 'first packet flagged config');
    ok(events.video[1].isKeyFrame, 'second packet is a keyframe');
    eq(events.config.length, 1, 'config event emitted');
    eq(events.config[0].codecString, 'avc1.42001E', 'demuxed codec string');
    eq(events.config[0].avcC[0], 1, 'demuxed avcC version');
    const cached = demuxer.getVideoConfig();
    eq(cached.codecString, 'avc1.42001E', 'cached codec string');
    ok(cached.avcC.equals(events.config[0].avcC), 'cached avcC');
    eq(events.video[3].pts, 1000 + 2 * 33333, 'pts parsed from frame header');
    // a second session header must be reported (e.g. rotation)
    demuxer.push(Buffer.concat([sessionHeader(1280, 720), frameHeader(5, { pts: 1 }), Buffer.from([0, 0, 1, 0x41, 1])]));
    eq(events.session.length, 2, 'session count after rotation');
    eq(demuxer.width, 1280, 'rotated width');
    eq(demuxer.height, 720, 'rotated height');
  });

  await test('ScrcpyVideoDemuxer rejects unsupported codecs', () => {
    const errors = [];
    const demuxer = new ScrcpyVideoDemuxer({ onError: (error) => errors.push(error) });
    demuxer.push(Buffer.from([0x68, 0x32, 0x36, 0x35])); // "h265"
    eq(errors.length, 1, 'one error');
    ok(/unsupported video codec/.test(errors[0].message), 'mentions unsupported codec');
  });

  await test('ScrcpyDeviceMessageParser parses all device message types', () => {
    const messages = [];
    const errors = [];
    const parser = new ScrcpyDeviceMessageParser({
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
    });
    const clipboard = Buffer.concat([
      Buffer.from([0]),
      Buffer.from([0, 0, 0]),
      Buffer.from([5]),
      Buffer.from('hello', 'utf8'),
    ]);
    const ack = Buffer.alloc(9);
    ack[0] = 1;
    ack.writeBigUInt64BE(123456789n, 1);
    const uhid = Buffer.concat([Buffer.from([2, 0x00, 0x07, 0x00, 0x03]), Buffer.from([1, 2, 3])]);
    const combined = Buffer.concat([clipboard, ack, uhid]);
    for (let i = 0; i < combined.length; i += 3) {
      parser.push(combined.subarray(i, Math.min(combined.length, i + 3)));
    }
    eq(errors.length, 0, 'no parser errors');
    eq(messages.length, 3, 'message count');
    eq(messages[0].type, 'clipboard', 'clipboard type');
    eq(messages[0].text, 'hello', 'clipboard text');
    eq(messages[1].type, 'ack_clipboard', 'ack type');
    eq(messages[1].sequence, 123456789n, 'ack sequence');
    eq(messages[2].type, 'uhid_output', 'uhid type');
    eq(messages[2].id, 7, 'uhid id');
    bufEq(messages[2].data, Buffer.from([1, 2, 3]), 'uhid data');

    const unknownErrors = [];
    const unknown = new ScrcpyDeviceMessageParser({ onError: (error) => unknownErrors.push(error) });
    unknown.push(Buffer.from([99, 1, 2, 3, 4, 5]));
    eq(unknownErrors.length, 1, 'unknown type is an error');
  });
}

// ---------------------------------------------------------------------------
// fake scrcpy-server (speaks the real v5.0.1 wire protocol over TCP)
// ---------------------------------------------------------------------------

class FakeScrcpyServer {
  constructor({ width = 720, height = 1280, frames = 40 } = {}) {
    this.width = width;
    this.height = height;
    this.frames = frames;
    this.deviceName = 'Fake Android Device';
    this.server = null;
    this.port = 0;
    this.videoSocket = null;
    this.controlSocket = null;
    this.controlData = Buffer.alloc(0);
    this.controlReads = 0;
    this.connectionCount = 0;
    this.packetsSent = 0;
    this.bytesSent = 0;
    this.video = Buffer.alloc(0);
    this._sendTimer = null;
  }

  async listen() {
    this.server = net.createServer((socket) => this._onConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  _onConnection(socket) {
    this.connectionCount++;
    socket.setNoDelay(true);
    socket.on('error', () => {
      // the relay closing its side is expected
    });
    if (this.connectionCount === 1) {
      // video socket: the real server writes the dummy byte immediately after accept
      this.videoSocket = socket;
      socket.write(Buffer.from([0]));
      this._waitForControl = this._waitForControlPromise();
      return;
    }
    if (this.connectionCount === 2) {
      this.controlSocket = socket;
      this.controlSocket.on('data', (chunk) => {
        this.controlData = Buffer.concat([this.controlData, chunk]);
        this.controlReads++;
      });
      if (this._resolveControl) {
        this._resolveControl();
      }
      void this.startStreaming();
      return;
    }
    socket.destroy();
  }

  _waitForControlPromise() {
    return new Promise((resolve) => {
      if (this.controlSocket) {
        resolve();
        return;
      }
      this._resolveControl = resolve;
    });
  }

  async startStreaming() {
    await this._waitForControl;
    const video = this.videoSocket;
    // 64-byte zero-padded device name
    const nameBuffer = Buffer.alloc(64);
    Buffer.from(this.deviceName, 'utf8').copy(nameBuffer, 0, 0, 63);
    video.write(nameBuffer);
    video.write(Buffer.from([0x68, 0x32, 0x36, 0x34])); // codec id "h264"
    video.write(sessionHeader(this.width, this.height));
    const { packets } = buildFakeVideoStream({ frames: this.frames, width: this.width, height: this.height });
    let index = 0;
    const sendNext = () => {
      if (index >= packets.length || !this.videoSocket || this.videoSocket.destroyed) {
        return;
      }
      const packet = packets[index];
      const buffer = Buffer.concat([frameHeader(packet.payload.length, packet), packet.payload]);
      this.videoSocket.write(buffer);
      this.packetsSent++;
      this.bytesSent += buffer.length;
      index++;
      this._sendTimer = setTimeout(sendNext, 4);
    };
    sendNext();
    // exercise the device → host direction as well
    setTimeout(() => {
      if (this.controlSocket && !this.controlSocket.destroyed) {
        const sequence = Buffer.alloc(8);
        sequence.writeBigUInt64BE(424242n, 0);
        this.controlSocket.write(Buffer.concat([Buffer.from([1]), sequence]));
      }
    }, 40);
  }

  close() {
    if (this._sendTimer) {
      clearTimeout(this._sendTimer);
    }
    if (this.videoSocket) {
      this.videoSocket.destroy();
    }
    if (this.controlSocket) {
      this.controlSocket.destroy();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 4242;
    this.killed = false;
  }

  kill() {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    setTimeout(() => this.emit('exit', 0, null), 5);
    return true;
  }
}

async function fakeDeviceEndToEnd() {
  const fakeServer = new FakeScrcpyServer({ frames: 40 });
  const port = await fakeServer.listen();
  const adbCalls = [];
  const spawnCalls = [];
  const fakeChild = new FakeChildProcess();

  const runAdb = async (args) => {
    adbCalls.push(args.join(' '));
    if (args[0] === 'devices') {
      return { code: 0, stdout: 'List of devices attached\nemulator-5558\tdevice\n', stderr: '' };
    }
    if (args.includes('get-state')) {
      return { code: 0, stdout: 'device\n', stderr: '' };
    }
    if (args.includes('push')) {
      return { code: 0, stdout: '1 file pushed, 0 skipped.', stderr: '' };
    }
    if (args.includes('forward') || args.includes('reverse')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const spawn = (command, args) => {
    spawnCalls.push([command, ...args]);
    setTimeout(() => {
      fakeChild.stdout.emit('data', Buffer.from('INFO: Device: [Fake] Fake Android Device (Android 14)\n'));
    }, 20);
    return fakeChild;
  };

  const events = { init: [], video: [], config: [], session: [], errors: [], deviceMessages: [], logs: [] };
  const session = new ScrcpySession({
    adbPath: 'fake-adb.exe',
    serial: 'emulator-5558',
    serverJarPath: JAR_PATH,
    port,
    maxSize: 720,
    videoBitRate: 4_000_000,
    spawn,
    runAdb,
    log: (level, message) => events.logs.push(`${level}: ${message}`),
  });

  session.onInit((payload) => events.init.push(payload));
  session.onVideo((packet) => events.video.push(packet));
  session.onConfig((config) => events.config.push(config));
  session.onSession((payload) => events.session.push(payload));
  session.onError((error) => events.errors.push(error));
  session.onDeviceMessage((message) => events.deviceMessages.push(message));

  await session.start();
  eq(session.state, 'running', 'session state after start');
  eq(session.deviceName, 'Fake Android Device', 'device name');
  ok(adsHas(adbCalls, 'push'), 'adb push called');
  ok(adsHas(adbCalls, 'forward'), 'adb forward called');
  ok(spawnCalls.length === 1, 'server process spawned once');
  const spawnedArgs = spawnCalls[0].join(' ');
  ok(spawnedArgs.includes('CLASSPATH=/data/local/tmp/scrcpy-server.jar'), 'CLASSPATH argument');
  ok(spawnedArgs.includes('com.genymobile.scrcpy.Server 5.0.1'), 'server class + version');
  ok(spawnedArgs.includes('audio=false'), 'audio disabled');
  ok(spawnedArgs.includes('tunnel_forward=true'), 'forward mode option');
  ok(spawnedArgs.includes('clipboard_autosync=false'), 'clipboard autosync disabled');
  eq(SCRCPY_VERSION, '5.0.1', 'SCRCPY_VERSION constant');
  ok(adsHas(adbCalls, 'forward --remove'), 'forward rule removed after connect');

  await waitFor(() => events.video.length >= 35, 5000, '35 video packets');
  ok(session.videoSize && session.videoSize.width === 720 && session.videoSize.height === 1280, 'video size');
  eq(events.init.length, 1, 'init event count');
  eq(events.init[0].codec, 'h264', 'init codec');
  eq(events.config.length, 1, 'config event count');
  eq(events.config[0].codecString, 'avc1.42001E', 'codec string');
  ok(Buffer.isBuffer(events.config[0].avcC), 'avcC is a Buffer');
  const configCached = session.getVideoConfig();
  ok(configCached && configCached.codecString === 'avc1.42001E', 'getVideoConfig()');
  const configPackets = events.video.filter((packet) => packet.isConfig);
  const keyPackets = events.video.filter((packet) => packet.isKeyFrame);
  eq(configPackets.length, 1, 'config packet count');
  ok(keyPackets.length >= 3, 'keyframe count');
  ok(events.video.every((packet) => packet.codec === 'h264'), 'all packets codec h264');
  ok(events.video.every((packet) => packet.data.length === packet.size && packet.size > 0), 'packet sizes');
  // verify no packet mixed the 12-byte header into the payload
  ok(events.video.some((packet) => packet.data[0] === 0 && packet.data[1] === 0 && packet.data[2] === 0 && packet.data[3] === 1), 'annex-b payload');

  // control messages
  await session.sendTouch({ action: 'down', x: 360, y: 640 });
  await session.sendTouch({ action: 'move', x: 350, y: 630 });
  await session.sendTouch({ action: 'up', x: 350, y: 630 });
  await session.sendKeycode({ action: 'down', keycode: KEYCODES.HOME });
  await session.sendKeycode({ action: 'up', keycode: KEYCODES.HOME });
  await session.sendText('héllo 你好');
  await session.sendScroll({ x: 360, y: 640, scrollY: -2 });
  await session.sendDisplayPower(true);
  const expectedTouchDown = buildTouchMessage({ action: 'down', x: 360, y: 640, screenWidth: 720, screenHeight: 1280 });
  const expectedTouchUp = buildTouchMessage({ action: 'up', x: 350, y: 630, screenWidth: 720, screenHeight: 1280 });
  const expectedKey = buildKeycodeMessage({ action: 'down', keycode: KEYCODES.HOME });
  const expectedScroll = buildScrollMessage({ x: 360, y: 640, screenWidth: 720, screenHeight: 1280, scrollY: -2 });
  await waitFor(() => fakeServer.controlData.includes(expectedScroll), 3000, 'scroll message delivery');
  const controlData = fakeServer.controlData;
  ok(controlData.includes(expectedTouchDown), 'touch down message delivered');
  ok(controlData.includes(expectedTouchUp), 'touch up message delivered');
  ok(controlData.includes(expectedKey), 'keycode message delivered');
  ok(controlData.includes(buildDisplayPowerMessage(true)), 'display power message delivered');
  const textMessages = buildTextMessages('héllo 你好');
  ok(textMessages.every((message) => controlData.includes(message)), 'text message delivered');

  await waitFor(() => events.deviceMessages.length >= 1, 3000, 'device message');
  eq(events.deviceMessages[0].type, 'ack_clipboard', 'device message type');
  eq(events.deviceMessages[0].sequence, 424242n, 'device message sequence');

  // verify onVideo latency metadata is present and plausible
  const firstPacket = events.video[0];
  ok(Number.isFinite(firstPacket.recvTimeMs) && firstPacket.recvTimeMs > 0, 'recvTimeMs present');
  ok(Number.isFinite(firstPacket.pts) && firstPacket.pts >= 0, 'pts present');

  // write the captured stream for manual inspection / ffprobe
  const capture = Buffer.concat(events.video.map((packet) => packet.data));
  fs.writeFileSync(join(HERE, 'capture-fake.h264'), capture);
  ok(fs.statSync(join(HERE, 'capture-fake.h264')).size === capture.length, 'capture file written');

  // stop + cleanup checks
  await session.stop();
  eq(session.state, 'stopped', 'session state after stop');
  ok(fakeChild.killed, 'server process killed');
  ok(adsHas(adbCalls, 'forward --remove'), 'forward removed during cleanup');
  fakeServer.close();

  return {
    mode: 'fake-device',
    port,
    packetCount: events.video.length,
    configPacketCount: configPackets.length,
    keyFrameCount: keyPackets.length,
    mediaPacketCount: events.video.length - configPackets.length,
    firstPacketBytes: events.video[0].size,
    maxPacketBytes: Math.max(...events.video.map((packet) => packet.size)),
    totalVideoBytes: events.video.reduce((sum, packet) => sum + packet.size, 0),
    width: session.videoSize.width,
    height: session.videoSize.height,
    deviceName: session.deviceName,
    codecString: session.getVideoConfig().codecString,
    avcCBytes: session.getVideoConfig().avcC.length,
    controlBytesWritten: fakeServer.controlData.length,
    deviceMessages: events.deviceMessages.map((message) => message.type),
    adbCalls,
    durationMs: null,
  };
}

function adsHas(calls, needle) {
  return calls.some((call) => call.includes(needle));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`scrcpy relay fake-device test (SCRCPY_VERSION=${SCRCPY_VERSION})`);
  console.log(`node ${process.version}, jar: ${JAR_PATH}\n`);

  if (!fs.existsSync(JAR_PATH)) {
    throw new Error(`missing vendored jar: ${JAR_PATH}`);
  }

  await unitTests();

  let e2eResult = null;
  await test('full ScrcpySession lifecycle against a fake scrcpy-server', async () => {
    e2eResult = await fakeDeviceEndToEnd();
    console.log(
      `      fake server sent ${e2eResult.packetCount} video packets ` +
        `(${e2eResult.mediaPacketCount} media, ${e2eResult.configPacketCount} config, ${e2eResult.keyFrameCount} keyframes), ` +
        `avcC=${e2eResult.codecString} (${e2eResult.avcCBytes} B), control=${e2eResult.controlBytesWritten} B`,
    );
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'fake-device',
    status: 'protocol-verified-fake-device',
    scrcpyVersion: SCRCPY_VERSION,
    jar: {
      path: 'spike/scrcpy/vendor/scrcpy-server-v5.0.1.jar',
      sha256: '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536',
      bytes: 733930,
    },
    unitTestsPassed: passed,
    failures: failures.map(({ name, error }) => ({ name, message: error.message })),
    fakeDevice: e2eResult,
    realDevice: {
      status: 'pending',
      note: 'no usable online adb device was available when this test ran; see capture.js',
    },
  };
  fs.writeFileSync(join(HERE, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${passed} assertions passed, ${failures.length} test(s) failed`);
  if (failures.length > 0) {
    for (const { name, error } of failures) {
      console.error(`\nFAILED: ${name}\n${error.stack || error.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`report written: ${join(HERE, 'report.json')}`);
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
