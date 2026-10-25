# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x (current) | Yes |
| < 0.3 | No |

The plugin is a local development tool. It is not designed or hardened as a multi-tenant or
network-exposed service.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Preferred: use the repository's GitHub **Security** tab → **Report a vulnerability**
(private security advisory). Include:

- affected version and platform (OS, DSH profile, Android SDK/emulator versions);
- a minimal reproduction (routes/config involved, request payloads, expected vs. actual);
- impact assessment — what an attacker gains (guest root shell, host command execution, data
  exposure, denial of service, …);
- any logs/screenshots with secrets, tokens and personal paths removed.

If you cannot use private advisories, contact the maintainers through the repository's listed
contact channel and ask for a private reporting route.

**Do not** test against systems you do not own, do not access other users' data, and do not
publish details before a fix is available. Good-faith research within these bounds is welcome.

### What to expect

This is a small open-source project maintained on a best-effort basis:

1. Acknowledgement of the report, aiming for within 7 days.
2. Triage and an initial impact assessment.
3. A private fix and a coordinated disclosure date (normally once a release with the fix is
   available); the advisory credits the reporter unless anonymity is requested.

## Scope

In scope:

- this repository's code: [index.js](index.js), [client.js](client.js), [lib/](lib),
  [lib/ws.js](lib/ws.js), the route surface under `/apk-vm/*`;
- the vendored scrcpy server JAR provenance/redistribution
  ([NOTICE](NOTICE)) — e.g. a mismatch between the shipped artifact and upstream v5.0.1;
- documentation that would cause a user to expose the plugin unsafely.

Out of scope (report upstream):

- **DeepSeek Harness** itself (auth, Web server, plugin runtime) — report to the DSH project;
- the **Android Emulator, adb and AOSP system images** — report to the Android/AOSP projects;
- the **scrcpy** project — report to [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)
  (the JAR in this repository is upstream's unmodified v5.0.1 server build);
- **dsh-better-sidebar** — a separate community plugin.

## Threat model and known security-relevant behavior

The following behavior is intentional; it is documented here so it is not mistaken for a
vulnerability. Reports that rely on it being intentional will be closed as informational unless
they demonstrate a way to exceed the stated boundaries.

1. **A rooted, debuggable Android guest is started on the user's machine.** The image is
   `userdebug`; `adb root` is applied after boot, `ro.debuggable=1` and `ro.adb.secure=0`. Any APK
   installed in the VM runs inside that guest; the guest is not a security boundary against the
   host beyond the emulator's own isolation. Do not store sensitive data in the AVD.
2. **`/apk-vm/debug/shell` executes arbitrary commands inside the guest** (as root), and
   `/apk-vm/debug/action` can force-stop, clear data or uninstall packages. This is the product
   feature. Commands run in the Android guest, not on the host.
3. **`/apk-vm/debug/push` and `/pull` move files** between the host and the guest, constrained to
   `/data/local/tmp`, `/sdcard`, `/storage/emulated/0` on the guest and to allowed local roots/temp
   on the host.
4. **The `apk_vm` Agent tool is registered for all agents in the DSH profile** and exposes the
   same surface to them. Treat agent access to this plugin as equivalent to giving the agent a
   rooted Android device (and the ability to install APKs and run guest commands).
5. **All routes are same-origin only, and are loopback-only by default.** The HTTP routes reject
   cross-origin requests; additionally, every `/apk-vm/*` request and the WebSocket upgrade
   rejects non-loopback TCP peers unless `allowRemote: true` is explicitly set. Anything that can
   make same-origin requests to the DSH Web server — including a compromised page in the same
   origin, a malicious browser extension, or a reverse proxy that adds authentication but
   forwards `/apk-vm/*` — inherits this capability. **Do not expose the DSH Web port to
   untrusted networks.** If you must, add authentication at a trusted proxy and set
   `allowRemote: true` deliberately; keep the DSH auth token secret.
6. **Host commands are never built as shell strings.** `adb`, `emulator`, `sdkmanager` and
   `avdmanager` are spawned with `argv` arrays; paths and payload sizes are validated/bounded
   (JSON bodies ≤ 64 KiB, APK uploads ≤ 500 MiB with ZIP/APK magic validation, bounded
   stdout/stderr, APK paths must exist and end in `.apk`, push/pull targets restricted as above).
   Bypassing these bounds is in scope if demonstrated.
7. **Upload and environment setup are privileged local actions.** `/apk-vm/upload` writes the
   uploaded APK to the OS temp directory and installs it into the guest; `/apk-vm/setup`
   `create-avd` writes an AVD under the user's AVD home. `/apk-vm/setup` `install-image` runs
   `sdkmanager --install` only when `allowSetupDownloads: true` is configured (default `false`),
   because it is a large network download; it is never triggered automatically.
8. **The plugin does not send telemetry** or contact third-party services on its own; it talks to
   the local adb/emulator and the same-origin DSH Web server. The only network activity comes
   from the user's own `sdkmanager` when they explicitly run the opt-in `install-image` action.

## Hardening status

The released plugin applies same-origin and loopback checks to every `/apk-vm/*` HTTP route and
the `/apk-vm/ws` upgrade, bounded payloads for JSON and uploads, argument-array process spawning,
and a restricted push/pull path set. The multi-touch (`/touch`), clipboard (`/clipboard`) and
artifact-download routes are part of the same origin/loopback surface. There is no separate
authentication token of its own: it relies on the DSH Web server's session and on the operator
keeping that server local/trusted. Run this plugin only on a machine and local network you trust;
do not treat the rooted Android guest as a security boundary.
