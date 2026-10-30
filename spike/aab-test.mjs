#!/usr/bin/env node
/**
 * Hermetic checks for lib/aab.js. Creates fake .aab inputs and fake bundletool
 * jar/executable wrappers (Node scripts), so no Android SDK, JDK or real
 * bundletool is required. All scratch state lives under os.tmpdir().
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { aabInfo, buildApksFromAab, detectBundletool } from '../lib/aab.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const PASS = 'PASS';
const FAIL = 'FAIL';

let passed = 0;
let failed = 0;
let current = '';

async function test(name, fn) {
  current = name;
  try {
    await fn();
    passed += 1;
    console.log(`${PASS} ${name}`);
  } catch (error) {
    failed += 1;
    const detail = error && error.stack ? error.stack : String(error);
    console.error(`${FAIL} ${name}\n${detail}`);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-aab-test-'));
const scratch = {
  root,
  aabPath: path.join(root, 'app.aab'),
  fakeJar: path.join(root, 'fake', 'bundletool-all-1.17.2.jar'),
  fakeKeystore: path.join(root, 'fake', 'release.jks'),
  fakeJava: path.join(root, 'jdk', 'bin', `java${EXE}`),
  binDir: path.join(root, 'bin'),
  emptyRepo: path.join(root, 'empty-repo'),
  toolsJar: path.join(root, 'repo', 'tools', 'bundletool-all-1.17.2.jar'),
};
scratch.fakeExe = path.join(scratch.binDir, IS_WIN ? 'bundletool.cmd' : 'bundletool');
const fakeApks = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from('fake universal apks')]);
const aabPayload = Buffer.from('PK fake app bundle used by the hermetic AAB test', 'utf8');

const isolatedEnv = {
  PATH: scratch.binDir,
  PATHEXT: '.EXE;.CMD;.BAT',
  JAVA_HOME: path.join(root, 'jdk'),
};

try {
  await mkdir(path.dirname(scratch.fakeJar), { recursive: true });
  await mkdir(path.dirname(scratch.fakeJava), { recursive: true });
  await mkdir(scratch.binDir, { recursive: true });
  await mkdir(scratch.emptyRepo, { recursive: true });
  await mkdir(path.dirname(scratch.toolsJar), { recursive: true });
  await writeFile(scratch.aabPath, aabPayload);
  await writeFile(scratch.fakeJar, 'not a real jar; detection only');
  await writeFile(scratch.fakeKeystore, 'not a real keystore; argument test only');
  await writeFile(scratch.fakeJava, '');
  await writeFile(scratch.fakeExe, IS_WIN ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  await writeFile(scratch.toolsJar, 'not a real jar; repo/tools detection only');
  if (!IS_WIN) await chmod(scratch.fakeExe, 0o755);

  await test('detectBundletool finds an explicit jar', () => {
    const found = detectBundletool({
      bundletoolPath: scratch.fakeJar,
      env: {},
      repoRoot: scratch.emptyRepo,
    });
    assert.equal(found.available, true);
    assert.equal(found.kind, 'jar');
    assert.equal(found.path, scratch.fakeJar);
    assert.equal(typeof found.javaPath, 'string');

    const viaJarPath = detectBundletool({
      jarPath: scratch.fakeJar,
      env: {},
      repoRoot: scratch.emptyRepo,
    });
    assert.equal(viaJarPath.kind, 'jar');
    assert.equal(viaJarPath.path, scratch.fakeJar);
  });

  await test('detectBundletool honors BUNDLETOOL_JAR and BUNDLETOOL_PATH', () => {
    const viaEnvJar = detectBundletool({
      env: { BUNDLETOOL_JAR: scratch.fakeJar },
      repoRoot: scratch.emptyRepo,
    });
    assert.equal(viaEnvJar.kind, 'jar');
    assert.equal(viaEnvJar.path, scratch.fakeJar);

    const viaEnvPath = detectBundletool({
      env: { BUNDLETOOL_PATH: scratch.fakeExe },
      repoRoot: scratch.emptyRepo,
    });
    assert.equal(viaEnvPath.kind, 'exe');
    assert.equal(viaEnvPath.path, scratch.fakeExe);
  });

  await test('detectBundletool finds bundletool on PATH and Java via JAVA_HOME', () => {
    const found = detectBundletool({ env: isolatedEnv, repoRoot: scratch.emptyRepo });
    assert.equal(found.available, true);
    assert.equal(found.kind, 'exe');
    assert.equal(found.path, scratch.fakeExe);
    assert.equal(found.javaPath, scratch.fakeJava);
  });

  await test('detectBundletool falls back to repo/tools jars', () => {
    const found = detectBundletool({ env: {}, repoRoot: path.join(root, 'repo') });
    assert.equal(found.available, true);
    assert.equal(found.kind, 'jar');
    assert.equal(found.path, scratch.toolsJar);
  });

  await test('detectBundletool reports missing without inventing a path', () => {
    const missing = detectBundletool({ env: {}, repoRoot: scratch.emptyRepo });
    assert.equal(missing.available, false);
    assert.equal(missing.kind, 'missing');
    assert.equal(missing.path, null);
    assert.equal(typeof missing.javaPath, 'string');
  });

  await test('aabInfo reads stat-only metadata', async () => {
    const info = await aabInfo(scratch.aabPath);
    assert.equal(info.ok, true);
    assert.equal(info.path, scratch.aabPath);
    assert.equal(info.name, 'app.aab');
    assert.equal(info.size, aabPayload.length);
    assert.equal(typeof info.available, 'boolean');
    assert.match(info.tool.kind, /^(jar|exe|missing)$/);

    await assert.rejects(aabInfo(path.join(root, 'app.zip')), /\.aab/);
  });

  await test('buildApksFromAab builds jar argv and creates nested outDir', async () => {
    const calls = [];
    const outDir = path.join(root, 'out', 'nested');
    const exec = async (file, args) => {
      calls.push({ file, args });
      const outputArg = args.find((arg) => arg.startsWith('--output='));
      assert.ok(outputArg, 'missing --output argument');
      await writeFile(outputArg.slice('--output='.length), fakeApks);
      return { code: 0, stdout: 'fake bundletool: universal .apks built', stderr: '' };
    };

    const result = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir,
      bundletoolPath: scratch.fakeJar,
      javaPath: scratch.fakeJava,
      exec,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.apksPath, path.join(outDir, 'app.apks'));
    assert.match(result.output, /universal \.apks built/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, scratch.fakeJava);
    assert.deepEqual(calls[0].args, [
      '-jar',
      scratch.fakeJar,
      'build-apks',
      `--bundle=${scratch.aabPath}`,
      `--output=${result.apksPath}`,
      '--mode=universal',
    ]);
    assert.ok((await stat(result.apksPath)).isFile());
  });

  await test('buildApksFromAab runs an executable directly with argv', async () => {
    const calls = [];
    const outDir = path.join(root, 'out-exe');
    const exec = async (file, args) => {
      calls.push({ file, args });
      const outputArg = args.find((arg) => arg.startsWith('--output='));
      assert.ok(outputArg, 'missing --output argument');
      await writeFile(outputArg.slice('--output='.length), fakeApks);
      return { ok: true, stdout: 'fake executable: built' };
    };

    const result = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir,
      bundletoolPath: scratch.fakeExe,
      exec,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.apksPath, path.join(outDir, 'app.apks'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, scratch.fakeExe);
    assert.deepEqual(calls[0].args, [
      'build-apks',
      `--bundle=${scratch.aabPath}`,
      `--output=${result.apksPath}`,
      '--mode=universal',
    ]);
    assert.ok(!calls[0].args.includes('-jar'));
  });

  await test('buildApksFromAab passes signing args and redacts secrets', async () => {
    const calls = [];
    const outDir = path.join(root, 'out-signed');
    const exec = async (file, args) => {
      calls.push({ file, args });
      const outputArg = args.find((arg) => arg.startsWith('--output='));
      await writeFile(outputArg.slice('--output='.length), fakeApks);
      // Pretend a noisy tool echoed the password; the returned output must redact it.
      return { code: 0, stdout: 'fake bundletool saw ks-test-secret', stderr: '' };
    };

    const result = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir,
      bundletoolPath: scratch.fakeJar,
      javaPath: scratch.fakeJava,
      keystore: scratch.fakeKeystore,
      ksPassword: 'ks-test-secret',
      ksAlias: 'test-key',
      ksKeyPassword: 'key-test-secret',
      exec,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true, result.error);
    const args = calls[0].args;
    assert.ok(args.includes(`--ks=${scratch.fakeKeystore}`));
    assert.ok(args.includes('--ks-pass=pass:ks-test-secret'));
    assert.ok(args.includes('--ks-key-alias=test-key'));
    assert.ok(args.includes('--key-pass=pass:key-test-secret'));
    assert.match(result.output, /<redacted>/);
    assert.ok(!JSON.stringify(result).includes('ks-test-secret'));
    assert.ok(!JSON.stringify(result).includes('key-test-secret'));
  });

  await test('buildApksFromAab rejects unsupported modes and non-.aab paths', async () => {
    const outDir = path.join(root, 'out-invalid');
    await assert.rejects(
      buildApksFromAab({
        aabPath: scratch.aabPath,
        outDir,
        bundletoolPath: scratch.fakeJar,
        mode: 'split',
      }),
      /unsupported mode/i,
    );
    await assert.rejects(
      buildApksFromAab({
        aabPath: path.join(root, 'app.zip'),
        outDir,
        bundletoolPath: scratch.fakeJar,
      }),
      /\.aab/,
    );
  });

  await test('buildApksFromAab reports a missing bundletool without spawning', async () => {
    const outDir = path.join(root, 'out-missing');
    let spawned = false;
    const result = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir,
      bundletoolPath: path.join(root, 'missing', 'bundletool.jar'),
      env: {},
      repoRoot: scratch.emptyRepo,
      exec: async () => {
        spawned = true;
        return { code: 0 };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.apksPath, null);
    assert.match(result.error, /bundletool not found/i);
    assert.equal(result.output, '');
    assert.equal(spawned, false);
    assert.ok((await stat(outDir)).isDirectory());
  });

  await test('buildApksFromAab surfaces command failures and missing outputs', async () => {
    const failedResult = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir: path.join(root, 'out-failed'),
      bundletoolPath: scratch.fakeJar,
      javaPath: scratch.fakeJava,
      exec: async () => ({ code: 1, stdout: '', stderr: 'simulated bundletool failure' }),
    });
    assert.equal(failedResult.ok, false);
    assert.equal(failedResult.apksPath, null);
    assert.match(failedResult.output, /simulated bundletool failure/);
    assert.match(failedResult.error, /code 1/);

    const noOutputResult = await buildApksFromAab({
      aabPath: scratch.aabPath,
      outDir: path.join(root, 'out-no-file'),
      bundletoolPath: scratch.fakeJar,
      javaPath: scratch.fakeJava,
      exec: async () => ({ code: 0, stdout: 'reported success without a file' }),
    });
    assert.equal(noOutputResult.ok, false);
    assert.equal(noOutputResult.apksPath, null);
    assert.match(noOutputResult.error, /did not create/);
  });

  await test('buildApksFromAab rejects outDir paths that are files', async () => {
    const fileAsDir = path.join(root, 'not-a-dir');
    await writeFile(fileAsDir, 'plain file');
    await assert.rejects(
      buildApksFromAab({
        aabPath: scratch.aabPath,
        outDir: fileAsDir,
        bundletoolPath: scratch.fakeJar,
      }),
      /not a directory/,
    );
  });

  // Real spawn path: a fake java/bundletool wrapper writes the .apks itself.
  const runDir = path.join(root, 'run');
  const helperPath = path.join(runDir, 'fake-bundletool.mjs');
  const runJar = path.join(runDir, 'bundletool.jar');
  const javaWrapper = path.join(runDir, IS_WIN ? 'java.cmd' : 'java');
  const exeWrapper = path.join(runDir, IS_WIN ? 'bundletool.cmd' : 'bundletool');
  await mkdir(runDir, { recursive: true });
  await writeFile(runJar, 'fake jar; wrapper handles execution');
  await writeFile(
    helperPath,
    [
      "import { promises as fsp } from 'node:fs';",
      "import path from 'node:path';",
      '',
      'const args = process.argv.slice(2);',
      "const start = args[0] === '-jar' ? 2 : 0;",
      'if (args[start] !== "build-apks") {',
      '  console.error("fake bundletool: expected build-apks in " + JSON.stringify(args));',
      '  process.exit(2);',
      '}',
      'if (!args.includes("--mode=universal")) {',
      '  console.error("fake bundletool: expected --mode=universal");',
      '  process.exit(3);',
      '}',
      'const outputArg = args.find((arg) => arg.startsWith("--output="));',
      'if (!outputArg) {',
      '  console.error("fake bundletool: missing --output");',
      '  process.exit(4);',
      '}',
      'const output = outputArg.slice("--output=".length);',
      'await fsp.mkdir(path.dirname(output), { recursive: true });',
      'await fsp.writeFile(output, Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("fake-spawned-apks")]));',
      'console.log("fake bundletool: wrote " + path.basename(output));',
      '',
    ].join('\n'),
  );
  const wrapperSource = IS_WIN
    ? `@echo off\r\n"%DSH_AAB_TEST_NODE%" "%~dp0fake-bundletool.mjs" %*\r\n`
    : `#!/bin/sh\nexec "$DSH_AAB_TEST_NODE" "$(dirname "$0")/fake-bundletool.mjs" "$@"\n`;
  await writeFile(javaWrapper, wrapperSource);
  await writeFile(exeWrapper, wrapperSource);
  if (!IS_WIN) {
    await chmod(javaWrapper, 0o755);
    await chmod(exeWrapper, 0o755);
  }

  // Keep the wrapper .cmd ASCII-only: %~dp0 expands the (possibly non-ASCII)
  // helper directory at runtime, and the Node path travels through the
  // environment, so cmd.exe never has to decode UTF-8 file content.
  const previousTestNode = process.env.DSH_AAB_TEST_NODE;
  process.env.DSH_AAB_TEST_NODE = process.execPath;
  try {
    await test('buildApksFromAab spawns java -jar and a fake tool writes the .apks', async () => {
      const outDir = path.join(root, 'out-spawn-jar');
      const result = await buildApksFromAab({
        aabPath: scratch.aabPath,
        outDir,
        bundletoolPath: runJar,
        javaPath: javaWrapper,
        timeoutMs: 20000,
      });
      assert.equal(result.ok, true, result.error || result.output);
      assert.equal(result.apksPath, path.join(outDir, 'app.apks'));
      assert.match(result.output, /fake bundletool: wrote app\.apks/);
      const built = await stat(result.apksPath);
      assert.ok(built.isFile() && built.size > 8);
    });

    await test('buildApksFromAab spawns an executable directly and writes the .apks', async () => {
      const outDir = path.join(root, 'out-spawn-exe');
      const result = await buildApksFromAab({
        aabPath: scratch.aabPath,
        outDir,
        bundletoolPath: exeWrapper,
        timeoutMs: 20000,
      });
      assert.equal(result.ok, true, result.error || result.output);
      assert.equal(result.apksPath, path.join(outDir, 'app.apks'));
      assert.match(result.output, /fake bundletool: wrote app\.apks/);
      const built = await stat(result.apksPath);
      assert.ok(built.isFile() && built.size > 8);
    });
  } finally {
    if (previousTestNode === undefined) delete process.env.DSH_AAB_TEST_NODE;
    else process.env.DSH_AAB_TEST_NODE = previousTestNode;
  }
} catch (error) {
  failed += 1;
  console.error(`${FAIL} test setup/teardown${current ? ` (after ${current})` : ''}`);
  console.error(error && error.stack ? error.stack : String(error));
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('AAB tests FAILED');
  process.exitCode = 1;
} else {
  console.log('AAB tests PASSED');
}
