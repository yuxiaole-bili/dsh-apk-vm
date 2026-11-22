# APK 虚拟机（中文完整说明）

> 一个 DeepSeek Harness 插件：在侧边栏里运行**本地、rooted、开源的 Android 14 虚拟机**，安装 APK、以最高 **60 fps 的 H.264 视频**预览画面，并让 Agent 通过 `apk_vm` 工具直接操作 Android。

- 英文 README：[README.md](README.md)
- 英文/中文更新日志：[CHANGELOG.md](CHANGELOG.md) / [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)
- Agent 操作手册：[docs/AGENTS.md](docs/AGENTS.md)
- 隐私说明：[docs/PRIVACY.md](docs/PRIVACY.md)

> 提示：本文档是额外提供的中文说明，内容与英文 README 对齐；具体细节以代码与英文 README 为准。

---

## 一、能力概览

| 能力 | 说明 |
| --- | --- |
| 本地 Android 虚拟机 | 官方 Android 14 x86_64（`default`）镜像，`userdebug`/`adb root`，真实设备行为 |
| 最高 60 fps 预览 | 内置 scrcpy-server + H.264/WebCodecs 流，面板随开随用 |
| APK 安装与启动 | 面板上传/拖拽/路径安装，安装后自动启动；记住已装应用，重装后自动恢复 |
| Agent 自动化 | 全局 `apk_vm` 工具（60+ 动作）+ HTTP API：UI 树、点击、输入、WebView/CDP、等待与断言 |
| 多实例 | 每对话/项目可独占一台；默认上限 3 台（内存守卫，8 GB 机器自动降到 1 台） |
| 共享常驻 VM | 默认共享 VM 永不释放/删除，空闲自动挂起，按需恢复 |
| 所有权与操作锁 | 租约持久化、24 小时保留、显式接管；可选硬锁阻止其他 Agent/用户操作 |
| ARM 转译 | 可选 Google APIs 镜像自带 `libndk_translation`，可直接安装 ARM-only APK |
| 远端虚拟机 | 通过 SSH 端口转发把远端 Linux/Windows 上的 emulator 当成一台实例用 |
| 可观测 | Agent 活动日志（含截图）、即时 / 真实日志、UI 检查、性能概览、崩溃转储定位 |
| 存储管理 | 一键统计/清理临时文件、快照、孤儿 AVD、损坏快照与崩溃转储 |
| 零依赖 | 运行时无第三方 npm 依赖；随包附 scrcpy-server |

---

## 二、安装

### 在 DeepSeek Harness 中安装（推荐）

在 DSH 插件面板（插件 → 安装）中搜索 `dsh-apk-vm` 并安装，或在插件市场页面按提示安装。

命令行等价方式：

```bash
dsh plugin --profile web add dsh-apk-vm
```

DSH Desktop 的 `desktop` profile 也可以通过插件页的 **添加 / 安装本地 bundle** 安装同一个包。安装后在左侧出现 **APK 虚拟机** 入口。

### 运行环境

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | 已验证 | 需要 AEHD（推荐）或 WHPX 硬件加速；WHPX 与 Hyper-V 冲突时用 AEHD |
| Linux x86_64（KVM） | 已验证（headless） | 需要 `/dev/kvm`；可配合 SwiftShader 无头运行 |
| macOS | 未做真机验证 | 仅 SDK 探测/CI 覆盖；Apple Silicon 可尝试 arm64 镜像，但建议用「远端虚拟机」能力 |

首次运行插件会自动完成环境准备（`autoSetup`）：

1. 下载 JDK 17（Temurin，Google 不可达时切换国内 TUNA 镜像）
2. 下载 Android SDK `cmdline-tools`、`platform-tools`、`emulator`
3. 下载 Android 14 系统镜像并创建 AVD `dsh_apk`
4. 启动 VM 并自助检查 root/调试工具

网络较慢时可以在设置里改用镜像或预置 `jdkRoot` / `sdkRoot` / `systemImage`。

---

## 三、快速开始

1. 打开左侧 **APK 虚拟机** 页面。
2. 首次启动等待自动配置完成（状态卡显示进度；约 1–5 分钟，取决于网络）。
3. 点 **启动虚拟机**，约 6 秒（快照启动）或 20–30 秒（冷启动）后变为 **已就绪**。
4. 在 **APK 文件** 卡里选择/上传 APK → **安装并启动**。
5. 在右侧设备画面或控制栏中操作；Agent 也可以直接调用 `apk_vm` 工具。

命令行的最小验证（在 DSH 主机上）：

