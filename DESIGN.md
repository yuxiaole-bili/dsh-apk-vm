# 设计方案：DSH 侧边栏 APK 虚拟机预览插件

> 目标：在 DeepSeek Harness 的侧边栏里，以「打开一台虚拟机」的方式预览 APK ——
> 启动开源 Android 虚拟机、安装 APK、把 VM 画面流进侧边栏面板、把鼠标/键盘输入送回 VM。

## 1. 需求与约束

| 项 | 内容 |
| --- | --- |
| 入口 | 侧边栏（`sidebar.panellist`）新增「APK 虚拟机」图标；点击后主区（`main`，key `apk-vm`）渲染完整面板 |
| 体验 | 像虚拟机控制台：开机/关机、状态、屏幕、输入、安装 APK、日志 |
| 运行环境 | Windows 10/11 x64；无管理员权限；**不允许使用 MuMu Player**；需从 GitHub 选择开源模拟器 |
| 宿主能力 | 无 Hyper-V/WHPX/AEHD/KVM 驱动；只有用户态虚拟化（QEMU TCG）可用 |
| 插件规范 | DSH 静态插件：Host 半 `apply(ctx)` + `dsh.client` 声明的浏览器 bundle；UI 只用主题 token、locale、slot |

## 2. 开源框架选型（GitHub / AOSP）

通过 GitHub/AOSP 调研了以下候选：

| 候选 | 许可证 | 结论 |
| --- | --- | --- |
| **AOSP Android Emulator**（`aosp-mirror/platform_external_qemu` + official `emulator` / `system-images`） | Apache-2.0 | **主选 VM**。官方开源模拟器，adb 生态完整，可无窗口、可指定 AVD |
| **Genymobile/scrcpy** v5.0.1（仅 scrcpy-server，自研 headless relay） | Apache-2.0 | **主选串流/控制框架**。H.264 低延迟、触摸/按键/滚轮/文本控制协议完善，可无桌面客户端 |
| Android-x86 / Bliss OS + QEMU | GPL/Apache-2.0 | 备选：无硬件虚拟化时的 QEMU TCG 路径；本机无法从网络取得 ISO（SourceForge/OSDN/Archive.org 均被阻断） |
| LineageOS-TV-x86（GitHub Releases） | Apache-2.0 | 备选：GitHub 上可下载的 x86_64 Android 21 OTA，但需要 payload2iso/recovery，不能直接 boot |
| ws-scrcpy | MIT | 备选：开箱即用的 web 串流，但需要独立 Node 服务 + iframe，和 DSH 主题/插件规范不符 |
| Waydroid / redroid / Anbox | GPL/Apache-2.0 | 仅 Linux；Windows 无内核 binder/ashmem，排除 |
| Genymotion / Appetize / Corellium | 商业 | 非开源，排除 |
| ARChon | 旧版 Apache-2.0 | Android 4.4 Chrome runtime，APK 兼容性差，排除 |

**最终栈**：AOSP Android Emulator（VM） + scrcpy-server（画面/控制协议） + adb（安装/启动/截图/输入）。
无 npm 运行时依赖；Host 半只使用 Node 内置模块。

## 3. 总体架构

```
┌──────────────────────────── DSH Web UI ─────────────────────────────┐
│ sidebar.panellist [apk-vm]  ──click──▶  main[apk-vm]                │
│                                            │                        │
│                                  Client half (client.js)            │
│                 ┌──────────────────────────┼──────────────────┐      │
│                 │ 工具栏 / APK 列表 / 手机框 │ 2s state, 500ms frame │
│                 └──────────────────────────┼──────────────────┘      │
└────────────────────────────────────────────┼────────────────────────┘
                                             │ same-origin HTTP (fetch)
┌────────────────────────────────────────────┼────────────────────────┐
│ DSH Host (desktop process)                 ▼                        │
│  index.js  ── /apk-vm/{state,apks,vm,install,frame,input}           │
│     │                                                               │
│     ├─ lib/android.js   AndroidVm: AVD lifecycle / adb / aapt2      │
│     │      • spawn emulator (open-source AOSP) or attach serial     │
│     │      • install -r, am start, wm size, screencap -p            │
│     │      • input tap/swipe/keyevent/text                          │
│     │                                                               │
│     └─ lib/scrcpy.js    ScrcpySession (可选 H.264 快通道)            │
│            • push scrcpy-server 5.0.1, adb forward, app_process      │
│            • video demux + SPS/PPS → avcC + control messages         │
└─────────────────────────────────────────────────────────────────────┘
                                             │ adb
                                   ┌─────────▼─────────┐
                                   │ Android VM (AVD)   │
                                   │  system.img + APK  │
                                   └───────────────────┘
```

