# dsh-apk-vm 0.12.0

**Read what the WebView actually says, and keep your APKs across a guest reset.** `0.12.0` turns
`webviewAction=eval` into a real value-returning call and remembers apps installed through the
plugin so a quick-boot reset or a plugin upgrade no longer means reinstalling by hand.

## Highlights

- **`webviewAction=eval` returns values.** Ordinary JSON values come back as `result.value`;
  objects that do not survive JSON by value (`DOMRect`, `MediaQueryList`, class instances) come
  back as a JSON-safe property snapshot, and a compact preview is added to the tool summary. So
  `document.querySelector("#x").getBoundingClientRect().width` and
  `matchMedia("(pointer: coarse)").matches` read correctly without injecting a banner and taking a
  screenshot. Statement blocks fall back to plain CDP evaluation (no property snapshot; the
  result is whatever the runtime returns, often `null`); wrap a sequence in an expression instead:

  ```js
  (() => {
    const r = document.querySelector("#x").getBoundingClientRect();
    return { width: r.width, height: r.height };
  })()
  ```

- **Remembered APKs / auto-reinstall.** APKs installed through the panel or the Agent tool are
  recorded in `<profile>/.apk-vm/installed-apps.json`; uploaded APKs are archived under
  `<profile>/.apk-vm/apks` (newest 10). When the guest no longer has a remembered package — after a
  quick-boot snapshot reset, a recreated AVD or a plugin/emulator upgrade — the plugin reinstalls
  it on the next boot and journals the pass as a `source: system` activity entry. Config:
  `autoReinstall` (default `true`).
- **Docs for phone-driven testing.** A new Troubleshooting section covers physical-pixel vs CSS
  coordinates (`device = round(css * dpr) + offset`), preferring `tap_css` / `tap_selector`,
  pinning `instance: "default"`, the soft-keyboard tap pitfall and how resets interact with app
  data.

## Verification

- `node --check` on the touched files — pass
- `spike/cdp-test.mjs` — 17 tests pass (5 new for the eval helpers and `evaluateJson`)
- `spike/installed-apps-test.mjs` — 9 hermetic tests pass (registry, pruning, corrupt state,
  reinstall selection, failures)
- `npm run check` / `npm test` / `npm run privacy -- --untracked` — pass
- Live Android 14 emulator against a real WebView target (`org.chromium.webview_shell`):
  `document.body.getBoundingClientRect()` returned a property snapshot
  (`{"x":8,"y":8,"width":964,"height":1318.0625,...}`),
  `matchMedia("(pointer: coarse)").matches` returned `false`, `window.innerWidth` returned `980`,
  a plain object came back as JSON and an IIFE returned `{"w":964,"h":1318.0625}` — all through
  `apk_vm { action: "webview", webviewAction: "eval" }`.
- An installed APK is reinstalled after a quick-boot reset when the package is removed from the
  guest. The registry, pruning, reinstall selection and failure handling are covered by the
  hermetic suite; a live destructive reset was not exercised on the shared reference guest.

## Limits

- Reinstall trusts the recorded APK path (or the archived copy); if the archive is deleted the
  entry is reported as `apk-missing` and skipped.
- Android-side app data (login state, preferences) is not part of the archive — `clear_data` or a
  wiped quick-boot snapshot still requires an app-level re-login.
- `webviewAction=eval` returns values for single expressions; multi-statement scripts fall back to
  plain evaluation and report `null` (wrap them in an IIFE and return a value).

## Install

```bash
dsh plugin --profile desktop add dsh-apk-vm
```

Existing installs: update the plugin and reload the DSH Web page so the new `client.js` bundle is
used. No configuration change is required; `autoReinstall` defaults to `true`.

## Publishing checklist (maintainers)

1. `npm run check` / `npm test` / `npm run privacy -- --untracked` on a clean tree.
2. Confirm `package.json` version `0.12.0`, this file, `CHANGELOG.md` and `README.md` agree.
3. `npm pack --dry-run` — confirm the package contains `lib/installed-apps.js`.
4. `npm login` → `npm publish --access public` → `npm view dsh-apk-vm version`.
5. Push the clean open-source branch and tag `v0.12.0`; create the GitHub release with excerpts of
   this file.
