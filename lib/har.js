/**
 * HAR (HTTP Archive) parsing helpers for the Network panel.
 *
 * The panel reads a HAR file exported by Chrome DevTools or a capture proxy and
 * shows a normalized, bounded view of every request. This module is read-only:
 * it never replays a request, resolves a URL, or writes to disk. Header values
 * are kept because the panel is a debugging tool, but control characters are
 * stripped and every string is length limited before it can reach the browser
 * or a copied curl command.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const MAX_HAR_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_HEADERS = 100;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 2048;
const MAX_URL_LENGTH = 16384;
const MAX_METHOD_LENGTH = 24;
const MAX_PAGES = 500;
const MAX_TEXT = 256;
const ALLOWED_EXTENSIONS = new Set(['.har', '.json']);
const UNSAFE_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const STRIP_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Keep tab; replace CR/LF/NUL and other C0/C1 controls so values stay one line.
const HEADER_CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]+/g;
const SHELL_QUOTE_ESCAPE = "'\\''";

function truncate(value, limit) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function sanitizeText(value, limit = MAX_TEXT) {
  return truncate(String(value == null ? '' : value).replace(HEADER_CONTROL_RE, ' ').trim(), limit);
}

function sanitizeUrl(value) {
  return truncate(String(value == null ? '' : value).replace(STRIP_CONTROL_RE, '').trim(), MAX_URL_LENGTH);
}

function sanitizeMethod(value) {
  const method = String(value == null ? '' : value).replace(STRIP_CONTROL_RE, '').trim().toUpperCase();
  if (!method || method.length > MAX_METHOD_LENGTH || !TOKEN_RE.test(method)) return '';
  return method;
}

function sanitizeHeaderName(value) {
  const name = String(value == null ? '' : value).replace(STRIP_CONTROL_RE, '').trim();
  if (!name || name.length > MAX_HEADER_NAME || !TOKEN_RE.test(name)) return '';
  return name;
}

function headerValueText(value) {
  if (Array.isArray(value)) return value.map((item) => headerValueText(item)).join(', ');
  if (value && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return typeof json === 'string' ? json : '';
    } catch {
      return '';
    }
  }
  return String(value == null ? '' : value);
}

function sanitizeHeaderValue(value) {
  const text = headerValueText(value).replace(HEADER_CONTROL_RE, ' ').trim();
  return truncate(text, MAX_HEADER_VALUE);
}

/**
 * Build a lower-case header map and merge duplicate names with ", ". Only HTTP
 * token names are kept and prototype keys are ignored so a HAR object can never
 * modify Object.prototype.
 */
function normalizeHeaders(source) {
  const out = {};
  const add = (rawName, rawValue) => {
    if (Object.keys(out).length >= MAX_HEADERS) return;
    const name = sanitizeHeaderName(rawName);
    if (!name) return;
    const key = name.toLowerCase();
    if (UNSAFE_HEADER_KEYS.has(key)) return;
    const value = sanitizeHeaderValue(rawValue);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = truncate(`${out[key]}, ${value}`, MAX_HEADER_VALUE);
    } else {
      out[key] = value;
    }
  };
  if (Array.isArray(source)) {
    for (const header of source) {
      if (!header || typeof header !== 'object') continue;
      add(header.name, header.value);
    }
  } else if (source && typeof source === 'object') {
    for (const [name, value] of Object.entries(source)) add(name, value);
  }
  return out;
}

function normalizeStatus(value) {
  const status = Math.round(Number(value));
  if (!Number.isFinite(status) || status < 0) return 0;
  return Math.min(status, 999);
}

function normalizeDuration(value) {
  const duration = Math.round(Number(value));
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function normalizeSize(value) {
  const size = Math.round(Number(value));
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function pickSize(content, response) {
  for (const value of [content.size, response.bodySize]) {
    const size = Number(value);
    if (Number.isFinite(size) && size >= 0) return Math.round(size);
  }
  return 0;
}

// Normalized entries are:
// { startedDateTime, method, url, status, statusText, durationMs, mimeType,
//   size, requestHeaders, responseHeaders }
// `size` is the response body in bytes and headers are lower-case name -> value.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const request = raw.request && typeof raw.request === 'object' && !Array.isArray(raw.request) ? raw.request : {};
  const response = raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response) ? raw.response : {};
  const content =
    response.content && typeof response.content === 'object' && !Array.isArray(response.content)
      ? response.content
      : {};
  return {
    startedDateTime: sanitizeText(raw.startedDateTime, 64),
    method: sanitizeMethod(request.method) || 'GET',
    url: sanitizeUrl(request.url),
    status: normalizeStatus(response.status),
    statusText: sanitizeText(response.statusText, MAX_TEXT),
    durationMs: normalizeDuration(raw.time),
    mimeType: sanitizeText(content.mimeType, MAX_TEXT),
    size: pickSize(content, response),
    requestHeaders: normalizeHeaders(request.headers),
    responseHeaders: normalizeHeaders(response.headers),
  };
}

