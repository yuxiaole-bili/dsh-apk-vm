# 更新日志（中文）

本文件提供 **0.12.x** 各版本的中文更新日志，与英文版 [`CHANGELOG.md`](CHANGELOG.md) 同步；
0.12.0 之前的历史仅保留在英文文件中。发布时请在 [docs/RELEASING.md](docs/RELEASING.md)
的检查清单里确认本文件已同步更新。

## 0.13.0

归属管理版本：专属虚拟机在重启后依然保留，接管必须显式确认。

- **虚拟机操作锁。** `lock_vm` / `unlock_vm`（以及 `POST /apk-vm/ownership` 的 `lock`/`unlock`）
  会把租约变成硬锁：锁定期间其他 Agent 与面板的变更请求一律返回 `409 vm-locked`，
  `ownerForce` 与接管都无法绕过；只有锁所有者（或本地管理员解锁）可以继续操作。
  锁会持久化到 `leases.json`，面板提供「锁定/解锁」按钮。两个配置项可调整策略：
  `lockEnforcement`（`all` | `agents` | `off`）与 `lockControl`（`all` | `user`）。
### 新增

- **租约持久化与专属保留。** 租约写入 `<profile>/.apk-vm/leases.json`，并在插件下次启动时
  恢复。专属（`conversation`/`project`）虚拟机在 DSH 重启后仍保留给原 owner，不会再被第一个
  请求的会话拿走。专属租约带 `reservedUntil` 截止时间（`leaseReservationTtlMs`，默认 24 小时），
  过期后可正常认领。
- **接管显式化并留痕。** 被他人占用的租约会在 409 响应中携带 owner 短 id 与保留截止时间；
  面板显示保留信息、对其他 owner 保持只读，并提供「接管」按钮；非显式接管的管理员变更返回
  `vm-takeover-required`（`x-apk-vm-takeover: 1`），不再静默操作他人虚拟机。claim/release/takeover
  变更会记录到活动日志（含前后 owner）。
- **`force` 作为 `ownerForce` 的别名。** `apk_vm` 接受 `force: true`，错误文案与实际参数一致；
  `claim_vm`/`release_vm` 在接管时会报告前一个 owner。
- **活动日志补充 owner 维度。** 记录 `owner`（key/label/scope/role），并经过统一脱敏，便于多会话
  与面板同时操作时追溯「谁做了什么」。
- **常驻共享默认虚拟机。** 默认虚拟机永不释放、永不删除。空闲 `sharedSuspendAfterMs`（默认 5 分钟）
  后挂起到快速启动快照（状态 `suspended`，约 6 秒恢复）；再空闲 `sharedStopAfterMs`（默认 1 小时）
  后标记为 `stopped`，快照与 AVD 均保留。工具调用、面板操作与视频客户端都会重置空闲计时，下次启动
  按需恢复。
- **存储统计覆盖崩溃残留与孤儿 AVD。** `GET /apk-vm/storage` 现在报告隔离的 `*.corrupt-*`
  快照备份、模拟器崩溃转储以及可回收总量 `reclaimableBytes`；`POST /apk-vm/storage` 新增
  `corrupt-snapshots` 与 `crash-dumps`（均需 `confirm: true`），存储卡片显示可回收大小并可
  一键清理。
- **危险操作二次确认。** `destroy_instance` 需要 `confirm: true`，面板删除按钮需点击两次，
  避免 agent 或误点直接删除实例 AVD 与数据；实例 DELETE 路由也拒绝不带 `?confirm=1` 的请求。

### 变更

- 面板的 claim/release 不再默认强制：`POST /apk-vm/ownership` 仅在请求体带 `force: true` 时强制，
  并且所有 owner 变更都会写入活动日志。
