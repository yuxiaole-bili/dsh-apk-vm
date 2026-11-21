# dsh-apk-vm 0.14.0 — ARM translation support

## Highlights

- **ARM64 (arm64-v8a) APKs now run on x86_64 hosts.** Set `armTranslation: true` and new VMs use
  the Android 14 Google APIs image (`system-images;android-34;google_apis;x86_64`), which ships
  Google's `libndk_translation.so` native bridge plus the `arm64-v8a` ABI. No proprietary blob is
  bundled: the image is fetched through `sdkmanager` with Google's normal license flow.
- **ABI visibility and actionable failures.** `apk_vm info` and `/apk-vm/state` (including
  `/apk-vm/instances/<id>/state`) report `abilist`, `nativeBridge` and `armTranslation`.
  Installing an APK whose native libraries match no guest ABI now returns an
  `INSTALL_FAILED_NO_MATCHING_ABIS` error that names `armTranslation` and how to enable it.
- **The AOSP `default` image stays the zero-config default.** Existing setups and the resident
  shared VM are unchanged unless you opt in.

## CI note

`v0.13.0`'s CI run is red because `spike/instances-smoke.mjs` hard-coded the host GPU mode while
GitHub's headless Ubuntu runner falls back to SwiftShader. The runtime is unaffected; the
platform-aware assertion was fixed on `main` (`eafec4d`) and `main` is green. From this release
on, tagged releases run with the corrected test.

## Verification

- `npm run check` — exit 0 (check-version 0.14.0).
- `npm test` — exit 0. New `spike/arm-translation-test.mjs` (10 checks) covers
  `resolveSystemImage` precedence and image selection; existing suites (ownership 126,
  activity-log 157, shared-resident 29, storage-clean 16, …) stay green.
- `node scripts/privacy-scan.mjs --untracked` — clean (147 files).
- End-to-end on Windows with the installed plugin: a Google APIs AVD created through
  `create_instance` reported `ro.product.cpu.abilist=x86_64,arm64-v8a` and
  `ro.dalvik.vm.native.bridge=libndk_translation.so`; a signed APK carrying only
  `lib/arm64-v8a` libraries installed (`Success`) and its activity became the resumed activity.
  The default AOSP VM still reports `abilist: ["x86_64"]` and `guestArmTranslation: false`.

## Known issues

- The Google APIs image is about 1.3 GB; first-time provisioning needs
  `allowSetupDownloads: true`.
- `armTranslation` selects the image used when an AVD is **created**. Existing AVDs (for example
  `dsh_apk`) keep the AOSP image; delete/recreate the AVD or create a new instance to switch.
- ARM translation is a best-effort compatibility layer: apps with hard ARM-only requirements
  (kernel modules, some DRM/graphics stacks) may still not work.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.14.0
```

After upgrading, set `armTranslation: true` in `<profile>/cordis.patch.yml` if you need
arm64-only APKs; leave it off to keep the current AOSP behavior.

## 中文摘要

- **新增 ARM 转译层支持**：设置 `armTranslation: true` 后新建的虚拟机使用 Android 14 Google APIs
  镜像（自带 Google `libndk_translation.so` 与 `arm64-v8a` ABI），仅含 arm64 原生库的 APK 可直接安装运行；
  不捆绑任何专有库，镜像经 `sdkmanager` 按 Google 许可下载。AOSP `default` 镜像仍是零配置默认值。
- **ABI 状态可见、失败可操作**：`apk_vm info` 与 `/apk-vm/state`（含 `/apk-vm/instances/<id>/state`）
  报告 `abilist`/`nativeBridge`/`armTranslation`；ABI 不匹配时错误会提示开启 `armTranslation`。
- **CI 说明**：`v0.13.0` 的 CI 红是 Linux 无头 runner 的 GPU 断言问题（运行时代码无影响），
  已在 `main` 的 `eafec4d` 修复；从本版本起发布 tag 的 CI 为绿。
- 验证：`npm run check`/`npm test`/隐私扫描全绿；端到端在 Google APIs 实例上成功安装并运行
  arm64-only APK；默认 AOSP 虚拟机行为不变。
- 已知限制：镜像约 1.3GB（需 allowSetupDownloads）；`armTranslation` 只影响**新建** AVD，
  已有 AVD 需重建或新建实例；个别强依赖 ARM 的应用仍可能不兼容。