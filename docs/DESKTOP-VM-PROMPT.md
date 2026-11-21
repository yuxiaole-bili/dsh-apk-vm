# Prompt：实现 `dsh-desktop-vm`（Windows / Linux / macOS 桌面虚拟机 DSH 插件）

> 这是一份可直接交给另一位工程师/Agent 的任务 Prompt。
> 背景：`dsh-apk-vm`（Android APK 虚拟机插件，0.13.0）已经验证了"DSH 插件内嵌虚拟机 + 面板 + Agent 工具 + 活动审计"这套交互模型。
> 现在要把同一套控制面复制到**桌面操作系统虚拟机**（Linux / Windows / macOS guest），做成**独立插件** `dsh-desktop-vm`，与 `dsh-apk-vm` 并行存在、互不修改。

---

## 0. 你要做什么（一句话）

构建一个 DSH 插件 **`dsh-desktop-vm`**：在 DSH 侧边栏里启动/操作一台**桌面 Linux（Phase 1）**、之后扩展 **Windows（Phase 2）** 的虚拟机——实时画面、鼠标/键盘输入、截图、SSH shell、文件上传下载、qcow2 快照，并把这些能力注册为 Agent 可调用的 `desktop_vm` 工具；界面语言/交互/审计模型与 `dsh-apk-vm` 保持一致。

**不要**修改或 fork `dsh-apk-vm` 仓库；可以**复制**其中的可复用模块（见 §2.2），保留版权头并注明来源。

---

## 1. 必读资料（先读，再动手）

1. `https://github.com/yuxiaole-bili/dsh-apk-vm`，tag `v0.13.0`（或更新）。
2. 重点阅读文件（按顺序）：
   - `index.js`：插件入口 `apply(ctx)`、HTTP/WS 路由、工具注册、`stateBody`、owner 守卫。
   - `client.js`：面板 UI（卡片布局、H.264/PNG 帧显示、输入映射、Activity 卡、i18n EN/ZH）。
   - `cordis.patch.yml`：插件配置声明（默认值 + 注释）。
   - `lib/activity-log.js`、`lib/lease-store.js`、`lib/vm-ownership.js`、`lib/http-owner.js`：活动审计与租约/所有权（可直接复制）。
   - `lib/storage.js`：存储统计/清理（可裁剪后复用）。
   - `lib/setup.js`、`lib/autosetup.js`、`lib/jdk.js`：零配置引导与下载加固（复用其模式）。
   - `spike/*.mjs`：无依赖的测试风格（`node --test` 风格自研断言 + fake 对象）。
   - `docs/AGENTS.md`：Agent playbook 写法；新插件要给 Agent 一份同样的 playbook。
   - `README.md` 的「Compatibility」「Configuration」「Architecture」三节。
3. DSH 插件开发文档：<https://dsh-plugin.org/>（bundle/plugin 契约、client 注入、cordis patch）。

---

## 2. 架构要求

### 2.1 总体

```
dsh-desktop-vm/
  index.js                 # apply(ctx)：路由、工具、生命周期、租约/审计接线
  client.js                # DSH 面板（web client bundle）
  lib/
    vm-driver.js           # 统一驱动接口（create/start/stop/pause/snapshot/restore/framebuffer/input/shell/fs）
    qemu-driver.js         # Phase 1：QEMU 实现（Linux guest；Windows guest Phase 2）
    rfb-client.js          # 纯 Node RFB(VNC) 客户端：握手/SetPixelFormat/FramebufferUpdate/Pointer/Key/ClientCutText
    frame-encoder.js       # 原始帧 → PNG（node:zlib）或 JPEG（Phase 2 可选 ffmpeg）
    cloudinit.js           # 生成 cloud-init NoCloud ISO/seed（Linux guest 无人值守初始化）
    guest-ssh.js           # ssh/scp 子进程封装（Windows/Linux/macOS 自带 OpenSSH）
    activity-log.js        # 从 dsh-apk-vm 复制
    lease-store.js         # 同上
    vm-ownership.js        # 同上（instance=VM id）
    http-owner.js          # 同上（409 语义保持一致：vm-busy / vm-takeover-required / vm-locked）
    storage.js             # 磁盘占用/孤儿清理（参考 dsh-apk-vm 裁剪）
  docs/{README,AGENTS,RELEASING,PRIVACY}.md
  spike/*.mjs              # 无依赖测试
  cordis.patch.yml
  package.json
```

