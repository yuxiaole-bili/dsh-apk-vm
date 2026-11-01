/**
 * Tiny dependency-free image features for UI control matching.
 *
 * The APK VM already receives PNG screencaps. When a Skill wants to identify a
 * control by appearance (icon-only buttons, custom canvas UI), we crop the
 * control bounds and compute two cheap features:
 *   - a 64-bit difference hash (dHash), stable across small render changes
 *   - an average and dominant RGB colour
 *
 * `image` entries in a codebook are intentionally optional. The Skill matcher
 * always combines them with structural features when structural features exist,
 * so a similar-looking button elsewhere cannot win by itself.
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('image-features: not a PNG buffer');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error(`image-features: truncated PNG chunk ${type}`);
    chunks.push({ type, data: buffer.subarray(start, end) });
    if (type === 'IEND') break;
    offset = end + 4;
  }
  return chunks;
}

/** Decode an 8-bit non-interlaced PNG into RGBA pixels. */
export function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('image-features: missing IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filter = ihdr.data[11];
  const interlace = ihdr.data[12];
  if (!width || !height || width > 20000 || height > 20000) throw new Error('image-features: unsupported PNG dimensions');
  if (bitDepth !== 8) throw new Error(`image-features: unsupported bit depth ${bitDepth}`);
  if (compression !== 0 || filter !== 0) throw new Error('image-features: unsupported PNG compression/filter method');
  if (interlace !== 0) throw new Error('image-features: interlaced PNG is not supported');

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels && colorType !== 3) throw new Error(`image-features: unsupported PNG colour type ${colorType}`);
  const palette = chunks.find((chunk) => chunk.type === 'PLTE');
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (!idat.length) throw new Error('image-features: missing IDAT');
  const raw = zlib.inflateSync(idat);

  const bpp = colorType === 3 ? 1 : channels;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error('image-features: short PNG image data');
  const pixels = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[position++];
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position++];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = previous[x];
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      if (filterType === 0) row[x] = value;
      else if (filterType === 1) row[x] = (value + left) & 0xff;
      else if (filterType === 2) row[x] = (value + up) & 0xff;
      else if (filterType === 3) row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) row[x] = (value + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`image-features: unsupported PNG filter ${filterType}`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * bpp;
      const target = (y * width + x) * 4;
      if (colorType === 0) {
        const grey = row[source];
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] = 255;
      } else if (colorType === 2) {
        pixels[target] = row[source];
        pixels[target + 1] = row[source + 1];
        pixels[target + 2] = row[source + 2];
        pixels[target + 3] = 255;
      } else if (colorType === 3) {
        const index = row[source] * 3;
        if (!palette || index + 2 >= palette.data.length) throw new Error('image-features: invalid PNG palette');
        pixels[target] = palette.data[index];
        pixels[target + 1] = palette.data[index + 1];
        pixels[target + 2] = palette.data[index + 2];
        pixels[target + 3] = 255;
      } else if (colorType === 4) {
        const grey = row[source];
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] = row[source + 1];
      } else {
        pixels[target] = row[source];
        pixels[target + 1] = row[source + 1];
        pixels[target + 2] = row[source + 2];
        pixels[target + 3] = row[source + 3];
      }
    }
    previous = row;
  }
  return { width, height, pixels };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normaliseBounds(bounds, width, height) {
  if (!bounds || typeof bounds !== 'object') return { x: 0, y: 0, width, height };
  const x1 = clamp(Math.floor(Number(bounds.x1 ?? 0)), 0, width - 1);
  const y1 = clamp(Math.floor(Number(bounds.y1 ?? 0)), 0, height - 1);
  const x2 = clamp(Math.ceil(Number(bounds.x2 ?? width)), x1 + 1, width);
  const y2 = clamp(Math.ceil(Number(bounds.y2 ?? height)), y1 + 1, height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function hex64(value) {
  return value.toString(16).padStart(16, '0');
}

/**
 * Compute dHash + colour features for one crop of a PNG screencap.
 * @param {Buffer} buffer PNG bytes.
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} bounds device-pixel bounds.
 */
export function computeImageFeatures(buffer, bounds, options = {}) {
  const decoded = options.decoded || decodePng(buffer);
  const crop = normaliseBounds(bounds, decoded.width, decoded.height);
  const maxSamples = Math.max(64, Number(options.maxSamples) || 12000);
  const step = Math.max(1, Math.floor(Math.sqrt((crop.width * crop.height) / maxSamples)));
  const histogram = new Map();
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = crop.y; y < crop.y + crop.height; y += step) {
    for (let x = crop.x; x < crop.x + crop.width; x += step) {
      const index = (y * decoded.width + x) * 4;
      const alpha = decoded.pixels[index + 3];
      if (alpha === 0) continue;
      const red = decoded.pixels[index];
      const green = decoded.pixels[index + 1];
      const blue = decoded.pixels[index + 2];
      r += red;
      g += green;
      b += blue;
      count += 1;
      const bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
      const item = histogram.get(bucket) || { count: 0, r: 0, g: 0, b: 0 };
      item.count += 1;
      item.r += red;
      item.g += green;
      item.b += blue;
      histogram.set(bucket, item);
    }
  }
  if (!count) throw new Error('image-features: crop has no visible pixels');
  const average = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  let dominant = average;
  let best = null;
  for (const item of histogram.values()) if (!best || item.count > best.count) best = item;
  if (best) dominant = [Math.round(best.r / best.count), Math.round(best.g / best.count), Math.round(best.b / best.count)];
  const colors = [...histogram.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
    .map((item) => ({
      rgb: [Math.round(item.r / item.count), Math.round(item.g / item.count), Math.round(item.b / item.count)],
      ratio: Math.round((item.count / count) * 1000) / 1000,
    }));

  // 9x8 nearest-neighbour grayscale sample -> 8x8 horizontal difference bits.
  const samples = new Array(9);
  for (let column = 0; column < 9; column += 1) {
    const x = Math.min(crop.x + crop.width - 1, crop.x + Math.floor(((column + 0.5) / 9) * crop.width));
    samples[column] = new Array(8);
    for (let row = 0; row < 8; row += 1) {
      const y = Math.min(crop.y + crop.height - 1, crop.y + Math.floor(((row + 0.5) / 8) * crop.height));
      const index = (y * decoded.width + x) * 4;
      const grey = Math.round(0.299 * decoded.pixels[index] + 0.587 * decoded.pixels[index + 1] + 0.114 * decoded.pixels[index + 2]);
      samples[column][row] = grey;
    }
  }
  let bits = 0n;
  let bitIndex = 0;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (samples[column][row] < samples[column + 1][row]) bits |= 1n << BigInt(bitIndex);
      bitIndex += 1;
    }
  }
  return {
    version: 1,
    width: crop.width,
    height: crop.height,
    hash: hex64(bits),
    avgColor: average,
    dominantColor: dominant,
    colors,
    samples: count,
  };
}

function toColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const rgb = value.slice(0, 3).map((part) => clamp(Math.round(Number(part)), 0, 255));
  return rgb.every((part) => Number.isFinite(part)) ? rgb : null;
}

/** Normalise a codebook `image` object; returns null when no usable feature exists. */
export function normalizeImageFeatures(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name ? String(raw.name).slice(0, 120) : '';
  const hash = raw.hash ? String(raw.hash).toLowerCase().replace(/[^0-9a-f]/g, '') : '';
  const avgColor = toColor(raw.avgColor || raw.averageColor);
  const dominantColor = toColor(raw.dominantColor);
  if (!name && !hash && !avgColor && !dominantColor) return null;
  return {
    name,
    hash: hash || null,
    avgColor: avgColor || null,
    dominantColor: dominantColor || null,
    maxDistance: Number.isFinite(Number(raw.maxDistance)) ? Math.max(0, Number(raw.maxDistance)) : 10,
    colorTolerance: Number.isFinite(Number(raw.colorTolerance)) ? Math.max(0, Number(raw.colorTolerance)) : 36,
  };
}

export function hammingDistance(left, right) {
  const a = BigInt(`0x${String(left || '0').replace(/[^0-9a-f]/gi, '') || '0'}`);
  const b = BigInt(`0x${String(right || '0').replace(/[^0-9a-f]/gi, '') || '0'}`);
  let value = a ^ b;
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

function colorDistance(left, right) {
  return Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2);
}

/**
 * Compare expected codebook features with computed screenshot features.
 * A hash is the strongest signal; colours are a loose secondary signal.
 */
/**
 * Attach computed image features to parsed UIAutomator nodes.
 * Decoding happens once; only nodes with valid device bounds are sampled.
 * @param {Buffer} buffer PNG screencap
 * @param {Array} nodes parsed nodes (mutated: sets node.imageFeatures)
 */
export function attachNodeImageFeatures(buffer, nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return list;
  const decoded = options.decoded || decodePng(buffer);
  for (const node of list) {
    if (!node || !node.bounds) continue;
    const bounds = node.bounds;
    if (!(bounds.width > 0) || !(bounds.height > 0)) continue;
    try {
      node.imageFeatures = computeImageFeatures(buffer, bounds, { ...options, decoded });
    } catch {
      // A zero-area or fully transparent node simply has no image features.
    }
  }
  return list;
}

export function compareImageFeatures(expectedRaw, actualRaw, options = {}) {
  const expected = normalizeImageFeatures(expectedRaw);
  const actual = actualRaw ? normalizeImageFeatures(actualRaw) : null;
  if (!expected) return { ok: false, reason: 'no expected image features' };
  if (!actual) return { ok: false, reason: 'no screenshot image features available' };
  const reasons = [];
  if (expected.hash && actual.hash) {
    const distance = hammingDistance(expected.hash, actual.hash);
    const max = Number.isFinite(Number(options.maxDistance)) ? Number(options.maxDistance) : expected.maxDistance;
    if (distance > max) reasons.push(`hash distance ${distance} > ${max}`);
    else reasons.push(`hash distance ${distance}`);
  }
  const tolerance = Number.isFinite(Number(options.colorTolerance))
    ? Number(options.colorTolerance)
    : expected.colorTolerance;
  if (expected.avgColor && actual.avgColor) {
    const distance = colorDistance(expected.avgColor, actual.avgColor);
    if (distance > tolerance * 2) reasons.push(`average colour distance ${Math.round(distance)} > ${tolerance * 2}`);
    else reasons.push(`average colour distance ${Math.round(distance)}`);
  }
  if (expected.dominantColor && actual.dominantColor) {
    const distance = colorDistance(expected.dominantColor, actual.dominantColor);
    if (distance > tolerance * 2) reasons.push(`dominant colour distance ${Math.round(distance)} > ${tolerance * 2}`);
    else reasons.push(`dominant colour distance ${Math.round(distance)}`);
  }
  return {
    ok: !reasons.some((reason) => reason.includes(' > ')),
    expected: { hash: expected.hash, avgColor: expected.avgColor },
    actual: { hash: actual.hash, avgColor: actual.avgColor },
    details: reasons,
  };
}
