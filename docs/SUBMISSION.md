# Community market submission

Prepared for the [dsh-plugin.org submission checklist](https://dsh-plugin.org/zh/submit) and the
DSH plugin hub issue template.

## Filled issue template

### 仓库地址

<https://github.com/yuxiaole-bili/dsh-apk-vm>

### 一句话价值

在 DeepSeek Harness 的侧边栏里直接运行和调试 rooted Android APK 虚拟机，提供最高 60 fps 预览、UIAutomator/Agent 自动化与多 Agent 隔离实例。

### 能力分类

开发与运维

### 安装命令

无 npm 包，源码安装：

```bash
dsh plugin --profile web add github:yuxiaole-bili/dsh-apk-vm
```

DSH Desktop（`desktop` profile）通过 **Plugins → add/install local bundle** 安装同一目录。

### 兼容与运行要求

- DSH Desktop `0.2.1-rc.3` 已实测；静态 bundle/plugin API。
- Windows x64 为唯一端到端验证平台（启动、H.264、root 调试、Agent tool）；macOS/Linux 有
  headless setup/CI 覆盖，但未做真实模拟器运行验证。
- 需要 Android SDK/emulator/platform-tools、Android 14 x86_64 system image、AVD，以及
  AEHD/WHPX（Windows）、KVM（Linux）或 HVF（macOS）硬件虚拟化。
- 每个运行中的 VM 约占 2.5 GB 内存；默认最多 3 个额外实例。
- 可选兼容 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)。

### 许可证

Apache-2.0

### 截图 / 演示

- 面板 + H.264 预览：<https://github.com/yuxiaole-bili/dsh-apk-vm/blob/main/docs/screenshot-panel.png>
- Environment 自检：<https://github.com/yuxiaole-bili/dsh-apk-vm/blob/main/docs/screenshot-setup.png>
- Android guest：<https://github.com/yuxiaole-bili/dsh-apk-vm/blob/main/docs/screenshot-emulator.png>
- 真实 `apk_vm` 输出见 README 的 Demo/Verification 章节。

### 补充说明

- guest 是刻意 root/debuggable 的 `userdebug` 镜像；不要放真实凭据或隐私数据。
- `apk_vm` Agent tool 对所有 Agent 开放 guest root shell/安装/UI 自动化，按“给 Agent 一台
  rooted Android 设备”的权限级别对待。
- `/apk-vm/*` API 与 WebSocket 默认仅 loopback；`allowRemote` 是显式远程代理 opt-in。
- 无遥测；只有用户显式启用 SDK 下载或配置远程 adb 时才产生网络访问。
- 更多风险/权限/兼容信息见 README 的 “Risks, permissions and compatibility” 与
  [PRIVACY](PRIVACY.md)、[SECURITY](../SECURITY.md)。

### 提交前自查

- [x] 仓库已公开
- [x] 已添加 GitHub topic：`dsh-plugin`
- [x] README 包含安装命令
- [x] 插件导出 `apply(ctx)` 模块
- [x] 仓库根目录包含 `package.json`
- [x] README 声明 Apache-2.0
- [x] 截图/真实输出已附
- [x] 能力分类选定：开发与运维