```bash
# 查看状态（端口为 DSH 面板端口）
curl http://127.0.0.1:53982/apk-vm/state
# 安装并启动 APK
curl -X POST http://127.0.0.1:53982/apk-vm/vm \
  -H 'content-type: application/json' \
  -d '{"action":"install","path":"D:/work/app.apk"}'
```

---

## 四、面板说明

左侧主卡：

- **环境**：SDK / JDK / 硬件加速 / 系统镜像 / AVD 检查结果，可切换 AVD、选择主机的 adb 设备。
- **APK 文件**：扫描到的 APK 列表；支持上传、按路径安装、重新扫描。
- **虚拟机实例**：实例列表、状态、所有者、实例上限；支持新建、改名、停止、销毁（销毁需二次确认）。
- **虚拟机使用**：显示当前租约所有者与范围；认领/释放/接管/锁定/解锁。
- **操作录制 / 应用操作 SKILL**：录制一次 UI 操作并回放。
- **网络**：HTTP 代理、DNS、hosts、端口转发诊断。
- **存储**：AVD/快照/临时文件占用与一键清理。
- **详情 / 远程 VM（SSH）**：主机信息、远端配置。
- **摄像头与麦克风**：虚拟摄像头海报与虚拟麦克风配置。
- **已安装应用**：列出 guest 内已安装的包。
- **ROOT 调试**：shell、日志、剪贴板、属性、授权、UI 树、性能、录屏、帧率/分辨率。

中间设备区：H.264 画面 + 控制栏（返回 / 主页 / 多任务 / 电源 / 截图 / 旋转 / 检查 UI / 文本输入）。

右侧面板：**活动记录**（Agent 与用户操作时间线，可按来源/实例/动作过滤）与 **ROOT 调试**（宽屏三栏模式默认展开）。

---

## 五、配置

配置有两种修改方式：

1. **插件设置页（推荐）**：DSH 插件页 → APK 虚拟机 → 设置区。
2. **配置文件**：`<profile>/cordis.patch.yml` 中该插件的 `config` 段，改完重载插件。

常用配置项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `autoSetup` | `true` | 首次运行自动下载/配置 JDK、SDK、镜像、AVD |
| `autoStart` | `true` | 首次使用/面板打开时自动启动 VM |
| `prewarm` | `false` | 后台预热实例（更快，但多占内存） |
| `frameFps` | `2` | 设备帧率上限（H.264 编码帧率，最高 60） |
| `maxInstances` | `3` | 本机最多同时运行的 VM 数 |
| `memoryGuard` | `true` | 按主机内存限制可运行的 VM 数 |
| `hostReserveMb` | `4096` | 为宿主系统保留的内存 |
| `estimatedVmMb` | `3072` | 每台 VM 的估算占用 |
| `vmPreset` | `standard` | `lite` 用 1 GB / 2 vCPU / SwiftShader / 720p |
| `memoryPressureReap` | `true` | 内存紧张时回收最久未用的空闲实例 |
| `sharedResident` | `true` | 默认共享 VM 常驻（不释放/不删除） |
| `sharedSuspendAfterMs` | `300000` | 共享 VM 空闲多久后挂起为快照 |
| `sharedStopAfterMs` | `3600000` | 挂起后再空闲多久标记为 stopped |
| `lockEnforcement` | `all` | 操作锁强度：`all` / `agents` / `off` |
| `lockControl` | `all` | `user` 时只有面板/用户能加解锁 |
| `armTranslation` | `false` | 使用 Google APIs 镜像，启用 ARM64 转译 |
| `systemImage` | 自动 | 指定系统镜像（覆盖 `armTranslation` 的选择） |
| `autoReinstall` | `true` | 记住已装 APK，重建实例后自动重装 |
| `setupRetries` | `3` | 自动配置失败重试次数 |
| `allowRemote` | `false` | 允许非 loopback 访问 `/apk-vm/*`（谨慎） |

修改配置时注意：

- 保存设置会**重启插件**（VM 会冷启动约 20–30 秒），面板会自动重连。
- 内存相关配置修改后对**新建**实例生效。
- `armTranslation` / `systemImage` 只影响**新建**的实例。

---

## 六、所有权、租约与操作锁

VM 是**带租约的设备**：

- 范围：`shared`（共享）、`conversation`（对话独占）、`project`（项目独占）。
- 租约持久化在 `<profile>/.apk-vm/leases.json`，插件重启后恢复。
- 独占租约默认保留 24 小时（`reservedUntil`）；期间其他所有者需要显式 `ownerForce` / `force` 才能接管。
- 冲突错误：`vm-busy`（被他人占用）、`vm-takeover-required`（面板管理员需要显式接管头）。

