#!/usr/bin/env node
/**
 * make-demo-gif.mjs — dependency-free animated GIF encoder for Android VM demos.
 *
 * Frames are raw Android `screencap` dumps (12-byte little-endian header plus
 * RGBA pixels; some AVD images emit a 16-byte prefix — the layout is detected
 * from the file size) or bare RGBA pixel buffers. The encoder downsamples,
 * quantizes to at most 256 colors, and writes a GIF89a with a global color
 * table, per-frame local tables by default, and a Netscape loop extension.
 *
 * Run `node scripts/make-demo-gif.mjs --help` for the CLI, or
 * `node scripts/make-demo-gif.mjs --selftest` for an end-to-end round-trip.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DIMENSION = 65535;
const COLOR_TABLE_SIZE = 256;
const HISTOGRAM_SIZE = 1 << 15;
const MIN_CODE_SIZE = 8;

/**
 * @typedef {object} FrameProgress
 * @property {number} index Zero-based frame index.
 * @property {number} bytes Bytes emitted for this frame's blocks.
 * @property {number} totalBytes Bytes emitted so far, including the header.
 * @property {number} width Scaled output width.
 * @property {number} height Scaled output height.
 * @property {number} delay Frame delay in centiseconds.
 * @property {'local'|'global'} palette Palette used by the frame.
 */

/**
 * @typedef {object} EncodeGifOptions
 * @property {number} [width] Fallback source width for bare RGBA frames.
 * @property {number} [height] Fallback source height for bare RGBA frames.
 * @property {number} [scale=1] Downscale factor in (0, 1]. Output is even-sized.
 * @property {number} [fps=10] Playback rate used to derive GIF delays (1-100).
 * @property {number} [colors=256] Quantizer palette size (2-256).
 * @property {number} [loop=0] Netscape loop count (0 = infinite, 0-65535).
 * @property {'local'|'global'} [palette='local'] Use per-frame local palettes or
 *   one global palette derived from the first frame.
 * @property {'box'|'nearest'} [sampling='box'] Downsampling filter.
 * @property {(info: FrameProgress) => void} [onFrame] Called after each frame is
 *   written; useful for progress output.
 */

/**
 * @typedef {object} FrameInput
 * @property {Uint8Array} data Raw RGBA bytes (R, G, B, A order), no header.
 * @property {number} [width] Frame width; falls back to the encoder option.
 * @property {number} [height] Frame height; falls back to the encoder option.
 * @property {number} [delay] Delay in centiseconds; overrides fps.
 * @property {string} [name] Optional label used in error messages.
 */

/**
 * Encode raw RGBA frames as an animated GIF89a.
 *
 * Each frame may be a plain Uint8Array (with `opts.width` and `opts.height`)
 * or a FrameInput object. Frames are consumed lazily, so a generator can keep
 * memory bounded. The returned Buffer is the complete .gif file.
 *
 * @param {Iterable<Uint8Array|FrameInput>} frames
 * @param {EncodeGifOptions} [opts]
 * @returns {Buffer}
 */
export function encodeGif(frames, opts = {}) {
  const options = normalizeOptions(opts);

  if (!frames || typeof frames[Symbol.iterator] !== 'function') {
    throw new Error('encodeGif: frames must be an iterable of RGBA frames');
  }

  const iterator = frames[Symbol.iterator]();
  const firstStep = iterator.next();
  if (firstStep.done) throw new Error('encodeGif: no frames to encode');

  const quantizer = createQuantizer();
  const indexCache = new Int16Array(HISTOGRAM_SIZE);

  let pixels = prepareFramePixels(firstStep.value, options, 0);
  firstStep.value = null;
  const outputWidth = pixels.width;
  const outputHeight = pixels.height;
  let firstPalette = quantizeFrame(quantizer, pixels.rgb, options.colors);
  let firstIndices = mapPixelsToPalette(pixels.rgb, firstPalette, indexCache);
  const globalPalette = firstPalette;

  const parts = [];
  let totalBytes = 0;
  const push = (chunk) => {
    parts.push(chunk);
    totalBytes += chunk.length;
  };

  const header = buildHeader(outputWidth, outputHeight, globalPalette, options.loop);
  push(header.logicalScreen);
  push(header.loopExtension);

  let frameCount = 0;
  let frame = writeFrame({
    pixels,
    palette: firstPalette,
    indices: firstIndices,
    useLocalPalette: false,
  });
  appendChunks(frame.chunks);
  reportFrame(0, frame.bytes, totalBytes, pixels.delay);
  frameCount += 1;
  pixels.rgb = null;
  firstIndices = null;
  firstPalette = null;
  frame = null;
  pixels = null;

  for (;;) {
    const step = iterator.next();
    if (step.done) break;

    pixels = prepareFramePixels(step.value, options, frameCount);
    if (pixels.width !== outputWidth || pixels.height !== outputHeight) {
      throw new Error(
        `encodeGif: frame ${frameCount} is ${pixels.width}x${pixels.height} after scaling; ` +
          `expected ${outputWidth}x${outputHeight} (all frames must match)`,
      );
    }

    let palette = globalPalette;
    let useLocalPalette = false;
    let indices;
    if (options.palette === 'local') {
      palette = quantizeFrame(quantizer, pixels.rgb, options.colors);
      useLocalPalette = true;
      indices = mapPixelsToPalette(pixels.rgb, palette, indexCache);
    } else {
      indices = mapPixelsToPalette(pixels.rgb, palette, indexCache);
    }

    frame = writeFrame({
      pixels,
      palette,
      indices,
      useLocalPalette,
    });
    appendChunks(frame.chunks);
    reportFrame(frameCount, frame.bytes, totalBytes, pixels.delay);
    frameCount += 1;
    pixels.rgb = null;
    pixels = null;
    indices = null;
    palette = null;
    frame = null;
    step.value = null;
  }

  if (frameCount === 0) throw new Error('encodeGif: no frames to encode');
  push(Buffer.from([0x3b]));

  const gif = Buffer.concat(parts, totalBytes);
  parts.length = 0;
  return gif;

  function appendChunks(chunks) {
    for (let i = 0; i < chunks.length; i += 1) push(chunks[i]);
  }

  function reportFrame(index, bytes, cumulativeBytes, delay) {
    if (!options.onFrame) return;
    options.onFrame({
      index,
      bytes,
      totalBytes: cumulativeBytes,
      width: outputWidth,
      height: outputHeight,
      delay,
      palette: useReportedPalette(index),
    });
  }

  function useReportedPalette(index) {
    return options.palette === 'local' && index > 0 ? 'local' : 'global';
  }
}