### 状态机（Host 侧 AndroidVm）

`stopped → starting → booting → ready → stopped`
失败进入 `error`（附带 `error` 与有界 `logTail`）；`start()` 幂等，先 attach 已在线 adb
设备，再考虑 `adb connect <serial>`，最后才按配置 spawn AVD；`stop()` 只杀自己 spawn 的
子进程，并清理 adb 连接。

## 4. DSH 插件落点

- **Host 半**（`index.js`）：`export function apply(ctx, config)`；`ctx.inject(['webServer'], host => host.effect(() => mountRoutes(host.webServer)))`。
  路由注册在 `webServer.register({ kind: 'exact', path })`；返回 disposer，插件卸载时清理
  route 与 `AndroidVm`。不使用任何未公开 API。
- **Client 半**（`client.js`）：`window.__ModuleLoader__.load({ id, factory(require) })`，
  只 `require('react')`，`React.createElement` 手写。`apply(ctx)` 中：
  - `ctx.locale.register('apk-vm', { en, zh })` + `bind`；
  - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'apk-vm', locale:'apk-vm' }, ApkVmPage))`；
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'apk-vm', order:30, label:()=>t('nav.label'), locale:'apk-vm' }, PhoneIcon))`。
- **显示元数据**：`locale/en.json`、`locale/zh.json` 提供 `meta.title/meta.description`，
  `icon.svg` 为原创 currentColor 手机图标；`exports` 暴露 `./locale/*.json` 与 `./icon`。
- **主题**：仅使用 `--dsw-alias-bg-* / border-* / label-* / brand-primary / state-*` token；
  手机框等“内容物”允许多一点自由色，但面板容器/按钮全部走 token。

## 4.5 与 dsh-better-sidebar 的兼容层

`dsh-better-sidebar`（MIT，GitHub）是社区侧栏工作台，它在**客户端**提供 `ctx.betterSidebar`
服务（`registerTab` / `registerFileViewer` / `openTab` / `getSnapshot`），并把这些 tab
类型投影到 DSH 原生右侧栏（`sidebar.right.pane.tab`）与它自己的底部 workbench。

兼容策略（不 fork、不硬依赖、不操作其 DOM）：

1. **可选注入**：在 `apply(ctx)` 末尾使用 `ctx.inject(['betterSidebar'], sub => …)`，
   等到服务出现才注册；没有该插件的 DSH 上行为完全不变（`main` 面板 + 左侧图标照常）。
2. **注册 tab**：`sub.betterSidebar.registerTab({ id:'apk-vm:preview', title, description,
   icon, order:60, single:true, component })`；component 复用同一 `ApkVmPage`，标记
   `embedded:true` 以切换窄栏布局（列表在上、手机框更小）。
3. **打开入口**：主面板 header 增加「在侧栏打开」（仅服务存在时显示），调用
   `openTab({ type:'apk-vm:preview', target:'right' })`；无活动会话时给出明确提示，
   因为 better-sidebar 的右侧栏按会话隔离。
4. **生命周期**：注册放入 `sub.effect(...)`，服务卸载/HMR 时自动反注册；组件通过
   `visible` prop 暂停不可见 tab 的帧轮询，避免后台开销。
5. **验证**：本机 live slot tree 中 `sidebar.right.pane.tab` 出现 occupant
   `dsh-better-sidebar:apk-vm:preview`（active）；另有 `spike/ui-better-sidebar-smoke.cjs`
   覆盖描述符、本地化、dispose、服务已存在路径、服务缺失容错。

## 4.6 开机加速设计（目标 <30s）

