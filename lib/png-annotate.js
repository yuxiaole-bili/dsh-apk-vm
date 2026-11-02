import zlib from 'node:zlib';
import { decodePng } from './image-features.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

/** Encode RGBA pixels as an 8-bit, non-interlaced PNG. */
export function encodePng({ width, height, pixels }) {
  if (!width || !height || !pixels || pixels.length !== width * height * 4) {
    throw new Error('png-annotate: invalid RGBA pixels');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    raw[target] = 0;
    pixels.copy ? pixels.copy(raw, target + 1, y * width * 4, (y + 1) * width * 4) : Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, target + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function drawRect(pixels, width, height, rect, color) {
  const x1 = Math.max(0, Math.min(width - 1, Math.round(Number(rect.x1) || 0)));
  const y1 = Math.max(0, Math.min(height - 1, Math.round(Number(rect.y1) || 0)));
  const x2 = Math.max(x1, Math.min(width - 1, Math.round(Number(rect.x2) || x1)));
  const y2 = Math.max(y1, Math.min(height - 1, Math.round(Number(rect.y2) || y1)));
  const draw = (x, y) => {
    const index = (y * width + x) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = 230;
  };
  for (let t = 0; t < 2; t += 1) {
    for (let x = x1; x <= x2 && x < width; x += 1) {
      if (y1 + t < height) draw(x, y1 + t);
      if (y2 - t >= 0) draw(x, y2 - t);
    }
    for (let y = y1; y <= y2 && y < height; y += 1) {
      if (x1 + t < width) draw(x1 + t, y);
      if (x2 - t >= 0) draw(x2 - t, y);
    }
  }
  return { x1, y1, x2, y2 };
}

/**
 * Draw UIAutomator bounds over a PNG screencap.
 * @param {Buffer} png screenshot bytes
 * @param {Array<{bounds?:object,text?:string,contentDesc?:string,resourceId?:string}>} nodes
 */
export function annotateScreenshot(png, nodes, options = {}) {
  const decoded = decodePng(png);
  const pixels = Buffer.from(decoded.pixels);
  const boxed = [];
  const colors = [
    [255, 71, 87],
    [255, 184, 48],
    [46, 213, 115],
  ];
  const list = (Array.isArray(nodes) ? nodes : []).slice(0, Math.max(1, Number(options.maxNodes) || 80));
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    if (!node || !node.bounds) continue;
    const rect = node.bounds;
    const color = colors[i % colors.length];
    const box = drawRect(pixels, decoded.width, decoded.height, rect, color);
    boxed.push({
      ...box,
      color,
      label: node.text || node.contentDesc || node.resourceId || node.className || null,
    });
  }
  return {
    buffer: encodePng({ width: decoded.width, height: decoded.height, pixels }),
    width: decoded.width,
    height: decoded.height,
    boxes: boxed,
  };
}

export { PNG_SIGNATURE };