/**
 * @param {EncodeGifOptions} opts
 * @returns {Required<Omit<EncodeGifOptions, 'onFrame' | 'width' | 'height'>> & {width: number|null, height: number|null, onFrame?: Function}}
 */
function normalizeOptions(opts) {
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error('encodeGif: --scale must be > 0 and <= 1');
  }

  const fps = opts.fps ?? 10;
  if (!Number.isFinite(fps) || fps < 1 || fps > 100) {
    throw new Error('encodeGif: --fps must be between 1 and 100');
  }

  const colors = opts.colors ?? 256;
  if (!Number.isInteger(colors) || colors < 2 || colors > 256) {
    throw new Error('encodeGif: --colors must be an integer from 2 to 256');
  }

  const loop = opts.loop ?? 0;
  if (!Number.isInteger(loop) || loop < 0 || loop > 65535) {
    throw new Error('encodeGif: --loop must be an integer from 0 to 65535');
  }

  const palette = opts.palette ?? 'local';
  if (palette !== 'local' && palette !== 'global') {
    throw new Error("encodeGif: --palette must be 'local' or 'global'");
  }

  const sampling = opts.sampling ?? 'box';
  if (sampling !== 'box' && sampling !== 'nearest') {
    throw new Error("encodeGif: --sampling must be 'box' or 'nearest'");
  }

  const width = opts.width ?? null;
  const height = opts.height ?? null;
  if ((width === null) !== (height === null)) {
    throw new Error('encodeGif: --width and --height must be provided together');
  }
  if (width !== null) {
    validateSourceDimension(width, 'width');
    validateSourceDimension(height, 'height');
  }

  if (opts.onFrame !== undefined && typeof opts.onFrame !== 'function') {
    throw new Error('encodeGif: onFrame must be a function');
  }

  return {
    width,
    height,
    scale,
    fps,
    colors,
    loop,
    palette,
    sampling,
    onFrame: opts.onFrame,
  };
}

function validateSourceDimension(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error(`encodeGif: ${name} must be an integer from 1 to ${MAX_DIMENSION}`);
  }
}

function prepareFramePixels(frame, options, index) {
  let data;
  let sourceWidth;
  let sourceHeight;
  let delay;
  let name = `frame ${index}`;

  if (frame instanceof Uint8Array) {
    data = frame;
    sourceWidth = options.width;
    sourceHeight = options.height;
  } else if (frame && typeof frame === 'object') {
    data = frame.data;
    sourceWidth = frame.width ?? options.width;
    sourceHeight = frame.height ?? options.height;
    delay = frame.delay;
    if (typeof frame.name === 'string' && frame.name) name = frame.name;
  } else {
    throw new Error(`encodeGif: ${name} must be a Uint8Array or frame object`);
  }

  if (!(data instanceof Uint8Array)) {
    throw new Error(`encodeGif: ${name} has no RGBA data`);
  }
  validateSourceDimension(sourceWidth, `${name} width`);
  validateSourceDimension(sourceHeight, `${name} height`);

  const expected = sourceWidth * sourceHeight * 4;
  if (data.length !== expected) {
    throw new Error(
      `encodeGif: ${name} has ${data.length} bytes; expected ${expected} ` +
        `(${sourceWidth}x${sourceHeight} RGBA)`,
    );
  }

  delay = delay ?? Math.round(100 / options.fps);
  if (!Number.isInteger(delay) || delay < 0 || delay > 65535) {
    throw new Error(`encodeGif: ${name} delay must be an integer from 0 to 65535`);
  }

  const width = outputDimension(sourceWidth, options.scale);
  const height = outputDimension(sourceHeight, options.scale);
  return {
    rgb: downscaleToRgb(data, sourceWidth, sourceHeight, width, height, options.sampling),
    width,
    height,
    delay,
    name,
  };
}

