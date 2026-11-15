# Agent guide — driving the APK VM

This is the playbook for an AI agent using the `apk_vm` tool (or the `/apk-vm/*` HTTP API).
It is shipped inside the plugin package as `docs/AGENTS.md`.

**Read it in-context:** call the tool with `{ "action": "guide" }` (returns this file's Markdown),
or `GET /apk-vm/guide`. The tool description also points here.

## TL;DR

1. Call `{ "action": "info" }` first; only act when the VM state is `ready`.
2. Locate controls with `ui_dump` / `find_ui` / `assert_text`, and click them with
   `tap_text` or `tap_selector`; avoid blind device-pixel coordinates.
3. Wait with `wait_for`; verify with `assert_text`; take a `screenshot` or `record` for evidence.
4. Pass `instance` when a task targets a specific VM; never take over another session's lease
   without explicit approval.
5. The guest is a rooted `userdebug` image — never type real credentials or private data into it.

## Three entry points

| Entry | Audience | Notes |
| --- | --- | --- |
| `apk_vm` tool | **Agents (first choice)** | Registered globally through `ctx.tools`; every DSH agent can call it. Params: `action`, `instance`, selectors, coordinates, paths. |
| HTTP API `/apk-vm/*` | Scripts / CI | Same-origin, loopback-only by default. See the route table in `README.md`. |
| Panel UI | Humans | Environment card, APK list, H.264 preview, debug card, media card, remote sessions, activity timeline. Agents don't need to click it. |

## Mental model

- The VM is a **leased device**. Leases have a scope (`shared`, `conversation`, `project`).
  A VM owned by another conversation returns a `vm-busy` error; `ownerForce: true` is an
  explicit takeover and should only be used when the user asked for it.
- **Only `ready` VMs accept input.** `info` returns `state`, `root`, `serial`, `size`,
  `density`, `dpr` and `coordinateMap`.
- `instance` selects the VM: omit it to use the calling agent's assignment (the first
  conversation gets `default`; later conversations get isolated instances, up to
  `maxInstances`). Pass `instance: "<id>"` from `list_instances` to target a specific VM.
- Every call is journaled in the Agent activity log (action, args preview, ok/error, duration,
  screenshots for mutating actions). It is safe to rely on it to reconstruct what happened.

## Standard loop

```jsonc
// 1. Status and readiness
{ "action": "info" }
// 2. Start only if needed (autoStart normally already did)
{ "action": "start", "timeoutMs": 300000 }
// 3. Install and launch an APK (absolute local path)
{ "action": "install", "path": "D:/work/app.apk" }
// 4. Inspect the accessibility tree before touching anything
{ "action": "ui_dump" }
// 5. Find and click: text/resource-id/content-desc beat coordinates
{ "action": "find_ui", "text": "Sign in" }
{ "action": "tap_text", "text": "Sign in" }
//    Inside a WebView, click the DOM directly:
{ "action": "tap_selector", "selector": "[data-testid=submit]", "webviewTarget": "0" }
// 6. Wait for a condition instead of sleeping
{ "action": "wait_for", "text": "Welcome", "timeoutMs": 15000 }
// 7. Assert, then capture evidence
{ "action": "assert_text", "text": "Hello from dsh-apk-vm", "timeoutMs": 5000 }
{ "action": "screenshot" }
```

## Action map

- **Lifecycle:** `info`, `start`, `stop`, `devices`, `attach_device`, `detach_device`
- **Apps & files:** `install`, `push`, `pull` (under `/data/local/tmp`, `/sdcard`,
  `/storage/emulated/0`), `apk_info` (reads APK metadata without booting), `packages`,
  `force_stop`, `clear_data`, `uninstall`
- **UI automation:** `ui_dump`, `find_ui`, `assert_text`, `tap_text`, `tap`, `swipe`,
  `long_press`, `key`, `text` (device coordinates), `type_text` (UTF-8, Chinese supported)
- **WebView / CDP:** `webview` (`list|eval|click|wait_for|insert_text|info`), `tap_css`,
  `tap_selector`
- **Debug:** `shell`, `adb` (raw argv), `logcat`, `getprop`, `setprop`, `root`, `screenshot`
  (`overlay: true` draws UIAutomator boxes), `record`, `perf`, `rotate`
- **Instances & leases:** `list_instances`, `create_instance`, `rename_instance`, `destroy_instance`,
  `owner_status`, `claim_vm`, `release_vm`, `ownerScope` (`shared|conversation|project`),
  `ownerForce`
- **Network / environment:** `network`, `proxy`, `env_snapshot`, `env_restore`, `install_ca`
- **Flows and skills:** `flow_*` (record/replay a journey), `skill_*` (persisted app-operation
  skills with a Control Codebook), `control_*` (semantic-code tap/input, more layout-stable
  than coordinates)
- **This guide:** `guide` (returns this Markdown; no device access needed)

## Coordinates: three rules

1. `info.coordinateMap` says `device = round(css * dpr) + offset`. Screenshots are **device
   pixels** (for example 720×1280); the WebView viewport is CSS pixels (for example 360×640 at
   `dpr: 2`).
2. `tap` / `swipe` / `long_press` take **device pixels**. To click by CSS coordinates use
   `tap_css` (it reads `dpr` / `offsetX` / `offsetY` from `info`) instead of doing the math
   yourself.