**操作锁**（`lock_vm` / `unlock_vm`）：

- 锁定后，其他 Agent/用户的**写操作**返回 `409 vm-locked`，`ownerForce` / 接管也无法突破。
- 读操作（`info`、`list_instances`、`owner_status`）不受影响。
- 面板「虚拟机使用」卡提供锁定/解锁按钮；本地管理员可以强制解锁。
- `lockEnforcement`：`all`（默认，所有人）、`agents`（只挡其他 Agent，面板可操作）、`off`（仅作标记）。
- `lockControl`：`user` 时只有面板/用户能加解锁，工具的 `lock_vm`/`unlock_vm` 返回 `vm-lock-restricted`。

---

## 七、共享常驻 VM

默认实例是**常驻共享设备**：

- 永远不会被释放或删除（AVD 与快照保留）。
- 空闲 `sharedSuspendAfterMs`（默认 5 分钟）后，VM 挂起为快照（状态 `suspended`）。
- 再空闲 `sharedStopAfterMs`（默认 1 小时）后，状态变为 `stopped`（快照仍保留）。
- 下一次 `apk_vm` 调用 / 面板操作 / 视频客户端连接会重置空闲计时；启动时优先从快照恢复（约 6 秒）。
- 其他对话进入共享 VM 时会重置回桌面，避免继承他人的前台应用。

需要长期稳定环境（登录态、安装的应用）时，建议 `claim_vm` 申请独占实例，或 `create_instance` 新建隔离实例。

---

## 八、ARM 转译

默认 AOSP 镜像只有 `x86_64` ABI。开启 `armTranslation: true` 后，新建的 VM 使用 **Android 14 Google APIs x86_64 镜像**：

- 该镜像自带 Google `libndk_translation.so` 原生转译层；
- guest 会报告 `abilist = x86_64,arm64-v8a`；
- 只有 `arm64-v8a` 原生库的 APK 可以安装与运行。

相关字段：

- `apk_vm info` 返回：`abi`、`abilist`、`nativeBridge`、`armTranslation`
- `GET /apk-vm/state` 返回：`armTranslation.{enabled,systemImage,guestArmTranslation,abilist,nativeBridge}`

首次启用需要下载约 1.3 GB 镜像。安装不匹配 ABI 的 APK 会失败并提示 `INSTALL_FAILED_NO_MATCHING_ABIS`，同时给出启用 `armTranslation` 的建议。

> 注意：`armTranslation` 只对**新建的实例**生效；已有实例仍使用旧镜像。

---

## 九、更新检查与插件设置页

- **更新检查**：APK 虚拟机页面顶部会检查 npm 最新版本；有新版本时显示「新版本 vX 已发布」，并提供 **前往更新** / **插件设置** 按钮（跳转 DSH 插件页）。
- 接口：`GET /apk-vm/version`（1 小时缓存，npmjs 优先、npmmirror 回退）。
- **插件设置页**：DSH 插件页 → APK 虚拟机 → 设置区，可编辑 13 项运行设置（见「配置」），保存通过 DSH 配置编辑器写回 `cordis.patch.yml` 并重启插件生效。
- 接口：`GET /apk-vm/settings`（当前值与可编辑性）、`POST /apk-vm/settings`（校验后写回）。

---

## 十、Agent 使用（apk_vm）

所有 DSH Agent 都可以调用 `apk_vm` 工具。推荐流程：

1. `{ "action": "info" }` —— 只有 `ready` 才操作；首次调用会返回一次操作手册（`docs/AGENTS.md`）。
2. `{ "action": "ui_dump" }` / `find_ui` / `assert_text` —— 先定位控件。
3. `tap_text` / `tap_selector`（WebView DOM）—— 优先语义定位，避免盲点坐标。
4. `wait_for` 等待条件，`assert_text` 校验，`screenshot`/`record` 留证。
5. 需要指定实例时传 `instance`；不要静默抢占其他会话的租约。

坐标规则：

- 截图是**设备像素**（如 720×1280），WebView 视口是 **CSS 像素**（如 360×640，dpr=2）。
- `tap`/`swipe` 用设备像素；CSS 坐标用 `tap_css`（自动套用 `dpr` 与偏移）。
- 优先级：`tap_selector` > `tap_text`/`find_ui` > `tap_css` > 原始 `tap`。

安全边界：guest 是 rooted `userdebug` 镜像，把它当作「用户拥有的 rooted 设备」；不要在里面输入真实凭据或隐私数据。

---

