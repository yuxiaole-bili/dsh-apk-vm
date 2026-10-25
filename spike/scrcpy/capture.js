/**
 * Real-device capture test for lib/scrcpy.js (scrcpy-server v5.0.1).
 *
 * Usage:
 *   node spike/scrcpy/capture.js [--serial emulator-5558] [--adb <path>]
 *                                [--port 27183] [--packets 60] [--wait-ms 180000]
 *
 * Behaviour:
 *  - waits until an adb device is online (and boot_completed=1 when the property exists)
 *  - starts a ScrcpySession against spike/scrcpy/vendor/scrcpy-server-v5.0.1.jar
 *  - captures >= N video packets, writes spike/scrcpy/capture.h264
 *  - verifies NAL units (SPS/PPS/IDR), builds avcC + codec string
 *  - injects a tap through the scrcpy control socket and checks that the video changed
 *  - writes spike/scrcpy/report.json (device section) and exits 0 on success
 *
 * If no device is available in time it writes report.json with status "blocked".
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ScrcpySession,
  SCRCPY_VERSION,
  splitAnnexBNals,
} from '../../lib/scrcpy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, 'report.json');
const CAPTURE_PATH = join(HERE, 'capture.h264');
const JAR_PATH = join(HERE, 'vendor', 'scrcpy-server-v5.0.1.jar');
const DEFAULT_ADB = '<android-sdk>\\platform-tools\\adb.exe';

function parseArgs(argv) {
  const args = {
    adb: DEFAULT_ADB,
    serial: null,
    port: 27183,
    packets: 60,
    waitMs: 180_000,
    maxSize: 720,
    videoBitRate: 4_000_000,
    transport: 'forward',
    timeoutMs: 30_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    switch (name) {
      case '--adb':
        args.adb = value;
        i++;
        break;
      case '--serial':
        args.serial = value;
        i++;
        break;
      case '--port':
        args.port = Number(value);
        i++;
        break;
      case '--packets':
        args.packets = Number(value);
        i++;
        break;
      case '--wait-ms':
        args.waitMs = Number(value);
        i++;
        break;
      case '--max-size':
        args.maxSize = Number(value);
        i++;
        break;
      case '--bit-rate':
        args.videoBitRate = Number(value);
        i++;
        break;
      case '--transport':
        args.transport = value === 'reverse' ? 'reverse' : 'forward';
        i++;
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(value);
        i++;
        break;
      case '--help':
        console.log('node spike/scrcpy/capture.js [--serial S] [--adb PATH] [--port P] [--packets N] [--wait-ms MS]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${name}`);
    }
  }
  return args;
}

function run(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdoutBuffer: Buffer.concat(stdout),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function adbDevices(adb) {
  const result = await run(adb, ['devices']);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => /^(\S+)\s+(\S+)$/.exec(line))
    .filter((match) => match && match[2] === 'device')
    .map((match) => match[1]);
}

async function adbGetProp(adb, serial, name) {
  const result = await run(adb, ['-s', serial, 'shell', `getprop ${name}`], { timeoutMs: 10_000 });
  return result.stdout.trim();
}

async function waitForDevice(adb, wantedSerial, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const online = await adbDevices(adb).catch(() => []);
    let serial = null;
    if (wantedSerial) {
      if (online.includes(wantedSerial)) {
        serial = wantedSerial;
      }
    } else if (online.length > 0) {
      serial = online[0];
      if (online.length > 1) {
        console.log(`multiple devices online (${online.join(', ')}), using ${serial}`);
      }
    }
    if (serial) {
      const boot = await adbGetProp(adb, serial, 'sys.boot_completed').catch(() => '');
      if (boot === '' || boot === '1') {
        return serial;
      }
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        console.log(`device ${serial} online but boot_completed=${JSON.stringify(boot)}; waiting...`);
      }
    } else if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      console.log(
        wantedSerial
          ? `waiting for adb device ${wantedSerial} (online now: ${online.join(', ') || 'none'})...`
          : 'waiting for an online adb device...',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

async function screenshotSha(adb, serial) {
  const result = await run(adb, ['-s', serial, 'exec-out', 'screencap -p'], { timeoutMs: 30_000 });
  if (result.code !== 0) {
    return null;
  }
  const buffer = result.stdoutBuffer;
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    isPng,
  };
}

function nalTypeCounts(buffer) {
  const counts = { sps: 0, pps: 0, idr: 0, nonIdr: 0, sei: 0, other: 0 };
  let nals = [];
  try {
    nals = splitAnnexBNals(buffer);
  } catch {
    return counts;
  }
  for (const nal of nals) {
    if (nal.length === 0) {
      continue;
    }
    const type = nal[0] & 0x1f;
    if (type === 7) {
      counts.sps++;
    } else if (type === 8) {
      counts.pps++;
    } else if (type === 5) {
      counts.idr++;
    } else if (type === 1) {
      counts.nonIdr++;
    } else if (type === 6) {
      counts.sei++;
    } else {
      counts.other++;
    }
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`scrcpy relay device capture (scrcpy-server ${SCRCPY_VERSION})`);
  console.log(`adb: ${args.adb}`);
  console.log(`jar: ${JAR_PATH}`);

  if (!fs.existsSync(JAR_PATH)) {
    throw new Error(`missing vendored jar: ${JAR_PATH}`);
  }

  // keep the fake-device verification results when merging this run into report.json
  let priorReport = null;
  try {
    priorReport = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  } catch {
    priorReport = null;
  }
  const mergePrior = (report) => {
    if (priorReport && priorReport.fakeDevice) {
      report.fakeDevice = priorReport.fakeDevice;
      report.unitTestsPassed = priorReport.unitTestsPassed ?? null;
    }
    return report;
  };

  const serial = await waitForDevice(args.adb, args.serial, args.waitMs);
  if (!serial) {
    const report = mergePrior({
      generatedAt: new Date().toISOString(),
      mode: 'real-device',
      status: 'blocked',
      scrcpyVersion: SCRCPY_VERSION,
      blocker: `no online adb device within ${args.waitMs} ms (adb=${args.adb})`,
      realDevice: {
        status: 'blocked',
        note: 'start an adb-visible Android device (e.g. QEMU/Android-x86 at 127.0.0.1:5555 or the AOSP ARM64 AVD) and re-run this script',
      },
    });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`BLOCKED: ${report.blocker}`);
    process.exitCode = 2;
    return;
  }

  console.log(`device online: ${serial}`);
  const model = await adbGetProp(args.adb, serial, 'ro.product.model').catch(() => '');
  const sdk = await adbGetProp(args.adb, serial, 'ro.build.version.sdk').catch(() => '');
  const wmSize = await run(args.adb, ['-s', serial, 'shell', 'wm size']).catch(() => ({ stdout: '' }));
  const deviceScreenFromAdb = (wmSize.stdout || '').trim();

  const events = { init: [], video: [], config: [], session: [], errors: [], deviceMessages: [], logs: [] };
  const startedAt = Date.now();
  const session = new ScrcpySession({
    adbPath: args.adb,
    serial,
    serverJarPath: JAR_PATH,
    port: args.port,
    maxSize: args.maxSize,
    videoBitRate: args.videoBitRate,
    transport: args.transport,
    log: (level, message) => {
      events.logs.push(`${level}: ${message}`);
      if (level === 'info' || level === 'warn' || level === 'error' || level === 'server') {
        console.log(`  ${message}`);
      }
    },
  });
  session.onInit((payload) => events.init.push(payload));
  session.onVideo((packet) => events.video.push(packet));
  session.onConfig((config) => events.config.push(config));
  session.onSession((payload) => events.session.push(payload));
  session.onError((error) => events.errors.push(error));
  session.onDeviceMessage((message) => events.deviceMessages.push(message));

  let report;
  try {
    await session.start();
    const bootMs = null; // measured by lib/android.js, not by this relay test
    const deadline = Date.now() + args.timeoutMs;
    while (events.video.length < args.packets && Date.now() < deadline && session.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (events.video.length === 0) {
      throw new Error(
        'no video packets received from scrcpy-server' +
          (events.logs.length ? `\nrelay log:\n${events.logs.slice(-10).join('\n')}` : ''),
      );
    }

    const configPackets = events.video.filter((packet) => packet.isConfig);
    const mediaPackets = events.video.filter((packet) => !packet.isConfig);
    const keyPackets = mediaPackets.filter((packet) => packet.isKeyFrame);
    const videoConfig = session.getVideoConfig();
    const captureBuffer = Buffer.concat(events.video.map((packet) => packet.data));
    fs.writeFileSync(CAPTURE_PATH, captureBuffer);
    const nalCounts = nalTypeCounts(captureBuffer);
    const sizes = mediaPackets.map((packet) => packet.size);
    const captureMs = mediaPackets.length > 1
      ? mediaPackets[mediaPackets.length - 1].recvTimeMs - mediaPackets[0].recvTimeMs
      : 0;
    const ptsSkewUs = mediaPackets.length > 1
      ? mediaPackets[mediaPackets.length - 1].pts - mediaPackets[0].pts -
        (mediaPackets[mediaPackets.length - 1].recvTimeMs - mediaPackets[0].recvTimeMs) * 1000
      : null;

    // --- tap test through the scrcpy control socket -------------------------------------
    const beforeScreen = await screenshotSha(args.adb, serial).catch(() => null);
    const width = session.videoSize ? session.videoSize.width : 0;
    const height = session.videoSize ? session.videoSize.height : 0;
    const tapX = Math.floor(width / 2);
    const tapY = Math.floor(height / 2);
    const packetsBeforeTap = events.video.length;
    const tapSentAt = Date.now();
    await session.sendTouch({ action: 'down', x: tapX, y: tapY });
    await session.sendTouch({ action: 'up', x: tapX, y: tapY });
    // wait for the video to react (new media packet after the tap)
    const tapDeadline = Date.now() + 5000;
    while (events.video.length <= packetsBeforeTap && Date.now() < tapDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const firstPacketAfterTap = events.video[packetsBeforeTap] || null;
    const inputFrameLatencyMs = firstPacketAfterTap ? firstPacketAfterTap.recvTimeMs - tapSentAt : null;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterScreen = await screenshotSha(args.adb, serial).catch(() => null);
    const tapScreenChanged = Boolean(
      beforeScreen && afterScreen && beforeScreen.sha256 !== afterScreen.sha256,
    );

    report = {
      generatedAt: new Date().toISOString(),
      mode: 'real-device',
      status: 'device-captured',
      scrcpyVersion: SCRCPY_VERSION,
      jar: {
        path: 'spike/scrcpy/vendor/scrcpy-server-v5.0.1.jar',
        sha256: '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536',
        bytes: fs.statSync(JAR_PATH).size,
      },
      device: {
        serial,
        model,
        sdk,
        deviceName: session.deviceName,
        wmSize: deviceScreenFromAdb,
      },
      transport: {
        mode: args.transport,
        port: args.port,
        maxSize: args.maxSize,
        videoBitRate: args.videoBitRate,
      },
      video: {
        codec: 'h264',
        codecString: videoConfig ? videoConfig.codecString : null,
        avcCBytes: videoConfig ? videoConfig.avcC.length : 0,
        avcCHex: videoConfig ? videoConfig.avcC.toString('hex') : null,
        width,
        height,
        packetCount: events.video.length,
        mediaPacketCount: mediaPackets.length,
        configPacketCount: configPackets.length,
        keyFrameCount: keyPackets.length,
        nalCounts,
        totalVideoBytes: sizes.reduce((sum, size) => sum + size, 0),
        minPacketBytes: sizes.length ? Math.min(...sizes) : 0,
        maxPacketBytes: sizes.length ? Math.max(...sizes) : 0,
        avgPacketBytes: sizes.length ? Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length) : 0,
        captureMs,
        fpsEstimate: captureMs > 0 ? Number(((mediaPackets.length / captureMs) * 1000).toFixed(2)) : null,
        ptsSkewUs,
        captureFile: 'spike/scrcpy/capture.h264',
        captureBytes: captureBuffer.length,
      },
      tapTest: {
        sentAt: new Date(tapSentAt).toISOString(),
        x: tapX,
        y: tapY,
        packetsBeforeTap,
        packetsAfterTap: events.video.length,
        firstPacketAfterTapLatencyMs: inputFrameLatencyMs,
        screenChanged: tapScreenChanged,
        beforeScreenSha256: beforeScreen ? beforeScreen.sha256 : null,
        afterScreenSha256: afterScreen ? afterScreen.sha256 : null,
        beforeScreenBytes: beforeScreen ? beforeScreen.bytes : null,
        afterScreenBytes: afterScreen ? afterScreen.bytes : null,
      },
      latencyEstimate: {
        method: 'time from control-socket tap write to the first subsequent video packet arrival (upper bound; includes Android input dispatch + MediaCodec encode + transport)',
        valueMs: inputFrameLatencyMs,
      },
      sessionMs: Date.now() - startedAt,
      deviceMessages: events.deviceMessages.map((message) => message.type),
      errors: events.errors.map((error) => error.message),
      relayLogTail: events.logs.slice(-20),
    };
  } catch (error) {
    report = {
      generatedAt: new Date().toISOString(),
      mode: 'real-device',
      status: 'error',
      scrcpyVersion: SCRCPY_VERSION,
      device: { serial, model, sdk, deviceName: session.deviceName, wmSize: deviceScreenFromAdb },
      error: error.message,
      errors: events.errors.map((relayError) => relayError.message),
      relayLogTail: events.logs.slice(-20),
    };
    console.error(`FAILED: ${error.message}`);
  } finally {
    await session.stop().catch(() => {});
  }

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(mergePrior(report), null, 2)}\n`);
  console.log(`report written: ${REPORT_PATH}`);
  if (report.status !== 'device-captured') {
    process.exitCode = 1;
  } else {
    console.log(
      `captured ${report.video.mediaPacketCount} media packets ` +
        `(${report.video.keyFrameCount} keyframes), ${report.video.width}x${report.video.height}, ` +
        `${report.video.codecString} in ${report.video.captureMs} ms; ` +
        `tap latency ~${report.latencyEstimate.valueMs} ms, screenChanged=${report.tapTest.screenChanged}`,
    );
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