冷启动 Android 的时间由 CPU 虚拟化决定，因此按“硬件加速 → GPU → 快照 → 预热”四层解决：

1. **CPU 加速探测**：`lib/android.js` 调用 SDK 的 `emulator-check accel`，AEHD/WHPX/KVM/
   HAXM/HVF 可用时不传 `-accel off`（emulator 自动使用硬件加速）；仅在确实没有 hypervisor
   时才退回 `-accel off`（此路径 x86_64 不可用，会显式报错而不是静默卡住）。
2. **GPU host**：默认 `-gpu host`（RTX 5070 Ti），替代 SwiftShader 软件渲染；无 GPU 的
   headless 主机可用 `gpuMode: swiftshader_indirect` 回退。
3. **Quick-boot 快照**：首次成功冷启动后执行 `adb emu avd snapshot save default_boot`；
   之后的启动传 `-snapshot default_boot`，直接恢复内存态（通常数秒）。快照有效性以
   `snapshot.pb` 为准，失败 TCG 运行留下的 `ram.img` 不会被误当快照；同时修复了“残留
   offline adb 设备把启动卡在 attach 路径”的问题。
4. **预热/自动启动**：`prewarm: true` 在插件激活 3s 后后台启动 VM；`autoStart: true`
   在第一次 `state/frame` 请求时启动。用户打开面板时 VM 通常已就绪，主观“打开即可见”。
5. **可观测性**：`/apk-vm/state.vm` 暴露 `bootKind`（cold/snapshot/attach）、`bootMs`、
   `accel`、`gpuMode`、`snapshotAvailable`；面板状态 pill 显示 `cold Ns` / `quick Ns`，
   后续验收可直接读取实测值。
6. **帧率（双路径）**：默认走 **scrcpy H.264 + WebCodecs**（见 4.8），最高 **60 fps**；
   PNG 回退由 `/apk-vm/stream {fps:1..10}` 控制，`/apk-vm/state.stream` 同时返回
   `fps / hostFps / h264 {active, fps, clients, maxFps, width, height}`；header 显示实测 FPS。

本机实测：重启释放 AMD-V 后 AEHD 生效；修复 AVD 的 `fastboot.forceColdBoot/forceFastBoot`
与 `snapshot.present` 后，快照真正参与启动。首次冷启动 **29.5s**（含重建 AVD 配置后的
新快照），快照重存后再启动 **8.4s**（日志 `Loading snapshot 'default_boot'`、
`Boot completed in 8371 ms`、`bootKind: snapshot`），已达标。

## 4.7 Root / ADB / 调试接口设计

目标：模拟器默认 root、adb 直接可用，并向 DSH 暴露底层调试能力。

1. **默认 root**：镜像本身是 `userdebug`（`ro.debuggable=1`、`ro.adb.secure=0`，无 adb 授权
   弹窗）。每次启动 ready 后 Host 自动执行 `adb root`，等待 adbd 重启并校验
   `uid=0(root)`；`--prop` 只接受 `qemu.*`，因此不用命令行属性伪造 root，而是启动后应用
   并写入 quick-boot 快照，后续快照启动再幂等补一次 `adb root`。
2. **调试友好配置**：启用 adb/开发者设置，关闭安装校验（`verifier_verify_adb_installs`、
   `package_verifier_enable`），`persist.sys.usb.config=adb`、`persist.sys.root_access=3`。
3. **机内工具包**：`/data/local/tmp/dsh/debug.sh` + README（755）：
   `info / logs / prop / pkgs / install / help`，用户可在 root shell 里直接用。
4. **DSH 调试接口**：
   - HTTP：`/apk-vm/debug/{info,shell,logcat,prop,packages,root,push,pull,reboot,action,rotate,ui,record,perf,screenshot}`，
     参数/输出有上限，push/pull 路径受限；
   - Agent Tool：`apk_vm`（`ctx.tools.register`，全局可见），动作覆盖 info/shell/logcat/
     getprop/setprop/packages/install/push/pull/reboot/root/force_stop/clear_data/uninstall/
     rotate/ui_dump/record/perf/screenshot，与 HTTP/面板共用同一 Host 方法；
   - UI：面板新增「Root 调试」卡（root/shell 徽章、Android/API/ABI、命令输入、Logcat/
     Props/Root/UI 树/性能/录屏/旋转按钮、输出控制台），并支持截图下载。