### 2.2 从 `dsh-apk-vm` 复制（保留 Apache-2.0 头 + NOTICE 注明来源）

- `lib/activity-log.js`（Activity 审计：JSONL + 截图，按条数/字节裁剪）
- `lib/lease-store.js` + `lib/vm-ownership.js` + `lib/http-owner.js`（租约持久化、保留、硬锁、takeover 语义）
- `lib/storage.js` 的统计/清理模式（改造成磁盘镜像/快照/临时文件）
- `spike/` 的断言/测试风格与 `scripts/privacy-scan.mjs`（必须 copy 并保持 clean）

### 2.3 必须实现的 Agent 工具（`desktop_vm`，action 风格与 apk_vm 一致）

`info, start, stop, list_vms, create_vm, destroy_vm, rename_vm, snapshot_create, snapshot_list, snapshot_restore, screenshot, tap, swipe, long_press, key, type_text, clipboard_get/set, shell, fs_upload, fs_download, fs_list, wait_for, boot?（no）, perf, lock_vm, unlock_vm, owner_status, claim_vm, release_vm`

约定：
- `screenshot` 返回 PNG（base64/临时文件路径与 apk_vm 一致）；
- `tap/swipe` 使用 **guest 分辨率坐标**，`info` 返回 `coordinateMap`（与 apk_vm 相同公式）；
- `type_text`：优先 RFB 剪贴板 + 粘贴，失败回退 SSH + `xdotool type --clearmodifiers`（Linux guest）；
- `shell`：Phase 1 默认 SSH 执行（guest 内 root/sudo 由 cloud-init 配置）；
- 所有权/锁复用 `vm-busy`（他人持有）、`vm-takeover-required`（admin 需显式 takeover）、`vm-locked`（硬锁，ownerForce 不可破）三套 409；
- 危险操作（`destroy_vm`、删除快照、清理磁盘）必须 `confirm=true` 二次确认。

### 2.4 面板 UI（client.js）

- 右侧栏卡片布局与 apk_vm 对齐：**环境/VM 列表卡片**、**画面区（H.264 或 PNG 帧）**、**输入栏（点击/拖动/滚轮/按键/文本）**、**Activity 时间线**、**Console/Debug 卡**、**Storage 卡（含可回收空间 + confirm 清理）**。
- 画面：Phase 1 用 PNG 帧（2–10 fps 可配）经 HTTP/WS 推送；Phase 2 可选 H.264（ffmpeg/libav 或复用 apk_vm 的 WebCodecs 管线）。
- 输入：面板 CSS 坐标 → RFB 坐标（用 `info.screen` 计算，DPR 明确）；中文文本走剪贴板。
- i18n：EN/ZH 双语键集完全对称（参考 `spike/ui-smoke.cjs` 的键集校验）。
- 务必支持 **`state` 机器状态**：`stopped/starting/ready/suspended/error`，面板显示对应中文标签。

### 2.5 配置（`cordis.patch.yml`）

```yaml
vmProvider: qemu            # qemu（Phase 1）
vmImage: ubuntu-24.04       # 内置镜像清单（自动下载 qcow2 + cloud-init）
vmMemoryMb: 4096
vmCpus: 2
vmDiskGb: 20
displayFps: 5               # PNG 帧率；Phase 2 支持 H.264
bootTimeoutMs: 120000
sshUser: dsh
sshPortBase: 47000
autoDownloadImage: true
maxVms: 2
lockEnforcement: all        # all | agents | off（复用 apk_vm 语义）
lockControl: all            # all | user
```

### 2.6 虚拟机模型与磁盘布局

