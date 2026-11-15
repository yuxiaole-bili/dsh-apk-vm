# dsh-apk-vm 0.12.3

This release turns the plugin into a more complete agent-facing device service:
an agent playbook ships inside the package, new conversations are onboarded once,
VMs can be named and are followed per conversation, quick-boot snapshots heal
themselves, and the plugin declares which DSH releases it supports.

## Highlights

- **Agent playbook in the package.** `docs/AGENTS.md` is included and readable at
  runtime: `apk_vm` action `guide` returns the Markdown itself, and
  `GET /apk-vm/guide` serves the same file. The tool description, README and
  docs/README.md link to it. It documents the standard loop, action map,
  device-pixel vs CSS-pixel coordinates, WebView/CDP usage, instances and remote
  sessions, error recovery and safety boundaries.
- **Forced onboarding for new conversations.** The first `apk_vm` call in a new
  conversation returns the playbook once (`result.guideRequired: true`) instead
  of executing the requested action; repeat the call to continue.
  `action=guide` remains available at any time and never touches a VM.
- **Shared vs dedicated VMs.** The playbook and README now recommend claiming a
  dedicated VM (`ownerScope=conversation|project`, or `create_instance`) for
  long-lived debugging instead of holding the shared default VM, and entering
  the shared VM from another conversation resets the guest to its home screen
  (`KEYCODE_HOME` + keyguard dismissal) so nobody inherits someone else's app.
- **Named VMs and per-conversation auto-selection.** Every VM (including
  `default` and remote sessions) can carry a persisted display name
  (`<profile>/.apk-vm/instance-names.json`). Rename from an agent with
  `apk_vm` action `rename_instance`, from scripts with
  `POST /apk-vm/instances {"action":"rename","instance":"default","name":"QA phone"}`,
  or from the Instances card in the panel. The panel follows the current
  conversation and selects the VM whose lease belongs to the active session
  (falling back to `default`); a manual pick sticks for that session.
- **Quick-boot snapshot self-healing.** A snapshot that crashes the emulator on
  restore (Windows `0xC0000005`) or that looks partially written
  (`snapshot.pb` much newer than `ram.bin`) is quarantined, retried once as a
  cold boot and rebuilt. The quarantine path is exposed as
  `status().snapshotRecovery`.
- **DSH compatibility metadata.** `package.json` declares `engines.dsh`
  (`>=0.2.1-rc.3 || >=0.2.2-rc.1`) and `dsh.compatibility.dshReleases`, so the
  plugin manager and market can verify supported DSH releases before install.
  README has a "Supported DSH versions" section; tested with DSH Desktop
  0.2.1-rc.3 and 0.2.2-rc.3 (Node 24.21.0, host protocol v4).
- **Version-chip fix carried over from 0.12.2.** The panel version chip follows
  the host's `pluginVersion`; `scripts/check-version.mjs` now fails `npm run check`
  if `package.json` and the client's `CLIENT_VERSION` ever diverge again.

## Verification

- `npm run check` — exit 0 (`check-version: ok (0.12.3)`).
- `npm test` — exit 0 across the full suite: tool-core (including forced
  onboarding and `guide`/`/apk-vm/guide`), instance names (6 checks), snapshot
  recovery, remote sessions (45 checks), media, emulator inventory, activity
  journal, Android resilience, ownership, and the UI smokes.
- `node scripts/privacy-scan.mjs --untracked` — clean (working tree, including
  untracked files).
- Live checks on the reference Windows/AEHD host: onboarding gate returns the
  playbook once; second call executes; `rename_instance` and HTTP rename persist;
  panel auto-selection follows the current session; a deliberately corrupted
  snapshot was quarantined and the VM cold-booted once and rebuilt a warm
  snapshot (`status().snapshotRecovery` populated).

## Limits

- Remote multi-session/emulator inventory/camera/mic were introduced in 0.12.1;
  remote hosts still need an AVD each (Android does not allow two emulator
  instances on the same AVD unless all are `-read-only`) and no virtual webcam
  device is emulated — the virtual camera is the emulator's `virtualscene` with
  optional posters, and microphone capture on Windows is host passthrough only.
- `/apk-vm/instances/<id>/frame` can return one 409 right at the boot→ready
  edge; clients should retry briefly (the panel already does).
- The shared default VM now resets to the home screen when entered from a
  different conversation; that is intentional, but scripts that expect to find
  the previous app foreground should claim/own the VM instead.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.12.3
```

DSH Desktop: Plugins → add/install local bundle, or `plugin_manager` with the
npm package `dsh-apk-vm@0.12.3`.

## Publishing checklist (maintainers)

- [ ] `npm run check && npm test`
- [ ] `node scripts/privacy-scan.mjs --untracked` (clean)
- [ ] `npm publish --access public --registry=https://registry.npmjs.org`
- [ ] `git push origin HEAD:main && git push origin v0.12.3`
- [ ] GitHub release from this file (draft → publish)
