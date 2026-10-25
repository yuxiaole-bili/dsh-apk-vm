/**
 * Per-instance H.264 stream relay (scrcpy → WebSocket → client WebCodecs).
 *
 * The default VM's stream lives in index.js for backwards compatibility; this
 * class gives every extra multi-agent instance the same 60 fps path without
 * sharing scrcpy state, ports or encoder sessions.
 */
import { existsSync } from 'node:fs';
import net from 'node:net';

import { ScrcpySession, annexbToAvcc, CONTROL_MESSAGE_TYPE } from './scrcpy.js';

export function isPortFree(port) {
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

export async function pickFreePort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = 28200 + Math.floor(Math.random() * 2000);
    if (await isPortFree(candidate)) return candidate;
  }
  return preferred;
}

export class ScrcpyStream {
  constructor({ vm, jarPath, maxSize = 960, bitrate = 6_000_000, maxFps = 60, preferredPort = 27183, log }) {
    this.vm = vm;
    this.jarPath = jarPath;
    this.maxSize = maxSize;
    this.bitrate = bitrate;
    this.maxFps = maxFps;
    this.preferredPort = preferredPort;
    this.logSink = typeof log === 'function' ? log : null;
    this.clients = new Set();
    this.initWeak = new WeakSet();
    this.idleTimer = null;
    this.state = {
      session: null,
      startPromise: null,
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
  }

  _log(message) {
    if (this.logSink) this.logSink(message);
  }

  status() {
    const st = this.state;
    return {
      enabled: true,
      active: Boolean(st.session && st.session.state === 'running'),
      clients: this.clients.size,
      fps: st.fps,
      maxFps: this.maxFps,
      width: st.dims ? st.dims.width : null,
      height: st.dims ? st.dims.height : null,
      initReady: Boolean(st.dims && st.videoConfig),
      initSent: st.initSent === true,
      pending: st.pending.length,
      sessionState: st.session ? st.session.state : null,
      error: st.lastError ? String(st.lastError.message || st.lastError) : null,
    };
  }

  _broadcastText(payload) {
    const text = JSON.stringify(payload);
    for (const client of this.clients) client.sendText(text);
  }

  _broadcastBinary(buffer) {
    for (const client of this.clients) client.sendBinary(buffer);
  }

  _sendInit() {
    const st = this.state;
    if (!st.dims || !st.videoConfig) return;
    const signature = `${st.dims.width}x${st.dims.height}:${st.videoConfig.codecString}:${Buffer.from(st.videoConfig.avcC).toString('base64')}`;
    const changed = Boolean(st.initSignature && st.initSignature !== signature);
    if (changed) {
      st.init = null;
      st.initSent = false;
      st.initSignature = null;
      st.pending = [];
      this.initWeak = new WeakSet();
    }
    if (!st.init) {
      st.init = {
        type: 'init',
        codec: 'h264',
        codecString: st.videoConfig.codecString,
        description: Buffer.from(st.videoConfig.avcC).toString('base64'),
        width: st.dims.width,
        height: st.dims.height,
        maxFps: this.maxFps,
        bitrate: this.bitrate,
      };
    }
    for (const client of this.clients) {
      if (this.initWeak.has(client)) continue;
      this.initWeak.add(client);
      client.sendText(JSON.stringify(st.init));
    }
    st.initSignature = signature;
    if (st.initSent) return;
    st.initSent = true;
    for (const packet of st.pending.splice(0)) this._broadcastBinary(packet);
  }

  _recordFrame() {
    const st = this.state;
    const now = Date.now();
    st.frames += 1;
    if (!st.fpsAt) st.fpsAt = now;
    if (now - st.fpsAt >= 1000) {
      st.fps = Math.round((st.frames / (now - st.fpsAt)) * 1000 * 10) / 10;
      st.frames = 0;
      st.fpsAt = now;
    }
  }

  _scheduleIdleStop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) void this.stop();
    }, 15000);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  ensure() {
    const st = this.state;
    if (!this.jarPath || !existsSync(this.jarPath)) {
      return Promise.reject(new Error(`scrcpy server jar not found: ${this.jarPath || '(missing)'}`));
    }
    if (st.session && st.session.state === 'running') return Promise.resolve(st);
    if (st.startPromise) return st.startPromise;
    st.startPromise = (async () => {
      try {
        const status = await this.vm.status();
        if (status.state !== 'ready') throw new Error(`instance VM is not ready (state: ${status.state})`);
        try {
          await this.vm.ensureRoot();
        } catch {
          /* shell works too */
        }
        const port = await pickFreePort(this.preferredPort);
        const session = new ScrcpySession({
          adbPath: this.vm.adbPath,
          serial: status.serial,
          serverJarPath: this.jarPath,
          port,
          maxSize: this.maxSize,
          videoBitRate: this.bitrate,
          maxFps: this.maxFps,
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
          this._sendInit();
        });
        session.onConfig((config) => {
          if (!config || !config.avcC) return;
          st.videoConfig = {
            avcC: Buffer.isBuffer(config.avcC) ? config.avcC : Buffer.from(config.avcC),
            codecString: config.codecString,
          };
          this._sendInit();
        });
        session.onSession((payload) => {
          if (!payload || !payload.width || !payload.height) return;
          if (st.dims && st.dims.width === payload.width && st.dims.height === payload.height) return;
          st.dims = { width: payload.width, height: payload.height };
          this._sendInit();
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
          buffer[0] = 1;
          buffer[1] = packet.isKeyFrame ? 1 : 0;
          buffer.writeBigInt64LE(BigInt(Math.round(pts)), 2);
          avcc.copy(buffer, 10);
          this._recordFrame();
          if (st.initSent) this._broadcastBinary(buffer);
          else if (st.pending.length < 240) st.pending.push(buffer);
        });
        session.onError((error) => {
          st.lastError = error instanceof Error ? error : new Error(String(error));
          this._broadcastText({ type: 'error', error: String(st.lastError.message || st.lastError) });
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
        this._broadcastText({ type: 'error', error: String(failure.message || failure) });
        throw failure;
      } finally {
        st.startPromise = null;
      }
    })();
    return st.startPromise;
  }

  /** Forward a scrcpy touch event (multi-pointer capable) to this instance's control socket. */
  async sendTouch(message) {
    const session = this.state.session;
    if (!session || session.state !== 'running') throw new Error('H.264 control stream is not running');
    await session.sendTouch(message);
    return { ok: true };
  }

  async setClipboard(text, paste = false) {
    await this.ensure();
    const session = this.state.session;
    if (!session || session.state !== 'running') throw new Error('H.264 control stream is not running');
    return session.setClipboard(text, { paste });
  }

  async getClipboard() {
    await this.ensure();
    const session = this.state.session;
    if (!session || session.state !== 'running') throw new Error('H.264 control stream is not running');
    return session.requestClipboard();
  }

  handleClient(client) {
    this.clients.add(client);
    this._sendInit();
    if (this.state.initSent && this.state.session && this.state.session.state === 'running') {
      void Promise.resolve(this.state.session.sendEmptyMessage(CONTROL_MESSAGE_TYPE.RESET_VIDEO)).catch(() => {});
    }
    client.onClose(() => {
      this.clients.delete(client);
      if (this.clients.size === 0) this._scheduleIdleStop();
    });
    client.onError(() => {
      this.clients.delete(client);
      if (this.clients.size === 0) this._scheduleIdleStop();
    });
    this.ensure().catch((error) => {
      const message = String((error && error.message) || error);
      client.sendText(JSON.stringify({ type: 'error', error: message }));
      client.close(1011, 'stream unavailable');
    });
  }

  async stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const st = this.state;
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
    for (const client of this.clients) {
      try {
        client.close(1001, 'video stream stopped');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (session) {
      try {
        await session.stop();
      } catch {
        /* ignore */
      }
    }
  }
}