function outputDimension(source, scale) {
  const even = Math.floor((source * scale) / 2) * 2;
  const result = Math.max(2, even);
  if (result > MAX_DIMENSION) {
    throw new Error(`encodeGif: scaled dimension ${result} exceeds ${MAX_DIMENSION}`);
  }
  return result;
}

/**
 * Box-average or nearest-neighbor downscale, compositing RGBA onto black
 * (GIF has no alpha channel). Returns tightly packed RGB bytes.
 */
function downscaleToRgb(rgba, sourceWidth, sourceHeight, width, height, sampling) {
  const out = new Uint8Array(width * height * 3);

  if (sourceWidth === width && sourceHeight === height) {
    let src = 0;
    let dst = 0;
    const pixels = width * height;
    for (let i = 0; i < pixels; i += 1) {
      const alpha = rgba[src + 3];
      if (alpha === 255) {
        out[dst] = rgba[src];
        out[dst + 1] = rgba[src + 1];
        out[dst + 2] = rgba[src + 2];
      } else {
        out[dst] = Math.round((rgba[src] * alpha) / 255);
        out[dst + 1] = Math.round((rgba[src + 1] * alpha) / 255);
        out[dst + 2] = Math.round((rgba[src + 2] * alpha) / 255);
      }
      src += 4;
      dst += 3;
    }
    return out;
  }

  if (sampling === 'nearest') {
    const xMap = new Uint32Array(width);
    const yMap = new Uint32Array(height);
    for (let x = 0; x < width; x += 1) {
      xMap[x] = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / width));
    }
    for (let y = 0; y < height; y += 1) {
      yMap[y] = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / height));
    }
    let dst = 0;
    for (let y = 0; y < height; y += 1) {
      const srcRow = yMap[y] * sourceWidth;
      for (let x = 0; x < width; x += 1) {
        const src = (srcRow + xMap[x]) * 4;
        const alpha = rgba[src + 3];
        out[dst] = Math.round((rgba[src] * alpha) / 255);
        out[dst + 1] = Math.round((rgba[src + 1] * alpha) / 255);
        out[dst + 2] = Math.round((rgba[src + 2] * alpha) / 255);
        dst += 3;
      }
    }
    return out;
  }

  const xRanges = axisRanges(sourceWidth, width);
  const yRanges = axisRanges(sourceHeight, height);
  let dst = 0;
  for (let y = 0; y < height; y += 1) {
    const sy0 = yRanges.starts[y];
    const sy1 = yRanges.ends[y];
    for (let x = 0; x < width; x += 1) {
      const sx0 = xRanges.starts[x];
      const sx1 = xRanges.ends[x];
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        let src = (sy * sourceWidth + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const alpha = rgba[src + 3];
          sumR += rgba[src] * alpha;
          sumG += rgba[src + 1] * alpha;
          sumB += rgba[src + 2] * alpha;
          src += 4;
        }
      }
      const denominator = (sx1 - sx0) * (sy1 - sy0) * 255;
      out[dst] = denominator === 0 ? 0 : Math.round(sumR / denominator);
      out[dst + 1] = denominator === 0 ? 0 : Math.round(sumG / denominator);
      out[dst + 2] = denominator === 0 ? 0 : Math.round(sumB / denominator);
      dst += 3;
    }
  }
  return out;
}

function axisRanges(source, destination) {
  const starts = new Uint32Array(destination);
  const ends = new Uint32Array(destination);
  for (let i = 0; i < destination; i += 1) {
    const start = Math.min(source - 1, Math.floor((i * source) / destination));
    let end = Math.min(source, Math.floor(((i + 1) * source) / destination));
    if (end <= start) end = Math.min(source, start + 1);
    starts[i] = start;
    ends[i] = end;
  }
  return { starts, ends };
}

function createQuantizer() {
  return {
    counts: new Uint32Array(HISTOGRAM_SIZE),
    sumR: new Float64Array(HISTOGRAM_SIZE),
    sumG: new Float64Array(HISTOGRAM_SIZE),
    sumB: new Float64Array(HISTOGRAM_SIZE),
    touched: [],
  };
}

/**
 * Deterministic 5-5-5 popularity quantizer: bucket exact colors, keep the
 * most frequent 256 buckets, and map tail buckets to the nearest kept color.
 */