## 十一、HTTP API 摘要

默认只监听 loopback，与 DSH 面板同源。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/apk-vm/state` | VM 状态、安装信息、共享/内存/锁策略、活动设置 |
| GET | `/apk-vm/instances` | 实例列表（含所有者、状态、序列号） |
| GET | `/apk-vm/instances/:id/state` | 单实例状态与日志尾部 |
| GET | `/apk-vm/instances/:id/frame` | 单帧截图（PNG） |
| WS | `/apk-vm/instances/:id/ws` | H.264/PNG 视频流 |
| POST | `/apk-vm/vm` | 默认实例动作：`start` / `stop` / `install` / `screenshot` 等 |
| POST | `/apk-vm/instances` | 新建实例（可 `start:true`） |
| POST | `/apk-vm/instances/:id/vm` | 实例动作（start/stop/restart/destroy 需 `?confirm=1`） |
| GET/POST | `/apk-vm/ownership` | 租约查询 / claim / release / lock / unlock |
| POST | `/apk-vm/storage` | 存储报告与清理（破坏性动作需 `confirm:true`） |
| GET | `/apk-vm/version` | 检查 npm 最新版本 |
| GET/POST | `/apk-vm/settings` | 插件设置读取/保存 |
| GET | `/apk-vm/guide` | Agent 操作手册 Markdown |
| GET | `/apk-vm/activity` | Agent/用户活动日志 |

---

## 十二、存储管理

占用主要来自 AVD：

- 每个 AVD 的 `userdata-qemu.img` 约 6 GB；
- 快照 `ram.img` 约 2.5 GB；
- 退出保存的快照 `ram.bin` 约 2.5 GB；
- 旧实例的 AVD、损坏快照备份 `*.corrupt-*`、崩溃转储会累积。

面板「存储」卡会显示可回收空间；命令行示例：

```bash
# 查看占用
curl -X POST http://127.0.0.1:53982/apk-vm/storage -d '{"action":"report"}'
# 清理孤儿 AVD（确认后执行）
curl -X POST http://127.0.0.1:53982/apk-vm/storage \
  -d '{"action":"clean","target":"orphan-avds","confirm":true}'
```

可清理类型：`temp`、`snapshots`、`orphan-avds`、`corrupt-snapshots`、`crash-dumps`；后四类需要 `confirm:true`。

---

## 十三、常见问题

| 现象 | 处理 |
| --- | --- |
| 环境卡显示缺少 SDK/JDK/镜像 | 等待自动配置或用「详情」中的路径手动配置 |
| 启动很慢或提示缺少硬件加速 | Windows 启用 AEHD（或 WHPX）；Linux 确认 `/dev/kvm` 权限 |
| 面板提示「正在连接虚拟机服务」 | 点「刷新」；VM 可能在冷启动，等 20–30 秒 |
| `vm-busy` / 被他人占用 | `owner_status` 查看；`release_vm` 释放，或显式 `ownerForce`/面板「接管」 |
| `vm-locked` | 被所有者锁定；请所有者解锁，或本地面板管理员强制解锁 |
| 快照损坏/VM 反复崩溃 | 插件会自动隔离快照并冷启动重试；仍失败时销毁实例后重建 |
| 截图超时 | guest 可能无响应，`stop` + `start`；插件已内置有界等待与错误码 |
| 存储占用过大 | 用「存储」卡清理孤儿 AVD / 损坏快照 / 崩溃转储 |
| 更新提示不出现 | 当前已是最新版本时不会提示 |
| 安装 APK 报 ABI 不匹配 | 开启 `armTranslation: true` 后新建实例 |
| 保存设置后 VM 重启 | 预期行为：插件重启后 VM 冷启动约 20–30 秒 |

---

## 十四、兼容性与限制

- DSH 版本：`>= 0.2.1-rc.3 || >= 0.2.2-rc.1`（已在本机 0.2.2-rc.3 验证）。
- Windows 需要 AEHD/WHPX；Linux 需要 KVM；macOS 未做真机验证。
- 每台本地 VM 约 2–3 GB 内存；默认最多 3 台（内存不足时自动降级）。
- 显示链路依赖 scrcpy（H.264/PNG），必须在宿主能运行 emulator 的情况下使用。
- 远端 VM 依赖 SSH、adb 与远程主机可访问性；远端需要自行安装 Android SDK/emulator。
- 无遥测：仅在你显式配置 SDK 下载镜像、远端 SSH 或网络代理时才产生相应网络请求。
- 不要将真实凭据输入 guest；guest 是 root/debuggable 镜像。

---

## 十五、许可证

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