function normalizeCreator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    name: sanitizeText(value.name, 128),
    version: sanitizeText(value.version, 64),
  };
}

function normalizePages(value) {
  if (!Array.isArray(value)) return [];
  const pages = [];
  for (const page of value) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) continue;
    pages.push({
      id: sanitizeText(page.id, 128),
      title: sanitizeText(page.title, MAX_TEXT),
      startedDateTime: sanitizeText(page.startedDateTime, 64),
    });
    if (pages.length >= MAX_PAGES) break;
  }
  return pages;
}

function normalizeMaxEntries(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return MAX_ENTRIES;
  return Math.min(number, MAX_ENTRIES);
}

function normalizeMaxBytes(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return MAX_HAR_BYTES;
  return Math.min(number, MAX_HAR_BYTES);
}

function toHarObject(source) {
  if (Buffer.isBuffer(source)) source = source.toString('utf8');
  if (typeof source === 'string') {
    const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    if (Buffer.byteLength(text, 'utf8') > MAX_HAR_BYTES) {
      throw new Error('HAR text is larger than the 20 MB limit');
    }
    if (!text.trim()) throw new Error('HAR input is empty');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Deliberately do not echo the parser message: a syntax error can contain
      // fragments of captured cookies or authorization headers.
      throw new Error('invalid HAR JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('HAR root must be an object');
    }
    return parsed;
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) return source;
  throw new Error('HAR input must be JSON text or an object');
}

/**
 * Parse HAR JSON text (or an already parsed object) into bounded, normalized
 * entries. Invalid structure throws; malformed individual entries are skipped.
 *
 * @param {string|Buffer|object} source HAR text or object.
 * @param {{maxEntries?: number}} [options] Defaults to and is capped at 5000.
 * @returns {{ok: true, entries: object[], creator: object|null, pages: object[], total: number, truncated: boolean}}
 */
export function parseHar(source, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const data = toHarObject(source);
  const log = data.log;
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    throw new Error('HAR is missing the "log" object');
  }
  if (!Array.isArray(log.entries)) throw new Error('HAR log.entries must be an array');

  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const entries = [];
  for (const raw of log.entries) {
    const entry = normalizeEntry(raw);
    if (entry) entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  return {
    ok: true,
    entries,
    creator: normalizeCreator(log.creator),
    pages: normalizePages(log.pages),
    total: log.entries.length,
    truncated: entries.length < log.entries.length,
  };
}

/**
 * Read a .har/.json file as UTF-8 and parse it.
 *
 * A missing, non-regular, wrongly named, or oversized (>20 MB) file is rejected
 * before parsing. This is a convenience reader, not a sandbox: callers that
 * accept a path from the browser must resolve it inside their own upload
 * directory.
 *
 * @param {string} filePath Local path ending in .har or .json.
 * @param {{maxEntries?: number, maxBytes?: number}} [options] maxBytes may only lower the 20 MB limit.
 * @returns {Promise<{ok: true, entries: object[], creator: object|null, pages: object[],
 *   total: number, truncated: boolean, file: string, bytes: number}>} Parsed result plus file metadata.
 */
export async function readHarFile(filePath, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const file = String(filePath == null ? '' : filePath).trim();
  if (!file) throw new Error('readHarFile requires a file path');
  if (!ALLOWED_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error('HAR file must use a .har or .json extension');
  }

  const maxBytes = normalizeMaxBytes(opts.maxBytes);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    const reason = error && error.code ? error.code : 'stat failed';
    throw new Error(`cannot read HAR file: ${reason}`);
  }
  if (!stat.isFile()) throw new Error('HAR path is not a regular file');
  if (stat.size > maxBytes) throw new Error(`HAR file is too large (${stat.size} bytes, limit ${maxBytes} bytes)`);

  const buffer = await fsp.readFile(file);
  if (buffer.length > maxBytes) {
    throw new Error(`HAR file is too large (${buffer.length} bytes, limit ${maxBytes} bytes)`);
  }
  const parsed = parseHar(buffer.toString('utf8'), opts);
  return { ...parsed, file, bytes: buffer.length };
}

function hostFromUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
    if (!match) return '';
    const authority = match[1].replace(/^.*@/, '');
    const host = authority.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
    return host.toLowerCase();
  }
}

function searchableText(entry) {
  const headers = [entry.requestHeaders, entry.responseHeaders]
    .map((value) => {
      if (!value || typeof value !== 'object') return '';
      return Object.entries(value)
        .map(([name, headerValue]) => `${name}: ${headerValue}`)
        .join('\n');
    })
    .join('\n');
  return [entry.method, entry.url, entry.status, entry.statusText, entry.mimeType, headers].join('\n').toLowerCase();
}

function statusMatcher(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return null;
  if (text === 'other') return (status) => status < 200 || status >= 600;
  const klass = /^([1-5])xx$/.exec(text);
  if (klass) {
    const start = Number(klass[1]) * 100;
    return (status) => status >= start && status < start + 100;
  }
  if (/^\d{1,3}$/.test(text)) {
    const wanted = Number(text);
    return (status) => status === wanted;
  }
  return () => false;
}

/**
 * Aggregate counts and sizes for the panel header.
 *
 * @param {object[]} entries Normalized entries from parseHar.
 * @returns {{total: number, totalBytes: number, statusClasses: object, slowest: object|null, domains: string[]}}
 */
export function summarizeHar(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  const statusClasses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const domains = new Set();
  let totalBytes = 0;
  let slowest = null;
  for (const entry of list) {
    const status = normalizeStatus(entry.status);
    const klass = status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
    if (Object.prototype.hasOwnProperty.call(statusClasses, klass)) statusClasses[klass] += 1;
    else statusClasses.other += 1;
    totalBytes += normalizeSize(entry.size);
    const host = hostFromUrl(entry.url);
    if (host) domains.add(host);
    if (!slowest || normalizeDuration(entry.durationMs) > normalizeDuration(slowest.durationMs)) slowest = entry;
  }
  return {
    total: list.length,
    totalBytes,
    statusClasses,
    slowest,
    domains: [...domains].sort(),
  };
}

/**
 * Case-insensitive filter over normalized entries. Returns a new array.
 *
 * `status` accepts an exact code (404 or "404"), a class ("4xx") or "other".
 * `domain` matches the URL hostname as a substring, and `search` scans method,
 * URL, status text, MIME type and header names/values.
 *
 * @param {object[]} entries Normalized entries from parseHar.
 * @param {{method?: string, status?: string|number, domain?: string, search?: string}} [filters]
 * @returns {object[]}
 */
export function filterHar(entries, filters = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  const opts = filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {};
  const method = String(opts.method == null ? '' : opts.method).trim().toUpperCase();
  const domain = String(opts.domain == null ? '' : opts.domain).trim().toLowerCase();
  const search = String(opts.search == null ? '' : opts.search).trim().toLowerCase();
  const matchesStatus = statusMatcher(opts.status);
  if (!method && !domain && !search && !matchesStatus) return list.slice();
  return list.filter((entry) => {
    if (method && String(entry.method == null ? '' : entry.method).toUpperCase() !== method) return false;
    if (matchesStatus && !matchesStatus(normalizeStatus(entry.status))) return false;
    if (domain && !hostFromUrl(entry.url).includes(domain)) return false;
    if (search && !searchableText(entry).includes(search)) return false;
    return true;
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, SHELL_QUOTE_ESCAPE)}'`;
}

/**
 * Build a shell-safe curl command for copying a request.
 *
 * Accepts a normalized entry or a raw HAR entry. Only method, URL and request
 * headers are copied (no body); URL and header values are single-quoted and
 * embedded quotes are escaped. The command is returned as a string and is never
 * executed by the plugin.
 *
 * @param {object} entry Normalized entry or raw HAR entry.
 * @returns {string}
 */
export function toCurl(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('toCurl requires a HAR entry');
  }
  const request = entry.request && typeof entry.request === 'object' && !Array.isArray(entry.request)
    ? entry.request
    : null;
  const url = sanitizeUrl(entry.url != null ? entry.url : request && request.url);
  if (!url) throw new Error('toCurl requires a URL');
  const method = sanitizeMethod(entry.method != null ? entry.method : request && request.method) || 'GET';
  const rawHeaders = entry.requestHeaders != null ? entry.requestHeaders : request && request.headers;
  const headers = normalizeHeaders(rawHeaders);
  const parts = ['curl', '-X', method, shellQuote(url)];
  for (const [name, value] of Object.entries(headers)) {
    parts.push('-H', shellQuote(`${name}: ${value}`));
  }
  return parts.join(' ');
}
