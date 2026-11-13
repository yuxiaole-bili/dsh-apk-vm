# Privacy

This plugin is a local development tool. It does not include analytics, telemetry, crash
reporting, advertising or a remote backend.

## Data the plugin handles

- **APKs you select or upload** are copied into the OS temp directory and installed into the
  local Android emulator. They are not uploaded anywhere by the plugin.
- **VM data** (AVD images, snapshots, installed apps, guest files) stays on the host under the
  Android SDK/AVD locations. The guest is a local emulator; do not put real secrets or personal
  data inside it.
- **Screenshots, recordings and logcat** are written to the OS temp directory or returned to the
  panel. They are not sent off the machine. The artifact-download route is loopback-only and
  whitelists files created by the plugin.
- **Client diagnostics** (`POST /apk-vm/client-report`) contain a user agent and WebCodecs
  capability information, stored in the local Host process memory for troubleshooting. They are
  not persisted to disk or transmitted externally.
- **Configuration** (`cordis.patch.yml`) may contain local paths (`sdkRoot`, `emulatorPath`,
  `roots`). Do not commit a personal configuration to a public repository.
- **Provisioned toolchain** (the managed JDK, Android SDK packages, system image and AVD) is
  downloaded into local directories on the host — `~/.dsh/apk-vm/jdk` by default, plus the
  Android SDK/AVD locations — and is never uploaded.
- **The activity journal** (`<profile>/.apk-vm/activity/activity.jsonl` plus
  `screenshots/<id>.png`) records `apk_vm` tool calls made by Agents and mutating operations
  performed in the panel (taps, swipes, typed text, installs, snapshots, debug commands) —
  action name, a bounded argument preview, success/error, duration, instance, `source`
  (`tool` / `http` / `system`) and an optional screenshot for mutating actions such as
  tap/install. It is stored on this host only, ring-pruned (1000 entries / 250 MB by
  default) and can be cleared from the panel or with `POST /apk-vm/activity/clear`.
  Because entries can contain screen content and command arguments (typed text is recorded
  as a character count only), clear the journal before sharing the panel or its recordings.
- **Remembered installed apps.** `<profile>/.apk-vm/installed-apps.json` stores the APK path,
  package name, label, launch activity and instance for APKs installed through the plugin, and
  archived copies live under `<profile>/.apk-vm/apks` (newest 10). Both stay on this host and are
  used only to re-install a package that the guest lost (quick-boot reset, recreated AVD, plugin
  upgrade). Delete the files or set `autoReinstall: false` to opt out.

## Network activity

- The plugin talks to the local DSH Web server and local `adb`/emulator processes.
- **First-use provisioning (`autoSetup`, on by default).** When the environment is incomplete,
  the plugin downloads a portable **Temurin JDK 17** (about 190 MB) from `api.adoptium.net` or —
  when the GitHub-hosted asset is unreachable, as on some mainland-China networks — from the
  built-in Tsinghua mirror (`mirrors.tuna.tsinghua.edu.cn`) or a user-configured `jdkMirror`
  base. Every archive is verified against Adoptium's published SHA-256 checksum; the plugin sends
  no identifying headers, cookies or user data. It then runs the user's own `sdkmanager` for the
  Android SDK command-line tools, build-tools, platform and system image from the official Google
  Android SDK repository. The plugin does not proxy or collect those downloads. Those downloads
  are size- and time-bounded and HTTPS-only, and can be disabled with `autoSetup: false` (the
  Environment card then offers the manual actions as before). No analytics, telemetry,
  advertising or remote backend is involved, and no third-party endpoint other than the ones
  listed above is contacted by the plugin itself.

## Public repository hygiene

The repository ships `scripts/privacy-scan.mjs` and CI runs it on every push. It checks the
tracked tree for personal paths (Windows, POSIX and non-ASCII workspace paths, matched with either
path separator), private-network IPs, agent instance IDs, credential patterns and emails. Run
`node scripts/privacy-scan.mjs --untracked` locally to include files that are not committed yet.
The development history may contain older local paths; publish the clean `open-source` branch
(single initial commit) instead of the full development history. See [RELEASING](RELEASING.md).