3. Prefer `tap_selector` (WebView DOM) > `tap_text` / `find_ui` (native UI) > `tap_css` >
   raw `tap`. Raw coordinates break when layouts, keyboards or status bars change.

## WebView specifics

- `webview` with `webviewAction: "list"` returns DevTools targets; then use `eval`, `click`,
  `insert_text` or `wait_for` with `targetId` (or `webviewTarget`).
- `eval` takes a **single JavaScript expression**. Use an IIFE when you need several statements
  and want a value back. Values that cannot cross JSON by value come back as a property
  snapshot (`DOMRect`, `MediaQueryList`, …), so `matchMedia('(pointer: coarse)').matches` works
  directly.
- Real WebView behaviour (pointer media queries, `position: fixed` clipping, virtual keyboard
  reflow) can differ from headless browsers; verify it with `eval` inside this VM.

```jsonc
{ "action": "webview", "webviewAction": "eval",
  "script": "(() => ({ w: innerWidth, coarse: matchMedia('(pointer: coarse)').matches }))()" }
```

## First call in a new conversation

The first `apk_vm` call in every new conversation returns this playbook once instead of
executing the requested action (`result.guideRequired: true`). Read it, then repeat the
call. `action=guide` is always available and never touches a VM.

## Shared vs dedicated VMs

The default instance is a **shared** device: every conversation may use it, it is
short-lived, and entering it from a different conversation resets the guest to the home
screen (so you never inherit someone else's foreground app). Use it for one-off inspection
and short automations.

If this conversation needs a long-lived debugging device — logins, installed apps, stable
state — claim a dedicated VM instead of holding the shared one:

- `{"action":"claim_vm","instance":"default","ownerScope":"conversation"}` (or `"project"`)
  reserves the default VM for this conversation/workspace, or
- `{"action":"create_instance","name":"my-debug","start":true}` starts an isolated extra VM,
- `owner_status` inspects leases; `release_vm` gives a VM back.

Don't keep several agents on one shared VM. Leases are visible in the panel, and a VM owned
by another conversation returns `vm-busy` unless you force a takeover (`ownerForce=true`).

## Instances and remote VMs

- `list_instances` lists `default`, extra instances and remote sessions. Remote sessions appear
  as instances named `remote-<avdName>-<adbPort>` (for example `remote-yuagent_dsh2-5557`).
- Remote sessions are created from the panel or `POST /apk-vm/remote`; an agent normally just
  discovers them via `list_instances` and passes `"instance": "remote-…"`. Install, input,
  screenshots, UI dumps and the H.264 stream all work the same way.
- Each instance has its own WebSocket (`/apk-vm/instances/<id>/ws`), unless the panel falls back
  to PNG frames.

## VM names and per-conversation selection

- Every VM can have a human-friendly display name; ids stay stable (`default`, `frontend`,
  `remote-…`). `list_instances` entries include `name`.
- Rename from an agent: `{"action":"rename_instance","instance":"default","name":"QA phone"}`.
  `create_instance`'s `name` doubles as the initial display name when it is a valid id. From
  the panel, use Rename in the Instances card. Names persist in
  `<profile>/.apk-vm/instance-names.json`.
- The panel follows the current conversation: it auto-selects the VM whose lease belongs to
  the active session (falling back to `default`); a manual selection sticks for that session.

## Errors and recovery

- `409 not ready` (for example `/apk-vm/instances/<id>/frame` right after attach): poll again;
  readiness usually arrives within a couple of seconds.
- Screenshot or device timeouts return structured error codes (for example
  `EDEVICE_UNRESPONSIVE`); if the guest is wedged, `stop` + `start` is the recovery.
- `vm-busy`: inspect with `owner_status`; `release_vm` frees a lease, `claim_vm` with
  `ownerForce: true` is an explicit takeover.
- Failed calls are journaled too (`ok: false` with the error); read the activity log before
  retrying the same action.

## Suggested agent instructions

```text
You can operate a rooted Android VM with the apk_vm tool.
1) Call info first; act only when state is ready.
2) Find controls with ui_dump/find_ui; click with tap_text or tap_selector (WebView DOM).
   Avoid blind device-pixel taps; screenshots are device pixels and the viewport is CSS pixels.
3) Use wait_for instead of sleeping and assert_text to verify results.
4) Pass instance when a task targets a specific VM; never steal another session's lease
   without explicit approval.
5) Do not type secrets into the guest; it is a rooted userdebug image.
6) On failure read the error and the activity log before retrying.
7) Call action=guide to re-read docs/AGENTS.md.
```

## Boundaries

- The guest runs `userdebug` with `adb root`: treat it like a rooted device owned by the user.
- The `apk_vm` tool is available to every agent in the profile and can install apps, inject
  input and run a root shell. Grant the same trust as a terminal on the guest.
- `/apk-vm/*` HTTP routes and WebSockets are same-origin and loopback-only by default;
  `allowRemote: true` is an explicit opt-in for remote adb / SSH proxy setups.
- No telemetry: the plugin only talks to the guest, the local DSH server, and — when you
  explicitly configure it — the user's SDK download or remote SSH host.
