// Smoke test for the H.264 WebSocket relay (no decode; measures packet rate).
const url = process.env.APK_VM_WS || 'ws://127.0.0.1:<dsh-port>/apk-vm/ws';
const durationMs = Number(process.env.APK_VM_TEST_MS || 8000);
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
let init = null;
let packets = 0;
let keyFrames = 0;
let bytes = 0;
let firstInitAt = null;
let firstPacketAt = null;
const started = Date.now();
const errors = [];

ws.onmessage = (event) => {
  if (typeof event.data === 'string') {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'init') {
        init = message;
        if (!firstInitAt) firstInitAt = Date.now() - started;
      } else if (message.type === 'error') {
        errors.push(message.error);
      }
    } catch {
      /* ignore */
    }
    return;
  }
  const bytesView = new Uint8Array(event.data);
  if (bytesView.byteLength < 10 || bytesView[0] !== 1) return;
  packets += 1;
  bytes += bytesView.byteLength;
  if ((bytesView[1] & 1) === 1) keyFrames += 1;
  if (!firstPacketAt) firstPacketAt = Date.now() - started;
};

ws.onerror = () => errors.push('ws error');

const timer = setTimeout(() => {
  const seconds = (Date.now() - started) / 1000;
  const result = {
    init: init ? { codec: init.codec, codecString: init.codecString, width: init.width, height: init.height, maxFps: init.maxFps, descriptionBytes: init.description ? Buffer.from(init.description, 'base64').length : 0 } : null,
    packets,
    keyFrames,
    bytes,
    seconds: Math.round(seconds * 100) / 100,
    avgFps: Math.round((packets / seconds) * 10) / 10,
    firstInitMs: firstInitAt,
    firstPacketMs: firstPacketAt,
    errors,
  };
  console.log(JSON.stringify(result, null, 2));
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, durationMs);

// Do not exit early when the socket closes unexpectedly.
ws.onclose = () => {
  if (!init && !packets && errors.length === 0) errors.push('closed without init');
};
