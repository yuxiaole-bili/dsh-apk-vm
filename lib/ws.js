/**
 * Minimal RFC 6455 WebSocket server side used by the APK VM video bridge.
 * No dependencies: handshake + unmasked server frames + masked client frames
 * (close/ping only; the video path is server→client). One instance per socket.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Complete the upgrade handshake and return a small connection face.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} _head bytes read after the HTTP request (unused: client sends no early data)
 * @returns {null | { sendText(s:string):boolean, sendBinary(b:Buffer|Uint8Array):boolean, close(code?:number, reason?:string):void, onClose(fn:()=>void):void, onError(fn:(e:Error)=>void):void, readonly closed:boolean }}
 */
export function acceptWebSocket(req, socket, _head) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n',
  );
  socket.setNoDelay(true);

  let closed = false;
  let buffer = Buffer.alloc(0);
  const closeHandlers = [];
  const errorHandlers = [];

  function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, data.length]);
    } else if (data.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    return Buffer.concat([header, data]);
  }

  function writeFrame(opcode, payload) {
    if (closed || socket.destroyed) return false;
    try {
      socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendText(text) {
    return writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  function sendBinary(data) {
    return writeFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    try {
      socket.removeListener('data', onData);
      socket.removeListener('close', cleanup);
      socket.removeListener('error', onSocketError);
      socket.removeListener('end', cleanup);
    } catch {
      /* ignore */
    }
    for (const fn of closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function close(code = 1000, reason = '') {
    if (closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    writeFrame(0x8, payload);
    cleanup();
    try {
      socket.end();
    } catch {
      socket.destroy();
    }
  }

  function onSocketError(error) {
    for (const fn of errorHandlers.splice(0)) {
      try {
        fn(error);
      } catch {
        /* ignore */
      }
    }
    cleanup();
  }

  function onData(chunk) {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER) {
      close(1009, 'buffer too large');
      return;
    }
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_BUFFER)) {
          close(1009, 'frame too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        const out = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        close(1000);
        return;
      }
      if (opcode === 0x9) {
        writeFrame(0xa, payload);
        continue;
      }
      /* 0x1/0x2/0xa frames from the browser are ignored (video is one-way). */
      if (!fin) {
        close(1003, 'fragmented frames unsupported');
        return;
      }
    }
  }

  socket.on('data', onData);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', onSocketError);

  return {
    sendText,
    sendBinary,
    close,
    onClose(fn) {
      if (typeof fn === 'function') closeHandlers.push(fn);
    },
    onError(fn) {
      if (typeof fn === 'function') errorHandlers.push(fn);
    },
    get closed() {
      return closed;
    },
  };
}