5. **错误可见性**：无硬件加速时 fail-fast 报错，不再 20 分钟“启动中”；工具注册 schema
   错误会显式抛出（本次已修正为严格 JSON Schema）。

## 4.8 60fps H.264 串流设计

目标：把 PNG 轮询（~1 fps）替换为可用的 60fps 实时画面，同时保留无 WebCodecs 环境的回退。

1. **链路**：浏览器 `<canvas>` ← `VideoDecoder` ← `/apk-vm/ws`（无依赖 RFC6455 服务端，
   `lib/ws.js`）← `annexbToAvcc` 分片 ← `ScrcpyVideoDemuxer` ← scrcpy-server 5.0.1（
   `lib/vendor/scrcpy-server-v5.0.1.jar`，启动时 adb push + forward + `app_process`）。
2. **参数**：`maxSize=960`（540×960，面板足够清晰且软件解码可达 ~60fps）、
   `videoBitRate=6_000_000`、`maxFps=60`；scrcpy 只在屏幕变化时出帧，静态桌面 FPS 低
   是正常语义，不等于串流故障。
3. **协议**：文本 `init` 一次（`codec/codecString/description(avcC base64)/width/height/
   maxFps/bitrate`），随后二进制帧 `[0]=1, [1]=keyFlag, [2..9]=pts(LE int64), [10..]=AVCC`。
4. **关键帧**：客户端配置解码器后先丢 delta，等首个 keyframe；已运行的会话接到新客户端时
   发送 `RESET_VIDEO`（scrcpy control type 17）请求新 keyframe，避免二次打开面板黑屏。
5. **会话管理**：一个 scrcpy 会话广播给多个 WS 客户端；客户端断开后 15s 无连接自动停止
   会话（释放编码/端口），VM 不停止；VM stop/restart/插件 dispose 时主动停流。
6. **回退**：无 `WebSocket`/`VideoDecoder`/`EncodedVideoChunk`、初始化失败、连续 3 次连接
   失败、或面板不可见时，自动退回 PNG 轮询；输入仍走 `/apk-vm/input`（不受串流影响）。
7. **旋转/编码器重置**：scrcpy `session` 包更新宽高时 Host 重发 `init`，客户端重建
   `VideoDecoder`、更新画布尺寸与输入坐标映射，避免横竖屏拉伸/错位。
8. **实测**（本机 60Hz 动画测试 APK `test.dshanim`）：
   - `/apk-vm/ws` 原始包速率 **59.3fps**（425–474 包/8s；首 init 6–1000ms）；
   - headless Edge 软件 WebCodecs 解码 **318 帧/6.32s = 50.3fps**（扣除启动约 57fps），
     0 协议错误；
   - 第二个客户端在 4s 内收到 234 包（~58.5fps）+ 1 个 keyframe（RESET_VIDEO 生效）；
   - 视觉 GPU 加速的 DSH 窗口预期更接近 60fps；headless 软件解码是下限。


## 4.9 开源化 / 环境自检 / 上传与安全

为“别人能装得上、敢用、可维护”补齐的工程能力：

1. **环境自检（lib/setup.js）**：跨平台探测 SDK 根目录、`adb`、`emulator`、
   `sdkmanager`/`avdmanager`（Windows 下 `.bat` 通过 argv-only `cmd.exe` trampoline）、
   system image、AVD、`emulator-check accel`（AEHD/WHPX/KVM/HAXM/HVF）以及 JDK
   （`JAVA_HOME` 未设置时自动寻找并仅注入子进程环境）。只读，不自动下载。
   `GET /apk-vm/setup` 返回 `ok/missing/actions/hypervisorNotes`；`POST /apk-vm/setup`
   支持 `refresh`、`create-avd`，以及仅在 `allowSetupDownloads: true` 时允许的
   `install-image`（~1 GB，显式动作）。
