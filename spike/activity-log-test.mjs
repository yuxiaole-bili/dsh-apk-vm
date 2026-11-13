#!/usr/bin/env node
/**
 * Activity log tests.
 *
 * Hermetic: every case writes to a throwaway os.tmpdir() directory, no
 * emulator and no network. Covers append/read order, filters and cursor
 * pagination, ring pruning (entries and bytes), screenshot save/get, clear,
 * stats, corruption-tolerant reads, JSON-safety, secret stripping and the
 * "record never throws" contract.
 */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ActivityLog, defaultActivityLogRoot } from '../lib/activity-log.js';

let checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log('  ok', message);
}
function eq(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
  console.log('  ok', message);
}
function same(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
  console.log('  ok', message);
}

const tempDirs = [];
async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apkvm-activity-'));
  tempDirs.push(dir);
  return dir;
}

async function readJsonLines(root) {
  try {
    const raw = await fsp.readFile(path.join(root, 'activity.jsonl'), 'utf8');
    return raw.split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

async function fileExists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const ENTRY_KEYS = [
  'id',
  'at',
  'action',
  'source',
  'instanceId',
  'tool',
  'summary',
  'ok',
  'error',
  'durationMs',
  'argsPreview',
  'shotId',
];

async function main() {
  console.log('activity-log: roots and defaults');
  {
    const homeRoot = defaultActivityLogRoot(path.join(os.tmpdir(), 'apkvm-data'));
    ok(homeRoot.endsWith(path.join('.apk-vm', 'activity')), 'default root is <dataDir>/.apk-vm/activity');
    ok(defaultActivityLogRoot().endsWith(path.join('.apk-vm', 'activity')), 'default root falls back to the home directory');

    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir, dataDir: path.join(dir, 'ignored') });
    eq(log.rootDir, path.resolve(dir), 'rootDir wins over dataDir');
    eq(log.file, path.join(path.resolve(dir), 'activity.jsonl'), 'journal lives in the root');
    eq(log.shotsDir, path.join(path.resolve(dir), 'screenshots'), 'screenshots live under the root');
    eq(log.maxEntries, 1000, 'default maxEntries is 1000');
    eq(log.maxBytes, 250 * 1024 * 1024, 'default maxBytes is 250MB');
    eq(log.maxStringBytes, 2048, 'default maxStringBytes is 2048');

    const emptyStats = await log.stats();
    same(emptyStats, { count: 0, bytes: 0, shots: 0, oldest: null, newest: null }, 'stats on a missing root are empty');
    const emptyList = await log.list();
    same(emptyList.entries, [], 'list on a missing root is empty');
    eq(emptyList.nextId, null, 'empty list has no cursor');
    eq(await log.get('nope'), null, 'get on a missing root is null');
    eq(await log.shot('nope'), null, 'shot on a missing root is null');
    const cleared = await log.clear();
    eq(cleared.ok, true, 'clear on a missing root is a no-op success');
    eq(cleared.removedEntries, 0, 'clear reports no entries removed');
    eq(cleared.removedShots, 0, 'clear reports no shots removed');
  }

  console.log('activity-log: append, schema and read order');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    const first = await log.record({ action: 'shell', source: 'tool', instanceId: 'default', summary: 'first', ok: true });
    const second = await log.record({ action: 'start', source: 'tool', instanceId: 'vm-2', summary: 'second', ok: true });
    const third = await log.record({ action: 'stop', source: 'http', instanceId: 'vm-2', summary: 'third', ok: false, error: 'boom' });

    same(Object.keys(first), ENTRY_KEYS, 'stored entries use the documented schema');
    ok(typeof first.id === 'string' && first.id.length > 0, 'id is a non-empty string');
    ok(Number.isFinite(Date.parse(first.at)), 'at is an ISO timestamp');
    eq(first.action, 'shell', 'action is stored');
    eq(first.source, 'tool', 'source defaults to tool');
    eq(first.instanceId, 'default', 'instanceId defaults to default');
    eq(first.ok, true, 'ok defaults to true');
    eq(first.summary, 'first', 'summary is stored');
    eq(first.tool, null, 'tool defaults to null');
    eq(first.error, null, 'error defaults to null');
    eq(first.durationMs, null, 'durationMs defaults to null');
    eq(first.argsPreview, null, 'argsPreview defaults to null');
    eq(first.shotId, null, 'shotId defaults to null');
    eq(third.ok, false, 'ok:false is kept');
    eq(third.error, 'boom', 'error text is kept');

    const newestFirst = await log.list();
    same(newestFirst.entries.map((entry) => entry.id), [third.id, second.id, first.id], 'list is newest-first');
    same(newestFirst.entries.map((entry) => entry.summary), ['third', 'second', 'first'], 'newest-first summaries');
    const httpOnly = await log.list({ source: 'http' });
    same(httpOnly.entries.map((entry) => entry.summary), ['third'], 'source filter matches only http entries');
    const toolOnly = await log.list({ source: 'tool' });
    eq(toolOnly.entries.length, 2, 'source filter matches only tool entries');
    same((await log.list({ source: 'nope' })).entries, [], 'unknown source filter is empty');
    const limited = await log.list({ limit: 2 });
    same(limited.entries.map((entry) => entry.id), [third.id, second.id], 'limit caps the page');
    eq(limited.nextId, second.id, 'nextId points at the page tail when more entries exist');
    eq((await log.list({ limit: 100 })).nextId, null, 'nextId is null when the page is complete');
    eq((await log.get(second.id)).summary, 'second', 'get returns the matching entry');
    eq(await log.get('missing'), null, 'get returns null for an unknown id');
    eq(await log.get('../escape'), null, 'get rejects unsafe ids');
    const overLimit = await log.list({ limit: 0 });
    eq(overLimit.entries.length, 1, 'limit is clamped to at least 1');

    const stats = await log.stats();
    eq(stats.count, 3, 'stats count entries');
    eq(stats.shots, 0, 'stats count shots');
    eq(stats.oldest, first.at, 'stats oldest is the first timestamp');
    eq(stats.newest, third.at, 'stats newest is the last timestamp');
    ok(stats.bytes > 0, 'stats bytes are positive');
    const rawJournal = await fsp.readFile(path.join(dir, 'activity.jsonl'));
    eq(stats.bytes, rawJournal.length, 'stats bytes match the journal size');
  }

  console.log('activity-log: filters and cursor pagination');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    const actions = ['shell', 'start', 'shell', 'stop', 'shell', 'start', 'shell', 'stop'];
    const ids = [];
    for (let index = 0; index < actions.length; index += 1) {
      const entry = await log.record({
        action: actions[index],
        instanceId: index % 2 === 0 ? 'default' : 'vm-b',
        ok: index % 3 !== 0,
        summary: `entry-${index}`,
      });
      ids.push(entry.id);
    }
    const shells = await log.list({ action: 'shell' });
    eq(shells.entries.length, 4, 'action filter matches only shell entries');
    ok(shells.entries.every((entry) => entry.action === 'shell'), 'action filter is exact');
    const instanceScoped = await log.list({ instanceId: 'vm-b' });
    eq(instanceScoped.entries.length, 4, 'instanceId filter matches only vm-b entries');
    ok(instanceScoped.entries.every((entry) => entry.instanceId === 'vm-b'), 'instanceId filter is exact');
    const errorsOnly = await log.list({ ok: false });
    eq(errorsOnly.entries.length, 3, 'ok:false filter returns failures only');
    const combined = await log.list({ action: 'shell', ok: false, instanceId: 'default' });
    eq(combined.entries.length, 2, 'filters combine');
    const unknownAction = await log.list({ action: 'nope' });
    same(unknownAction.entries, [], 'unknown action filter is empty');

    const cursor = await log.list({ beforeId: ids[4] });
    same(cursor.entries.map((entry) => entry.summary), ['entry-3', 'entry-2', 'entry-1', 'entry-0'], 'beforeId keeps older entries only');
    eq((await log.list({ beforeId: ids[0] })).entries.length, 0, 'beforeId at the oldest entry is empty');
    eq((await log.list({ beforeId: 'missing-cursor' })).entries.length, 0, 'unknown cursor is empty');

    const pageOne = await log.list({ limit: 3 });
    eq(pageOne.entries.length, 3, 'page one size');
    const pageTwo = await log.list({ limit: 3, beforeId: pageOne.nextId });
    const pageThree = await log.list({ limit: 3, beforeId: pageTwo.nextId });
    const collected = [...pageOne.entries, ...pageTwo.entries, ...pageThree.entries].map((entry) => entry.id);
    same(collected, ids.slice().reverse(), 'cursor pagination walks the whole log exactly once');
    eq(pageThree.nextId, null, 'the last page has no cursor');
  }

  console.log('activity-log: ring pruning by entry count');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir, maxEntries: 3 });
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const entry = await log.record({ action: 'shell', summary: `prune-${index}` });
      ids.push(entry.id);
    }
    const listed = await log.list();
    same(listed.entries.map((entry) => entry.summary), ['prune-4', 'prune-3', 'prune-2'], 'oldest entries are pruned');
    eq((await readJsonLines(dir)).length, 3, 'journal is rewritten down to maxEntries lines');
    eq(await log.get(ids[0]), null, 'pruned entries are gone from get');
    eq((await log.stats()).count, 3, 'stats reflect the ring');
  }

  console.log('activity-log: ring pruning by bytes');
  {
    const dir = await tempDir();
    const maxBytes = 2000;
    const log = new ActivityLog({ rootDir: dir, maxEntries: 1000, maxBytes });
    for (let index = 0; index < 10; index += 1) {
      await log.record({ action: 'shell', summary: `byte-${index}`, args: { blob: 'x'.repeat(400) } });
    }
    const stats = await log.stats();
    ok(stats.count >= 1 && stats.count < 10, 'byte cap prunes old entries');
    ok(stats.bytes <= maxBytes, `ring stays under maxBytes (${stats.bytes} <= ${maxBytes})`);
    const newest = await log.list({ limit: 1 });
    eq(newest.entries[0].summary, 'byte-9', 'newest entry is always kept');
    const lines = await readJsonLines(dir);
    ok(lines.length === stats.count, 'journal lines match the entry count after a byte rewrite');
  }

  console.log('activity-log: screenshots');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    const withShot = await log.record({ action: 'screenshot', shot: PNG });
    eq(withShot.shotId, withShot.id, 'shot buffer gets the entry id as shotId');
    const shotPath = path.join(dir, 'screenshots', `${withShot.id}.png`);
    ok(await fileExists(shotPath), 'screenshot file is written to screenshots/<id>.png');
    const loaded = await log.shot(withShot.id);
    ok(Buffer.isBuffer(loaded.buffer), 'shot returns a buffer');
    eq(loaded.mediaType, 'image/png', 'shot returns the PNG media type');
    same([...loaded.buffer], [...PNG], 'shot bytes round-trip');
    eq(await log.shot('missing'), null, 'missing screenshot is null');
    eq(await log.shot('../escape'), null, 'path traversal in shot id is rejected');
    eq(await log.shot('a/b'), null, 'slashes in shot id are rejected');

    const plain = await log.record({ action: 'info' });
    eq(plain.shotId, null, 'entries without a shot have no shotId');
    eq(await log.shot(plain.id), null, 'entries without a shot have no screenshot');

    const capped = new ActivityLog({ rootDir: dir, maxEntries: 1 });
    await capped.record({ action: 'shell', summary: 'kicks out the shot' });
    eq(await capped.shot(withShot.id), null, 'pruning deletes the screenshot of a dropped entry');
    ok(!(await fileExists(shotPath)), 'pruned screenshot file is removed from disk');
  }

  console.log('activity-log: clear');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    await log.record({ action: 'shell' });
    const shotEntry = await log.record({ action: 'screenshot', shot: PNG });
    ok(await fileExists(path.join(dir, 'screenshots', `${shotEntry.id}.png`)), 'screenshot exists before clear');
    const cleared = await log.clear();
    eq(cleared.ok, true, 'clear succeeds');
    eq(cleared.removedEntries, 2, 'clear reports removed entries');
    eq(cleared.removedShots, 1, 'clear reports removed screenshots');
    same((await log.list()).entries, [], 'clear empties the log');
    same(await log.stats(), { count: 0, bytes: 0, shots: 0, oldest: null, newest: null }, 'clear resets stats');
    eq(await log.shot(shotEntry.id), null, 'clear removes screenshots');
    ok(!(await fileExists(path.join(dir, 'activity.jsonl'))), 'clear removes the journal file');
  }

  console.log('activity-log: corruption tolerance');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir, maxEntries: 2 });
    const entryA = JSON.stringify({
      id: 'valid-a',
      at: '2026-01-01T00:00:00.000Z',
      action: 'shell',
      source: 'tool',
      instanceId: 'default',
      tool: null,
      summary: 'a',
      ok: true,
      error: null,
      durationMs: null,
      argsPreview: null,
      shotId: null,
    });
    const entryB = JSON.stringify({
      id: 'valid-b',
      at: '2026-01-01T00:00:01.000Z',
      action: 'start',
      source: 'tool',
      instanceId: 'default',
      tool: 'apk_vm',
      summary: 'b',
      ok: true,
      error: null,
      durationMs: 5,
      argsPreview: '{"action":"start"}',
      shotId: null,
    });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'activity.jsonl'),
      `${entryA}\nnot json at all\n{"broken":\n${entryB}\n{"id":"partial-only"}\n`,
      'utf8'
    );
    const listed = await log.list();
    eq(listed.entries.length, 2, 'corrupt lines are skipped');
    same(listed.entries.map((entry) => entry.id), ['valid-b', 'valid-a'], 'valid lines keep their order');
    eq((await log.get('valid-a')).summary, 'a', 'get sees the validated entries');

    const fresh = await log.record({ action: 'stop', summary: 'after corruption' });
    const rewritten = await readJsonLines(dir);
    eq(rewritten.length, 2, 'pruning rewrites the journal down to the ring size');
    ok(
      rewritten.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }),
      'rewritten journal has no corrupt lines'
    );
    const afterRewrite = await log.list();
    same(
      afterRewrite.entries.map((entry) => entry.id),
      [fresh.id, 'valid-b'],
      'newest entries survive the rewrite and old/corrupt lines are dropped'
    );
  }

  console.log('activity-log: JSON safety and secret stripping');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir, maxStringBytes: 2048 });
    const circular = { a: 1 };
    circular.self = circular;
    const entry = await log.record({
      action: 'shell',
      args: {
        circular,
        bytes: Buffer.from('hi'),
        date: new Date('2026-01-02T03:04:05.000Z'),
        big: 10n,
        missing: undefined,
        fn() {},
        nan: Number.NaN,
      },
    });
    ok(typeof entry.argsPreview === 'string', 'argsPreview is stored as a string');
    const parsed = JSON.parse(entry.argsPreview);
    same(parsed.bytes, { type: 'bytes', length: 2 }, 'buffers become JSON-safe byte markers');
    eq(parsed.date, '2026-01-02T03:04:05.000Z', 'dates become ISO strings');
    eq(parsed.big, '10', 'bigint becomes a string');
    eq(parsed.missing, null, 'undefined becomes null');
    eq(parsed.fn, null, 'functions become null');
    eq(parsed.nan, null, 'non-finite numbers become null');
    eq(parsed.circular.self, '[Circular]', 'cycles become [Circular]');
    ok(!entry.argsPreview.includes('undefined'), 'serialized args contain no undefined token');

    // Fixture values are assembled at runtime so the privacy scanner does not
    // mistake these intentionally leaked test strings for real credentials.
    const fakeToken = ['sk', 'verysecret1234567890'].join('-');
    const secret = await log.record({
      action: 'shell',
      summary: 'token=' + 'abc12345' + ' leaked',
      args: {
        password: 'hunter' + '2',
        token: fakeToken,
        apiKey: 'secret' + 'value',
        nested: { authorization: ['Bearer', 'abcdefghijklmnop'].join(' ') },
        query: 'password=' + 'hunter3' + '&x=1',
      },
    });
    for (const leaked of ['hunter' + '2', ['sk', 'verysecret'].join('-'), 'secret' + 'value', 'abcdefghijklmnop', 'hunter3']) {
      ok(!String(secret.argsPreview).includes(leaked), `argsPreview strips secret value ${leaked}`);
    }
    ok(String(secret.argsPreview).includes('[redacted]'), 'argsPreview keeps a redaction marker');
    ok(!String(secret.summary).includes('abc12345'), 'summary strips secret assignments');
    eq(JSON.parse(secret.argsPreview).password, '[redacted]', 'secret keys become [redacted]');

    const long = await log.record({
      action: `act-${'y'.repeat(300)}`,
      summary: 's'.repeat(5000),
      error: 'e'.repeat(5000),
    });
    ok(long.summary.length <= 2048 && long.summary.endsWith('…'), 'summary is truncated to maxStringBytes');
    ok(long.error.length <= 2048 && long.error.endsWith('…'), 'error is truncated to maxStringBytes');
    ok(long.action.length <= 100, 'action is truncated to 100 chars');

    const failing = await log.record({ action: 'start', ok: false, error: new Error('device offline'), durationMs: 12.7 });
    eq(failing.ok, false, 'ok:false is preserved');
    eq(failing.error, 'device offline', 'Error instances store their message');
    eq(failing.durationMs, 13, 'durationMs is rounded');

    const custom = await log.record({
      id: 'custom-id-1',
      at: '2026-01-02T03:04:05.000Z',
      action: 'shell',
      source: 'http',
      instanceId: 123,
      tool: 'apk_vm',
      argsPreview: '{"already":"serialized"}',
    });
    eq(custom.id, 'custom-id-1', 'safe custom ids are kept');
    eq(custom.at, '2026-01-02T03:04:05.000Z', 'custom ISO timestamps are kept');
    eq(custom.source, 'http', 'http source is kept');
    eq(custom.instanceId, '123', 'numeric instance ids are stringified');
    eq(custom.tool, 'apk_vm', 'tool name is kept');
    eq(custom.argsPreview, '{"already":"serialized"}', 'string argsPreview is kept as-is');

    const normalizedSource = await log.record({ action: 'shell', source: 'martian' });
    eq(normalizedSource.source, 'tool', 'unknown sources fall back to tool');
  }

  console.log('activity-log: record never throws');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    for (const weird of [null, undefined, 42, 'text', [], { action: { hostile: true } }, Symbol('s')]) {
      let result;
      let failed = false;
      try {
        result = await log.record(weird);
      } catch {
        failed = true;
      }
      ok(!failed, `record(${typeof weird}) resolves instead of throwing`);
      ok(result && typeof result === 'object' && typeof result.id === 'string', `record(${typeof weird}) returns an entry`);
    }
    const traversal = await log.record({ id: '../../evil', action: 'shell' });
    ok(/^[A-Za-z0-9_-]+$/.test(traversal.id), 'unsafe ids are replaced with generated ids');
    eq(await log.get('../../evil'), null, 'unsafe ids cannot be fetched');
    const listed = await log.list({ limit: 1000 });
    eq(listed.entries.length, 8, 'all attempted records landed as valid entries');
  }

  console.log('activity-log: concurrent records');
  {
    const dir = await tempDir();
    const log = new ActivityLog({ rootDir: dir });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => log.record({ action: 'shell', summary: `concurrent-${index}` }))
    );
    eq(new Set(results.map((entry) => entry.id)).size, 20, 'concurrent records get unique ids');
    const listed = await log.list({ limit: 1000 });
    eq(listed.entries.length, 20, 'no concurrent append is lost');
    eq((await readJsonLines(dir)).length, 20, 'journal has one line per record');
    eq((await log.stats()).count, 20, 'stats count every concurrent record');
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const dir of tempDirs) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore temp cleanup failures */
    }
  }
  console.log(`\n${checks} checks passed`);
}