- **工具等待有上界。** 需要启动 VM 的设备操作约 120 秒后（显式 `start` 为 180 秒，可用
  `timeoutMs` 覆盖）返回可操作错误，而不是等满 1200 秒启动超时；VM 仍在后台继续启动，稍后
  再调用可观察到 ready；另外 `maybeAutoStart` 会跳过处于崩溃循环的 VM。

### 修复

- 保留中的租约可能被其他会话或管理面板静默抢占。
- 租约只存在内存中，插件重载后丢失，导致专属 VM 在重启后被重新分配。
- 显式 `claim_vm` 后，未指定 `instance` 的后续工具调用可能仍落在之前分配的虚拟机上：现在
  认领会同步更新该会话在 conversation/project/shared 三种范围下的实例映射，下一次调用会
  解析到刚刚认领的虚拟机。
- 活动日志记录的是「请求的实例 id」（未指定时按 `default` 记录），而不是实际执行调用的
  虚拟机，导致这类错配在日志里看不出来；现在记录实际解析到的实例。

- 修复 `recordOwnershipAction is not defined`（`ReferenceError`）导致工具与 HTTP 接管路径
  失败：日志助手改在插件作用域定义，`claim_vm`/`vm` 接管与归属活动记录恢复正常。
- Windows 模拟器在写入 quick-boot 快照时或之后可能崩溃（`0xC0000005`）：现在会跟踪快照保存
  状态——保存期间到来的 `start` 会等待完成；保存后崩溃会禁用后续快照保存、隔离损坏快照并
  以冷启动重试一次。
- 不完整的 quick-boot 快照（`ram.bin` 过小或 `snapshot.pb` 写了一半）现在会在启动前被隔离，
  启动计划改用 `-no-snapshot-load` 冷启动，损坏快照不会再导致模拟器反复崩溃重启。
- **崩溃循环熔断。** 15 分钟内三次非零退出会暂停自动恢复/自动启动并禁用快照保存，原因写入
  state error 与 logTail；请检查模拟器日志/崩溃转储后手动启动。

## 0.12.5

可靠性版本：零配置首次启动的抗网络故障能力，以及多 VM 宿主机的内存管理。

### 新增

- **零配置供应的下载可靠性。** 每个供应步骤都会自动重试临时性的网络/命令失败
  （`setupRetries`，默认 3 次；`retryDelayMs` 指数退避），45 秒无进展看门狗会中止卡死的
  下载，而不是一直挂起。JDK 压缩包从 `.partial` 文件用 HTTP Range 续传，每次尝试都重新校验
  SHA-256；命令行工具下载现在带 stall 超时、大小上限和可选校验
  （`commandLineToolsUrl` / `commandLineToolsSha256`），并支持镜像地址；`sdkmanager`
  支持镜像/代理配置（`sdkManagerArgs`、`sdkManagerEnv`、`networkProxy`）；供应开始前先检查
  累计可用磁盘预算（`minFreeDiskBytes`，默认 6 GB）。重试会在 `autoSetup.detail` 中报告
  `attempt` 与 `nextDelayMs`，环境卡片在退避期间显示「retry n/m in Ns」。
- **内存感知的实例管理。** 新增 `lib/memory.js`：读取宿主内存并推导有效实例上限
  （`memoryGuard`，`hostReserveMb` 4 GB，`estimatedVmMb` 3 GB，限制在 1–8 之间），通过
  `GET /apk-vm/state`、`/apk-vm/emulators`、`GET /apk-vm/instances` 和 `apk_vm`
  `list_instances` 的 `memory` 对象暴露。低内存宿主上创建/启动本地 VM 会给出可操作的错误，
  而不是把整机换页致死；`memoryPressureReap`（默认开启）先停止最久未使用的空闲本地 VM。
  VM 实例卡片显示宿主内存、有效上限、预设以及每个 VM 的 RAM/vCPU 配置。