2. **上传 APK**：`POST /apk-vm/upload` 接收 raw APK，`x-apk-name` 传文件名，500 MiB 上限，
   检查 ZIP/APK magic，写入 OS 临时目录后走与路径安装相同的 `installApk`；面板提供上传
   按钮与拖放覆盖层，插件卸载时清理临时目录。
3. **安全边界**：所有 `/apk-vm/*` HTTP 路由与 `/apk-vm/ws` 升级校验 `Origin`/`Host` 与
   `Sec-Fetch-Site`，跨站请求 403/destroy；JSON body ≤64 KiB；上传 ≤500 MiB；调试输出/命令
   长度有界；push/pull 路径限制；所有子进程 argv 数组，不拼接 shell 字符串。
4. **多 AVD**：`GET /apk-vm/avds` 列出 emulator 可见 AVD；`POST /apk-vm/avd` 停止当前 VM、
   切换 `AndroidVm.avdName`、清空快照探测并自动重启。环境卡在多于一个 AVD 时显示切换器。
5. **调试接口扩展**：`rotate`（锁定 user_rotation）、`uiDump`（UIAutomator XML）、
   `screenRecord`（5s MP4 拉回 Host 临时目录）、`perfSnapshot`（loadavg/meminfo/cpuinfo）、
   `screenshot`（PNG 附件）；Agent `apk_vm` 同步新增 action。
6. **开源工程**：README（含中文简介/Quickstart/故障排查/安全说明）、Apache-2.0 LICENSE、
   NOTICE（scrcpy/AOSP 归属）、CONTRIBUTING/SECURITY、GitHub Actions（Node 24，headless
   检查 + mock 测试）、Issue/PR 模板；二进制 scrcpy JAR 随包，系统镜像不随包分发。
7. **跨平台**：`candidateSdkRoots` 增加 Linux/macOS 常见路径；`resolveEmulatorPath` 支持
   SDK 目录与 PATH；加速错误提示按 win32/darwin/linux 区分。Windows x64 为当前端到端验证平台。


## 4.10 多 Agent / 多虚拟机实例

问题：DSH 同一 profile 下多个 Agent 会共享一个插件进程，但 `apk_vm` 工具、面板、adb 端口、
AVD、快照、scrcpy 会话原本都是单例；两个 Agent 同时 install/input 会互相踩状态。

设计：
1. **实例模型**：默认实例继续由 `index.js` 持有（UI/兼容路径不变）；额外实例由
   `lib/instances.js` 的 `InstanceManager` 管理。每个 `ExtraVmInstance` 拥有独立：
   AVD（`<base>_<id>`）、emulator console port（基准 5558 + 2*序号，自动找空闲）、
   独立 userdata/snapshot（每个 AVD 自己的 `default_boot`）、`AndroidVm`、PNG frame 缓存、
   lastApk/install 锁。
2. **AVD 创建**：首次创建实例时用 `lib/setup.js` 的 `avdmanager create avd` 建 AVD，并
   写入 `fastboot.forceColdBoot=no / forceFastBoot=yes / snapshot.present=true`；首次冷启动
   后保存该实例自己的 quick-boot 快照，后续 6–8s 启动。
3. **Agent 归属**：`apk_vm` 在 `exec.agent.session` 上取稳定 key；第一个 Agent 使用默认
   实例，后续 Agent 自动创建隔离实例（受 `maxInstances` 限制）并在首次真实操作时启动。
   也支持显式 `instance` 参数、`list_instances/create_instance/destroy_instance/start/stop`。
4. **HTTP 命名空间**：`GET/POST /apk-vm/instances` + 每实例
   `/apk-vm/instances/<id>/{state,frame,vm,input,install,upload,debug/*}`；额外实例的
   debug 路径与默认实例同构（shell/logcat/prop/packages/root/rotate/ui/record/perf/
   screenshot/push/pull/reboot/action）。精确路由在实例创建时注册、销毁时释放。
5. **视频**：默认实例与每个额外实例各有独立 H.264/WebCodecs 流（`lib/video-stream.js` 的
   `ScrcpyStream`）：独立 scrcpy server、空闲端口、init/AVCC/关键帧、旋转重发、15s 无客户端
   自动停流。额外 AVD 固定 720×1280 预览分辨率，避免 pixel_5 1080×2340 + 第二路编码器导致的
   GPU 卡顿；WebCodecs 不可用时回退各自 PNG frame。