function quantizeFrame(quantizer, rgb, maxColors) {
  const { counts, sumR, sumG, sumB, touched } = quantizer;
  const pixels = rgb.length / 3;

  for (let i = 0, p = 0; i < pixels; i += 1, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (counts[key] === 0) touched.push(key);
    counts[key] += 1;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }

  const entries = new Array(touched.length);
  for (let i = 0; i < touched.length; i += 1) {
    const key = touched[i];
    const count = counts[key];
    entries[i] = {
      key,
      count,
      r: Math.round(sumR[key] / count),
      g: Math.round(sumG[key] / count),
      b: Math.round(sumB[key] / count),
    };
  }

  if (entries.length > maxColors) {
    entries.sort((a, b) => b.count - a.count || a.key - b.key);
    entries.length = maxColors;
  }

  const size = Math.max(1, entries.length);
  const colors = new Uint8Array(size * 3);
  for (let i = 0; i < size; i += 1) {
    colors[i * 3] = entries[i].r;
    colors[i * 3 + 1] = entries[i].g;
    colors[i * 3 + 2] = entries[i].b;
  }

  for (let i = 0; i < touched.length; i += 1) {
    const key = touched[i];
    counts[key] = 0;
    sumR[key] = 0;
    sumG[key] = 0;
    sumB[key] = 0;
  }
  touched.length = 0;

  return { colors, size };
}

