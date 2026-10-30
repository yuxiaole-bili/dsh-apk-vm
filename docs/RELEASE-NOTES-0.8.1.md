# dsh-apk-vm 0.8.1

Remote VM over SSH.

## Added

- **SSH adb tunnel** — connect a remote Android VM by forwarding a local loopback port to the
  remote emulator's adb port (`ssh -N -L`), then attaching it through the normal adb path.
- Remote SSH card with host, user, optional private-key path and remote adb port.
- Tunnel lifecycle is explicit: connect / disconnect; the tunnel is stopped when the plugin unloads.
- Host/user/key are supplied per connection and never persisted.

## Verification

- `node spike/remote-test.mjs` — 3/3 pass (argument construction, shell-metacharacter rejection,
  stable serial/state)
- full `npm run check` / `npm test` — pass
- privacy scan — clean

## Limits

- Requires an SSH server and reachable remote adb port (typically the emulator console port 5558).
- No SSH password prompts: use keys or an SSH agent.
- This is a remote device tunnel, not a full remote emulator provisioning service.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm
```
