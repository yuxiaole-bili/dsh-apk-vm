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

## Network activity

- The plugin talks to the local DSH Web server and local `adb`/emulator processes.
- The optional SDK bootstrap / install actions use the user's own `sdkmanager` and the official
  Google Android SDK repository, only when explicitly enabled with
  `allowSetupDownloads: true`. This plugin does not proxy or collect those downloads.
- No third-party endpoints are contacted by the plugin itself.

## Public repository hygiene

The repository ships `scripts/privacy-scan.mjs` and CI runs it on every push. It checks the
tracked tree for personal paths, private-network IPs, agent instance IDs, credential patterns and
emails. The development history may contain older local paths; publish the clean `open-source`
branch (single initial commit) instead of the full development history. See
[RELEASING](docs/RELEASING.md).
