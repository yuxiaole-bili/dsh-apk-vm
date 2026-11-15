# dsh-apk-vm 0.12.2 — panel version chip fix

**Release date:** 2026-11-15

0.12.2 is a small follow-up to 0.12.1. It fixes the panel header reporting the wrong plugin
version (`v0.11.1` instead of the installed version) and adds a release check so the mismatch
cannot silently ship again. All 0.12.1 features — remote VM multi-session, emulator inventory,
virtual camera/microphone, the new icon and the wide-screen dashboard — are unchanged.

## Fixed

- **Panel version chip reported `v0.11.1` on 0.12.0/0.12.1.** The panel ships as plain ESM, and
  `client.js` carried a hand-maintained `CLIENT_VERSION` constant that was never bumped after
  0.11.1. The header pill now prefers the host-reported `pluginVersion` (so it always matches the
  installed plugin), the constant is set to `0.12.2`, and the stale-client banner still warns when
  a cached older panel is served.
- **Release check.** `scripts/check-version.mjs` now runs as part of `npm run check` and fails
  when `CLIENT_VERSION` in `client.js` differs from `package.json`.

## Verification

- `npm run check` — syntax checks plus the new version-consistency check.
- `npm test` — full automated suite (hermetic + mock-device; no emulator required).
- `node scripts/privacy-scan.mjs --untracked` — clean.
- Panel verified against a live plugin host: `GET /apk-vm/state` reports
  `pluginVersion: 0.12.2` and the header pill follows it after a panel reload.

## Install

```bash
npm install dsh-apk-vm@0.12.2
```

or update the plugin in the DSH plugin manager, then reload the panel (Ctrl+R). The panel shows
`v0.12.2` once the refreshed client bundle is loaded.

## Known issues

- A freshly attached remote instance can return one transient 409 from
  `/apk-vm/instances/<id>/frame` while its status flips to `ready`; polling recovers on the next
  request.
- The virtual microphone `file` mode requires PulseAudio (Linux or a remote SSH host). On Windows
  only `host` passthrough is available.