6. **面板**：header 增加实例选择器，环境卡/实例列表；支持 New VM / Destroy VM；切换实例时
   重置 frame/解码器并重载该实例 state。
7. **实测**：默认 `emulator-5558` 与额外 `emulator-5560` 同时 ready/root；额外实例冷启动
   约 27.5s、快照后 quick boot ~6.5s；额外实例 PNG frame（~1.29MB）和 root shell 验证成功，
   默认实例保持 ready。


## 5. 关键接口契约

`GET /apk-vm/state` →
```json
{ "ok": true,
  "vm": { "state": "ready", "serial": "emulator-5558", "avd": "dsh_apk",
          "bootMs": 95000, "error": null, "logTail": ["..."] },
  "screen": { "width": 720, "height": 1280 },
  "apk": { "path": "...", "packageName": "com.example.app", "label": "Demo", "launched": true },
  "installing": false, "roots": ["<workspace>"] }
```
`GET /apk-vm/frame?t=<ms>` → `image/png`（`Cache-Control: no-store`；VM 未 ready 时 409 + JSON）；
`POST /apk-vm/input` 支持 `tap {x,y}` / `swipe {x1,y1,x2,y2,duration}` /
`key {key:'home'|'back'|'recents'|'power'|'enter'}` / `text {text}`；
`POST /apk-vm/install {path}` 先 `aapt2 dump badging` 解析 package/launcher，再
`adb install -r` + `am start`，返回安装/启动结果。

## 6. 安全与稳健性

- **无 shell 字符串拼接**：所有 adb/emulator 调用用 `child_process.spawn(exe, argv[])`；
  文件路径仅通过参数传递，避免命令注入。
- **输入边界**：JSON body ≤ 64 KiB；上传 ≤ 500 MiB 且校验 ZIP/APK magic；坐标/时长做数值校验；
  text ≤ 4096 字符；APK 路径必须存在且以 `.apk` 结尾，相对路径只在配置 roots 下解析；
  debug push/pull 限制远程路径，pull 本地限制在 roots+临时目录。
- **同源边界**：所有 `/apk-vm/*` 路由和 `/apk-vm/ws` 升级校验 Origin/Host 与 Sec-Fetch-Site，
  跨站请求返回 403（WS 直接断 socket）。
- **资源回收**：所有路由注册在 `ctx.effect` 中；插件卸载时 dispose `AndroidVm`，
  杀自己 spawn 的 emulator 进程树，清理 frame 缓存、scrcpy 会话与上传临时目录。
- **失败可见**：VM 启动/安装/输入失败返回结构化 `{ok:false,error}`；面板展示
  `logTail`（有界 200 行）而不是吞错。
- **本地路由面**：DTO 只服务同源 Web UI，绑定在本机 DSH web 端口；不监听公网。

## 7. 验证与已知限制

已验证（本机）：
- 插件安装 `application: applied`；`sidebar.panellist` 与 `main` 两个 slot 均 active；
- Host 路由真实 HTTP 调通（state/apks/frame 409/stop/start 集成路径）；
- APK 发现可用（发现工作区 sample.apk 与 Downloads 下 APK）；`aapt2` 解析通过；
- 新功能实测：`GET /apk-vm/setup`（ok/sdk/accel）、`GET /apk-vm/avds`（dsh_apk/dsh_apk_arm/ss_test）、
  `POST /apk-vm/upload`（anim60.apk 安装启动成功）、`debug/rotate`（rotation 1/0）、
  `debug/ui`（节点数）、`debug/perf`（loadavg/mem）、`debug/record`（2s MP4 ~0.5–1MB）、
  `debug/screenshot`（PNG 附件）、跨站请求 403、非法 upload 400、install-image 未授权 403；
- 多实例实测：默认 `emulator-5558` + 额外 `emulator-5560`（`dsh_apk_test1`）同时 ready/root；
  额外实例独立上传安装 anim60.apk、H.264 init `540×960`（412 包/10s，60Hz 动画）、PNG frame
  与 root shell 正常，默认实例保持 ready；额外实例 quick boot 约 10.6s，销毁后仅剩 default。
