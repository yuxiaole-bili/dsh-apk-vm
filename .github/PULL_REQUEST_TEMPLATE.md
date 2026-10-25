# Pull request

## Summary

<!-- What does this PR change, and why? -->

## Related issue

<!-- Fixes #... / Refs #... — leave empty if none. -->

## Type of change

- [ ] Bug fix (non-breaking change)
- [ ] New feature (non-breaking change, documented and marked shipped only if verified)
- [ ] Breaking change (config key / route / tool schema changed)
- [ ] Documentation / CI / packaging only
- [ ] Refactor / internal cleanup

## Testing performed

<!-- Commands you actually ran and their results. Do not paste unmeasured numbers. -->

```bash
node --check index.js
node --check client.js
for f in lib/*.js; do node --check "$f"; done
node spike/ui-smoke.cjs
node spike/ui-better-sidebar-smoke.cjs
node spike/android/mock-device.mjs
node spike/android/launch-plan.mjs
```

- [ ] Headless suites above pass locally.

Emulator-dependent work (real boot, snapshot save/restore, H.264 stream, rooted debug) was
tested on a Windows host, because hosted CI has no nested virtualization:

- [ ] Not applicable to this PR.
- [ ] Tested on Windows; details (platform, acceleration backend, boot kind/time, FPS, logs):

<!-- Describe what you ran and what you observed. -->

## Checklist

- [ ] No npm runtime dependencies or build step were introduced (Host uses Node built-ins only;
      `client.js` stays a self-contained browser bundle that only requires `react`).
- [ ] `node --check` passes for every changed Host/Client/lib module.
- [ ] New/changed UI uses `--dsw-alias-*` theme tokens; localized strings added to both `en` and
      `zh` maps (and `locale/*.json` metadata if display metadata changed).
- [ ] Routes kept same-origin, payloads bounded, lifecycle disposers registered via `ctx.effect`.
- [ ] No shell command strings built for host processes (`spawn(exe, argv)` only).
- [ ] README updated when config keys, routes, the `apk_vm` tool schema, or verified
      verification/performance facts changed. Unshipped features remain under **Roadmap** and are
      not described as available.
- [ ] Same-origin guard, input/upload bounds and lifecycle cleanup kept intact for new routes.
- [ ] `NOTICE` updated if third-party/vendored content changed; `package.json` `files` updated
      for new shipped files.
- [ ] No secrets, tokens, personal paths, emulator logs or recordings committed. Screenshots are
      real captures (mockups are labeled as such).
- [ ] I agree that this contribution is licensed under the repository's Apache-2.0 terms and
      that I have the right to submit it.

## Notes for reviewers

<!-- Screenshots/recordings (real only), before/after behavior, follow-ups, known gaps. -->