- **Lite 模式。** `vmPreset: lite` 把默认 AVD 和额外实例缩小到 1 GB 客机内存、2 vCPU、
  SwiftShader GPU 以及 720×1280 / 30 fps 的 H.264 流（PNG 回退 1 fps），适合 8–16 GB 的
  宿主机。
- **卡死 guest 的自动恢复。** 如果 adb 仍能列出设备但客机 shell 已无响应，插件会在连续两次
  启动探测超时后判定为 wedged：通过模拟器控制台（以及进程树）结束该模拟器、隔离损坏快照，
  并冷启动重试一次，而不是永远停在 `booting`。`_refresh()` 在启动等待进行中不再于
  `starting` 与 `stopped` 之间来回切换，实例卡片也为已停止的 VM 增加了「启动」按钮。
- **中文更新日志。** `CHANGELOG.zh-CN.md` 提供 0.12.x 条目的中文版本，发布说明也带中文摘要；
  发布检查清单要求保持同步。

## 0.12.4

### 修复

- **0.12.3 引入的 hypervisor 检测回归。** 启动速度统计的重构丢失了三个构造器初始化字段
  （`_accelAvailable`、`_snapshotSave`、`_lastLaunchArgs`），导致 `_detectAcceleration()`
  在 `!== null` 处短路并返回 `undefined`，于是每次启动都误报「找不到可用的 CPU
  hypervisor（AEHD/WHPX）」，即使 `emulator -accel-check` 报告可用。本次恢复这三个字段，
  并在 `spike/snapshot-recovery-test.mjs` 中断言其初始值以及 `_detectAcceleration()` 返回
  布尔值，防止该回归再次静默发布。

## 0.12.3

### 新增

- **Agent 操作手册。** 包内新增 [`docs/AGENTS.md`](docs/AGENTS.md)，可在运行时通过
  `apk_vm` 的 `guide` 动作（或 `GET /apk-vm/guide`）读取；内容覆盖标准循环、动作地图、
  设备像素与 CSS 坐标规则、WebView/CDP、实例与远端会话、错误恢复和安全边界。
- **新会话强制引导。** 每个新会话的第一次 `apk_vm` 调用会先返回一次操作手册
  （`result.guideRequired: true`）而不执行原动作；阅读后重复调用即可。`action=guide`
  始终可用。
- **共享与专用 VM 指引。** 手册和 README 说明默认实例是共享、短命的设备，长时间调试建议
  claim 一个专用 VM，并说明从其它会话进入共享 VM 会把客机重置回桌面。
- **Quick-boot 快照自愈。** 恢复时会让模拟器崩溃（Windows 访问冲突 `0xC0000005`）或看起来
  只写了一半（`snapshot.pb` 远新于 `ram.bin`）的快照会被自动隔离、以冷启动重试一次并重建；
  隔离情况通过 `status().snapshotRecovery` 暴露。
- **VM 命名与按会话自动选中。** 每个实例（包括 `default` 和远端会话）都可以有持久化的显示名
  （`<profile>/.apk-vm/instance-names.json`）；可用 `apk_vm` 的 `rename_instance`、
  `POST /apk-vm/instances {"action":"rename",…}` 或面板的 Rename 按钮重命名。面板会跟随当前
  会话，选中租约属于该会话的 VM，而不是永远显示共享的 default。

### 变更

- **DSH 兼容性元数据。** `package.json` 现在声明 `engines.dsh`
  （`>=0.2.1-rc.3 || >=0.2.2-rc.1`）和 `dsh.compatibility.dshReleases`（`0.2.1-rc.3+`、
  `0.2.2-rc.1+` → `compatible`），插件管理器和市场可以在安装/启用前校验支持的 DSH 版本。
  README 增加「Supported DSH versions」一节，`docs/SUBMISSION.md` 列出同样的测试矩阵。

## 0.12.2

### 修复