- 环境模块 `lib/setup.js`：`spike/setup-smoke.mjs` 30/30；真实探测 294ms，AEHD 可用；
- 开源工程：Apache-2.0 LICENSE/NOTICE、CONTRIBUTING/SECURITY、GitHub Actions（Node 24 +
  headless 测试）、Issue/PR 模板；README/DEMO 为 UTF-8。
- Client bundle 136/136 沙箱断言通过；Host/backend 模块 `node --check` 通过；
- scrcpy relay 160 条协议断言（含假设备端到端）通过；并已真实接入 `/apk-vm/ws`：
  60Hz 动画 APK 下原始包速率 **59.3fps**（425–474 包/8s），headless Edge WebCodecs
  解码 **318 帧/6.32s = 50.3fps**（扣除启动 ~57fps、0 错误）；晚加入的第二个客户端
  4s 收到 234 包（~58.5fps）+ RESET_VIDEO keyframe。
- Fast-boot 启动计划单测通过：有快照时 argv 含 `-snapshot default_boot -gpu host` 且不含
  `-accel off`；无 hypervisor 的冷启动计划才加 `-accel off`；关闭 quickBoot 时含
  `-no-snapshot`；安装后的 profile 配置 live 生效（`bootKind/accel/gpu/snapshotAvailable`
  可在 `/apk-vm/state` 读到，prewarm 已按新计划拉起 host 侧 emulator）。
- 开机实测：AEHD 重启后生效；修复 AVD `fastboot.forceColdBoot/forceFastBoot` 与
  `snapshot.present` 后，首次冷启动 **29.5s**、快照重存后的 quick boot **8.4s**
  （`bootKind: snapshot`、`Boot completed in 8371 ms`），30s 目标达成。
- Root/调试实测：`adb shell id` = `uid=0(root)`；`root:true/prepared:true`；工具包
  `/data/local/tmp/dsh/debug.sh` 已安装；`/debug/info|shell|logcat|prop|packages` 与
  snapshot save 全部实测 `ok`；Agent Tool `apk_vm` 已注册（DSH 推送了更新后的 Tool schema）。
- 一个 AVD 配置修正：快照首次加载报 “different AVD configuration” 后，重存 snapshot 即恢复
  秒级 quick boot；快照有效性仍以 `snapshot.pb` 判断。

本机限制 / 备注：
- Windows 组件存储损坏（DISM 14098）导致 WHPX 备选路径不可用，当前 AEHD 为唯一加速路径；
- 为使 AEHD 获得 AMD-V，MuMuVMMDrv 已改为 Manual 并停止（MuMu 数据未动；恢复需改回
  system 并重启）；
- 模拟器 `-prop` 只接受 `qemu.*`，因此 root 属性不走命令行，而是启动后 `adb root` +
  机内配置并写入快照；若要真正修改 build.prop，需要 `-writable-system` 冷启动后 remount，
  当前未启用（会改变快照配置）。


## 8. 演进路线

1. 已落地：scrcpy H.264 → `/apk-vm/ws` → `VideoDecoder` canvas（60fps）、多客户端 keyframe、
   旋转重配；后续可加 scrcpy 控制通道（触摸/键盘直连）进一步降低输入延迟；
2. 物理 adb 设备的运行时切换（当前支持配置 `serial` 附加；UI/路由切换待补）；
3. 音频转发（scrcpy audio socket + WebAudio）与录屏回放/自动断言；
4. 预置 ATD/更小镜像与冷启动压测（当前以 cold boot → snapshot → quick-boot 为主，目标是
   首次冷启动也压到 30s 内；ATD 镜像可作为可选 `avdName`）；
5. 用 `-writable-system` + `adb remount` 真正修改 `/system/build.prop`（把 adbd 默认 root、
   `persist.sys.usb.config` 写进镜像），并重新生成基准快照；
6. QEMU + Android-x86 后端适配器（无硬件虚拟化的 Windows/Linux 通用方案）与静态 APK
   预览（不启 VM 先看图标/manifest/权限）。
