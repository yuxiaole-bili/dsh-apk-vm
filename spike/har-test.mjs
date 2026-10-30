/**
 * spike/har-test.mjs - hermetic checks for lib/har.js.
 *
 * Builds a small HAR in memory and covers normalization, entry/header bounds,
 * invalid input rejection, file reading, summaries, filtering and safe curl
 * generation. No network access and no emulator required.
 *
 *   node spike/har-test.mjs
 *
 * Exit code 0 = every check passed.
 */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseHar, readHarFile, summarizeHar, filterHar, toCurl } from '../lib/har.js';

let checks = 0;
let failed = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    checks += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function makeHar() {
  return {
    log: {
      version: '1.2',
      creator: { name: 'dsh-har-test', version: '1.0' },
      pages: [{ startedDateTime: '2026-10-30T12:00:00.000Z', id: 'page_1', title: 'Demo page' }],
      entries: [
        {
          startedDateTime: '2026-10-30T12:00:01.100Z',
          time: 42.4,
          request: {
            method: 'get',
            url: 'https://api.example.com/v1/users?page=2',
            headers: [
              { name: 'Accept', value: 'application/json' },
              { name: 'X-Trace', value: 'alpha' },
            ],
          },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Set-Cookie', value: 'a=1' },
              { name: 'Set-Cookie', value: 'b=2' },
            ],
            content: { size: 512, mimeType: 'application/json' },
          },
        },
        {
          startedDateTime: '2026-10-30T12:00:01.200Z',
          time: 5,
          request: {
            method: 'GET',
            url: 'https://cdn.example.org/app.js',
            headers: [{ name: 'Accept', value: '*/*' }],
          },
          response: {
            status: 302,
            statusText: 'Found',
            headers: [{ name: 'Location', value: 'https://cdn.example.org/app.v2.js' }],
            content: { size: 0, mimeType: 'text/javascript' },
          },
        },
        {
          startedDateTime: '2026-10-30T12:00:01.300Z',
          time: 120.6,
          request: {
            method: 'POST',
            url: 'https://api.example.com/v1/missing',
            headers: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'X-Note', value: "it's fine" },
            ],
          },
          response: {
            status: 404,
            statusText: 'Not Found',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: { size: 128, mimeType: 'application/json' },
          },
        },
      ],
    },
  };
}

await check('parseHar normalizes entries, creator and pages', async () => {
  const parsed = parseHar(makeHar());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.creator, { name: 'dsh-har-test', version: '1.0' });
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].id, 'page_1');
  assert.equal(parsed.pages[0].title, 'Demo page');

  const first = parsed.entries[0];
  assert.equal(first.startedDateTime, '2026-10-30T12:00:01.100Z');
  assert.equal(first.method, 'GET');
  assert.equal(first.url, 'https://api.example.com/v1/users?page=2');
  assert.equal(first.status, 200);
  assert.equal(first.statusText, 'OK');
  assert.equal(first.durationMs, 42);
  assert.equal(first.mimeType, 'application/json');
  assert.equal(first.size, 512);
  assert.deepEqual(first.requestHeaders, { accept: 'application/json', 'x-trace': 'alpha' });
  assert.deepEqual(first.responseHeaders, { 'content-type': 'application/json', 'set-cookie': 'a=1, b=2' });
});