- 状态目录：`<profile>/.desktop-vm/`
  - `vms.json`（VM 列表：id/name/image/disk/ram/cpu/sshPort/state/createdAt）
  - `vms/<id>/disk.qcow2`、`vms/<id>/cloud-init.iso`、`vms/<id>/console.log`
  - `leases.json`（复用 apk_vm 的租约文件格式）
  - `activity/`（活动审计）
- 快照：`qemu-img snapshot -c/-a/-d`（qcow2 内置快照）；`snapshot_list` 返回名称/时间/虚拟大小。
- 孤儿清理：删除 VM 时删除目录（二次确认）；启动时清理 `*.tmp` 与残留 qemu 进程。

### 2.7 QEMU 启动参数基线（Windows 宿主，Linux guest）

```
qemu-system-x86_64 \
  -accel whpx                        # Windows；Linux 宿主用 kvm；macOS 用 hvf
  -m 4096 -smp 2 \
  -drive file=disk.qcow2,if=virtio \
  -drive file=cloud-init.iso,media=cdrom \
  -device virtio-vga -display vnc=127.0.0.1:5900 \
  -nic user,hostfwd=tcp:127.0.0.1:47022-:22 \
  -boot c -monitor none -daemonize?（Node spawn 即可，不需要 daemonize）
```

- `-vnc` 用 loopback 端口，端口从 `sshPortBase + 2*index` 起分配，避免冲突。
- Linux 宿主：`-accel kvm -cpu host`；macOS Intel：`-accel hvf`；macOS Apple Silicon：Phase 3（arm64 guest）。
- **Windows 宿主没有系统 QEMU**：Phase 1 允许要求用户预装 QEMU（winget/官网），插件做探测 + 明确报错；Phase 2 再做自动下载（约 150MB，注意签名/体积）。

### 2.8 显示链路（RFB 客户端要求）

- RFB 3.8 握手；安全类型支持 `None` 与 `VNC Authentication`（DES；Phase 1 可用 `None` + loopback 限制）。
- `SetPixelFormat`：32bpp true-color，little-endian；`SetEncodings`：优先 `Raw`（0），可选 `Tight/Hextile`（Phase 2）。
- 循环：`FramebufferUpdateRequest(incremental=1)` → 处理 update → 编码 PNG → 推送面板；断开时停止请求。
- 输入：`PointerEvent`（buttonMask 1=左键 2=中 4=右键；滚轮 = 4/5 按钮 press+release）、`KeyEvent`（keysym）、`ClientCutText`（UTF-8）。
- 剪贴板：`ServerCutText` → 面板；面板文本 → `ClientCutText`。

### 2.9 Guest（Linux）镜像与 cloud-init

- Phase 1 推荐 **Ubuntu 24.04 cloud image**（`https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img`，qcow2，约 600MB）：
  - 下载后 resize 到 `vmDiskGb`；
  - 生成 cloud-init NoCloud（`user-data` + `meta-data`，`genisoimage` 可能缺失 → 用纯 Node 生成 ISO9660，或 Phase 1 直接要求用户装 `cloud-localds`/`genisoimage`；建议实现纯 Node 的 ISO 生成以保持零依赖）；
  - cloud-init 创建 `dsh` 用户 + SSH key（插件生成 ed25519 到 `<profile>/.desktop-vm/keys/`），安装 `xfce4 xfce4-terminal`（或 `ubuntu-desktop-minimal`）与 `openssh-server`，`sudo` 免密（仅 VM 内）。
  - 首启 1–5 分钟（apt 安装桌面）；`autoSetup` 面板显示进度；之后冷启动约 10–20s。
- 可选更轻方案：Debian 12 cloud image + xfce4。

### 2.10 SSH

- 依赖宿主 `ssh`/`scp` 可执行（Windows 10+ 自带 OpenSSH Client；Linux/macOS 自带）。
- 连接：`ssh -i key -p <port> -o StrictHostKeyChecking=no dsh@127.0.0.1`；
- `shell` 返回 stdout/stderr/exitCode，超时 30s 可配，输出截断 64KB（与 apk_vm 一致）；
- 文件上传下载：`scp`（远端路径限制在 `/home/dsh`、`/tmp`）。