- **面板版本标签显示 `v0.11.1`。** `client.js` 里手写的 `CLIENT_VERSION` 常量在 0.11.1 之后
  没有再更新，导致 0.12.0/0.12.1 的标题栏胶囊显示错误版本。现在胶囊优先使用宿主上报的版本，
  常量更新为当前版本，并且 `npm run check` 会运行 `scripts/check-version.mjs`，在
  `CLIENT_VERSION` 与 `package.json` 不一致时让构建失败。

## 0.12.1

### 新增

- **远端 VM 多会话。** 远端主机成为一类 VM 来源：配置文件保存在
  `<profile>/.apk-vm/remote-profiles.json`（只存校验后的非敏感字段，不存密钥内容），
  `RemoteSessionManager` 可并发运行多个会话（`remoteMaxSessions`，默认 4），每个会话有自己
  的 AVD、adb 隧道、H.264 流和实例 id。
- **模拟器清单。** `GET /apk-vm/emulators` 把本地 AVD/设备状态与每个已保存的远端主机合并
  （`lib/emulator-inventory.js`），面板增加「Available emulators」卡片。
- **虚拟摄像头。** 支持摄像头前后置模式与 `-virtualscene-poster` 海报，由
  `GET/POST /apk-vm/camera`、面板 Media 卡片或 `cfg.camera` 管理（`lib/media.js`）。
- **虚拟麦克风。** 麦克风模式 `off` / `host` / `file`；file 模式把音频循环进虚拟
  PulseAudio 源（null-sink + remap-source），在 Linux 和远端主机可用；由
  `GET/POST /apk-vm/mic`、面板 Media 卡片或 `cfg.mic` 管理。
- **SSH 远端虚拟机（远端 VM 主机）。** `/apk-vm/remote` 现在把一台 SSH 可达主机变成 VM
  代理：转发本地回环端口到远端模拟器的 adb 端口，执行 `adb connect` 并把设备接入正常的
  启动等待/H.264/输入/调试链路。`launch: true` 会在远端用固定命令启动无窗口模拟器
  （`-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`），`disconnect` 可以停止
  它。经验证的配置（主机/用户/端口/AVD，不含密钥）持久化在
  `<profile>/.apk-vm/remote-profile.json`，面板卡片会预填并每两秒轮询隧道/启动状态。

### 变更

- 新的插件图标（`icon.svg`，36×36）：柠檬/草绿与紫色分层屏幕，替换原先在深色磁贴上几乎不可见
  的细线 `currentColor` 图标。
- 使用 0.12.0 面板 UI 重新生成演示截图（主面板、Activity 卡片、客机、Environment、APK 文件
  和 Rooted debug 卡片）；Windows 用户名、真实 APK 名称/路径和助手头像做了高斯模糊。

### 移除

- `docs/screenshot-sidebar.png`：由重新拍摄的面板与卡片截图替代。

## 0.12.0

WebView 读取、记住已装 APK 和零配置首次运行。

- `webviewAction=eval` 现在返回真实值（普通 JSON 值直接返回；`DOMRect`、`MediaQueryList`
  这类不能按值穿过 JSON 的对象返回属性快照），不再需要截图。
- 记住已安装的 APK：通过工具或面板安装的 APK 记录在
  `<profile>/.apk-vm/installed-apps.json`，上传的 APK 归档在 `<profile>/.apk-vm/apks`
  （最新 10 个）；客机重置/AVD 重建/插件升级后会按需自动重装（`autoReinstall`，默认开）。
- 零配置首次运行：`autoSetup`（默认开）在第一次使用时自动准备 JDK 17、SDK 命令行工具、
  system image 和 AVD；可在环境卡片查看进度、取消和重试，也可用 `autoSetup: false` 保持手动。
- Agent 活动日志、设备韧性/恢复、quick-boot 快照恢复、多实例隔离等 0.12.0 的完整说明见
  [`CHANGELOG.md`](CHANGELOG.md) 的 0.12.0 一节（含 Historical: planned 1.0.0 的历史记录）。
