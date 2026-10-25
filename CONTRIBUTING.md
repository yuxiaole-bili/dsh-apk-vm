# Contributing to dsh-apk-vm

Thanks for improving the APK Virtual Machine plugin. This document covers the repository
layout, the development workflow, the checks a change must pass, and the conventions this
project follows.

By participating you agree to keep discussion respectful and to license your contributions
under the repository's [Apache-2.0](LICENSE) terms.

- Bugs / feature requests: use the [issue templates](.github/ISSUE_TEMPLATE/).
- Community behavior: follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security issues: **do not** open a public issue — follow [SECURITY.md](SECURITY.md).
- Larger design changes: open an issue first; the architecture notes live in
  [DESIGN.md](DESIGN.md).

---

## Repository layout

| Path | What it is |
| --- | --- |
| [index.js](index.js) | Host half (`apply(ctx, config)`): HTTP routes, WebSocket relay, rooted debug API, `apk_vm` Agent tool. |
| [client.js](client.js) | Client half: a pre-built browser bundle exposing the sidebar entry, main panel, better-sidebar tab, environment card, APK upload/drop and WebCodecs canvas. |
| [lib/android.js](lib/android.js) | `AndroidVm`: AVD lifecycle, adb commands, APK discovery/install, screenshots, input, rooted debug helpers and the extra device actions (rotate / UI dump / record / perf). |
| [lib/scrcpy.js](lib/scrcpy.js) | `ScrcpySession`: pushes the vendored scrcpy server, H.264 demux, Annex-B→AVCC, control messages. |
| [lib/setup.js](lib/setup.js) | Dependency-free environment detection (SDK, adb, emulator, command-line tools, system image, AVD, acceleration) plus `createAvd()` / `installSystemImage()`. |
| [lib/ws.js](lib/ws.js) | Dependency-free RFC 6455 WebSocket server used by `/apk-vm/ws`. |
| [lib/vendor/scrcpy-server-v5.0.1.jar](lib/vendor/scrcpy-server-v5.0.1.jar) | Vendored scrcpy 5.0.1 server JAR (Apache-2.0, unmodified — see [NOTICE](NOTICE)). |
| [cordis.patch.yml](cordis.patch.yml) | Bundle patch that inserts the plugin row and its default config. |
| [locale/](locale) | `en.json` / `zh.json` display metadata (`meta.title`, `meta.description`). |
| [spike/](spike) | Test harnesses and protocol notes. Not loaded by the plugin at runtime. |
| [DESIGN.md](DESIGN.md) | Design rationale, architecture, verified measurements and evolution notes (Chinese). |

There is **no build step and no npm dependency graph**: `index.js` and `lib/**` import Node
built-ins only, and `client.js` is plain JavaScript evaluated by the DSH Web module loader.
Do not introduce a bundler or npm packages for the Host half; keep `client.js` dependency-free
apart from the `react` provided by the DSH client runtime.

---

## Development environment

- **Node.js 24+** for running the checks (`node --check`, spike suites) — matches CI.
- A **Windows host** for end-to-end work: Android SDK (`platform-tools`, `emulator`,
  `build-tools`), one AOSP system image (the reference image is
  `system-images;android-34;default;x86_64`), hardware acceleration (AEHD/WHPX on Windows) and
  an AVD created for the plugin. The panel's **Environment** card reports what is missing.
- **No `npm install` is required.** If you add files that should ship, update `files` in
  [package.json](package.json) — do not add runtime dependencies.

A quick manual smoke test on a development machine:

```bash
# 1. install this folder as a local bundle in DSH (Plugins UI or plugin_manager tool)
# 2. reload the DSH Web UI
# 3. open the APK Virtual Machine sidebar entry and check the Environment card
# 4. start the VM, install an APK (upload or path), interact, exercise the Rooted debug card
```

---

## Testing

### Headless suites (run in CI, no emulator needed)

```bash
node --check index.js
node --check client.js
for f in lib/*.js; do node --check "$f"; done

node spike/ui-smoke.cjs                 # 136 sandbox assertions on the real client bundle
node spike/ui-better-sidebar-smoke.cjs  # optional better-sidebar integration
node spike/setup-smoke.mjs              # 30 hermetic environment/setup checks (no SDK needed)
node spike/android/mock-device.mjs      # device critical path against a mock adb (24 checks)
node spike/android/launch-plan.mjs      # fast-boot argv plan assertions
```

`spike/android/mock-device.mjs` parses a real APK with `aapt2`, so it needs Android SDK
build-tools (`ANDROID_HOME` / `ANDROID_SDK_ROOT` or an SDK found on the host). The CI workflow
uses the Android SDK preinstalled on GitHub's `ubuntu-latest` runner. `spike/setup-smoke.mjs` is
fully hermetic: it mocks OS layouts and the `exec` boundary, so it needs neither an SDK nor an
emulator and runs on any OS.