await check('parseHar accepts text/Buffer, strips BOM and enforces maxEntries', async () => {
  const har = makeHar();
  const text = `\uFEFF${JSON.stringify(har)}`;
  const fromText = parseHar(text);
  assert.equal(fromText.entries.length, 3);
  assert.equal(fromText.entries[1].durationMs, 5);

  const fromBuffer = parseHar(Buffer.from(JSON.stringify(har), 'utf8'));
  assert.equal(fromBuffer.entries.length, 3);

  const limited = parseHar(har, { maxEntries: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.total, 3);
  assert.equal(limited.truncated, true);

  const sparse = parseHar({ log: { entries: [null, 7, har.log.entries[0]] } });
  assert.equal(sparse.entries.length, 1);
  assert.equal(sparse.total, 3);
  assert.equal(sparse.truncated, true);
  assert.equal(sparse.creator, null);
  assert.deepEqual(sparse.pages, []);
});

await check('parseHar rejects invalid HAR input', async () => {
  assert.throws(() => parseHar(), /JSON text or an object/);
  assert.throws(() => parseHar(null), /JSON text or an object/);
  assert.throws(() => parseHar(''), /empty/);
  assert.throws(() => parseHar('{not json'), /invalid HAR JSON/);
  assert.throws(() => parseHar('[]'), /root must be an object/);
  assert.throws(() => parseHar({}), /"log"/);
  assert.throws(() => parseHar({ log: {} }), /log\.entries must be an array/);
  assert.throws(() => parseHar({ log: { entries: 'nope' } }), /log\.entries must be an array/);
});

await check('parseHar bounds header count, values, URL and prototype keys', async () => {
  const manyHeaders = Array.from({ length: 150 }, (_, index) => ({ name: `x-h${index}`, value: 'v' }));
  const hostile = parseHar({
    log: {
      entries: [
        {
          startedDateTime: 'not-a-date\r\n',
          time: -1,
          request: {
            method: 'get',
            url: 'https://example.test/path\r\nx',
            headers: [
              { name: 'X-Long', value: 'L'.repeat(5000) },
              { name: 'X-Multiline', value: 'one\r\ntwo' },
              { name: '__proto__', value: 'polluted' },
              ...manyHeaders,
            ],
          },
          response: { status: 200, content: { mimeType: 'text/plain' } },
        },
      ],
    },
  });
  const entry = hostile.entries[0];
  assert.equal(entry.method, 'GET');
  assert.equal(entry.url, 'https://example.test/pathx');
  assert.equal(entry.startedDateTime, 'not-a-date');
  assert.equal(entry.durationMs, 0);
  assert.equal(entry.status, 200);
  assert.equal(Object.keys(entry.requestHeaders).length, 100);
  assert.equal(Object.hasOwn(entry.requestHeaders, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(entry.requestHeaders), Object.prototype);
  assert.equal(entry.requestHeaders['x-long'].length, 2048);
  assert.ok(entry.requestHeaders['x-long'].endsWith('...'));
  assert.equal(entry.requestHeaders['x-multiline'], 'one two');
});

await check('readHarFile reads .har/.json and rejects extension, size and missing files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-har-test-'));
  try {
    const harPath = path.join(dir, 'capture.har');
    const jsonPath = path.join(dir, 'capture.json');
    const txtPath = path.join(dir, 'capture.txt');
    const text = `\uFEFF${JSON.stringify(makeHar())}`;
    await fsp.writeFile(harPath, text, 'utf8');
    await fsp.writeFile(jsonPath, text, 'utf8');
    await fsp.writeFile(txtPath, text, 'utf8');

    const fromHar = await readHarFile(harPath);
    assert.equal(fromHar.ok, true);
    assert.equal(fromHar.entries.length, 3);
    assert.equal(fromHar.file, harPath);
    assert.equal(fromHar.bytes, Buffer.byteLength(text, 'utf8'));

    const fromJson = await readHarFile(jsonPath);
    assert.equal(fromJson.entries.length, 3);

    await assert.rejects(() => readHarFile(txtPath), /\.har or \.json/);
    await assert.rejects(() => readHarFile(harPath, { maxBytes: 16 }), /too large/);
    await assert.rejects(() => readHarFile(path.join(dir, 'missing.har')), /cannot read/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await check('summarizeHar counts status classes, bytes, slowest entry and domains', async () => {
  const parsed = parseHar(makeHar());
  const summary = summarizeHar(parsed.entries);
  assert.equal(summary.total, 3);
  assert.equal(summary.totalBytes, 640);
  assert.deepEqual(summary.statusClasses, { '2xx': 1, '3xx': 1, '4xx': 1, '5xx': 0, other: 0 });
  assert.equal(summary.slowest.url, 'https://api.example.com/v1/missing');
  assert.equal(summary.slowest.durationMs, 121);
  assert.deepEqual(summary.domains, ['api.example.com', 'cdn.example.org']);

  const empty = summarizeHar(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalBytes, 0);
  assert.equal(empty.slowest, null);
  assert.deepEqual(empty.domains, []);
  assert.deepEqual(empty.statusClasses, { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 });
});

await check('filterHar matches method/status/domain/search case-insensitively', async () => {
  const entries = parseHar(makeHar()).entries;
  assert.equal(filterHar(entries).length, 3);
  assert.equal(filterHar(entries, {}).length, 3);
  assert.equal(filterHar(entries, { method: 'post' }).length, 1);
  assert.equal(filterHar(entries, { method: 'GET' }).length, 2);
  assert.equal(filterHar(entries, { status: '2XX' }).length, 1);
  assert.equal(filterHar(entries, { status: '4xx' }).length, 1);
  assert.equal(filterHar(entries, { status: 302 }).length, 1);
  assert.equal(filterHar(entries, { status: '200' }).length, 1);
  assert.equal(filterHar(entries, { status: 'other' }).length, 0);
  assert.equal(filterHar(entries, { status: 'bogus' }).length, 0);
  assert.equal(filterHar(entries, { domain: 'API.EXAMPLE.COM' }).length, 2);
  assert.equal(filterHar(entries, { domain: 'cdn.example.org' }).length, 1);
  assert.equal(filterHar(entries, { search: 'USERS' }).length, 1);
  assert.equal(filterHar(entries, { search: 'application/json' }).length, 2);
  assert.equal(filterHar(entries, { search: "IT'S" }).length, 1);
  assert.equal(filterHar(entries, { method: 'get', status: '3xx', domain: 'cdn.example' }).length, 1);
  assert.equal(filterHar(entries, { search: 'nope' }).length, 0);
  assert.equal(filterHar(null, { search: 'x' }).length, 0);
});

await check('toCurl quotes URL/header values and never emits a line break', async () => {
  const parsed = parseHar(makeHar());
  assert.equal(
    toCurl(parsed.entries[0]),
    "curl -X GET 'https://api.example.com/v1/users?page=2' -H 'accept: application/json' -H 'x-trace: alpha'",
  );
  assert.equal(
    toCurl(parsed.entries[2]),
    "curl -X POST 'https://api.example.com/v1/missing' -H 'content-type: application/json' -H 'x-note: it'\\''s fine'",
  );
  assert.equal(toCurl(makeHar().log.entries[0]), toCurl(parsed.entries[0]));
  assert.equal(
    toCurl({
      method: 'GET',
      url: "https://example.test/a'b",
      requestHeaders: { 'x-note': 'a\r\nb', 'bad name': 'x' },
    }),
    "curl -X GET 'https://example.test/a'\\''b' -H 'x-note: a b'",
  );
  assert.throws(() => toCurl({}), /requires a URL/);
  assert.throws(() => toCurl(null), /requires a HAR entry/);
});

console.log(`\n--- summary ---\nchecks: ${checks}, failed: ${failed}`);
if (failed) process.exitCode = 1;