function mapPixelsToPalette(rgb, palette, cache) {
  cache.fill(-1);
  const pixels = rgb.length / 3;
  const indices = Buffer.allocUnsafe(pixels);
  const colors = palette.colors;
  const size = palette.size;

  for (let i = 0, p = 0; i < pixels; i += 1, p += 3) {
    const r = rgb[p];
    const g = rgb[p + 1];
    const b = rgb[p + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let index = cache[key];
    if (index < 0) {
      index = nearestPaletteIndex(r, g, b, colors, size);
      cache[key] = index;
    }
    indices[i] = index;
  }
  return indices;
}

function nearestPaletteIndex(r, g, b, colors, size) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0, p = 0; i < size; i += 1, p += 3) {
    const dr = r - colors[p];
    const dg = g - colors[p + 1];
    const db = b - colors[p + 2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function buildHeader(width, height, palette, loop) {
  const logicalScreen = Buffer.alloc(13 + COLOR_TABLE_SIZE * 3);
  logicalScreen.write('GIF89a', 0, 'ascii');
  logicalScreen.writeUInt16LE(width, 6);
  logicalScreen.writeUInt16LE(height, 8);
  // Global color table present, 8 bits of color resolution, 256 entries.
  logicalScreen[10] = 0xf7;
  logicalScreen[11] = 0;
  logicalScreen[12] = 0;
  writeColorTable(logicalScreen, 13, palette);

  const loopExtension = Buffer.alloc(19);
  loopExtension[0] = 0x21;
  loopExtension[1] = 0xff;
  loopExtension[2] = 0x0b;
  loopExtension.write('NETSCAPE2.0', 3, 'ascii');
  loopExtension[14] = 0x03;
  loopExtension[15] = 0x01;
  loopExtension.writeUInt16LE(loop, 16);
  loopExtension[18] = 0;

  return { logicalScreen, loopExtension };
}

function writeColorTable(buffer, offset, palette) {
  const colors = palette.colors;
  const count = Math.min(palette.size, COLOR_TABLE_SIZE);
  for (let i = 0; i < count; i += 1) {
    buffer[offset + i * 3] = colors[i * 3];
    buffer[offset + i * 3 + 1] = colors[i * 3 + 1];
    buffer[offset + i * 3 + 2] = colors[i * 3 + 2];
  }
}

function writeFrame({ pixels, palette, indices, useLocalPalette }) {
  const chunks = [];
  let bytes = 0;
  const add = (chunk) => {
    chunks.push(chunk);
    bytes += chunk.length;
  };

  const gce = Buffer.alloc(8);
  gce[0] = 0x21;
  gce[1] = 0xf9;
  gce[2] = 0x04;
  gce[3] = 0x04; // Disposal method 1 (do not dispose).
  gce.writeUInt16LE(pixels.delay, 4);
  gce[6] = 0;
  gce[7] = 0;
  add(gce);

  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(0, 1);
  descriptor.writeUInt16LE(0, 3);
  descriptor.writeUInt16LE(pixels.width, 5);
  descriptor.writeUInt16LE(pixels.height, 7);
  descriptor[9] = useLocalPalette ? 0x87 : 0x00;
  add(descriptor);

  if (useLocalPalette) {
    const table = Buffer.alloc(COLOR_TABLE_SIZE * 3);
    writeColorTable(table, 0, palette);
    add(table);
  }

  add(Buffer.from([MIN_CODE_SIZE]));
  add(wrapLzwSubBlocks(lzwEncode(indices)));
  return { chunks, bytes };
}

function lzwEncode(indices) {
  const clearCode = 1 << MIN_CODE_SIZE;
  const endCode = clearCode + 1;
  const capacity = Math.ceil((indices.length * 12) / 8) + 4096;
  const output = Buffer.allocUnsafe(capacity);
  const codeTable = new Map();

  let codeSize = MIN_CODE_SIZE + 1;
  let nextCode = endCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let outPos = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output[outPos] = bitBuffer & 0xff;
      outPos += 1;
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  let current = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const symbol = indices[i];
    const key = (current << 8) | symbol;
    const found = codeTable.get(key);
    if (found !== undefined) {
      current = found;
      continue;
    }

    emit(current);
    if (nextCode === 4096) {
      emit(clearCode);
      nextCode = endCode + 1;
      codeSize = MIN_CODE_SIZE + 1;
      codeTable.clear();
    } else {
      if (nextCode >= 1 << codeSize) codeSize += 1;
      codeTable.set(key, nextCode);
      nextCode += 1;
    }
    current = symbol;
  }

  emit(current);
  emit(endCode);
  if (bitCount > 0) {
    output[outPos] = bitBuffer & 0xff;
    outPos += 1;
  }
  return output.subarray(0, outPos);
}

function wrapLzwSubBlocks(compressed) {
  const blockCount = Math.ceil(compressed.length / 255);
  const output = Buffer.allocUnsafe(compressed.length + blockCount + 1);
  let outPos = 0;
  for (let offset = 0; offset < compressed.length; offset += 255) {
    const length = Math.min(255, compressed.length - offset);
    output[outPos] = length;
    outPos += 1;
    compressed.copy(output, outPos, offset, offset + length);
    outPos += length;
  }
  output[outPos] = 0;
  outPos += 1;
  return output.subarray(0, outPos);
}

function listFrameFiles(dir, excludePath = null) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read input directory ${dir}: ${error.message}`);
  }

  const excluded = excludePath ? path.resolve(excludePath) : null;
  const names = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => !excluded || path.resolve(dir, name) !== excluded);
  names.sort(naturalCompare);
  if (names.length === 0) throw new Error(`no frame files found in ${dir}`);
  return names;
}

function naturalCompare(a, b) {
  const result = a.localeCompare(b, 'en', { numeric: true, sensitivity: 'variant' });
  if (result !== 0) return result;
  return a < b ? -1 : a > b ? 1 : 0;
}

function* loadFrames(dir, names, fallbackWidth, fallbackHeight) {
  for (const name of names) {
    const file = path.join(dir, name);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    const frame = decodeFrameFile(bytes, fallbackWidth, fallbackHeight, name);
    yield {
      data: frame.data,
      width: frame.width,
      height: frame.height,
      name,
    };
  }
}

function decodeFrameFile(buffer, fallbackWidth, fallbackHeight, name) {
  const size = buffer.length;
  let header = null;

  if (size >= 12) {
    const width = buffer.readUInt32LE(0);
    const height = buffer.readUInt32LE(4);
    const format = buffer.readUInt32LE(8);
    const dimensionsValid =
      width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
    if (format === 1 && dimensionsValid) {
      const pixelBytes = width * height * 4;
      // Android's raw `screencap` dump has a 12-byte header (width, height,
      // format), but some AVD images (observed on Android 14 x86_64) prepend
      // four extra bytes, making the prefix 16 bytes. Detect the layout from
      // the file size instead of assuming one of them.
      const headerSize = size - pixelBytes;
      if (headerSize === 12 || headerSize === 16) {
        return { data: buffer.subarray(headerSize), width, height };
      }
      header = { width, height, format, expected12: 12 + pixelBytes, expected16: 16 + pixelBytes };
    } else if (format !== 1 && dimensionsValid) {
      header = { width, height, format, expected: null };
    }
  }

  if (
    fallbackWidth !== null &&
    fallbackHeight !== null &&
    size === fallbackWidth * fallbackHeight * 4
  ) {
    return { data: buffer, width: fallbackWidth, height: fallbackHeight };
  }

  if (header?.expected12) {
    throw new Error(
      `${name}: screencap header declares ${header.width}x${header.height} ` +
        `(${header.expected12} bytes with a 12-byte header, or ${header.expected16} with the ` +
        `16-byte variant) but file is ${size} bytes`,
    );
  }
  if (header) {
    throw new Error(
      `${name}: unsupported screencap format ${header.format}; expected format 1 ` +
        '(RGBA_8888), or provide --width/--height for headerless RGBA',
    );
  }
  if (fallbackWidth !== null && fallbackHeight !== null) {
    throw new Error(
      `${name}: ${size} bytes does not match ${fallbackWidth}x${fallbackHeight} ` +
        `RGBA (${fallbackWidth * fallbackHeight * 4} bytes) or a screencap header; ` +
        'check --width/--height and the frame file',
    );
  }
  throw new Error(
    `${name}: not a screencap file and no fallback dimensions were provided; ` +
      'pass --width W --height H for bare RGBA frames',
  );
}

const USAGE = `Usage:
  node scripts/make-demo-gif.mjs --in <dir> --out <file.gif> [options]
  node scripts/make-demo-gif.mjs --selftest
  node scripts/make-demo-gif.mjs --help

Options:
  --in <dir>        Directory of RGBA frames, sorted naturally.
  --out <file.gif>  Output GIF path.
  --width W         Fallback input width for bare RGBA frames.
  --height H        Fallback input height for bare RGBA frames.
  --scale N         Downscale factor, 0 < N <= 1 (default 1).
  --fps N           Frames per second, 1-100 (default 10).
  --colors N        Palette colors, 2-256 (default 256).
  --loop N          Loop count, 0 = infinite (default 0).
  --palette MODE    local (per-frame tables) or global (default local).
  --sampling MODE   box or nearest (default box).
  --selftest        Run the built-in end-to-end GIF round-trip test.

Input files are either Android screencap dumps (header: width, height, format=1,
followed by RGBA pixels — the classic 12-byte header is accepted, and so is the
16-byte prefix emitted by some AVD images; the layout is detected from the file
size) or bare RGBA data. RGBA is composited onto black before quantization; GIF
output has no alpha.
`;

function parseArgs(argv) {
  const args = {
    in: null,
    out: null,
    width: null,
    height: null,
    scale: 1,
    fps: 10,
    colors: 256,
    loop: 0,
    palette: 'local',
    sampling: 'box',
    selftest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--selftest') {
      args.selftest = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);

    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    let value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === '') throw new Error(`${name} requires a value`);

    switch (name) {
      case '--in':
        args.in = value;
        break;
      case '--out':
        args.out = value;
        break;
      case '--width':
        args.width = parseInteger(value, '--width', 1, MAX_DIMENSION);
        break;
      case '--height':
        args.height = parseInteger(value, '--height', 1, MAX_DIMENSION);
        break;
      case '--scale':
        args.scale = parseNumber(value, '--scale');
        if (args.scale <= 0 || args.scale > 1) {
          throw new Error('--scale must be > 0 and <= 1');
        }
        break;
      case '--fps':
        args.fps = parseNumber(value, '--fps');
        if (args.fps < 1 || args.fps > 100) throw new Error('--fps must be between 1 and 100');
        break;
      case '--colors':
        args.colors = parseInteger(value, '--colors', 2, 256);
        break;
      case '--loop':
        args.loop = parseInteger(value, '--loop', 0, 65535);
        break;
      case '--palette':
        if (value !== 'local' && value !== 'global') {
          throw new Error('--palette must be local or global');
        }
        args.palette = value;
        break;
      case '--sampling':
        if (value !== 'box' && value !== 'nearest') {
          throw new Error('--sampling must be box or nearest');
        }
        args.sampling = value;
        break;
      default:
        throw new Error(`unknown option: ${name}`);
    }
  }

  if ((args.width === null) !== (args.height === null)) {
    throw new Error('--width and --height must be provided together');
  }
  return args;
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  return number;
}

function runCli(args) {
  if (!args.in) throw new Error('--in <dir> is required');
  if (!args.out) throw new Error('--out <file.gif> is required');

  const names = listFrameFiles(args.in, args.out);
  const total = names.length;
  let framePayloadBytes = 0;
  console.log(`encoding ${total} frame(s) from ${args.in} ...`);

  const gif = encodeGif(loadFrames(args.in, names, args.width, args.height), {
    width: args.width,
    height: args.height,
    scale: args.scale,
    fps: args.fps,
    colors: args.colors,
    loop: args.loop,
    palette: args.palette,
    sampling: args.sampling,
    onFrame(info) {
      framePayloadBytes += info.bytes;
      if ((info.index + 1) % 20 === 0 || info.index + 1 === total) {
        console.log(
          `  frame ${info.index + 1}/${total}: ${info.width}x${info.height}, ` +
            `${info.bytes} bytes, total ${info.totalBytes} bytes`,
        );
      }
    },
  });

  writeFileSync(args.out, gif);
  const average = (gif.length / total).toFixed(1);
  const payloadAverage = (framePayloadBytes / total).toFixed(1);
  console.log(
    `wrote ${args.out}: ${gif.length} bytes, ${total} frames, ` +
      `${average} bytes/frame average`,
  );
  console.log(`  frame payload average: ${payloadAverage} bytes/frame`);
}

function runSelfTest() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-make-demo-gif-'));
  const outputPath = path.join(tempDir, 'selftest.gif');
  try {
    const width = 32;
    const height = 20;
    const expectedNames = ['frame-1.rgba', 'frame-2.rgba', 'frame-10.rgba', 'frame-11.rgba'];
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];

    for (let i = 0; i < colors.length; i += 1) {
      const [r, g, b] = colors[i];
      // Mix layouts on purpose: frames 1-3 use the classic 12-byte header,
      // frame 4 uses the 16-byte prefix some AVD images emit.
      const headerSize = i === 3 ? 16 : 12;
      const buffer = Buffer.alloc(headerSize + width * height * 4);
      buffer.writeUInt32LE(width, 0);
      buffer.writeUInt32LE(height, 4);
      buffer.writeUInt32LE(1, 8);
      if (headerSize === 16) {
        buffer.writeUInt32LE(1, 12);
      }
      for (let p = headerSize; p < buffer.length; p += 4) {
        buffer[p] = r;
        buffer[p + 1] = g;
        buffer[p + 2] = b;
        buffer[p + 3] = 255;
      }
      writeFileSync(path.join(tempDir, expectedNames[i]), buffer);
    }

    const names = listFrameFiles(tempDir);
    check(
      names.join(',') === expectedNames.join(','),
      `natural sort mismatch: ${names.join(', ')}`,
    );
    console.log(`selftest: natural frame order OK (${names.join(', ')})`);

    const delays = [];
    const gif = encodeGif(loadFrames(tempDir, names, null, null), {
      scale: 1,
      fps: 10,
      colors: 256,
      loop: 2,
      palette: 'local',
      sampling: 'box',
      onFrame(info) {
        delays.push(info.delay);
      },
    });
    writeFileSync(outputPath, gif);
    const onDisk = readFileSync(outputPath);
    check(onDisk.length === gif.length, 'written GIF length differs from encoded buffer');
    check(onDisk.toString('latin1', 0, 6) === 'GIF89a', 'missing GIF89a signature');
    console.log(`selftest: output is GIF89a, ${onDisk.length} bytes`);

    const parsed = decodeGif(onDisk);
    check(parsed.width === width && parsed.height === height, 'logical screen size mismatch');
    check(parsed.loopCount !== null, 'Netscape loop extension missing');
    check(parsed.loopCount === 2, `loop count is ${parsed.loopCount}, expected 2`);
    check(parsed.frames.length === 4, `frame count is ${parsed.frames.length}, expected 4`);
    check(parsed.frames.every((frame) => frame.delay === 10), 'frame delays are not 10cs');
    check(delays.every((delay) => delay === 10), 'onFrame delay values are not 10cs');

    for (let i = 0; i < parsed.frames.length; i += 1) {
      assertSolidColor(parsed.frames[i], colors[i], i);
    }
    console.log(
      `selftest: loop=${parsed.loopCount}, frames=${parsed.frames.length}, ` +
        `delays=${parsed.frames.map((frame) => frame.delay).join(',')}cs, colors OK`,
    );

    const stress = Buffer.alloc(200000);
    let random = 0x12345678;
    for (let i = 0; i < stress.length; i += 1) {
      random ^= random << 13;
      random >>>= 0;
      random ^= random >>> 17;
      random ^= random << 5;
      random >>>= 0;
      stress[i] = random >>> 24;
    }
    const compressed = lzwEncode(stress);
    const decompressed = lzwDecode(MIN_CODE_SIZE, compressed, stress.length);
    check(Buffer.compare(stress, decompressed) === 0, 'LZW stress round-trip mismatch');
    console.log(
      `selftest: LZW round-trip OK (${stress.length} indices, ${compressed.length} bytes)`,
    );

    console.log(`selftest: PASS (${gif.length} bytes written to temporary GIF)`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function check(condition, message) {
  if (!condition) throw new Error(`selftest: ${message}`);
}

function assertSolidColor(frame, expected, index) {
  const [r, g, b] = expected;
  for (let p = 0; p < frame.rgba.length; p += 4) {
    if (frame.rgba[p] !== r || frame.rgba[p + 1] !== g || frame.rgba[p + 2] !== b) {
      throw new Error(
        `selftest: frame ${index} pixel ${p / 4} is ` +
          `(${frame.rgba[p]},${frame.rgba[p + 1]},${frame.rgba[p + 2]}), ` +
          `expected (${r},${g},${b})`,
      );
    }
  }
}

function decodeGif(buffer) {
  if (buffer.length < 13) throw new Error('selftest: GIF is too short');
  if (buffer.toString('latin1', 0, 6) !== 'GIF89a') {
    throw new Error('selftest: bad GIF89a signature');
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  if ((packed & 0x80) === 0) throw new Error('selftest: missing global color table');
  const globalCount = 1 << ((packed & 0x07) + 1);
  let position = 13;
  const globalPalette = readColorTable(buffer, position, globalCount);
  position += globalCount * 3;

  let loopCount = null;
  let pendingDelay = null;
  let pendingDisposal = 0;
  const frames = [];
  let sawTrailer = false;

  while (position < buffer.length) {
    const marker = buffer[position];
    position += 1;
    if (marker === 0x3b) {
      sawTrailer = true;
      break;
    }

    if (marker === 0x21) {
      const label = buffer[position];
      position += 1;
      if (label === 0xf9) {
        check(buffer[position] === 4, 'bad graphics control extension length');
        position += 1;
        const gcePacked = buffer[position];
        position += 1;
        pendingDelay = buffer.readUInt16LE(position);
        position += 2;
        position += 1; // Transparent color index.
        check(buffer[position] === 0, 'bad graphics control extension terminator');
        position += 1;
        pendingDisposal = (gcePacked >> 2) & 0x07;
      } else if (label === 0xff) {
        const size = buffer[position];
        position += 1;
        check(size === 11, 'bad application extension size');
        const appId = buffer.toString('latin1', position, position + 11);
        position += 11;
        const subSize = buffer[position];
        position += 1;
        if (appId === 'NETSCAPE2.0' && subSize === 3 && buffer[position] === 1) {
          loopCount = buffer.readUInt16LE(position + 1);
        }
        if (subSize > 0) {
          position += subSize;
          position = skipSubBlocks(buffer, position);
        }
      } else {
        position = skipSubBlocks(buffer, position);
      }
      continue;
    }

    if (marker === 0x2c) {
      check(position + 9 <= buffer.length, 'truncated image descriptor');
      const left = buffer.readUInt16LE(position);
      const top = buffer.readUInt16LE(position + 2);
      const frameWidth = buffer.readUInt16LE(position + 4);
      const frameHeight = buffer.readUInt16LE(position + 6);
      const imagePacked = buffer[position + 8];
      position += 9;
      check(left === 0 && top === 0, 'unexpected image offset');
      check((imagePacked & 0x40) === 0, 'interlaced frame is unsupported');

      let palette = globalPalette;
      if (imagePacked & 0x80) {
        const localCount = 1 << ((imagePacked & 0x07) + 1);
        palette = readColorTable(buffer, position, localCount);
        position += localCount * 3;
      }

      const minCodeSize = buffer[position];
      position += 1;
      const chunks = [];
      let dataLength = 0;
      for (;;) {
        const size = buffer[position];
        position += 1;
        if (size === 0) break;
        check(position + size <= buffer.length, 'truncated image data');
        chunks.push(buffer.subarray(position, position + size));
        dataLength += size;
        position += size;
      }
      const compressed = Buffer.concat(chunks, dataLength);
      const indices = lzwDecode(minCodeSize, compressed, frameWidth * frameHeight);
      const rgba = Buffer.alloc(frameWidth * frameHeight * 4);
      for (let i = 0; i < indices.length; i += 1) {
        const colorIndex = indices[i] * 3;
        check(colorIndex + 2 < palette.length, 'palette index out of range');
        rgba[i * 4] = palette[colorIndex];
        rgba[i * 4 + 1] = palette[colorIndex + 1];
        rgba[i * 4 + 2] = palette[colorIndex + 2];
        rgba[i * 4 + 3] = 255;
      }

      frames.push({
        width: frameWidth,
        height: frameHeight,
        delay: pendingDelay ?? 0,
        disposal: pendingDisposal,
        rgba,
      });
      pendingDelay = null;
      pendingDisposal = 0;
      continue;
    }

    throw new Error(`selftest: unexpected GIF block 0x${marker.toString(16)}`);
  }

  check(sawTrailer, 'missing GIF trailer');
  return { width, height, loopCount, frames };
}

function readColorTable(buffer, offset, count) {
  check(offset + count * 3 <= buffer.length, 'truncated color table');
  return buffer.subarray(offset, offset + count * 3);
}

function skipSubBlocks(buffer, start) {
  let position = start;
  for (;;) {
    check(position < buffer.length, 'truncated sub-block');
    const size = buffer[position];
    position += 1;
    if (size === 0) return position;
    position += size;
    check(position <= buffer.length, 'truncated sub-block data');
  }
}

function lzwDecode(minCodeSize, data, pixelCount) {
  check(minCodeSize >= 2 && minCodeSize <= 8, 'bad LZW minimum code size');
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < clearCode; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }

  const output = Buffer.alloc(pixelCount);
  const stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let dataPosition = 0;
  let outPosition = 0;

  for (;;) {
    while (bitCount < codeSize) {
      check(dataPosition < data.length, 'truncated LZW code stream');
      bitBuffer |= data[dataPosition] << bitCount;
      dataPosition += 1;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      previous = -1;
      continue;
    }
    if (code === endCode) break;
    check(code < nextCode || (code === nextCode && previous >= 0), `invalid LZW code ${code}`);

    const special = code === nextCode;
    let chase = special ? previous : code;
    let stackSize = 0;
    while (chase >= clearCode) {
      check(chase < 4096 && stackSize < 4096, 'invalid LZW dictionary chain');
      stack[stackSize] = suffix[chase];
      stackSize += 1;
      chase = prefix[chase];
    }
    stack[stackSize] = chase;
    stackSize += 1;
    while (stackSize > 0) {
      check(outPosition < pixelCount, 'LZW stream produced too many pixels');
      stackSize -= 1;
      output[outPosition] = stack[stackSize];
      outPosition += 1;
    }
    if (special) {
      check(outPosition < pixelCount, 'LZW stream produced too many pixels');
      output[outPosition] = first[previous];
      outPosition += 1;
    }

    if (previous >= 0 && nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = special ? first[previous] : first[code];
      first[nextCode] = first[previous];
      nextCode += 1;
      if (nextCode >= 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }

  check(outPosition === pixelCount, `LZW stream produced ${outPosition} of ${pixelCount} pixels`);
  return output;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`make-demo-gif: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.selftest) {
    runSelfTest();
    return;
  }
  runCli(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`make-demo-gif: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  }
}