The Host HTTP/WebSocket surface (`/apk-vm/*`, including `/apk-vm/upload` and `/apk-vm/setup`)
is exercised in parts by the client sandbox (request shape) and the setup suite; end-to-end
route-level tests belong to the Windows-local integration pass. When changing routes, keep the
same-origin guard, body bounds and lifecycle cleanup intact.

A few more harnesses are useful but not part of CI:

```bash
node spike/scrcpy/test-fake-device.js    # 160 assertions against a fake scrcpy-server
node spike/android/smoke.mjs             # device methods with an injected empty adb
```

Running `spike/scrcpy/test-fake-device.js` regenerates
`spike/scrcpy/capture-fake.h264` and `spike/scrcpy/report.json`; treat those as generated
artifacts, not hand-edited sources.

### Emulator integration tests are Windows-local only

The end-to-end paths (real emulator boot, snapshot save/restore, actual H.264 stream, rooted
debug actions, APK upload) require hardware virtualization and an AVD. GitHub-hosted runners do
not provide nested virtualization, so these tests are **not** part of hosted CI. When a change
touches VM lifecycle, boot plans, streaming, upload or the rooted debug surface, run the
relevant scenario on a Windows host and state in the PR what you ran and what you observed
(boot kind/time, FPS, logs).

Do not report unmeasured numbers as results. If a benchmark could not be reproduced, say so
instead of copying a figure from an earlier run.

### UI changes

- `client.js` is loaded via `window.__ModuleLoader__.load(...)` and may only require `react`;
  keep it a single self-contained browser file.
- Style with `--dsw-alias-*` theme tokens (no hard-coded panel/button colors); content inside the
  phone frame (the simulated Android screen) is the intended exception.
- Add strings to both `en` and `zh` maps in `client.js`; keep locale files for metadata in sync.
- The DSH Web GUI is authenticated. The headless verification flow used for decoding tests may
  not be able to load the panel itself, so validate UI behavior with `spike/ui-smoke.cjs`
  (which renders the real component tree in a sandbox) and, when possible, a signed-in manual
  pass. Never commit screenshots or numbers that were not actually captured.

---

## Coding conventions

- **Never build shell command strings for host processes.** Spawn `adb`/`emulator`/`sdkmanager`/
  `avdmanager` with `child_process.spawn(exe, argv)` and pass user data as argv entries.
- **Bound everything.** Request bodies, APK uploads, stdout/stderr, log lines, APK scan
  depth/results and screenshots already have limits; keep new code within them.
- **Fail visibly.** Return structured `{ ok: false, error }` (or throw inside route handlers,
  which the shared wrapper converts) and surface problems in the panel/log tail instead of
  swallowing them.
- **Same-origin only.** All HTTP/WebSocket routes live behind the DSH Web server and keep the
  `isSameOrigin` check; do not bind additional listeners.
- **Clean up.** Register routes/timers/tools inside `ctx.effect(...)` and return disposers;
  stopping/restarting/unloading must stop the emulator, the scrcpy session, WebSocket clients
  and the upload temp directory.
- **Bounded surface.** Keep the scrcpy session shared across clients and stop it when the last
  client disconnects (the VM keeps running).
- **Verified claims only.** README/verification tables must match what was measured on a named
  host. Mark unshipped features under *Roadmap* — never as available.

---

## Commit and pull requests

- Keep PRs focused; a bug fix or a feature plus its docs/tests is the right size.
- Write commit messages that explain the *why*; reference issues when applicable.
- Fill out [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md), including the
  checks you ran and any platform-specific verification.
- Do not commit build outputs, `node_modules`, emulator logs, recordings, API keys, or paths
  from your machine that are not needed for the feature.
- If you change configuration keys, routes, or the `apk_vm` tool schema, update
  [README.md](README.md) (Configuration / HTTP control plane / tool sections) in the same PR.
- If you add a new file that must ship with the package, update `files` in `package.json`.

---

## Release hygiene (maintainers)

1. Run the headless suites above (they mirror CI).
2. Run the Windows-local emulator scenarios for anything touching boot/stream/upload/debug.
3. Re-read the README "Verification" and "Performance" tables; delete or update anything that no
   longer holds, and never fill in a number that was not measured on the stated host.
4. Confirm [NOTICE](NOTICE) still matches the vendored third-party content.
5. Confirm the demo placeholders in README are either replaced by real assets or still clearly
   marked as not recorded.

---

## License

By contributing you agree that your contributions are licensed under the Apache License,
Version 2.0, and that you have the right to submit them. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for the project license and third-party attribution.