---

## 3. 分阶段范围与验收

### Phase 1（优先交付，2–3 周）

**范围**：Windows 宿主 + Linux guest + 面板 + Agent 工具 + 快照 + 审计 + 租约/锁 + 存储卡；Linux 宿主用 KVM 做 CI 回归（可选）。

**验收（在干净 Windows 11 机器上执行）**：

1. `dsh plugin --profile web add dsh-desktop-vm` 安装成功，面板出现「桌面虚拟机」入口。
2. 首次使用自动下载 Ubuntu cloud image、生成 cloud-init、创建 qcow2、启动 QEMU；面板显示进度与日志；失败有任何一步（QEMU 缺失/下载失败/启动失败）时给出**可操作报错**。
3. 面板能看到 XFCE 桌面（PNG 帧 ≥2 fps），点击「Activities」、打开终端、输入命令，画面实时更新。
4. Agent 工具链路：`info` → `screenshot` → `tap` → `type_text` → `wait_for`/`shell uname -a` 断言；`fs_upload`/`fs_download` 往返一致。
5. `snapshot_create` → 修改 guest → `snapshot_restore` → 状态回滚并验证；`destroy_vm` 需 `confirm=true`。
6. Activity 卡记录全部操作（含 owner 字段）；`owner_status/claim_vm/release_vm/lock_vm/unlock_vm` 行为与 `dsh-apk-vm` 文档一致（409 文案复用）。
7. Storage 卡统计磁盘/快照/临时文件占用，`clean_storage` 危险动作需 confirm。
8. `npm run check`、`npm test` 全绿；`node scripts/privacy-scan.mjs --untracked` clean；中文/英文 CHANGELOG 同步。
9. 冷启动 ≤30s（已预装桌面后）、首装 ≤15 分钟（含镜像下载，取决于网速）；README Quickstart 可在 15 分钟内跑通。

### Phase 2（Windows guest，2–3 周，需先评审）

- 用户自备 Windows ISO（插件**不**分发/不内置镜像；README 明确授权责任）。
- QEMU + WHPX；Windows 11 需要 TPM/SecureBoot → `swtpm` 可选；建议先支持 Windows 10（无 TPM）。
- 无头安装：autounattend.xml + virtio-win 驱动 ISO；首启约 5–15 分钟。
- 输入/剪贴板：RFB 可用；文件传输：优先 guest 内 OpenSSH（用户可在镜像里启用），否则用 `-drive file=fat:rw:` 只读共享目录，文档说明限制。
- 验收：安装 → 桌面出现 → 打开记事本输入中文 → 截图断言；快照/恢复；销毁确认。

### Phase 3（macOS guest，仅 Apple 硬件，评估后再做）

- Apple Virtualization.framework（需要 native helper 或 Swift/Objective-C 小程序，或 `vz` CLI 封装）；Apple SLA 仅允许 Apple 硬件上虚拟化、数量限制；**不承诺跨平台**。除非有明确需求，否则不做。

### 非目标（明确不做）

- 不做云主机编排（AWS/Azure 的 Windows VM 由用户自己连，不做）。
- 不做 macOS guest 的非 Apple 硬件支持（法律/技术不可行）。
- 不改 `dsh-apk-vm` 的代码，不在此插件里嵌入 Android。
- 不做人类用的通用 VNC 客户端（只做 DSH 面板）。

---

## 4. 工程约束（与 dsh-apk-vm 一致）

- **零 npm 运行时依赖、零构建步骤**（纯 Node ≥20；client 用 DSH client API，不打包）。
- DSH 插件契约：导出 `apply(ctx)`；工具经 `ctx.tools` 注册；`cordis.patch.yml` 声明配置与 client 注入；`dsh.compatibility` 元数据照抄 `dsh-apk-vm/package.json` 的格式并填当前 DSH 版本（0.2.2-rc.x）。
- 安全：所有 HTTP/WS 路由默认 loopback + same-origin；路径参数校验（禁止 `..`）；输出截断；不记录 SSH 私钥内容；privacy-scan 必须 clean。
- 测试：`spike/*.mjs`，fake QEMU 进程/RFB server 覆盖驱动；UI smoke 校验 i18n 键集、slot 注册、无 `currentColor` 图标问题（照抄 apk_vm 的 smoke 设计）。
- 发布：`docs/RELEASING.md` 记录 npm（显式 `--registry=https://registry.npmjs.org`）+ GitHub release；版本从 0.1.0 开始；CHANGELOG.zh-CN.md 从第一个版本起就有。

---

## 5. 你需要先交付（第一个里程碑，禁止直接写代码）

1. `ARCHITECTURE.md`：驱动接口（`VmDriver`）定义、RFB 客户端设计（状态机 + 编码选择）、cloud-init ISO 生成方案、进程/端口/磁盘管理、错误码与 UI 状态映射。
2. `PHASE1-PLAN.md`：任务拆解（≤3 天粒度）、依赖、风险（QEMU 分发/Windows 授权/WHPX 可用性/RFB 带宽/cloud-init 时长）、测试矩阵（Windows 宿主必测、Linux KVM CI、macOS 不承诺）。
3. 一个**最小 PoC 脚本**（不进插件）：在 Windows 上用 QEMU + Ubuntu cloud image + VNC 启动一台 VM，用 Node 的 RFB 客户端抓 1 帧 PNG、模拟点击/按键并截图验证。PoC 通过后再进入插件开发。
4. 把以上三份产物发给项目 owner 评审，通过后开始 Phase 1 编码。

---

## 6. 风险与需要 owner 决策的点

| 风险 | 影响 | 建议 |
|---|---|---|
| Windows guest 授权 | 不能分发镜像；用户激活/合规 | 用户自备 ISO/授权；README 免责声明；不做一键镜像 |
| QEMU 分发（150MB+、签名） | 插件体积/市场审核 | Phase 1 要求用户预装 QEMU；Phase 2 再做下载器（带 SHA-256/镜像源） |
| WHPX/Hyper-V 冲突 | Windows 宿主可能启动失败 | 启动前探测 `-accel whpx`，给出"关闭 Hyper-V/WSL2 冲突"指引 |
| RFB Raw 带宽 | 1080p 5fps ≈ 数 MB/s | Phase 1 限制 720p/5fps，Phase 2 引入 Tight/JPEG 或 ffmpeg H.264 |
| cloud-init 生成 ISO 无外部工具 | 依赖 genisoimage | 纯 Node ISO9660 生成（PoC 必须验证） |
| macOS guest | 法律/硬件限制 | 明确列为 Phase 3、仅 Apple 硬件 |
| 维护成本 | 与 apk_vm 双线并行 | 共用代码以 copy + attribution 方式，不建 monorepo；CI 分开 |

---

## 7. 第一条消息模板（直接发给执行者）

> 请先阅读 `https://github.com/yuxiaole-bili/dsh-apk-vm` 的 `index.js`、`client.js`、`lib/{activity-log,lease-store,vm-ownership,http-owner,storage,setup}.js`、`docs/AGENTS.md` 和 `spike/ui-smoke.cjs`，理解现有 DSH VM 插件模式。
> 然后按本 prompt 交付 `ARCHITECTURE.md`、`PHASE1-PLAN.md` 与最小 RFB+QEMU PoC（只验证：Windows 上启动 Ubuntu cloud image，Node 抓帧、点击、按键、截图）。
> 交付前不要创建 npm 包、不要写完整插件代码；PoC 和设计文档经 owner 评审通过后再进入 Phase 1。
> 约束：独立仓库 `dsh-desktop-vm`、Apache-2.0、零 npm 运行时依赖、不修改 `dsh-apk-vm`、privacy-scan 必须 clean、中英文文档与 CHANGELOG 同步。
