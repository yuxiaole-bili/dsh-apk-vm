/**
 * dsh-apk-vm — Web client half (static DSH web plugin, no bundler).
 *
 * Registers:
 *   - a `main` panel (key `apk-vm`) that renders the APK-VM console: header with
 *     state pill + Start/Stop/Refresh, a left column (scanned APK list, manual
 *     path install, VM log/diagnostics, boot hint), and a live phone frame with
 *     tap/swipe/wheel/key/text input;
 *   - a `sidebar.panellist` entry (id `apk-vm`, order 30) with the phone glyph.
 *
 * Everything talks to the Host half over same-origin HTTP under /apk-vm/:
 *   GET  /apk-vm/state   GET /apk-vm/apks        POST /apk-vm/vm
 *   POST /apk-vm/install GET /apk-vm/frame?t=..  POST /apk-vm/input
 *
 * Only `require('react')` is used; styling goes through host theme tokens
 * (var(--dsw-alias-*)) so the panel follows the active Harness theme. Every
 * network/JSON access is guarded so a failing Host route degrades to an inline
 * banner instead of blanking the slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-apk-vm',
  factory: function (require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    var NS = 'apk-vm';
    var VM_STATES = ['stopped', 'starting', 'booting', 'ready', 'error'];
    var SWIPE_THRESHOLD_PX = 24;
    var FRAME_INTERVAL_MS = 500;
    var STATE_INTERVAL_MS = 2000;
    var CLIENT_VERSION = '0.2.1';

    /* ------------------------------------------------------------------ *
     * Optional dsh-better-sidebar integration.
     *
     * The ecosystem plugin publishes `ctx.betterSidebar` (registerTab /
     * registerFileViewer / openTab / getSnapshot). We do NOT hard-inject it,
     * because this plugin must keep working on a standalone DSH; instead we
     * wait for the service with ctx.inject at apply time. When it appears we
     * register one real tab type (`apk-vm:preview`) exactly like a first-party
     * tab, so it shows up in the native right Sidebar's + menu / guide and in
     * the bottom workbench, and the main panel gets an "Open in side bar"
     * action. Everything degrades to the plain `main` panel without it.
     * ------------------------------------------------------------------ */

    var BETTER_SIDEBAR_TAB_ID = 'apk-vm:preview';
    var betterSidebar = null;
    var betterSidebarListeners = [];

    function getBetterSidebar() {
      return betterSidebar;
    }

    function publishBetterSidebar(next) {
      if (betterSidebar === next) return;
      betterSidebar = next;
      var listeners = betterSidebarListeners.slice();
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](next);
        } catch (error) {
          /* a listener must never break the registry */
        }
      }
    }

    function subscribeBetterSidebar(listener) {
      if (typeof listener !== 'function') return function () {};
      betterSidebarListeners.push(listener);
      return function () {
        var at = betterSidebarListeners.indexOf(listener);
        if (at >= 0) betterSidebarListeners.splice(at, 1);
      };
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionaries (flat dotted keys; placeholders use {name}).
     * ------------------------------------------------------------------ */

    var EN = {
      'nav.label': 'APK VM',
      'title': 'APK Virtual Machine',
      'subtitle': 'Boot a local open-source Android VM, install an APK, and preview its screen.',
      'apk.current': 'Current APK: {name}',
      'state.loading': 'Connecting…',
      'state.stopped': 'Stopped',
      'state.starting': 'Starting',
      'state.booting': 'Booting',
      'state.ready': 'Ready',
      'state.error': 'Error',
      'pill.boot': 'boot {s}s',
      'pill.snapshot': 'quick {s}s',
      'pill.cold': 'cold {s}s',
      'action.start': 'Start VM',
      'action.starting': 'Starting…',
      'action.stop': 'Stop',
      'action.stopping': 'Stopping…',
      'action.restart': 'Restart',
      'action.refresh': 'Refresh',
      'action.rescan': 'Rescan',
      'action.installLaunch': 'Install & launch',
      'action.dismiss': 'Dismiss',
      'action.openSidebar': 'Open in side bar',
      'a11y.refresh': 'Refresh VM state',
      'a11y.retry': 'Retry the request',
      'a11y.openSidebar': 'Open the APK VM in dsh-better-sidebar',
      'sidebar.tab': 'APK VM',
      'sidebar.desc': 'Boot the open-source Android VM and preview an APK in the side panel.',
      'sidebar.opened': 'Opened the APK VM in the side bar',
      'sidebar.noSession': 'Open a conversation first: the side bar is session-scoped.',
      'sidebar.unavailable': 'dsh-better-sidebar is not installed or not ready',
      'apks.title': 'APK files',
      'apks.count': '{n} found',
      'apks.scanning': 'Scanning…',
      'upload.button': 'Upload APK',
      'upload.drop': 'Drop APK to install',
      'upload.detail': 'Installs into the local emulator and launches it.',
      'upload.uploading': 'Uploading {name}…',
      'upload.invalid': 'Please choose an .apk, .apks or .xapk package',
      'upload.failed': 'Upload/install failed',
      'upload.done': 'Installed {name}',
      'apks.empty': 'No APK files found in the scan roots.',
      'apks.roots': 'Scan roots: {roots}',
      'apks.installing': 'Installing…',
      'manual.title': 'Install from path',
      'manual.placeholder': '/absolute/path/to/app.apk',
      'manual.hint': 'Absolute APK file path on this machine.',
      'log.title': 'VM log',
      'log.waiting': 'Waiting for VM output…',
      'hint.boot': 'An x86_64 Android image needs CPU hardware acceleration (AEHD/WHPX). If booting does not finish, enable it and restart Windows once; the plugin then saves a quick-boot snapshot so later starts stay under 30 s.',
      'hint.short': 'Android 14 · x86_64 · AEHD · H.264 60 fps',
      'overlay.connecting': 'Connecting to the VM service…',
      'overlay.stopped': 'The virtual machine is not running',
      'overlay.startedHint': 'Start the VM, then install an APK from the list on the left.',
      'overlay.booting': 'Booting the Android VM…',
      'overlay.bootingHint': 'If this stays here for minutes, CPU hardware acceleration is missing: enable AEHD/WHPX (or attach an adb device) and restart Windows once. Quick-boot snapshots then make later starts fast.',
      'overlay.error': 'The virtual machine hit an error',
      'overlay.waitingFrame': 'Waiting for the first screen frame…',
      'overlay.retry': 'Try again',
      'screen.alt': 'Android device screen',
      'screen.hint': 'Click to tap · drag to swipe · wheel to scroll · two fingers pinch (H.264) · click then type for the device keyboard',
      'keys.back': 'Back',
      'keys.home': 'Home',
      'keys.recents': 'Recents',
      'keys.power': 'Power',
      'input.placeholder': 'Text to type on the device…',
      'input.send': 'Send',
      'debug.title': 'Rooted debug',
      'debug.state.root': 'root',
      'debug.state.shell': 'shell',
      'debug.placeholder': 'adb shell command (runs as root)…',
      'debug.run': 'Run',
      'debug.logcat': 'Logcat',
      'debug.live': 'Live logcat',
      'debug.liveStop': 'Stop live',
      'debug.crash': 'Crash log',
      'debug.clipboardSet': 'Copy field to device',
      'debug.clipboardGet': 'Get device clipboard',
      'debug.clipboardEmpty': 'Type text in the input field first',
      'debug.clipboardSetDone': 'Device clipboard updated',
      'debug.clipboardGot': 'Device clipboard copied to host',
      'debug.props': 'Props',
      'debug.rootAction': 'Root',
      'debug.ui': 'UI tree',
      'debug.perf': 'Perf',
      'debug.record': 'Record 5s',
      'debug.rotate': 'Rotate',
      'debug.screenshot': 'Screenshot',
      'debug.recording': 'Recording 5s…',
      'inspect.toggle': 'Inspect UI',
      'inspect.title': 'UI inspector',
      'inspect.loading': 'Reading UI tree…',
      'inspect.empty': 'No visible UI nodes',
      'inspect.hint': 'Click a highlighted node to generate an apk_vm command.',
      'inspect.selected': 'Selected',
      'inspect.copyTap': 'Copy tap_text',
      'inspect.copyAssert': 'Copy assert_text',
      'inspect.copied': 'Command copied',
      'inspect.refresh': 'Refresh tree',
      'inspect.close': 'Close inspector',
      'network.title': 'Network',
      'network.proxy': 'HTTP proxy',
      'network.host': 'Proxy host',
      'network.port': 'Port',
      'network.apply': 'Apply proxy',
      'network.clear': 'Clear proxy',
      'network.caPath': 'CA certificate path (.pem/.crt)',
      'network.installCa': 'Install CA',
      'network.current': 'Current: {value}',
      'network.forwards': 'Port forwards',
      'network.forwardLocal': 'Host port',
      'network.forwardRemote': 'Guest port',
      'network.addForward': 'Add forward',
      'network.remove': 'Remove',
      'network.mode': 'Mode',
      'network.isolated': 'Isolated',
      'network.shared': 'Shared (host bridge)',
      'network.dns': 'DNS servers',
      'network.applyDns': 'Apply DNS',
      'network.hosts': 'Hosts entries',
      'network.applyHosts': 'Apply hosts',
      'network.test': 'Test connectivity',
      'network.testOk': 'Connectivity OK',
      'network.testFail': 'Connectivity check failed',
      'network.pcap': 'Download pcap',
      'network.pcapPath': 'Host pcap path (.pcap, next start)',
      'network.restartRequired': 'Restart the VM to apply custom DNS',
      'network.sharedHint': 'Shared forwards are reachable from other VMs through the emulator host alias.',
      'network.guestUrl': 'Guest URL: {url}',
      'flow.title': 'Flow recorder',
      'flow.start': 'Record',
      'flow.stop': 'Stop',
      'flow.name': 'Flow name',
      'flow.play': 'Play',
      'flow.delete': 'Delete',
      'flow.empty': 'No saved flows',
      'flow.recording': 'Recording input…',
      'flow.saved': 'Saved {name}',
      'flow.done': 'Replayed {name}',
      'flow.count': '{n} step(s)',
      'storage.title': 'Storage',
      'storage.refresh': 'Refresh',
      'storage.cleanTemp': 'Clean temp',
      'storage.cleanSnapshots': 'Clean snapshots',
      'storage.cleanOrphans': 'Clean orphan AVDs',
      'storage.confirm': 'Click again to confirm',
      'storage.freed': 'Freed {size}',
      'storage.avds': '{size} AVDs',
      'storage.snapshots': 'Snapshots',
      'storage.sdk': 'SDK',
      'storage.temp': 'Temp',
      'storage.free': 'Free disk',
      'storage.active': 'active',
      'storage.orphan': 'orphan',
      'storage.empty': 'No AVDs found',
      'apk.bundle': 'Bundle',
      'setup.title': 'Environment',
      'setup.ok': 'Ready',
      'setup.missing': 'Setup needed',
      'setup.sdk': 'SDK',
      'setup.accel': 'Acceleration',
      'setup.avd': 'AVD',
      'setup.image': 'System image',
      'setup.createAvd': 'Create AVD',
      'setup.installImage': 'Download image',
      'setup.installTools': 'Install SDK tools',
      'setup.bootstrapSdk': 'Bootstrap SDK',
      'setup.refresh': 'Re-check',
      'setup.switch': 'Switch AVD',
      'setup.loading': 'Checking environment…',
      'setup.downloadsDisabled': 'Automatic system-image download is disabled (allowSetupDownloads).',
      'instances.label': 'VM instance',
      'instances.default': 'default',
      'instances.new': 'New VM',
      'instances.delete': 'Destroy VM',
      'instances.created': 'Created instance {id}',
      'instances.destroyed': 'Destroyed instance {id}',
      'instances.manage': 'VM instances',
      'instances.stop': 'Stop',
      'instances.stopped': 'Stopped instance {id}',
      'instances.idle': 'idle {seconds}s',
      'devices.title': 'Physical/remote adb device',
      'devices.select': 'Select device…',
      'devices.attach': 'Attach',
      'devices.detach': 'Detach',
      'devices.attached': 'Attached {serial}',
      'devices.detached': 'Detached external device',
      'devices.current': 'External device: {serial}',
      'apps.title': 'Installed apps',
      'apps.refresh': 'Refresh',
      'apps.loading': 'Loading…',
      'apps.empty': 'No third-party apps installed.',
      'apps.thirdParty': 'third-party only',
      'apps.stop': 'Stop',
      'apps.clear': 'Clear data',
      'apps.uninstall': 'Uninstall',
      'apps.done': '{action}: {packageName}',
      'debug.empty': 'No debug output yet.',
      'debug.identity': '{release} · API {sdk} · {abi}',
      'debug.busy': 'Running…',
      'fps.label': 'FPS',
      'fps.actual': '{fps} fps',
      'fps.target': 'Target FPS',
      'fps.mode.h264': 'H.264',
      'fps.mode.png': 'PNG',
      'fps.fallbackHint': 'H.264 is unavailable in this WebView; using the PNG fallback (~1–2 fps).',
      'fps.hint': 'Preview frame rate. With WebCodecs H.264 streaming this reaches up to 60 fps; the PNG fallback is capped by adb screencap (~2 fps). ',
      'stream.error': 'H.264 stream error',
      'stream.h264': 'H.264 · max {fps} fps',
      'tag.installed': 'installed',
      'tag.launched': 'launched',
      'toast.started': 'Start command sent.',
      'toast.stopped': 'Stop command sent.',
      'toast.restarted': 'Restart command sent.',
      'toast.installed': 'Installed {name}.',
      'toast.installedLaunched': 'Installed and launched {name}.',
      'err.state': 'Cannot read VM state',
      'err.apks': 'Cannot list APK files',
      'err.install': 'Install failed',
      'err.input': 'Device input failed',
      'err.action': 'VM action failed',
      'err.frame': 'Cannot read the device screen',
      'err.frameEmpty': 'The device returned an empty screen frame',
      'err.pathEmpty': 'Enter an APK path first.',
      'err.render': 'The APK VM panel failed to render.',
      'err.http': 'HTTP {status}',
      'err.badJson': 'The server returned invalid JSON',
      'err.request': 'The request failed',
      'err.noFetch': 'Network requests are unavailable',
      'err.noObjectUrl': 'Image object URLs are unavailable',
    };

    var ZH = {
      'nav.label': 'APK 虚拟机',
      'title': 'APK 虚拟机',
      'subtitle': '启动本地开源 Android 虚拟机，安装 APK 并在此预览屏幕。',
      'apk.current': '当前 APK：{name}',
      'state.loading': '连接中…',
      'state.stopped': '已停止',
      'state.starting': '启动中',
      'state.booting': '开机中',
      'state.ready': '已就绪',
      'state.error': '出错',
      'pill.boot': '启动用时 {s} 秒',
      'pill.snapshot': '快照启动 {s} 秒',
      'pill.cold': '冷启动 {s} 秒',
      'action.start': '启动虚拟机',
      'action.starting': '正在启动…',
      'action.stop': '停止',
      'action.stopping': '正在停止…',
      'action.restart': '重启',
      'action.refresh': '刷新',
      'action.rescan': '重新扫描',
      'action.installLaunch': '安装并启动',
      'action.dismiss': '关闭',
      'action.openSidebar': '在侧栏打开',
      'a11y.refresh': '刷新虚拟机状态',
      'a11y.retry': '重试请求',
      'a11y.openSidebar': '在 dsh-better-sidebar 中打开 APK 虚拟机',
      'sidebar.tab': 'APK 虚拟机',
      'sidebar.desc': '在侧边栏中启动开源 Android 虚拟机并预览 APK。',
      'sidebar.opened': '已在侧栏打开 APK 虚拟机',
      'sidebar.noSession': '请先打开一个会话：侧栏是按会话隔离的。',
      'sidebar.unavailable': '未检测到 dsh-better-sidebar 或服务未就绪',
      'apks.title': 'APK 文件',
      'apks.count': '共 {n} 个',
      'apks.scanning': '扫描中…',
      'upload.button': '上传 APK',
      'upload.drop': '松开以安装 APK',
      'upload.detail': '上传后自动安装到本地模拟器并启动。',
      'upload.uploading': '正在上传 {name}…',
      'upload.invalid': '请选择 .apk、.apks 或 .xapk 安装包',
      'upload.failed': '上传/安装失败',
      'upload.done': '已安装 {name}',
      'apks.empty': '扫描目录中没有找到 APK 文件。',
      'apks.roots': '扫描目录：{roots}',
      'apks.installing': '安装中…',
      'manual.title': '按路径安装',
      'manual.placeholder': '/绝对路径/app.apk',
      'manual.hint': '本机 APK 文件的绝对路径。',
      'log.title': '虚拟机日志',
      'log.waiting': '等待虚拟机输出…',
      'hint.boot': 'x86_64 Android 镜像需要 CPU 硬件加速（AEHD/WHPX）。若长时间停在“正在开机”，请启用硬件加速并重启一次 Windows；之后插件会把冷启动保存为快照，后续启动保持在 30 秒内。',
      'hint.short': 'Android 14 · x86_64 · AEHD · H.264 60fps',
      'overlay.connecting': '正在连接虚拟机服务…',
      'overlay.stopped': '虚拟机尚未运行',
      'overlay.startedHint': '启动虚拟机后，即可从左侧列表安装 APK。',
      'overlay.booting': 'Android 虚拟机正在开机…',
      'overlay.bootingHint': '若长时间停留在此，说明缺少 CPU 硬件加速：请启用 AEHD/WHPX（或接入 adb 设备）并重启一次 Windows；之后快照启动会很快。',
      'overlay.error': '虚拟机出现错误',
      'overlay.waitingFrame': '正在等待第一帧画面…',
      'overlay.retry': '重试',
      'screen.alt': 'Android 设备屏幕',
      'screen.hint': '单击 = 点按 · 拖动 = 滑动 · 滚轮 = 滚动 · 双指缩放（H.264）· 点按后可直接键盘输入',
      'keys.back': '返回',
      'keys.home': '主页',
      'keys.recents': '多任务',
      'keys.power': '电源',
      'input.placeholder': '输入要发送到设备的文本…',
      'input.send': '发送',
      'debug.title': 'Root 调试',
      'debug.state.root': 'root',
      'debug.state.shell': 'shell',
      'debug.placeholder': 'adb shell 命令（以 root 执行）…',
      'debug.run': '执行',
      'debug.logcat': '日志',
      'debug.live': '实时日志',
      'debug.liveStop': '停止实时',
      'debug.crash': '崩溃日志',
      'debug.clipboardSet': '文本写入设备剪贴板',
      'debug.clipboardGet': '读取设备剪贴板',
      'debug.clipboardEmpty': '请先在上方输入框输入文本',
      'debug.clipboardSetDone': '已写入设备剪贴板',
      'debug.clipboardGot': '已复制设备剪贴板到主机',
      'debug.props': '属性',
      'debug.rootAction': '提权',
      'debug.ui': 'UI 树',
      'debug.perf': '性能',
      'debug.record': '录屏 5s',
      'debug.rotate': '旋转',
      'debug.screenshot': '截图',
      'debug.recording': '正在录屏 5s…',
      'inspect.toggle': '检查 UI',
      'inspect.title': 'UI 检查器',
      'inspect.loading': '正在读取 UI 树…',
      'inspect.empty': '没有可见 UI 节点',
      'inspect.hint': '点击高亮节点，生成可用的 apk_vm 命令。',
      'inspect.selected': '已选择',
      'inspect.copyTap': '复制 tap_text',
      'inspect.copyAssert': '复制 assert_text',
      'inspect.copied': '命令已复制',
      'inspect.refresh': '刷新 UI 树',
      'inspect.close': '关闭检查器',
      'network.title': '网络',
      'network.proxy': 'HTTP 代理',
      'network.host': '代理主机',
      'network.port': '端口',
      'network.apply': '应用代理',
      'network.clear': '清除代理',
      'network.caPath': 'CA 证书路径（.pem/.crt）',
      'network.installCa': '安装 CA',
      'network.current': '当前：{value}',
      'network.forwards': '端口转发',
      'network.forwardLocal': '宿主机端口',
      'network.forwardRemote': 'Guest 端口',
      'network.addForward': '添加转发',
      'network.remove': '删除',
      'network.mode': '模式',
      'network.isolated': '隔离',
      'network.shared': '共享（宿主桥接）',
      'network.dns': 'DNS 服务器',
      'network.applyDns': '应用 DNS',
      'network.hosts': 'Hosts 条目',
      'network.applyHosts': '应用 Hosts',
      'network.test': '测试连通性',
      'network.testOk': '连通性正常',
      'network.testFail': '连通性检查失败',
      'network.pcap': '下载 pcap',
      'network.pcapPath': '宿主机 pcap 路径（.pcap，下次启动）',
      'network.restartRequired': '重启虚拟机后生效自定义 DNS',
      'network.sharedHint': '共享转发可被其他 VM 通过模拟器宿主别名访问。',
      'network.guestUrl': 'Guest URL: {url}',
      'flow.title': '操作录制',
      'flow.start': '录制',
      'flow.stop': '停止',
      'flow.name': '流程名称',
      'flow.play': '回放',
      'flow.delete': '删除',
      'flow.empty': '还没有录制的流程',
      'flow.recording': '正在录制输入…',
      'flow.saved': '已保存 {name}',
      'flow.done': '已回放 {name}',
      'flow.count': '{n} 步',
      'storage.title': '存储',
      'storage.refresh': '刷新',
      'storage.cleanTemp': '清理临时文件',
      'storage.cleanSnapshots': '清理快照',
      'storage.cleanOrphans': '清理孤立 AVD',
      'storage.confirm': '再点一次确认',
      'storage.freed': '已释放 {size}',
      'storage.avds': '{size} 个 AVD',
      'storage.snapshots': '快照',
      'storage.sdk': 'SDK',
      'storage.temp': '临时文件',
      'storage.free': '磁盘剩余',
      'storage.active': '运行中',
      'storage.orphan': '孤立',
      'storage.empty': '没有找到 AVD',
      'apk.bundle': '安装包',
      'setup.title': '环境',
      'setup.ok': '就绪',
      'setup.missing': '需要配置',
      'setup.sdk': 'SDK',
      'setup.accel': '硬件加速',
      'setup.avd': 'AVD',
      'setup.image': '系统镜像',
      'setup.createAvd': '创建 AVD',
      'setup.installImage': '下载镜像',
      'setup.installTools': '安装 SDK 工具',
      'setup.bootstrapSdk': '从零安装 SDK',
      'setup.refresh': '重新检测',
      'setup.switch': '切换 AVD',
      'setup.loading': '正在检测环境…',
      'setup.downloadsDisabled': '自动下载系统镜像已禁用（allowSetupDownloads）。',
      'instances.label': '虚拟机实例',
      'instances.default': '默认',
      'instances.new': '新建虚拟机',
      'instances.delete': '销毁虚拟机',
      'instances.created': '已创建实例 {id}',
      'instances.destroyed': '已销毁实例 {id}',
      'instances.manage': '虚拟机实例',
      'instances.stop': '停止',
      'instances.stopped': '已停止实例 {id}',
      'instances.idle': '空闲 {seconds}s',
      'devices.title': '物理/远程 adb 设备',
      'devices.select': '选择设备…',
      'devices.attach': '连接',
      'devices.detach': '断开',
      'devices.attached': '已连接 {serial}',
      'devices.detached': '已断开外部设备',
      'devices.current': '外部设备：{serial}',
      'apps.title': '已安装应用',
      'apps.refresh': '刷新',
      'apps.loading': '加载中…',
      'apps.empty': '没有已安装的第三方应用。',
      'apps.thirdParty': '仅第三方',
      'apps.stop': '停止',
      'apps.clear': '清数据',
      'apps.uninstall': '卸载',
      'apps.done': '{action}：{packageName}',
      'debug.empty': '暂无调试输出。',
      'debug.identity': '{release} · API {sdk} · {abi}',
      'debug.busy': '执行中…',
      'fps.label': '帧率',
      'fps.actual': '{fps} fps',
      'fps.target': '目标帧率',
      'fps.mode.h264': 'H.264',
      'fps.mode.png': 'PNG',
      'fps.fallbackHint': '当前 WebView 不支持 H.264，使用 PNG 回退（约 1–2 fps）。',
      'fps.hint': '预览帧率。WebCodecs H.264 串流最高可达 60 fps；PNG 回退受 adb screencap 限制（约 2 fps）。',
      'stream.error': 'H.264 串流错误',
      'stream.h264': 'H.264 · 最高 {fps} fps',
      'tag.installed': '已安装',
      'tag.launched': '已启动',
      'toast.started': '已发送启动指令。',
      'toast.stopped': '已发送停止指令。',
      'toast.restarted': '已发送重启指令。',
      'toast.installed': '已安装 {name}。',
      'toast.installedLaunched': '已安装并启动 {name}。',
      'err.state': '无法读取虚拟机状态',
      'err.apks': '无法列出 APK 文件',
      'err.install': '安装失败',
      'err.input': '设备输入失败',
      'err.action': '虚拟机操作失败',
      'err.frame': '无法读取设备画面',
      'err.frameEmpty': '设备画面数据为空',
      'err.pathEmpty': '请先输入 APK 路径。',
      'err.render': 'APK 虚拟机面板渲染失败。',
      'err.http': 'HTTP {status}',
      'err.badJson': '服务器返回的 JSON 无效',
      'err.request': '请求失败',
      'err.noFetch': '当前环境无法发起网络请求',
      'err.noObjectUrl': '当前环境无法创建图片对象地址',
    };

    /* ------------------------------------------------------------------ *
     * Small utilities (defensive: none of these may throw to the caller).
     * ------------------------------------------------------------------ */

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function interpolate(template, vars) {
      var text = String(template);
      if (!vars) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return hasOwn(vars, name) ? String(vars[name]) : match;
      });
    }

    /** Wrap a locale `t` so a missing/throwing translation falls back to English. */
    function createTranslator(translate) {
      return function T(key, vars) {
        var out = null;
        if (typeof translate === 'function') {
          try {
            out = translate(key, vars);
          } catch (error) {
            out = null;
          }
        }
        if (typeof out !== 'string' || out === '') {
          out = hasOwn(EN, key) && typeof EN[key] === 'string' ? EN[key] : String(key);
        }
        return vars ? interpolate(out, vars) : out;
      };
    }

    function clamp(value, minValue, maxValue) {
      var n = Number(value);
      if (!isFinite(n)) return minValue;
      if (n < minValue) return minValue;
      if (n > maxValue) return maxValue;
      return n;
    }

    function formatBytes(value) {
      var n = Number(value);
      if (!isFinite(n) || n <= 0) return '—';
      if (n < 1024) return Math.round(n) + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var size = n / 1024;
      var unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      var rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
      return rounded + ' ' + units[unit];
    }

    function baseName(filePath) {
      var parts = String(filePath == null ? '' : filePath).split(/[\\/]/);
      for (var i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i]) return parts[i];
      }
      return String(filePath == null ? '' : filePath);
    }

    function revokeObjectUrl(url) {
      if (!url) return;
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        /* ignore — a leaked object URL must never break the panel */
      }
    }

    /* ------------------------------------------------------------------ *
     * HTTP helpers. Every call resolves to {ok, status, error, data}; none
     * reject, so a dead Host route only produces an inline error banner.
     * ------------------------------------------------------------------ */

    function requestJson(url, options, T) {
      var tr = typeof T === 'function' ? T : createTranslator(null);
      var opts = isObject(options) ? options : {};
      if (typeof fetch !== 'function') {
        return Promise.resolve({ ok: false, status: 0, error: tr('err.noFetch'), data: null });
      }
      var init = { method: opts.method ? String(opts.method).toUpperCase() : 'GET', cache: 'no-store' };
      if (opts.body !== undefined) {
        init.body = opts.body;
        init.headers = { 'content-type': 'application/json' };
      }
      return fetch(url, init)
        .then(function (response) {
          return response.text().then(function (text) {
            var data = null;
            var parseFailed = false;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (error) {
                parseFailed = true;
              }
            }
            if (!response.ok) {
              var message = '';
              if (isObject(data)) {
                if (typeof data.error === 'string' && data.error) message = data.error;
                else if (typeof data.message === 'string' && data.message) message = data.message;
              }
              return {
                ok: false,
                status: response.status,
                error: message || tr('err.http', { status: response.status }),
                data: data,
              };
            }
            if (parseFailed) {
              return { ok: false, status: response.status, error: tr('err.badJson'), data: null };
            }
            if (isObject(data) && data.ok === false) {
              var reason = typeof data.error === 'string' && data.error ? data.error : tr('err.request');
              return { ok: false, status: response.status, error: reason, data: data };
            }
            return { ok: true, status: response.status, error: '', data: data || {} };
          });
        })
        .catch(function (error) {
          var message = error && error.message ? error.message : String(error);
          return { ok: false, status: 0, error: message, data: null };
        });
    }

    /** Fetch one device frame as an object URL; resolves to {url, error}. */
    function requestFrame(T, framePath) {
      var tr = typeof T === 'function' ? T : createTranslator(null);
      if (typeof fetch !== 'function') {
        return Promise.resolve({ url: '', error: tr('err.noFetch') });
      }
      return fetch(framePath || ('/apk-vm/frame?t=' + Date.now()), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) {
            return response.text().then(function (text) {
              var message = '';
              if (text) {
                try {
                  var data = JSON.parse(text);
                  if (isObject(data)) {
                    if (typeof data.error === 'string') message = data.error;
                    else if (typeof data.message === 'string') message = data.message;
                  }
                } catch (error) {
                  message = '';
                }
              }
              return { url: '', error: message || tr('err.http', { status: response.status }) };
            });
          }
          return response.blob().then(function (blob) {
            if (!blob || !blob.size) return { url: '', error: tr('err.frameEmpty') };
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
              return { url: '', error: tr('err.noObjectUrl') };
            }
            return { url: URL.createObjectURL(blob), error: '' };
          });
        })
        .catch(function (error) {
          return { url: '', error: error && error.message ? error.message : String(error) };
        });
    }

    /* ------------------------------------------------------------------ *
     * /apk-vm/state and /apk-vm/apks payload normalization.
     * ------------------------------------------------------------------ */

    function normalizeState(raw) {
      var data = isObject(raw) ? raw : {};
      var vmRaw = isObject(data.vm) ? data.vm : {};
      var state = typeof vmRaw.state === 'string' ? vmRaw.state : 'stopped';
      if (VM_STATES.indexOf(state) < 0) state = 'stopped';

      var logRaw = Array.isArray(vmRaw.logTail) ? vmRaw.logTail : [];
      var logTail = [];
      for (var i = 0; i < logRaw.length; i += 1) {
        var line = logRaw[i];
        if (typeof line === 'string') logTail.push(line);
        else if (line !== null && line !== undefined) logTail.push(String(line));
      }
      if (logTail.length > 160) logTail = logTail.slice(logTail.length - 160);

      var screen = null;
      if (isObject(data.screen)) {
        var width = Number(data.screen.width);
        var height = Number(data.screen.height);
        if (isFinite(width) && isFinite(height) && width > 0 && height > 0) {
          screen = { width: Math.round(width), height: Math.round(height) };
        }
      }

      var apk = null;
      if (isObject(data.apk)) {
        apk = {
          path: typeof data.apk.path === 'string' ? data.apk.path : '',
          packageName: typeof data.apk.packageName === 'string' ? data.apk.packageName : '',
          label: typeof data.apk.label === 'string' ? data.apk.label : '',
          launched: data.apk.launched === true,
        };
      }

      var bootMs = Number(vmRaw.bootMs);
      return {
        vm: {
          state: state,
          serial: typeof vmRaw.serial === 'string' ? vmRaw.serial : '',
          avd: typeof vmRaw.avd === 'string' ? vmRaw.avd : '',
          bootMs: isFinite(bootMs) && bootMs > 0 ? Math.round(bootMs) : 0,
          error: typeof vmRaw.error === 'string' ? vmRaw.error : '',
          external: vmRaw.external === true,
          externalSerial: typeof vmRaw.externalSerial === 'string' ? vmRaw.externalSerial : '',
          managedAvd: typeof vmRaw.managedAvd === 'string' ? vmRaw.managedAvd : '',
          logTail: logTail,
        },
        screen: screen,
        apk: apk,
        client: isObject(data.client) ? data.client : null,
        origin: typeof data.origin === 'string' && data.origin ? data.origin : '',
      };
    }

    function normalizeApkList(raw) {
      var data = isObject(raw) ? raw : {};
      var roots = [];
      var rootsRaw = Array.isArray(data.roots) ? data.roots : [];
      for (var i = 0; i < rootsRaw.length; i += 1) {
        if (typeof rootsRaw[i] === 'string' && rootsRaw[i]) roots.push(rootsRaw[i]);
      }
      var apks = [];
      var apksRaw = Array.isArray(data.apks) ? data.apks : [];
      for (var j = 0; j < apksRaw.length; j += 1) {
        var item = apksRaw[j];
        if (!isObject(item) || typeof item.path !== 'string' || !item.path) continue;
        apks.push({
          path: item.path,
          name: typeof item.name === 'string' && item.name ? item.name : baseName(item.path),
          size: Number(item.size),
          mtime: Number(item.mtime),
          kind: typeof item.kind === 'string' ? item.kind : String(item.name || '').split('.').pop(),
        });
      }
      return { roots: roots, apks: apks };
    }

    /* ------------------------------------------------------------------ *
     * Inline SVG glyphs (stroke = currentColor, so the host theme colors
     * every icon and the icon artwork stays token-free).
     * ------------------------------------------------------------------ */

    function svgIcon(size, children) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        children
      );
    }

    function PhoneIcon(props) {
      var size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('rect', { key: 'body', x: 6.25, y: 2.25, width: 11.5, height: 19.5, rx: 2.75 }),
        h('path', { key: 'speaker', d: 'M10.25 4.9h3.5' }),
        h('circle', { key: 'eye-l', cx: 9.9, cy: 9.8, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'eye-r', cx: 14.1, cy: 9.8, r: 0.85, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'mouth', d: 'M9.6 13.1c.55.9 1.4 1.35 2.4 1.35s1.85-.45 2.4-1.35' }),
        h('path', { key: 'base', d: 'M9.4 19.2h5.2' })
      );
    }

    function IconBack(props) {
      return svgIcon(props && props.size ? props.size : 14, h('path', { d: 'M15 5l-7 7 7 7' }));
    }

    function IconHome(props) {
      return svgIcon(
        props && props.size ? props.size : 14,
        [
          h('path', { key: 'roof', d: 'M4 11.5 12 4l8 7.5' }),
          h('path', { key: 'house', d: 'M6.5 10v9.5h11V10' }),
        ]
      );
    }

    function IconRecents(props) {
      return svgIcon(props && props.size ? props.size : 14, h('rect', { x: 4.5, y: 4.5, width: 15, height: 15, rx: 2.5 }));
    }

    function IconPower(props) {
      return svgIcon(
        props && props.size ? props.size : 14,
        [
          h('path', { key: 'stem', d: 'M12 3.5v8' }),
          h('path', { key: 'ring', d: 'M7.4 6.5a7 7 0 1 0 9.2 0' }),
        ]
      );
    }

    function IconRefresh(props) {
      return svgIcon(
        props && props.size ? props.size : 14,
        [
          h('path', { key: 'arc', d: 'M20 12a8 8 0 1 1-2.35-5.65' }),
          h('path', { key: 'arrow', d: 'M20 4v5h-5' }),
        ]
      );
    }

    /* ------------------------------------------------------------------ *
     * Component styles. Colors come exclusively from the host theme tokens
     * (bg-base / bg-layer-1/2, border-l1/l2, label-primary/secondary,
     * brand-primary, state-*-primary) — no literal palette colors.
     * ------------------------------------------------------------------ */

    var CSS_TEXT =
      '.apkvm-page{box-sizing:border-box;position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}' +
      '.apkvm-page *,.apkvm-page *::before,.apkvm-page *::after{box-sizing:border-box}' +
      '.apkvm-header{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}' +
      '.apkvm-headicon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}' +
      '.apkvm-title{font-size:16px;font-weight:600;line-height:21px;margin:0;white-space:nowrap}' +
      '.apkvm-subtitle{font-size:11.5px;line-height:16px;margin:1px 0 0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(46vw,560px)}' +
      '.apkvm-spacer{flex:1 1 auto;min-width:8px}' +
      '.apkvm-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;flex:none}' +
      '.apkvm-pillmeta{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;max-width:220px;overflow:hidden;text-overflow:ellipsis}' +
      '.apkvm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}' +
      '.apkvm-dot.ready{background:var(--dsw-alias-state-success-primary)}' +
      '.apkvm-dot.starting,.apkvm-dot.booting{background:var(--dsw-alias-state-warn-primary)}' +
      '.apkvm-dot.error{background:var(--dsw-alias-state-error-primary)}' +
      '.apkvm-dot.loading{background:var(--dsw-alias-state-idle-primary)}' +
      '.apkvm-btn{flex:none;appearance:none;font:inherit;font-size:12px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;user-select:none;transition:border-color .12s ease,background .12s ease,color .12s ease}' +
      '.apkvm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}' +
      '.apkvm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      '.apkvm-btn:disabled{opacity:.5;cursor:default}' +
      '.apkvm-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base)}' +
      '.apkvm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}' +
      '.apkvm-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-base)}' +
      '.apkvm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-state-error-primary)}' +
      '.apkvm-btn-sm{height:24px;padding:0 8px;font-size:11px;border-radius:7px}' +
      '.apkvm-banner{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin:10px 20px 0;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}' +
      '.apkvm-banner.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}' +
      '.apkvm-banner.success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}' +
      '.apkvm-banner.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}' +
      '.apkvm-banner-text{flex:1 1 auto;min-width:0;word-break:break-word}' +
      '.apkvm-banner-close{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1;padding:2px 4px;cursor:pointer;border-radius:5px;opacity:.75}' +
      '.apkvm-banner-close:hover{opacity:1}' +
      '.apkvm-body{flex:1 1 auto;min-height:0;display:flex;gap:16px;padding:14px 20px 18px;overflow:hidden;align-items:stretch}' +
      '.apkvm-aside{flex:0 0 280px;width:280px;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;overflow-x:hidden;padding-right:2px}' +
      '.apkvm-card{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0}' +
      '.apkvm-cardhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}' +
      '.apkvm-card-title{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0}' +
      '.apkvm-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;max-height:min(38vh,360px);min-height:60px;padding:1px 2px 1px 1px}' +
      '.apkvm-empty{display:flex;align-items:center;gap:8px;padding:10px 4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}' +
      '.apkvm-apk{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);min-width:0}' +
      '.apkvm-apk:hover{border-color:var(--dsw-alias-border-l2)}' +
      '.apkvm-apk-name{font-size:12.5px;font-weight:500;line-height:17px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-apk-icon{width:18px;height:18px;flex:none;border-radius:4px;align-self:center;object-fit:contain}' +
      '.apkvm-dim{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-tag{flex:none;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}' +
      '.apkvm-tag.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}' +
      '.apkvm-input{font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0;width:100%;flex:1 1 auto}' +
      '.apkvm-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.85}' +
      '.apkvm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}' +
      '.apkvm-input:disabled{opacity:.55}' +
      '.apkvm-inline-error{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary);word-break:break-word;max-height:96px;overflow-y:auto}' +
      '.apkvm-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:10.5px;line-height:15px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 8px;max-height:150px;min-height:42px;overflow-y:auto}' +
      '.apkvm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);padding:0 2px;flex:none}' +
      '.apkvm-stage{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;align-items:center;gap:8px}' +
      '.apkvm-phonewrap{flex:1 1 auto;min-height:160px;min-width:0;width:100%;display:flex;align-items:stretch;justify-content:center;padding:2px 0}' +
      '.apkvm-phone{display:flex;height:100%;padding:8px;border-radius:26px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);max-width:100%;max-height:100%;min-height:0;flex:none}' +
      '.apkvm-screen{position:relative;flex:none;height:100%;max-width:100%;aspect-ratio:9/19.5;border-radius:19px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none}' +
      '.apkvm-screen.ready{cursor:crosshair}' +
      '.apkvm-inspect-layer{position:absolute;inset:0;z-index:3;overflow:hidden;pointer-events:none}' +
      '.apkvm-inspect-box{position:absolute;border:1.5px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-radius:2px;pointer-events:auto;cursor:pointer;box-sizing:border-box}' +
      '.apkvm-inspect-box:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);border-color:var(--dsw-alias-label-primary)}' +
      '.apkvm-inspect-box.selected{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 25%,transparent);border-color:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-warn-primary)}' +
      '.apkvm-inspect-box.target{border-style:dashed;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}' +
      '.apkvm-inspect-bar{position:absolute;left:8px;right:8px;bottom:8px;z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-base) 90%,transparent);backdrop-filter:blur(4px);font-size:11px}' +
      '.apkvm-inspect-label{font-weight:600;color:var(--dsw-alias-label-primary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-inspect-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap}' +
      '.apkvm-frame{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}' +
      '.apkvm-overlay{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:22px 18px;text-align:center;background:var(--dsw-alias-bg-layer-1)}' +
      '.apkvm-overlay-title{font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-word}' +
      '.apkvm-overlay-detail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-word;max-width:100%;max-height:110px;overflow-y:auto}' +
      '.apkvm-overlay-icon{color:var(--dsw-alias-label-secondary);opacity:.85;display:inline-flex}' +
      '.apkvm-spinner{width:20px;height:20px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:apkvm-spin 1s linear infinite}' +
      '.apkvm-spinner-sm{width:13px;height:13px;border-width:2px}' +
      '@keyframes apkvm-spin{to{transform:rotate(360deg)}}' +
      '.apkvm-toolbar{flex:none;display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;width:100%}' +
      '.apkvm-textrow{flex:none;display:flex;align-items:center;gap:6px;width:100%;max-width:340px}' +
      '.apkvm-stagehint{flex:none;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);text-align:center;max-width:520px}' +
      '.apkvm-stagehint.error{color:var(--dsw-alias-state-error-primary);word-break:break-word}' +
      '.apkvm-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}' +
      '.apkvm-scroll::-webkit-scrollbar{width:8px;height:8px}' +
      '.apkvm-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}' +
      '.apkvm-scroll::-webkit-scrollbar-track{background:transparent}' +
      '@media (max-width:900px){.apkvm-body{flex-direction:column;overflow-y:auto}.apkvm-aside{flex:0 0 auto;width:100%;overflow:visible}.apkvm-list{max-height:200px}.apkvm-stage{min-height:440px}.apkvm-phonewrap{min-height:340px}.apkvm-subtitle{max-width:60vw}}' +
      '@media (max-width:560px){.apkvm-header{padding:10px 12px}.apkvm-body{padding:10px 12px 14px}.apkvm-toolbar{gap:4px}}' +
      /* dsh-better-sidebar tab layout: a native side pane is narrow, so stack
         the APK list above the phone frame and keep the header compact. */
      '.apkvm-page.apkvm-embedded{height:100%;min-height:0;background:var(--dsw-alias-bg-base)}' +
      '.apkvm-embedded .apkvm-header{padding:9px 12px;gap:6px;flex-wrap:wrap}' +
      '.apkvm-embedded .apkvm-subtitle{display:none}' +
      '.apkvm-embedded .apkvm-body{flex-direction:column;overflow-y:auto;gap:8px;padding:10px 12px 14px}' +
      '.apkvm-embedded .apkvm-aside{flex:0 0 auto;width:100%;overflow:visible;padding-right:0;gap:8px}' +
      '.apkvm-embedded .apkvm-list{max-height:170px}' +
      '.apkvm-embedded .apkvm-log{max-height:110px}' +
      '.apkvm-embedded .apkvm-stage{min-height:400px;flex:0 0 auto}' +
      '.apkvm-embedded .apkvm-phonewrap{min-height:320px;padding:0}' +
      '.apkvm-embedded .apkvm-phone{padding:5px;border-radius:20px}' +
      '.apkvm-embedded .apkvm-screen{border-radius:15px}' +
      '.apkvm-embedded .apkvm-overlay{padding:16px 12px;gap:7px}' +
      /* Compact layout refresh: tighter header, APK-first aside, collapsible
         debug, phone fills the stage height, controls in one row. */
      '.apkvm-header{padding:8px 16px;gap:8px;flex-wrap:wrap}' +
      '.apkvm-headicon{width:26px;height:26px;border-radius:8px}' +
      '.apkvm-title{font-size:15px;line-height:20px}' +
      '.apkvm-subtitle{font-size:11px;line-height:15px;max-width:min(40vw,480px)}' +
      '.apkvm-pill{height:22px;padding:0 9px;font-size:11px}' +
      '.apkvm-pillmeta{max-width:300px}' +
      '.apkvm-instance-select{font:inherit;font-size:11px;height:24px;max-width:190px;padding:0 5px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);flex:none}' +
      '.apkvm-instlist{display:flex;flex-direction:column;gap:4px;padding-top:4px}' +
      '.apkvm-instrow{display:flex;align-items:center;gap:5px;font-size:11px;min-width:0}' +
      '.apkvm-instname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-instmeta{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}' +
      '.apkvm-instactions{display:flex;gap:3px;flex:none}' +
      '.apkvm-mini{font:inherit;font-size:10px;height:19px;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer}' +
      '.apkvm-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}' +
      '.apkvm-mini.danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}' +
      '.apkvm-appsbody{display:flex;flex-direction:column;gap:5px;padding-top:4px}' +
      '.apkvm-appslist{display:flex;flex-direction:column;gap:3px;max-height:180px}' +
      '.apkvm-approw{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px}' +
      '.apkvm-appname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-appactions{display:flex;gap:2px;flex:none}' +
      '.apkvm-body{gap:12px;padding:10px 14px 12px}' +
      '.apkvm-aside{flex:0 0 296px;width:296px;gap:8px;padding-right:0}' +
      '.apkvm-card{padding:8px 9px;gap:6px;border-radius:10px}' +
      '.apkvm-apkcard{flex:1 1 auto;min-height:180px}' +
      '.apkvm-apkcard .apkvm-list{flex:1 1 auto;max-height:none;min-height:80px}' +
      '.apkvm-list{max-height:none;gap:4px}' +
      '.apkvm-apk{padding:5px 7px;gap:2px}' +
      '.apkvm-apk-name{font-size:12px;line-height:16px}' +
      '.apkvm-toolsline{display:flex;align-items:center;gap:5px;min-width:0}' +
      '.apkvm-stage{flex:1 1 0;min-height:0;gap:6px;justify-content:flex-start}' +
      '.apkvm-phonewrap{flex:1 1 0;min-height:0;padding:0;align-items:center}' +
      '.apkvm-phone{height:100%;padding:6px;border-radius:22px}' +
      '.apkvm-screen{border-radius:16px}' +
      '.apkvm-controls{flex:none;display:flex;align-items:center;justify-content:center;gap:6px;width:100%;max-width:640px;flex-wrap:wrap}' +
      '.apkvm-keys{display:flex;align-items:center;gap:4px;flex:none}' +
      '.apkvm-controls .apkvm-textrow{flex:1 1 220px;width:auto;max-width:none;min-width:160px}' +
      '.apkvm-stagehint{font-size:10.5px;line-height:14px}' +
      '.apkvm-debug{padding:0;overflow:hidden}' +
      '.apkvm-debug summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;padding:8px 9px;min-height:34px}' +
      '.apkvm-debug summary::-webkit-details-marker{display:none}' +
      '.apkvm-debug summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.apkvm-debug[open] summary{border-bottom:1px solid var(--dsw-alias-border-l1)}' +
      '.apkvm-debug-body{display:flex;flex-direction:column;gap:6px;padding:8px 9px 9px}' +
      '.apkvm-chevron{color:var(--dsw-alias-label-secondary);font-size:10px;flex:none;transition:transform .15s ease}' +
      '.apkvm-debug[open] .apkvm-chevron{transform:rotate(90deg)}' +
      '.apkvm-footnote{flex:none;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary);padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.apkvm-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' +
      '.apkvm-fileinput{display:none}' +
      '.apkvm-uploadbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 6px;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary)}' +
      '.apkvm-uploadbar-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.apkvm-uploadbar-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}' +
      '.apkvm-progress{grid-column:1/-1;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}' +
      '.apkvm-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .15s ease}' +
      '.apkvm-drop-overlay{position:absolute;inset:8px;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:2px dashed var(--dsw-alias-brand-primary);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);pointer-events:none;font-size:13px;font-weight:600;opacity:.97}' +
      '.apkvm-drop-overlay .apkvm-dim{color:var(--dsw-alias-label-secondary);font-weight:400}' +
      '.apkvm-setup-row{display:grid;grid-template-columns:13px 70px minmax(0,1fr);gap:5px;align-items:center;font-size:10.5px;line-height:14px}' +
      '.apkvm-setup-dot{font-weight:700;text-align:center}' +
      '.apkvm-setup-dot.ok{color:var(--dsw-alias-state-success-primary)}' +
      '.apkvm-setup-dot.bad{color:var(--dsw-alias-state-warn-primary)}' +
      '.apkvm-setup-label{color:var(--dsw-alias-label-primary)}' +
      '.apkvm-setup-detail{text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.apkvm-embedded .apkvm-header{padding:8px 10px;gap:6px}' +
      '.apkvm-embedded .apkvm-body{padding:8px 10px 10px;gap:6px}' +
      '.apkvm-embedded .apkvm-aside{gap:6px}' +
      '.apkvm-embedded .apkvm-apkcard{min-height:0}' +
      '.apkvm-embedded .apkvm-apkcard .apkvm-list{max-height:150px;min-height:50px}' +
      '.apkvm-embedded .apkvm-phonewrap{flex:0 0 auto;min-height:320px}' +
      '.apkvm-embedded .apkvm-controls{max-width:none}' +
      '@media (max-width:900px){.apkvm-header{flex-wrap:wrap}}' +
      '.apkvm-embedded .apkvm-header{flex-wrap:wrap}';

    /* ------------------------------------------------------------------ *
     * Render-error boundary: an unexpected exception inside the panel keeps
     * the slot alive with a recoverable message instead of a blank panel.
     * ------------------------------------------------------------------ */

    function createBoundary() {
      var Boundary = class ApkVmBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error: error };
        }

        componentDidCatch() {
          /* deliberately swallowed: the fallback UI reports the failure */
        }

        render() {
          if (!this.state || !this.state.error) return this.props ? this.props.children : null;
          var T = createTranslator(this.props && typeof this.props.translate === 'function' ? this.props.translate : null);
          var detail = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
          var self = this;
          return h(
            'div',
            {
              className: 'apkvm-page',
              style: { alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '24px', textAlign: 'center' },
            },
            h('div', { className: 'apkvm-title' }, T('title')),
            h('div', { className: 'apkvm-dim' }, T('err.render')),
            h('div', { className: 'apkvm-dim', style: { whiteSpace: 'normal', maxWidth: '480px', overflow: 'visible' } }, detail),
            h(
              'button',
              {
                type: 'button',
                className: 'apkvm-btn apkvm-btn-primary',
                onClick: function () {
                  self.setState({ error: null });
                },
              },
              T('overlay.retry')
            )
          );
        }
      };
      return Boundary;
    }

    /* ------------------------------------------------------------------ *
     * The main panel component. All hooks are unconditional and in a stable
     * order so React can re-render it safely across Host state transitions.
     * ------------------------------------------------------------------ */

    function createPage(getTranslate) {
      function ApkVmPage(props) {
        var propsSafe = isObject(props) ? props : {};
        var translate = typeof propsSafe.t === 'function' ? propsSafe.t : getTranslate();
        var T = createTranslator(translate);
        /* dsh-better-sidebar's TabComponentProps include `visible`; the native
           `main` panel has no such prop and is always treated as visible. */
        var embedded = propsSafe.embedded === true;
        var tabVisible = propsSafe.visible === undefined ? true : propsSafe.visible !== false;

        /* ---- state ---------------------------------------------------- */
        var snapshotState = React.useState(null);
        var snapshot = snapshotState[0];
        var setSnapshot = snapshotState[1];

        var stateErrorState = React.useState('');
        var stateError = stateErrorState[0];
        var setStateError = stateErrorState[1];

        var apksState = React.useState(null);
        var apks = apksState[0];
        var setApks = apksState[1];

        var rootsState = React.useState([]);
        var roots = rootsState[0];
        var setRoots = rootsState[1];

        var apksErrorState = React.useState('');
        var apksError = apksErrorState[0];
        var setApksError = apksErrorState[1];

        var apksBusyState = React.useState(false);
        var apksBusy = apksBusyState[0];
        var setApksBusy = apksBusyState[1];

        var installedAppsState = React.useState([]);
        var installedApps = installedAppsState[0];
        var setInstalledApps = installedAppsState[1];
        var appsOpenState = React.useState(false);
        var appsOpen = appsOpenState[0];
        var setAppsOpen = appsOpenState[1];
        var appsBusyState = React.useState(false);
        var appsBusy = appsBusyState[0];
        var setAppsBusy = appsBusyState[1];
        var appsErrorState = React.useState('');
        var appsError = appsErrorState[0];
        var setAppsError = appsErrorState[1];
        var appActionBusyState = React.useState('');
        var appActionBusy = appActionBusyState[0];
        var setAppActionBusy = appActionBusyState[1];

        var vmBusyState = React.useState(false);
        var vmBusy = vmBusyState[0];
        var setVmBusy = vmBusyState[1];

        var installingState = React.useState('');
        var installing = installingState[0];
        var setInstalling = installingState[1];

        var pathInputState = React.useState('');
        var pathInput = pathInputState[0];
        var setPathInput = pathInputState[1];

        var uploadState = React.useState(null);
        var upload = uploadState[0];
        var setUpload = uploadState[1];
        var draggingState = React.useState(false);
        var dragging = draggingState[0];
        var setDragging = draggingState[1];
        var fileInputRef = React.useRef(null);
        var dragDepthRef = React.useRef(0);

        var setupState = React.useState(null);
        var setup = setupState[0];
        var setSetup = setupState[1];
        var setupBusyState = React.useState(false);
        var setupBusy = setupBusyState[0];
        var setSetupBusy = setupBusyState[1];
        var avdsState = React.useState([]);
        var avds = avdsState[0];
        var setAvds = avdsState[1];
        var avdPickState = React.useState('');
        var avdPick = avdPickState[0];
        var setAvdPick = avdPickState[1];
        var devicesState = React.useState([]);
        var devices = devicesState[0];
        var setDevices = devicesState[1];
        var devicePickState = React.useState('');
        var devicePick = devicePickState[0];
        var setDevicePick = devicePickState[1];
        var deviceBusyState = React.useState(false);
        var deviceBusy = deviceBusyState[0];
        var setDeviceBusy = deviceBusyState[1];
        var deviceErrorState = React.useState('');
        var deviceError = deviceErrorState[0];
        var setDeviceError = deviceErrorState[1];

        var activeInstanceState = React.useState('default');
        var activeInstance = activeInstanceState[0];
        var setActiveInstance = activeInstanceState[1];
        var activeInstanceRef = React.useRef('default');
        var instancesListState = React.useState([]);
        var instancesList = instancesListState[0];
        var setInstancesList = instancesListState[1];
        var instanceBusyState = React.useState(false);
        var instanceBusy = instanceBusyState[0];
        var setInstanceBusy = instanceBusyState[1];

        var textInputState = React.useState('');
        var textInput = textInputState[0];
        var setTextInput = textInputState[1];

        var debugCommandState = React.useState('');
        var debugCommand = debugCommandState[0];
        var setDebugCommand = debugCommandState[1];
        var debugOutputState = React.useState('');
        var debugOutput = debugOutputState[0];
        var setDebugOutput = debugOutputState[1];
        var debugBusyState = React.useState(false);
        var debugBusy = debugBusyState[0];
        var setDebugBusy = debugBusyState[1];
        var logLiveState = React.useState(false);
        var logLive = logLiveState[0];
        var setLogLive = logLiveState[1];
        var logLiveTimerRef = React.useRef(null);

        var inspectModeState = React.useState(false);
        var inspectMode = inspectModeState[0];
        var setInspectMode = inspectModeState[1];
        var inspectNodesState = React.useState([]);
        var inspectNodes = inspectNodesState[0];
        var setInspectNodes = inspectNodesState[1];
        var inspectSelectedState = React.useState(null);
        var inspectSelected = inspectSelectedState[0];
        var setInspectSelected = inspectSelectedState[1];
        var inspectBusyState = React.useState(false);
        var inspectBusy = inspectBusyState[0];
        var setInspectBusy = inspectBusyState[1];
        var inspectErrorState = React.useState('');
        var inspectError = inspectErrorState[0];
        var setInspectError = inspectErrorState[1];

        var flowsState = React.useState([]);
        var flows = flowsState[0];
        var setFlows = flowsState[1];
        var flowRecordingState = React.useState(false);
        var flowRecording = flowRecordingState[0];
        var setFlowRecording = flowRecordingState[1];
        var flowNameState = React.useState('');
        var flowName = flowNameState[0];
        var setFlowName = flowNameState[1];
        var flowBusyState = React.useState('');
        var flowBusy = flowBusyState[0];
        var setFlowBusy = flowBusyState[1];

        var storageState = React.useState(null);
        var storage = storageState[0];
        var setStorage = storageState[1];
        var storageBusyState = React.useState('');
        var storageBusy = storageBusyState[0];
        var setStorageBusy = storageBusyState[1];
        var storageErrorState = React.useState('');
        var storageError = storageErrorState[0];
        var setStorageError = storageErrorState[1];
        var storageConfirmState = React.useState('');
        var storageConfirm = storageConfirmState[0];
        var setStorageConfirm = storageConfirmState[1];

        var proxyState = React.useState({ host: '', port: '' });
        var proxy = proxyState[0];
        var setProxy = proxyState[1];
        var proxyBusyState = React.useState(false);
        var proxyBusy = proxyBusyState[0];
        var setProxyBusy = proxyBusyState[1];
        var caPathState = React.useState('');
        var caPath = caPathState[0];
        var setCaPath = caPathState[1];
        var networkState = React.useState(null);
        var network = networkState[0];
        var setNetwork = networkState[1];
        var networkBusyState = React.useState('');
        var networkBusy = networkBusyState[0];
        var setNetworkBusy = networkBusyState[1];
        var forwardLocalState = React.useState('');
        var forwardLocal = forwardLocalState[0];
        var setForwardLocal = forwardLocalState[1];
        var forwardRemoteState = React.useState('');
        var forwardRemote = forwardRemoteState[0];
        var setForwardRemote = forwardRemoteState[1];
        var forwardSharedState = React.useState(false);
        var forwardShared = forwardSharedState[0];
        var setForwardShared = forwardSharedState[1];
        var dnsTextState = React.useState('');
        var dnsText = dnsTextState[0];
        var setDnsText = dnsTextState[1];
        var hostsTextState = React.useState('');
        var hostsText = hostsTextState[0];
        var setHostsText = hostsTextState[1];
        var pcapPathState = React.useState('');
        var pcapPath = pcapPathState[0];
        var setPcapPath = pcapPathState[1];

        var actualFpsState = React.useState(0);
        var actualFps = actualFpsState[0];
        var setActualFps = actualFpsState[1];

        var videoModeState = React.useState('png');
        var videoMode = videoModeState[0];
        var setVideoMode = videoModeState[1];
        var h264MetaState = React.useState(null);
        var h264Meta = h264MetaState[0];
        var setH264Meta = h264MetaState[1];

        var frameUrlState = React.useState('');
        var frameUrl = frameUrlState[0];
        var setFrameUrl = frameUrlState[1];

        var frameErrorState = React.useState('');
        var frameError = frameErrorState[0];
        var setFrameError = frameErrorState[1];

        var hiddenState = React.useState(function () {
          return typeof document !== 'undefined' && document.hidden === true;
        });
        var hidden = hiddenState[0];
        var setHidden = hiddenState[1];

        var toastState = React.useState(null);
        var toast = toastState[0];
        var setToast = toastState[1];

        var sbState = React.useState(getBetterSidebar());
        var sidebarService = sbState[0];
        var setSidebarService = sbState[1];

        /* ---- refs ----------------------------------------------------- */
        var mountedRef = React.useRef(true);
        var snapshotRef = React.useRef(null);
        var screenRef = React.useRef(null);
        var logRef = React.useRef(null);
        var frameUrlRef = React.useRef('');
        var stateBusyRef = React.useRef(false);
        var vmBusyRef = React.useRef(false);
        var installingRef = React.useRef('');
        var dragRef = React.useRef(null);
        var multiTouchRef = React.useRef(null);
        var latestRef = React.useRef({});
        var frameStatsRef = React.useRef([]);
        var canvasRef = React.useRef(null);
        var decoderRef = React.useRef(null);
        var wsRef = React.useRef(null);

        /* ---- derived snapshot values --------------------------------- */
        var vmInfo = snapshot ? snapshot.vm : null;
        var clientReport = snapshot && isObject(snapshot.client) ? snapshot.client : null;
        var wsOrigin = snapshot && snapshot.origin ? snapshot.origin : '';
        var apkInfo = snapshot ? snapshot.apk : null;
        var vmIdentity = vmInfo && isObject(vmInfo.identity) ? vmInfo.identity : null;
        var rootActive = vmInfo && vmInfo.root === true;
        var identityText = vmIdentity
          ? T('debug.identity', {
              release: vmIdentity.release ? 'Android ' + vmIdentity.release : 'Android',
              sdk: vmIdentity.sdk ? String(vmIdentity.sdk) : '?',
              abi: vmIdentity.abi || '?',
            })
          : '';
        var displayState = snapshot ? snapshot.vm.state : stateError ? 'error' : 'loading';
        var stateLabel = T('state.' + displayState);
        var ready = displayState === 'ready';
        var targetFps =
          snapshot && isObject(snapshot.stream) && Number(snapshot.stream.fps) > 0
            ? Math.min(10, Math.max(1, Math.round(Number(snapshot.stream.fps))))
            : 2;
        var frameIntervalMs = Math.max(200, Math.round(1000 / targetFps));
        var busyState = displayState === 'starting' || displayState === 'booting';
        var screen = snapshot ? snapshot.screen : null;
        var displayScreen =
          videoMode === 'h264' && h264Meta && Number(h264Meta.width) > 0 && Number(h264Meta.height) > 0
            ? { width: Number(h264Meta.width), height: Number(h264Meta.height) }
            : screen;
        // Input injection expects the guest display coordinate space
        // (`wm size`, swapped when rotated), not the downscaled H.264 frame.
        var inputScreen = screen;
        if (screen && videoMode === 'h264' && h264Meta) {
          var videoLandscape = Number(h264Meta.width) > Number(h264Meta.height);
          var screenLandscape = Number(screen.width) > Number(screen.height);
          if (videoLandscape !== screenLandscape) {
            inputScreen = { width: Number(screen.height), height: Number(screen.width) };
          }
        }
        if (!inputScreen) inputScreen = displayScreen;
        var screenAspect = displayScreen ? displayScreen.width + ' / ' + displayScreen.height : '9 / 16';
        var currentApkPath = apkInfo && apkInfo.path ? apkInfo.path : '';
        var logLines = vmInfo && vmInfo.logTail ? vmInfo.logTail : [];
        var logText = logLines.join('\n');

        var pillMeta = [];
        if (vmInfo) {
          if (vmInfo.serial) pillMeta.push(vmInfo.serial);
          else if (vmInfo.avd) pillMeta.push(vmInfo.avd);
          if (displayState === 'ready' && vmInfo.bootMs > 0) {
            var bootSeconds = Math.round(vmInfo.bootMs / 1000);
            var bootKey =
              vmInfo.bootKind === 'snapshot'
                ? 'pill.snapshot'
                : vmInfo.bootKind === 'cold'
                  ? 'pill.cold'
                  : 'pill.boot';
            pillMeta.push(T(bootKey, { s: bootSeconds }));
          }
        }
        var subtitleText = apkInfo
          ? T('apk.current', { name: apkInfo.label || apkInfo.packageName || apkInfo.path })
          : T('subtitle');
        var rootsLabel =
          roots.length > 2 ? roots.slice(0, 2).join(' · ') + ' +' + (roots.length - 2) : roots.join(' · ');

        snapshotRef.current = snapshot;
        latestRef.current = { ready: ready, screen: screen, send: sendInput, T: T };

        function sendClientReport(extra) {
          if (typeof fetch !== 'function') return;
          var payload = {
            version: CLIENT_VERSION,
            userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '',
            location: typeof location !== 'undefined' ? String(location.href || '') : '',
            webCodecs: typeof VideoDecoder === 'function',
            mode: extra && extra.mode ? String(extra.mode) : videoMode || 'png',
            codec: extra && extra.codec ? String(extra.codec) : '',
            h264Supported: extra && extra.h264Supported === true,
            h264Error: extra && extra.h264Error ? String(extra.h264Error).slice(0, 400) : '',
            decoderError: extra && extra.decoderError ? String(extra.decoderError).slice(0, 400) : '',
          };
          try {
            fetch('/apk-vm/client-report', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
              cache: 'no-store',
            }).catch(function () {});
          } catch (error) {
            /* diagnostics are best effort */
          }
        }

        React.useEffect(function () {
          if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
            sendClientReport({ h264Supported: false, h264Error: 'WebCodecs VideoDecoder/EncodedVideoChunk unavailable', decoderError: '' });
            return;
          }
          if (typeof VideoDecoder.isConfigSupported !== 'function') {
            sendClientReport({ h264Supported: false, h264Error: 'VideoDecoder.isConfigSupported unavailable' });
            return;
          }
          try {
            VideoDecoder.isConfigSupported({ codec: 'avc1.42C029' }).then(function (support) {
              sendClientReport({
                h264Supported: Boolean(support && support.supported),
                h264Error: support && support.supported ? '' : 'avc1.42C029 is not supported by this WebView',
              });
            }).catch(function (error) {
              sendClientReport({ h264Supported: false, h264Error: String(error && error.message ? error.message : error) });
            });
          } catch (error) {
            sendClientReport({ h264Supported: false, h264Error: String(error && error.message ? error.message : error) });
          }
        }, []);

        /* ---- effects -------------------------------------------------- */
        // Lifecycle flag + initial load + 2s state polling.
        React.useEffect(function () {
          mountedRef.current = true;
          loadState();
          loadApks();
          loadInstances();
          loadDevices();
          loadFlows();
          loadStorage();
          loadNetwork();
          var pollId = setInterval(function () {
            if (stateBusyRef.current) return;
            stateBusyRef.current = true;
            loadState().then(function () {
              stateBusyRef.current = false;
            });
          }, STATE_INTERVAL_MS);
          var instancePollId = setInterval(function () {
            if (mountedRef.current) loadInstances();
          }, 5000);
          return function () {
            mountedRef.current = false;
            clearInterval(pollId);
            clearInterval(instancePollId);
            if (logLiveTimerRef.current) {
              clearInterval(logLiveTimerRef.current);
              logLiveTimerRef.current = null;
            }
          };
        }, []);

        // Load network details once the VM becomes ready (the first render often
        // happens while the state is still loading).
        React.useEffect(function () {
          if (ready) loadNetwork();
        }, [ready, activeInstance]);

        // Track document visibility so the frame stream pauses when hidden.
        React.useEffect(function () {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
            return undefined;
          }
          function onVisibilityChange() {
            if (mountedRef.current) setHidden(document.hidden === true);
          }
          document.addEventListener('visibilitychange', onVisibilityChange);
          return function () {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          };
        }, []);

        // Follow the optional dsh-better-sidebar service: it can activate
        // before or after this panel, so both the initial read and the
        // subscription are needed. Without it the action stays hidden.
        React.useEffect(function () {
          var current = getBetterSidebar();
          if (current !== sidebarService) setSidebarService(current);
          return subscribeBetterSidebar(function (next) {
            if (mountedRef.current) setSidebarService(next);
          });
        }, []);

        // Auto-dismiss toast banners (errors linger longer than confirmations).
        React.useEffect(function () {
          if (!toast) return undefined;
          var hideId = setTimeout(
            function () {
              if (mountedRef.current) setToast(null);
            },
            toast.kind === 'error' ? 9000 : 4500
          );
          return function () {
            clearTimeout(hideId);
          };
        }, [toast && toast.id]);

        // Frame streaming: poll PNG frames only while ready, visible and the
        // H.264 WebCodecs path is not active.
        React.useEffect(function () {
          if (!ready) {
            var stale = frameUrlRef.current;
            frameUrlRef.current = '';
            if (stale) {
              revokeObjectUrl(stale);
              setFrameUrl('');
            }
            setFrameError('');
            setActualFps(0);
            frameStatsRef.current = [];
            return undefined;
          }
          if (hidden || !tabVisible || videoMode === 'h264') return undefined;
          var cancelled = false;
          var timer = 0;
          function schedule() {
            timer = setTimeout(tick, frameIntervalMs);
          }
          function tick() {
            if (cancelled) return;
            requestFrame(T, instancePath('/frame?t=' + Date.now())).then(function (result) {
              if (cancelled) {
                if (result.url) revokeObjectUrl(result.url);
                return;
              }
              if (result.url) {
                var previous = frameUrlRef.current;
                frameUrlRef.current = result.url;
                setFrameUrl(result.url);
                setFrameError('');
                if (previous) revokeObjectUrl(previous);
                var now = Date.now();
                var stats = frameStatsRef.current;
                stats.push(now);
                var cutoff = now - 3000;
                while (stats.length && stats[0] < cutoff) stats.shift();
                if (stats.length >= 2) {
                  var span = now - stats[0];
                  if (span > 0) {
                    var measured = Math.round((stats.length / (span / 1000)) * 10) / 10;
                    setActualFps(Math.min(30, measured));
                  }
                }
              } else {
                setFrameError(result.error || T('err.frame'));
              }
              schedule();
            });
          }
          tick();
          return function () {
            cancelled = true;
            clearTimeout(timer);
          };
        }, [ready, hidden, tabVisible, frameIntervalMs, videoMode, activeInstance]);

        /* ---- H.264 low-latency stream (scrcpy → WebSocket → WebCodecs) ---- */
        function base64ToBytes(text) {
          var binary = typeof atob === 'function' ? atob(String(text || '')) : '';
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }

        React.useEffect(function () {
          if (!ready || hidden || !tabVisible) {
            setVideoMode('png');
            setH264Meta(null);
            return undefined;
          }
          if (typeof WebSocket !== 'function' || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
            return undefined; // fall back to the PNG screencap path
          }
          var cancelled = false;
          var reconnectTimer = 0;
          var ws = null;
          var decoder = null;
          var attempts = 0;
          var waitingForKey = true;

          function stopDecoder() {
            if (decoder) {
              try {
                decoder.close();
              } catch (error) {
                /* ignore */
              }
              decoder = null;
            }
            decoderRef.current = null;
          }

          function closeSocket() {
            if (ws) {
              try {
                ws.close();
              } catch (error) {
                /* ignore */
              }
              ws = null;
            }
          }

          function scheduleReconnect(delayMs) {
            if (cancelled) return;
            attempts += 1;
            if (attempts > 3) return; // stay on the PNG fallback
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(function () {
              if (!cancelled) connect();
            }, Math.min(10000, delayMs || 2000));
          }

          function drawFrame(frame) {
            var canvas = canvasRef.current;
            if (canvas) {
              if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
              }
              var ctx = canvas.getContext('2d');
              if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            }
            frame.close();
            var now = Date.now();
            var stats = frameStatsRef.current;
            stats.push(now);
            var cutoff = now - 3000;
            while (stats.length && stats[0] < cutoff) stats.shift();
            if (stats.length >= 2) {
              var span = now - stats[0];
              if (span > 0) setActualFps(Math.min(60, Math.round((stats.length / (span / 1000)) * 10) / 10));
            }
          }

          function onPacket(data) {
            if (!decoder || decoder.state !== 'configured') return;
            var bytes = new Uint8Array(data);
            if (bytes.byteLength < 10 || bytes[0] !== 1) return;
            var view = new DataView(data);
            var pts = Number(view.getBigInt64(2, true));
            var key = (bytes[1] & 1) === 1;
            if (waitingForKey && !key) return;
            if (key) waitingForKey = false;
            try {
              decoder.decode(
                new EncodedVideoChunk({
                  type: key ? 'key' : 'delta',
                  timestamp: pts,
                  data: bytes.subarray(10),
                })
              );
            } catch (error) {
              /* decoder errors surface through VideoDecoder's error callback */
            }
          }

          function connect() {
            if (cancelled) return;
            var protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss://' : 'ws://';
            var host = typeof location !== 'undefined' && location.host ? location.host : '';
            var wsBase = '';
            if (wsOrigin) {
              // The desktop shell can load the panel from a custom scheme where
              // location.host is empty/meaningless; the Host-derived origin is
              // the only reliable ws target.
              wsBase = String(wsOrigin).replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/+$/, '');
            } else {
              wsBase = protocol + host;
            }
            if (!wsBase) {
              setVideoMode('png');
              return;
            }
            var wsPath = activeInstance === 'default'
              ? '/apk-vm/ws'
              : '/apk-vm/instances/' + encodeURIComponent(activeInstance) + '/ws';
            try {
              ws = new WebSocket(wsBase + wsPath);
            } catch (error) {
              scheduleReconnect(3000);
              return;
            }
            ws.binaryType = 'arraybuffer';
            wsRef.current = ws;
            ws.onmessage = function (event) {
              if (cancelled) return;
              if (typeof event.data === 'string') {
                var message = null;
                try {
                  message = JSON.parse(event.data);
                } catch (error) {
                  return;
                }
                if (message && message.type === 'init') {
                  attempts = 0;
                  setH264Meta({
                    width: message.width,
                    height: message.height,
                    codec: message.codecString,
                    maxFps: message.maxFps,
                  });
                  try {
                    stopDecoder();
                    var description = base64ToBytes(message.description);
                    decoder = new VideoDecoder({
                      output: drawFrame,
                      error: function (error) {
                        if (cancelled) return;
                        sendClientReport({ h264Supported: true, mode: 'png', decoderError: error && error.message ? error.message : String(error) });
                        setFrameError(T('stream.error') + (error && error.message ? ': ' + error.message : ''));
                        stopDecoder();
                        setVideoMode('png');
                      },
                    });
                    decoder.configure({
                      codec: message.codecString,
                      description: description,
                      optimizeForLatency: true,
                    });
                    decoderRef.current = decoder;
                    waitingForKey = true;
                    frameStatsRef.current = [];
                    setActualFps(0);
                    setVideoMode('h264');
                    setFrameError('');
                    sendClientReport({ h264Supported: true, mode: 'h264', codec: message.codecString });
                  } catch (error) {
                    sendClientReport({ h264Supported: true, mode: 'png', decoderError: error && error.message ? error.message : String(error) });
                    setFrameError(T('stream.error'));
                    stopDecoder();
                    setVideoMode('png');
                  }
                } else if (message && message.type === 'error') {
                  setFrameError(T('stream.error') + (message.error ? ': ' + message.error : ''));
                }
                return;
              }
              if (event.data && typeof event.data.byteLength === 'number') onPacket(event.data);
            };
            ws.onclose = function (event) {
              if (cancelled) return;
              sendClientReport({
                h264Supported: true,
                mode: 'png',
                decoderError: 'ws closed ' + (event ? event.code : '?') + ' ' + (event && event.reason ? event.reason : ''),
              });
              stopDecoder();
              setVideoMode('png');
              scheduleReconnect(2000);
            };
            ws.onerror = function () {
              /* onclose follows; reconnect is scheduled there */
            };
          }

          connect();
          return function () {
            cancelled = true;
            clearTimeout(reconnectTimer);
            closeSocket();
            stopDecoder();
            setVideoMode('png');
            setH264Meta(null);
          };
        }, [ready, hidden, tabVisible, activeInstance, wsOrigin]);

        // Revoke the last object URL if the panel unmounts mid-stream.
        React.useEffect(function () {
          return function () {
            var leftover = frameUrlRef.current;
            frameUrlRef.current = '';
            if (leftover) revokeObjectUrl(leftover);
          };
        }, []);

        // Keep the log pinned to the bottom unless the user scrolled up.
        React.useEffect(function () {
          var node = logRef.current;
          if (!node) return;
          var nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 28;
          if (nearBottom) node.scrollTop = node.scrollHeight;
        }, [logText]);

        // Wheel → vertical swipe on the device (native non-passive listener so
        // the page itself never scrolls while the cursor is over the screen).
        React.useEffect(function () {
          var node = screenRef.current;
          if (!node || typeof node.addEventListener !== 'function') return undefined;
          var lastSentAt = 0;
          function onWheel(event) {
            var info = latestRef.current || {};
            if (!info.ready || !info.screen || typeof info.send !== 'function') return;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            var now = Date.now();
            if (now - lastSentAt < 130) return;
            lastSentAt = now;
            var device = info.screen;
            var step = clamp(Number(event.deltaY), -3, 3) * device.height * 0.16;
            var centerX = Math.round(device.width / 2);
            var fromY = Math.round(device.height * 0.62);
            var toY = clamp(Math.round(fromY - step), 0, device.height - 1);
            if (Math.abs(toY - fromY) < 8) return;
            info.send({ type: 'swipe', x1: centerX, y1: fromY, x2: centerX, y2: toY, duration: 160 });
          }
          node.addEventListener('wheel', onWheel, { passive: false });
          return function () {
            node.removeEventListener('wheel', onWheel);
          };
        }, []);

        /* ---- data loading -------------------------------------------- */
        function instancePath(pathname) {
          var id = activeInstanceRef.current || 'default';
          return id === 'default' ? '/apk-vm' + pathname : '/apk-vm/instances/' + encodeURIComponent(id) + pathname;
        }

        function setActiveInstanceId(id) {
          var next = id || 'default';
          activeInstanceRef.current = next;
          setActiveInstance(next);
          var stale = frameUrlRef.current;
          frameUrlRef.current = '';
          if (stale) revokeObjectUrl(stale);
          setFrameUrl('');
          setFrameError('');
          setSnapshot(null);
          setActualFps(0);
          setInstalledApps([]);
          setAppsError('');
          setInspectMode(false);
          setInspectNodes([]);
          setInspectSelected(null);
          loadFlows();
          setNetwork(null);
          loadNetwork();
          stopLiveLogcat();
          frameStatsRef.current = [];
          loadState();
        }

        function loadInstances() {
          return requestJson('/apk-vm/instances', null, T).then(function (result) {
            if (!mountedRef.current) return result;
            if (result.ok && isObject(result.data) && Array.isArray(result.data.instances)) {
              setInstancesList(result.data.instances);
            }
            return result;
          });
        }

        function createInstance() {
          if (instanceBusy) return;
          setInstanceBusy(true);
          requestJson('/apk-vm/instances', { method: 'POST', body: JSON.stringify({}) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setInstanceBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 400));
              return;
            }
            var data = isObject(result.data) ? result.data : {};
            var created = data.instance && data.instance.id;
            pushToast('success', T('instances.created', { id: created || '' }));
            loadInstances();
            if (created) setActiveInstanceId(created);
          });
        }

        function destroyActiveInstance() {
          var id = activeInstanceRef.current;
          if (!id || id === 'default' || instanceBusy) return;
          setInstanceBusy(true);
          requestJson('/apk-vm/instances/' + encodeURIComponent(id), { method: 'DELETE' }, T).then(function (result) {
            if (!mountedRef.current) return;
            setInstanceBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 400));
              return;
            }
            pushToast('success', T('instances.destroyed', { id: id }));
            setActiveInstanceId('default');
            loadInstances();
          });
        }

        function stopInstanceById(id) {
          if (!id || instanceBusy) return;
          var vmPath = id === 'default' ? '/apk-vm/vm' : '/apk-vm/instances/' + encodeURIComponent(id) + '/vm';
          setInstanceBusy(true);
          requestJson(vmPath, { method: 'POST', body: JSON.stringify({ action: 'stop' }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setInstanceBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 400));
              return;
            }
            pushToast('success', T('instances.stopped', { id: id }));
            loadInstances();
            loadState();
          });
        }

        function destroyInstanceById(id) {
          if (!id || id === 'default' || instanceBusy) return;
          setInstanceBusy(true);
          requestJson('/apk-vm/instances/' + encodeURIComponent(id), { method: 'DELETE' }, T).then(function (result) {
            if (!mountedRef.current) return;
            setInstanceBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 400));
              return;
            }
            pushToast('success', T('instances.destroyed', { id: id }));
            if (activeInstanceRef.current === id) setActiveInstanceId('default');
            loadInstances();
          });
        }

        function loadState() {
          var statePath = activeInstanceRef.current === 'default' ? '/apk-vm/state' : '/apk-vm/instances/' + encodeURIComponent(activeInstanceRef.current) + '/state';
          return requestJson(statePath, null, T).then(function (result) {
            if (!mountedRef.current) return result;
            if (result.ok) {
              setSnapshot(normalizeState(result.data));
              setStateError('');
              if (isObject(result.data) && Array.isArray(result.data.instances)) {
                setInstancesList(result.data.instances);
              }
            } else {
              setStateError(result.error || T('err.state'));
            }
            return result;
          });
        }

        function loadApks() {
          if (mountedRef.current) {
            setApksBusy(true);
            setApksError('');
          }
          return requestJson('/apk-vm/apks', null, T).then(function (result) {
            if (!mountedRef.current) return result;
            if (result.ok) {
              var normalized = normalizeApkList(result.data);
              setApks(normalized.apks);
              setRoots(normalized.roots);
            } else {
              setApksError(result.error || T('err.apks'));
            }
            setApksBusy(false);
            return result;
          });
        }

        function loadInspector() {
          if (!ready || inspectBusy) return Promise.resolve(null);
          setInspectBusy(true);
          setInspectError('');
          return requestJson(instancePath('/debug/inspect'), null, T).then(function (result) {
            if (!mountedRef.current) return result;
            setInspectBusy(false);
            if (!result.ok) {
              setInspectError(result.error || T('err.action'));
              return result;
            }
            var data = isObject(result.data) ? result.data : {};
            var nodes = Array.isArray(data.nodes) ? data.nodes : [];
            setInspectNodes(nodes);
            setInspectSelected(null);
            return result;
          });
        }

        function toggleInspectMode() {
          var next = !inspectMode;
          setInspectMode(next);
          if (next) {
            loadInspector();
          } else {
            setInspectSelected(null);
          }
        }

        function copyInspectCommand(kind) {
          var node = inspectSelected;
          if (!node || !node.selector) return;
          var text = kind === 'assert' ? node.selector.assertCommand : node.selector.tapCommand;
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(
                function () {
                  pushToast('success', T('inspect.copied') + ': ' + text);
                },
                function () {
                  pushToast('error', T('inspect.copied') + ': ' + text);
                }
              );
            } else {
              pushToast('success', T('inspect.copied') + ': ' + text);
            }
          } catch (error) {
            pushToast('success', T('inspect.copied') + ': ' + text);
          }
        }

        function nodeBoundingStyle(node) {
          var target = inputScreen || displayScreen;
          if (!target || !node || !node.bounds) return null;
          var b = node.bounds;
          var width = Number(target.width) || 0;
          var height = Number(target.height) || 0;
          if (!(width > 0) || !(height > 0) || !(b.width > 0) || !(b.height > 0)) return null;
          return {
            left: ((b.x1 / width) * 100).toFixed(4) + '%',
            top: ((b.y1 / height) * 100).toFixed(4) + '%',
            width: ((b.width / width) * 100).toFixed(4) + '%',
            height: ((b.height / height) * 100).toFixed(4) + '%',
          };
        }

        function renderInspector() {
          if (!inspectMode || !ready) return null;
          var nodes = inspectNodes.filter(function (node) {
            return node && node.bounds && (node.interactive || node.clickable || node.text || node.contentDesc);
          });
          var boxes = nodes.slice(0, 160).map(function (node) {
            var style = nodeBoundingStyle(node);
            if (!style) return null;
            var selected = inspectSelected && inspectSelected.order === node.order;
            return h('div', {
              key: 'inspect-' + node.order,
              className: 'apkvm-inspect-box' + (selected ? ' selected' : ''),
              style: style,
              title: node.selector ? node.selector.selector : node.label,
              onClick: function (event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                setInspectSelected(node);
              },
            });
          });
          var bar = h(
            'div',
            { className: 'apkvm-inspect-bar' },
            h('span', { className: 'apkvm-inspect-label' }, T('inspect.title')),
            h(
              'span',
              { className: 'apkvm-inspect-meta' },
              inspectBusy ? T('inspect.loading') : T('flow.count', { n: nodes.length })
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            actionBtn(T('inspect.refresh'), {
              key: 'inspect-refresh',
              small: true,
              disabled: inspectBusy,
              onClick: loadInspector,
            }),
            actionBtn(T('inspect.close'), {
              key: 'inspect-close',
              small: true,
              onClick: toggleInspectMode,
            })
          );
          var selectedBar = inspectSelected
            ? h(
                'div',
                { className: 'apkvm-inspect-bar', style: { bottom: '52px' } },
                h('span', { className: 'apkvm-inspect-label' }, inspectSelected.label || T('inspect.selected')),
                h(
                  'span',
                  { className: 'apkvm-inspect-meta' },
                  inspectSelected.selector ? inspectSelected.selector.selector : ''
                ),
                h('span', { style: { flex: '1 1 auto' } }),
                actionBtn(T('inspect.copyTap'), {
                  key: 'inspect-copy-tap',
                  small: true,
                  onClick: function () {
                    copyInspectCommand('tap');
                  },
                }),
                actionBtn(T('inspect.copyAssert'), {
                  key: 'inspect-copy-assert',
                  small: true,
                  onClick: function () {
                    copyInspectCommand('assert');
                  },
                })
              )
            : null;
          return h(
            'div',
            { className: 'apkvm-inspect-layer' },
            boxes,
            inspectError ? h('div', { className: 'apkvm-inspect-bar', style: { bottom: '52px' } }, inspectError) : null,
            bar,
            selectedBar
          );
        }

        function flowPath(suffix) {
          var id = activeInstanceRef.current || 'default';
          var base = id === 'default' ? '/apk-vm/flows' : '/apk-vm/instances/' + encodeURIComponent(id) + '/flows';
          return base + (suffix || '');
        }

        function loadFlows() {
          return requestJson(flowPath(''), null, T).then(function (result) {
            if (!mountedRef.current) return result;
            if (result.ok && isObject(result.data) && Array.isArray(result.data.flows)) {
              setFlows(result.data.flows);
              setFlowRecording(result.data.recording === true);
            }
            return result;
          });
        }

        function toggleFlowRecording() {
          var starting = !flowRecording;
          requestJson(
            flowPath(''),
            { method: 'POST', body: JSON.stringify({ action: starting ? 'start' : 'stop', name: flowName || '' }) },
            T
          ).then(function (result) {
            if (!mountedRef.current) return;
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            setFlowRecording(starting);
            if (!starting) {
              setFlowName('');
              loadFlows();
              pushToast('success', T('flow.saved', { name: (result.data && result.data.name) || 'flow' }));
            } else {
              pushToast('success', T('flow.recording'));
            }
          });
        }

        function replayFlow(id) {
          if (!id || flowBusy) return;
          setFlowBusy(id);
          requestJson(flowPath(''), { method: 'POST', body: JSON.stringify({ action: 'replay', id: id }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setFlowBusy('');
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            pushToast('success', T('flow.done', { name: id }));
            loadState();
          });
        }

        function deleteFlow(id) {
          if (!id || flowBusy) return;
          setFlowBusy(id);
          requestJson(flowPath(''), { method: 'POST', body: JSON.stringify({ action: 'delete', id: id }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setFlowBusy('');
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            loadFlows();
          });
        }

        function loadNetwork() {
          if (!ready) return Promise.resolve(null);
          setNetworkBusy('load');
          return requestJson(instancePath('/network'), null, T).then(function (result) {
            if (!mountedRef.current) return result;
            setNetworkBusy('');
            if (result.ok && isObject(result.data)) {
              setNetwork(result.data);
              if (result.data.proxy && typeof result.data.proxy === 'string') {
                var colon = result.data.proxy.lastIndexOf(':');
                if (colon > 0) {
                  setProxy({ host: result.data.proxy.slice(0, colon), port: result.data.proxy.slice(colon + 1) });
                }
              }
              if (result.data.dnsServers && result.data.dnsServers.length) {
                setDnsText(result.data.dnsServers.join(', '));
              }
            }
            return result;
          });
        }

        function networkAction(action, payload) {
          if (networkBusy) return;
          setNetworkBusy(action);
          return requestJson(
            instancePath('/network'),
            { method: 'POST', body: JSON.stringify(Object.assign({ action: action }, payload || {})) },
            T
          ).then(function (result) {
            if (!mountedRef.current) return result;
            setNetworkBusy('');
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return result;
            }
            if (action === 'test') {
              pushToast(result.data && result.data.ok === true ? 'success' : 'error', T(result.data && result.data.ok ? 'network.testOk' : 'network.testFail'));
            } else if (action === 'dns' && result.data && result.data.restartRequired) {
              pushToast('success', T('network.restartRequired'));
            } else {
              pushToast('success', T('network.title'));
            }
            loadNetwork();
            return result;
          });
        }

        function addPortForward() {
          var local = Number(forwardLocal);
          var remote = Number(forwardRemote);
          if (!Number.isInteger(local) || local < 1 || local > 65535 || !Number.isInteger(remote) || remote < 1 || remote > 65535) {
            pushToast('error', T('err.action'));
            return;
          }
          networkAction('forward-add', {
            localPort: local,
            remotePort: remote,
            shared: forwardShared === true,
          }).then(function (result) {
            if (result && result.ok) {
              setForwardLocal('');
              setForwardRemote('');
              setForwardShared(false);
            }
          });
        }

        function removePortForward(localPort) {
          networkAction('forward-remove', { localPort: localPort });
        }

        function applyDns() {
          var servers = String(dnsText || '')
            .split(',')
            .map(function (item) {
              return item.trim();
            })
            .filter(Boolean);
          networkAction('dns', { servers: servers });
        }

        function applyHosts() {
          var entries = String(hostsText || '')
            .split(/\r?\n/)
            .map(function (line) {
              return line.trim();
            })
            .filter(Boolean);
          networkAction('hosts', { entries: entries });
        }

        function applyProxy() {
          if (proxyBusy) return;
          setProxyBusy(true);
          requestJson(
            instancePath('/debug/proxy'),
            { method: 'POST', body: JSON.stringify({ host: proxy.host, port: proxy.port, enabled: true }) },
            T
          ).then(function (result) {
            if (!mountedRef.current) return;
            setProxyBusy(false);
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            pushToast('success', T('network.current', { value: (result.data && result.data.proxy) || 'off' }));
            loadNetwork();
          });
        }

        function clearProxy() {
          if (proxyBusy) return;
          setProxyBusy(true);
          requestJson(instancePath('/debug/proxy'), { method: 'DELETE' }, T).then(function (result) {
            if (!mountedRef.current) return;
            setProxyBusy(false);
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            pushToast('success', T('network.clear'));
            loadNetwork();
          });
        }

        function installCa() {
          if (proxyBusy) return;
          var certPath = String(caPath || '').trim();
          if (!certPath) {
            pushToast('error', T('network.caPath'));
            return;
          }
          setProxyBusy(true);
          requestJson(instancePath('/debug/ca'), { method: 'POST', body: JSON.stringify({ path: certPath }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setProxyBusy(false);
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            pushToast('success', T('network.installCa') + ': ' + (result.data && result.data.hash ? result.data.hash + '.0' : 'ok'));
          });
        }

        function loadStorage() {
          setStorageBusy('load');
          setStorageError('');
          return requestJson('/apk-vm/storage', null, T).then(function (result) {
            if (!mountedRef.current) return result;
            setStorageBusy('');
            if (!result.ok) {
              setStorageError(result.error || T('err.action'));
              return result;
            }
            setStorage(isObject(result.data) ? result.data : null);
            return result;
          });
        }

        function storageSnapshotAvd() {
          var list = storage && Array.isArray(storage.avds) ? storage.avds : [];
          var current = snapshot && snapshot.vm && snapshot.vm.avd ? String(snapshot.vm.avd) : '';
          var match = list.find(function (item) {
            return item.name === current;
          });
          if (match) return match.name;
          var active = list.find(function (item) {
            return item.active && item.managed;
          });
          if (active) return active.name;
          var managed = list.find(function (item) {
            return item.managed;
          });
          return managed ? managed.name : 'dsh_apk';
        }

        function cleanStorage(action) {
          if (storageBusy) return;
          var destructive = action === 'snapshots' || action === 'orphan-avds';
          if (destructive && storageConfirm !== action) {
            setStorageConfirm(action);
            pushToast('success', T('storage.confirm'));
            return;
          }
          setStorageConfirm('');
          setStorageBusy(action);
          var payload = { action: action };
          if (action === 'snapshots') {
            payload.avdName = storageSnapshotAvd();
            payload.confirm = true;
          }
          if (action === 'orphan-avds') payload.confirm = true;
          requestJson('/apk-vm/storage', { method: 'POST', body: JSON.stringify(payload) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setStorageBusy('');
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
              return;
            }
            var freed = result.data && Number(result.data.freedBytes) ? Number(result.data.freedBytes) : 0;
            pushToast('success', T('storage.freed', { size: formatBytes(freed) }));
            loadStorage();
          });
        }

        function refreshAll() {
          loadState();
          loadApks();
          loadDevices();
          if (appsOpen) loadInstalledApps();
        }

        function loadInstalledApps() {
          if (!ready) return Promise.resolve(null);
          setAppsBusy(true);
          setAppsError('');
          return requestJson(instancePath('/debug/packages'), null, T).then(function (result) {
            if (!mountedRef.current) return result;
            setAppsBusy(false);
            if (!result.ok) {
              setAppsError(result.error || T('err.action'));
              return result;
            }
            var data = isObject(result.data) ? result.data : {};
            var list = Array.isArray(data.packages) ? data.packages : [];
            var apps = [];
            for (var i = 0; i < list.length; i += 1) {
              var item = list[i];
              if (!isObject(item) || typeof item.packageName !== 'string' || !item.packageName) continue;
              apps.push({ packageName: item.packageName, apkPath: typeof item.apkPath === 'string' ? item.apkPath : '' });
            }
            apps.sort(function (a, b) {
              return a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0;
            });
            setInstalledApps(apps);
            return result;
          });
        }

        function runAppAction(action, packageName) {
          if (!ready || !packageName || appActionBusy) return;
          var key = action + ':' + packageName;
          setAppActionBusy(key);
          requestJson(instancePath('/debug/action'), {
            method: 'POST',
            body: JSON.stringify({ action: action, packageName: packageName }),
          }, T).then(function (result) {
            if (!mountedRef.current) return;
            setAppActionBusy('');
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 400));
              return;
            }
            pushToast('success', T('apps.done', { action: action, packageName: packageName }));
            loadInstalledApps();
            loadState();
          });
        }

        function toggleApps() {
          var next = !appsOpen;
          setAppsOpen(next);
          if (next) loadInstalledApps();
        }

        function loadSetup(force) {
          if (!mountedRef.current && !force) return;
          setSetupBusy(true);
          requestJson('/apk-vm/setup' + (force ? '?force=1' : ''), null, T).then(function (result) {
            if (!mountedRef.current) return;
            setSetupBusy(false);
            if (result.ok && isObject(result.data)) setSetup(result.data);
          });
        }

        React.useEffect(function () {
          loadSetup(false);
          requestJson('/apk-vm/avds', null, T).then(function (result) {
            if (!mountedRef.current) return;
            if (result.ok && isObject(result.data) && Array.isArray(result.data.avds)) {
              setAvds(result.data.avds);
              if (result.data.current) setAvdPick(result.data.current);
            }
          });
        }, []);

        function switchAvd() {
          if (!avdPick || setupBusy) return;
          setSetupBusy(true);
          requestJson('/apk-vm/avd', { method: 'POST', body: JSON.stringify({ avdName: avdPick }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setSetupBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 500));
              return;
            }
            pushToast('success', T('setup.switch') + ': ' + avdPick);
            loadState();
            loadSetup(true);
          });
        }

        function loadDevices() {
          return requestJson('/apk-vm/devices', null, T).then(function (result) {
            if (!mountedRef.current) return result;
            if (result.ok && isObject(result.data) && Array.isArray(result.data.devices)) {
              setDevices(result.data.devices);
              setDeviceError('');
              var online = result.data.devices.filter(function (entry) {
                return entry && entry.state === 'device';
              });
              if (!devicePick && online.length) setDevicePick(String(online[0].serial || ''));
            } else if (!result.ok) {
              setDeviceError(result.error || T('err.action'));
            }
            return result;
          });
        }

        function attachDevice() {
          if (!devicePick || deviceBusy) return;
          setDeviceBusy(true);
          setDeviceError('');
          requestJson('/apk-vm/device', { method: 'POST', body: JSON.stringify({ serial: devicePick }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setDeviceBusy(false);
            if (!result.ok) {
              var data = isObject(result.data) ? result.data : {};
              pushToast('error', (data.error || result.error || T('err.action')).slice(0, 500));
              return;
            }
            pushToast('success', T('devices.attached', { serial: devicePick }));
            loadState();
            loadDevices();
            loadSetup(true);
            loadApks();
          });
        }

        function detachDevice() {
          if (deviceBusy) return;
          setDeviceBusy(true);
          requestJson('/apk-vm/device', { method: 'POST', body: JSON.stringify({ serial: '' }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setDeviceBusy(false);
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 500));
              return;
            }
            pushToast('success', T('devices.detached'));
            setDevicePick('');
            loadState();
            loadDevices();
            loadSetup(true);
          });
        }

        function runSetupAction(action) {
          if (setupBusy) return;
          setSetupBusy(true);
          requestJson('/apk-vm/setup', { method: 'POST', body: JSON.stringify({ action: action }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            setSetupBusy(false);
            var data = isObject(result.data) ? result.data : {};
            var detail = data.result && data.result.error ? data.result.error : (data.result && data.result.output ? data.result.output : '');
            if (!result.ok || data.ok === false) {
              pushToast('error', (detail || result.error || T('err.state')).slice(0, 500));
              return;
            }
            pushToast('success', action === 'create-avd' ? T('setup.createAvd') : T('setup.ok'));
            loadSetup(true);
            loadState();
          });
        }

        /* ---- actions -------------------------------------------------- */
        function pushToast(kind, text) {
          if (!mountedRef.current) return;
          setToast({ kind: kind, text: text, id: String(Date.now()) + ':' + String(Math.random()) });
        }

        function runVmAction(action) {
          if (vmBusyRef.current) return;
          vmBusyRef.current = true;
          setVmBusy(true);
          requestJson(instancePath('/vm'), { method: 'POST', body: JSON.stringify({ action: action }) }, T).then(function (result) {
            vmBusyRef.current = false;
            if (!mountedRef.current) return;
            setVmBusy(false);
            if (!result.ok) {
              pushToast('error', T('err.action') + ': ' + result.error);
            } else if (action === 'stop') {
              pushToast('success', T('toast.stopped'));
            } else if (action === 'restart') {
              pushToast('success', T('toast.restarted'));
            } else {
              pushToast('success', T('toast.started'));
            }
            loadState();
          });
        }

        function installApk(rawPath) {
          var target = String(rawPath == null ? '' : rawPath).trim();
          if (!target) {
            pushToast('error', T('err.pathEmpty'));
            return;
          }
          if (installingRef.current) return;
          installingRef.current = target;
          setInstalling(target);
          requestJson(instancePath('/install'), { method: 'POST', body: JSON.stringify({ path: target }) }, T).then(function (result) {
            installingRef.current = '';
            if (!mountedRef.current) return;
            setInstalling('');
            if (!result.ok) {
              pushToast('error', T('err.install') + ': ' + result.error);
              return;
            }
            var data = isObject(result.data) ? result.data : {};
            var name = data.label
              ? String(data.label)
              : data.packageName
                ? String(data.packageName)
                : baseName(target);
            pushToast('success', T(data.launched === true ? 'toast.installedLaunched' : 'toast.installed', { name: name }));
            if (pathInput.trim() === target) setPathInput('');
            loadState();
          });
        }

        function uploadApkFile(file) {
          if (!file) return;
          var name = String(file.name || 'upload.apk');
          if (!/\.(?:apk|apks|xapk)$/i.test(name)) {
            pushToast('error', T('upload.invalid'));
            return;
          }
          if (installingRef.current) return;
          installingRef.current = 'upload:' + name;
          setUpload({ name: name, pct: 0 });
          var xhr = new XMLHttpRequest();
          xhr.open('POST', instancePath('/upload'), true);
          xhr.setRequestHeader('x-apk-name', encodeURIComponent(name));
          xhr.upload.onprogress = function (event) {
            if (event && event.lengthComputable && mountedRef.current) {
              setUpload({ name: name, pct: Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))) });
            }
          };
          xhr.onload = function () {
            installingRef.current = '';
            if (!mountedRef.current) return;
            setUpload(null);
            var data = null;
            try {
              data = JSON.parse(xhr.responseText || '{}');
            } catch (error) {
              data = null;
            }
            if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
              pushToast('success', T('upload.done', { name: String(data.label || data.packageName || name) }));
              loadState();
              loadApks();
            } else {
              pushToast('error', T('upload.failed') + ': ' + String((data && data.error) || ('HTTP ' + xhr.status)));
            }
          };
          xhr.onerror = function () {
            installingRef.current = '';
            if (!mountedRef.current) return;
            setUpload(null);
            pushToast('error', T('upload.failed'));
          };
          xhr.send(file);
        }

        function pickApkFile() {
          if (fileInputRef.current && typeof fileInputRef.current.click === 'function') fileInputRef.current.click();
        }

        function onFileInputChange(event) {
          var files = event && event.target && event.target.files;
          var file = files && files.length ? files[0] : null;
          if (event && event.target) event.target.value = '';
          if (file) uploadApkFile(file);
        }

        function onPageDragEnter(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          dragDepthRef.current += 1;
          setDragging(true);
        }

        function onPageDragOver(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (event && event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        }

        function onPageDragLeave(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragging(false);
        }

        function onPageDrop(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          dragDepthRef.current = 0;
          setDragging(false);
          var files = event && event.dataTransfer && event.dataTransfer.files;
          if (files && files.length) uploadApkFile(files[0]);
        }

        function sendInput(payload) {
          requestJson(instancePath('/input'), { method: 'POST', body: JSON.stringify(payload) }, T).then(function (result) {
            if (!result.ok && mountedRef.current) {
              pushToast('error', T('err.input') + ': ' + result.error);
            }
          });
        }

        function sendText() {
          var value = String(textInput == null ? '' : textInput);
          if (!value || !ready) return;
          sendInput({ type: 'text', text: value });
          setTextInput('');
        }

        /* ---- rooted debug console ------------------------------------ */
        function runDebugRequest(url, options, format) {
          if (debugBusy || !ready) return;
          setDebugBusy(true);
          requestJson(url, options, T).then(function (result) {
            if (!mountedRef.current) return;
            setDebugBusy(false);
            if (!result.ok) {
              setDebugOutput((result.error || T('err.state')) + (result.data ? '\n' + JSON.stringify(result.data, null, 2) : ''));
              return;
            }
            var data = isObject(result.data) ? result.data : {};
            setDebugOutput(typeof format === 'function' ? format(data) : JSON.stringify(data, null, 2));
            loadState();
          });
        }

        function runDebugCommand() {
          var command = String(debugCommand == null ? '' : debugCommand).trim();
          if (!command || debugBusy || !ready) return;
          runDebugRequest(
            instancePath('/debug/shell'),
            { method: 'POST', body: JSON.stringify({ command: command }) },
            function (data) {
              var text = '';
              if (data.stdout) text += data.stdout;
              if (data.stderr) text += (text ? '\n' : '') + data.stderr;
              return (text || '(no output)') + '\n[exit ' + data.code + (data.root ? ', root' : '') + ']';
            }
          );
        }

        function runDebugLogcat() {
          runDebugRequest(instancePath('/debug/logcat?lines=200'), null, function (data) {
            return (data.lines || []).join('\n') || '(empty logcat)';
          });
        }

        function stopLiveLogcat() {
          if (logLiveTimerRef.current) {
            clearInterval(logLiveTimerRef.current);
            logLiveTimerRef.current = null;
          }
          setLogLive(false);
        }

        function liveLogcatTick() {
          if (!mountedRef.current || !ready) return;
          requestJson(instancePath('/debug/logcat?lines=200'), null, T).then(function (result) {
            if (!mountedRef.current || !result.ok) return;
            var data = isObject(result.data) ? result.data : {};
            setDebugOutput((data.lines || []).join('\n') || '(empty logcat)');
          });
        }

        function toggleLiveLogcat() {
          if (!ready) return;
          if (logLiveTimerRef.current) {
            stopLiveLogcat();
            return;
          }
          setLogLive(true);
          liveLogcatTick();
          logLiveTimerRef.current = setInterval(liveLogcatTick, 2000);
        }

        function runCrashLogcat() {
          runDebugRequest(instancePath('/debug/logcat?lines=400&buffer=crash'), null, function (data) {
            return (data.lines || []).join('\n') || '(no crash log)';
          });
        }

        function setDeviceClipboard() {
          if (!ready) return;
          var text = String(textInput == null ? '' : textInput);
          if (!text) {
            pushToast('error', T('debug.clipboardEmpty'));
            return;
          }
          requestJson(instancePath('/clipboard'), {
            method: 'POST',
            body: JSON.stringify({ text: text, paste: false }),
          }, T).then(function (result) {
            if (!mountedRef.current) return;
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 300));
              return;
            }
            pushToast('success', T('debug.clipboardSetDone'));
          });
        }

        function getDeviceClipboard() {
          if (!ready) return;
          requestJson(instancePath('/clipboard'), null, T).then(function (result) {
            if (!mountedRef.current) return;
            if (!result.ok) {
              pushToast('error', (result.error || T('err.action')).slice(0, 300));
              return;
            }
            var text = isObject(result.data) ? String(result.data.text || '') : '';
            setDebugOutput('clipboard (' + text.length + ' chars):\n' + text);
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(text).catch(function () {});
            }
            pushToast('success', T('debug.clipboardGot'));
          });
        }

        function runDebugInfo() {
          runDebugRequest(instancePath('/debug/info'), null, function (data) {
            return JSON.stringify(data, null, 2);
          });
        }

        function runDebugRoot() {
          runDebugRequest(instancePath('/debug/root'), { method: 'POST', body: '{}' }, function (data) {
            return data.root ? 'adb root enabled (uid=0)' : 'adb root unavailable on this image';
          });
        }

        function runDebugUi() {
          runDebugRequest(instancePath('/debug/ui'), null, function (data) {
            var xml = String(data.xml || '');
            return 'nodes=' + data.nodes + '  bytes=' + data.bytes + '\n' + xml.slice(0, 20000);
          });
        }

        function runDebugPerf() {
          runDebugRequest(instancePath('/debug/perf'), null, function (data) {
            return JSON.stringify(data, null, 2);
          });
        }

        function runDebugRecord() {
          runDebugRequest(instancePath('/debug/record'), { method: 'POST', body: JSON.stringify({ seconds: 5 }) }, function (data) {
            var localPath = String(data.localPath || '');
            var base = localPath.split(/[\\/]/).pop();
            if (base && /^(apk-vm-shot-|dsh-apk-vm-record-)[A-Za-z0-9._-]+\.(png|mp4)$/.test(base)) {
              var anchor = document.createElement('a');
              anchor.href = '/apk-vm/artifacts?name=' + encodeURIComponent(base);
              anchor.download = base;
              anchor.click();
            }
            return 'recorded ' + data.seconds + 's -> ' + localPath + (data.bytes ? ' (' + data.bytes + ' bytes)' : '');
          });
        }

        function runDebugRotate() {
          var next = inputScreen && inputScreen.width > inputScreen.height ? 'portrait' : 'landscape';
          runDebugRequest(instancePath('/debug/rotate'), { method: 'POST', body: JSON.stringify({ orientation: next }) }, function (data) {
            return 'rotation locked to ' + data.rotation + ' (' + next + ')';
          });
        }

        function downloadScreenshot() {
          if (!ready) return;
          if (videoMode === 'h264' && canvasRef.current && typeof canvasRef.current.toBlob === 'function') {
            canvasRef.current.toBlob(function (blob) {
              if (!blob) return;
              var url = URL.createObjectURL(blob);
              var link = document.createElement('a');
              link.href = url;
              link.download = 'apk-vm-' + Date.now() + '.png';
              link.click();
              setTimeout(function () {
                URL.revokeObjectURL(url);
              }, 1000);
            });
            return;
          }
          var anchor = document.createElement('a');
          anchor.href = instancePath('/debug/screenshot');
          anchor.download = 'apk-vm-' + Date.now() + '.png';
          anchor.click();
        }

        function setStreamTarget(fps) {
          var value = Math.min(10, Math.max(1, Math.round(Number(fps) || 2)));
          requestJson('/apk-vm/stream', { method: 'POST', body: JSON.stringify({ fps: value }) }, T).then(function (result) {
            if (!mountedRef.current) return;
            if (!result.ok) {
              pushToast('error', T('fps.target') + ': ' + result.error);
              return;
            }
            pushToast('success', T('fps.target') + ': ' + value + ' fps');
            loadState();
          });
        }

        /* ---- screen input geometry ----------------------------------- */
        // Map a pointer position inside the rendered screen box to device
        // pixels, honoring the object-fit:contain letterboxing.
        function toDevice(clientX, clientY) {
          var node = screenRef.current;
          if (!node || !inputScreen || typeof node.getBoundingClientRect !== 'function') return null;
          var rect = node.getBoundingClientRect();
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
          var scale = Math.min(rect.width / inputScreen.width, rect.height / inputScreen.height);
          if (!isFinite(scale) || scale <= 0) return null;
          var offsetX = (rect.width - inputScreen.width * scale) / 2;
          var offsetY = (rect.height - inputScreen.height * scale) / 2;
          return {
            x: clamp(Math.round((clientX - rect.left - offsetX) / scale), 0, inputScreen.width - 1),
            y: clamp(Math.round((clientY - rect.top - offsetY) / scale), 0, inputScreen.height - 1),
          };
        }

        function toVideo(clientX, clientY) {
          var node = screenRef.current;
          var target = displayScreen || screen;
          if (!node || !target || typeof node.getBoundingClientRect !== 'function') return null;
          var rect = node.getBoundingClientRect();
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
          var scale = Math.min(rect.width / target.width, rect.height / target.height);
          if (!isFinite(scale) || scale <= 0) return null;
          var offsetX = (rect.width - target.width * scale) / 2;
          var offsetY = (rect.height - target.height * scale) / 2;
          return {
            x: clamp(Math.round((clientX - rect.left - offsetX) / scale), 0, target.width - 1),
            y: clamp(Math.round((clientY - rect.top - offsetY) / scale), 0, target.height - 1),
          };
        }

        function postTouch(action, pointerId, clientX, clientY) {
          var point = toVideo(clientX, clientY);
          if (!point) return;
          var id = activeInstanceRef.current || 'default';
          var path = id === 'default' ? '/apk-vm/touch' : '/apk-vm/instances/' + encodeURIComponent(id) + '/touch';
          try {
            fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: action, pointerId: pointerId, x: point.x, y: point.y }),
              cache: 'no-store',
            }).catch(function () {});
          } catch (error) {
            /* multi-touch is best-effort */
          }
        }

        function sendMultiTouch(action) {
          var multi = multiTouchRef.current;
          if (!multi) return;
          multi.pointers.forEach(function (point, pointerId) {
            postTouch(action, pointerId, point.x, point.y);
          });
        }

        function onPointerDown(event) {
          if (inspectMode) return;
          if (!ready || !inputScreen) return;
          if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== undefined) return;
          var node = screenRef.current;
          if (!node) return;
          try {
            if (typeof node.focus === 'function') node.focus();
          } catch (error) {
            /* focus is best-effort */
          }
          try {
            if (typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId);
          } catch (error) {
            /* pointer capture is best-effort */
          }
          if (event.pointerType !== 'mouse') {
            var multi = multiTouchRef.current;
            if (multi) {
              multi.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
              postTouch('down', event.pointerId, event.clientX, event.clientY);
              if (typeof event.preventDefault === 'function') event.preventDefault();
              return;
            }
            var first = dragRef.current;
            if (first && first.pointerId !== event.pointerId) {
              // Second finger: promote the gesture to a scrcpy multi-touch pinch.
              dragRef.current = null;
              multiTouchRef.current = { pointers: new Map(), lastMove: 0 };
              multiTouchRef.current.pointers.set(first.pointerId, {
                x: first.lastX === undefined ? first.x0 : first.lastX,
                y: first.lastY === undefined ? first.y0 : first.lastY,
              });
              multiTouchRef.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
              sendMultiTouch('down');
              if (typeof event.preventDefault === 'function') event.preventDefault();
              return;
            }
          }
          dragRef.current = {
            x0: event.clientX,
            y0: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            startedAt: Date.now(),
            pointerId: event.pointerId,
          };
          if (typeof event.preventDefault === 'function') event.preventDefault();
        }

        function onPointerMove(event) {
          var multi = multiTouchRef.current;
          if (multi) {
            if (multi.pointers.has(event.pointerId)) {
              multi.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
              var now = Date.now();
              if (now - multi.lastMove >= 16) {
                multi.lastMove = now;
                sendMultiTouch('move');
              }
              if (typeof event.preventDefault === 'function') event.preventDefault();
            }
            return;
          }
          var drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            drag.lastX = event.clientX;
            drag.lastY = event.clientY;
          }
        }

        function onPointerUp(event) {
          if (inspectMode) return;
          var multi = multiTouchRef.current;
          if (multi && multi.pointers.has(event.pointerId)) {
            postTouch('up', event.pointerId, event.clientX, event.clientY);
            multi.pointers.delete(event.pointerId);
            if (multi.pointers.size === 0) multiTouchRef.current = null;
            if (typeof event.preventDefault === 'function') event.preventDefault();
            return;
          }
          var drag = dragRef.current;
          dragRef.current = null;
          if (!drag || drag.pointerId !== event.pointerId) return;
          var node = screenRef.current;
          if (node) {
            try {
              if (typeof node.releasePointerCapture === 'function') node.releasePointerCapture(event.pointerId);
            } catch (error) {
              /* ignore */
            }
          }
          if (!ready || !inputScreen) return;
          var dx = event.clientX - drag.x0;
          var dy = event.clientY - drag.y0;
          var distance = Math.sqrt(dx * dx + dy * dy);
          var from = toDevice(drag.x0, drag.y0);
          var to = toDevice(event.clientX, event.clientY);
          if (!from || !to) return;
          if (distance >= SWIPE_THRESHOLD_PX) {
            sendInput({
              type: 'swipe',
              x1: from.x,
              y1: from.y,
              x2: to.x,
              y2: to.y,
              duration: clamp(Date.now() - drag.startedAt, 80, 800),
            });
          } else {
            sendInput({ type: 'tap', x: from.x, y: from.y });
          }
        }

        function onPointerCancel(event) {
          var multi = multiTouchRef.current;
          if (multi) {
            multi.pointers.forEach(function (point, pointerId) {
              postTouch('cancel', pointerId, point.x, point.y);
            });
            multiTouchRef.current = null;
          }
          dragRef.current = null;
        }

        function onContextMenu(event) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
        }

        /* ---- small render helpers ------------------------------------ */
        function actionBtn(label, options) {
          var opts = isObject(options) ? options : {};
          var className =
            'apkvm-btn' +
            (opts.variant ? ' apkvm-btn-' + opts.variant : '') +
            (opts.small ? ' apkvm-btn-sm' : '');
          var children = [];
          if (opts.icon) {
            children.push(
              h('span', { key: 'icon', style: { display: 'inline-flex', alignItems: 'center' }, 'aria-hidden': 'true' }, opts.icon)
            );
          }
          children.push(h('span', { key: 'label' }, label));
          return h(
            'button',
            {
              key: opts.key,
              type: 'button',
              className: className,
              disabled: opts.disabled === true,
              title: opts.title || label,
              'aria-label': opts.ariaLabel || label,
              onClick: opts.onClick,
            },
            children
          );
        }

        function keyBtn(label, icon, key) {
          return actionBtn(label, {
            key: 'key-' + key,
            small: true,
            icon: icon,
            disabled: !ready,
            onClick: function () {
              sendInput({ type: 'key', key: key });
            },
          });
        }

        function onPathChange(event) {
          setPathInput(event && event.target ? String(event.target.value) : '');
        }

        function onPathKeyDown(event) {
          if (event && event.key === 'Enter') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            installApk(pathInput);
          }
        }

        function onTextChange(event) {
          setTextInput(event && event.target ? String(event.target.value) : '');
        }

        function onTextKeyDown(event) {
          if (event && event.key === 'Enter') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            sendText();
          }
        }

        function renderApkRow(apk, index) {
          var isInstalling = installing !== '' && installing === apk.path;
          var isCurrent = currentApkPath !== '' && currentApkPath === apk.path;
          var tag = null;
          if (isCurrent && apkInfo) {
            tag = h(
              'span',
              { key: 'tag', className: 'apkvm-tag' + (apkInfo.launched ? ' ok' : '') },
              T(apkInfo.launched ? 'tag.launched' : 'tag.installed')
            );
          }
          return h(
            'div',
            { key: apk.path + ':' + index, className: 'apkvm-apk' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
              h('img', {
                className: 'apkvm-apk-icon',
                src: '/apk-vm/apk-icon?path=' + encodeURIComponent(apk.path),
                alt: '',
                loading: 'lazy',
                onError: function (event) {
                  if (event && event.currentTarget) event.currentTarget.style.display = 'none';
                },
              }),
              h('span', { className: 'apkvm-apk-name', title: apk.path }, apk.name),
              apk.kind && apk.kind !== 'apk'
                ? h('span', { className: 'apkvm-tag' }, String(apk.kind).toUpperCase())
                : null,
              h('span', { className: 'apkvm-dim', style: { flex: 'none' } }, formatBytes(apk.size))
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
              h('span', { className: 'apkvm-dim', style: { flex: '1 1 auto' }, title: apk.path }, apk.path),
              tag,
              actionBtn(isInstalling ? T('apks.installing') : T('action.installLaunch'), {
                key: 'install',
                small: true,
                disabled: !ready || installing !== '',
                onClick: function () {
                  installApk(apk.path);
                },
              })
            )
          );
        }

        function renderOverlay() {
          if (ready) {
            if (frameUrl || videoMode === 'h264') return null;
            return h(
              'div',
              { className: 'apkvm-overlay' },
              h('div', { className: 'apkvm-spinner' }),
              h('div', { className: 'apkvm-overlay-title' }, T('overlay.waitingFrame'))
            );
          }
          if (displayState === 'loading') {
            return h(
              'div',
              { className: 'apkvm-overlay' },
              h('div', { className: 'apkvm-spinner' }),
              h('div', { className: 'apkvm-overlay-title' }, T('overlay.connecting'))
            );
          }
          if (busyState) {
            return h(
              'div',
              { className: 'apkvm-overlay' },
              h('div', { className: 'apkvm-spinner' }),
              h('div', { className: 'apkvm-overlay-title' }, T('overlay.booting')),
              h('div', { className: 'apkvm-overlay-detail' }, T('overlay.bootingHint')),
              actionBtn(vmBusy ? T('action.stopping') : T('action.stop'), {
                key: 'overlay-stop',
                variant: 'danger',
                small: true,
                disabled: vmBusy,
                onClick: function () {
                  runVmAction('stop');
                },
              })
            );
          }
          if (displayState === 'error') {
            var errorDetail = vmInfo && vmInfo.error ? vmInfo.error : stateError;
            return h(
              'div',
              { className: 'apkvm-overlay' },
              h('span', { className: 'apkvm-overlay-icon' }, h(PhoneIcon, { size: 34 })),
              h('div', { className: 'apkvm-overlay-title' }, T('overlay.error')),
              errorDetail ? h('div', { className: 'apkvm-overlay-detail' }, errorDetail) : null,
              actionBtn(vmBusy ? T('action.starting') : T('overlay.retry'), {
                key: 'overlay-retry',
                variant: 'primary',
                disabled: vmBusy,
                onClick: function () {
                  runVmAction('start');
                },
              })
            );
          }
          return h(
            'div',
            { className: 'apkvm-overlay' },
            h('span', { className: 'apkvm-overlay-icon' }, h(PhoneIcon, { size: 34 })),
            h('div', { className: 'apkvm-overlay-title' }, T('overlay.stopped')),
            h('div', { className: 'apkvm-overlay-detail' }, T('overlay.startedHint')),
            actionBtn(vmBusy ? T('action.starting') : T('action.start'), {
              key: 'overlay-start',
              variant: 'primary',
              disabled: vmBusy,
              onClick: function () {
                runVmAction('start');
              },
            })
          );
        }

        /* ---- elements ------------------------------------------------ */
        var diagCard = null;
        if (busyState || displayState === 'error' || stateError) {
          diagCard = h(
            'div',
            { className: 'apkvm-card' },
            h(
              'div',
              { className: 'apkvm-cardhead' },
              h('span', { className: 'apkvm-card-title' }, T('log.title')),
              h('span', { className: 'apkvm-dim', style: { marginLeft: 'auto' } }, stateLabel)
            ),
            vmInfo && vmInfo.error ? h('div', { className: 'apkvm-inline-error', title: vmInfo.error }, vmInfo.error) : null,
            h('div', { ref: logRef, className: 'apkvm-log apkvm-scroll' }, logText ? logText : T('log.waiting'))
          );
        }

        var setupCard = null;
        if (setup) {
          var setupMissing = Array.isArray(setup.missing) ? setup.missing.filter(Boolean) : [];
          var setupActions = (Array.isArray(setup.actions) ? setup.actions : []).filter(function (entry) {
            return entry && entry.available && (entry.id === 'create-avd' || entry.id === 'install-image' || entry.id === 'install-tools' || entry.id === 'bootstrap-sdk');
          });
          var setupBadgeOk = setup.ok === true;
          var setupBadgeStyle = {
            marginLeft: 'auto',
            fontSize: '10px',
            lineHeight: '15px',
            padding: '0 6px',
            borderRadius: '999px',
            border: '1px solid ' + (setupBadgeOk ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'),
            color: setupBadgeOk ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
            whiteSpace: 'nowrap',
          };
          function setupRow(label, ok, detail) {
            return h(
              'div',
              { className: 'apkvm-setup-row', title: detail || label },
              h('span', { className: 'apkvm-setup-dot ' + (ok ? 'ok' : 'bad') }, ok ? '✓' : '✕'),
              h('span', { className: 'apkvm-setup-label' }, label),
              h('span', { className: 'apkvm-dim apkvm-setup-detail' }, detail || (ok ? 'OK' : 'missing'))
            );
          }
          setupCard = h(
            'details',
            { className: 'apkvm-card apkvm-debug apkvm-setup' },
            h(
              'summary',
              { className: 'apkvm-debug-summary' },
              h('span', { className: 'apkvm-card-title' }, T('setup.title')),
              h('span', { style: setupBadgeStyle }, setupBusy ? '…' : setupBadgeOk ? T('setup.ok') : T('setup.missing')),
              h(
                'span',
                { className: 'apkvm-dim', style: { marginLeft: '6px' }, title: setupMissing.join('\n') },
                setup.sdkRoot || setup.platform || ''
              ),
              h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
            ),
            h(
              'div',
              { className: 'apkvm-debug-body' },
              setupRow(T('setup.sdk'), Boolean(setup.sdkRoot && setup.adbPath), setup.sdkRoot || ''),
              setupRow(T('setup.accel'), Boolean(setup.accel && setup.accel.available), setup.accel ? setup.accel.backend || setup.accel.detail || '' : ''),
              setupRow(T('setup.image'), setup.systemImagePresent === true, setup.systemImage || ''),
              setupRow(T('setup.avd'), setup.avdPresent === true, setup.avdName || ''),
              setupMissing.length
                ? h('div', { className: 'apkvm-inline-error', title: setupMissing.join('\n') }, setupMissing.slice(0, 3).join(' · '))
                : null,
              setup.hypervisorNotes && setup.accel && !setup.accel.available
                ? h(
                    'div',
                    { className: 'apkvm-dim', title: (setup.hypervisorNotes || []).join('\n') },
                    (setup.hypervisorNotes || []).slice(0, 2).join(' · ')
                  )
                : null,
              avds.length > 1
                ? h(
                    'div',
                    { className: 'apkvm-toolsline' },
                    h(
                      'select',
                      {
                        value: avdPick,
                        disabled: setupBusy,
                        onChange: function (event) {
                          setAvdPick(event && event.target ? String(event.target.value) : '');
                        },
                        style: {
                          font: 'inherit',
                          fontSize: '11px',
                          flex: '1 1 auto',
                          minWidth: 0,
                          background: 'var(--dsw-alias-bg-base)',
                          color: 'var(--dsw-alias-label-primary)',
                          border: '1px solid var(--dsw-alias-border-l2)',
                          borderRadius: '6px',
                          padding: '2px 4px',
                        },
                      },
                      avds.map(function (name) {
                        return h('option', { key: name, value: name }, name);
                      })
                    ),
                    actionBtn(T('setup.switch'), {
                      key: 'switch-avd',
                      small: true,
                      disabled: setupBusy || !avdPick,
                      onClick: switchAvd,
                    })
                  )
                : null,
              h(
                'div',
                { className: 'apkvm-toolsline' },
                h(
                  'select',
                  {
                    value: devicePick,
                    disabled: deviceBusy,
                    title: T('devices.title'),
                    onChange: function (event) {
                      setDevicePick(event && event.target ? String(event.target.value) : '');
                    },
                    style: {
                      font: 'inherit',
                      fontSize: '11px',
                      flex: '1 1 auto',
                      minWidth: 0,
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: '6px',
                      padding: '2px 4px',
                    },
                  },
                  h('option', { value: '' }, T('devices.select')),
                  devices.map(function (entry) {
                    var detail = entry.serial + ' · ' + entry.state + (entry.model ? ' · ' + entry.model : '');
                    return h('option', { key: entry.serial, value: entry.serial }, detail);
                  })
                ),
                actionBtn(T('devices.attach'), {
                  key: 'attach-device',
                  small: true,
                  disabled: deviceBusy || !devicePick,
                  onClick: attachDevice,
                }),
                vmInfo && vmInfo.external
                  ? actionBtn(T('devices.detach'), {
                      key: 'detach-device',
                      small: true,
                      disabled: deviceBusy,
                      onClick: detachDevice,
                    })
                  : null
              ),
              vmInfo && vmInfo.external
                ? h('div', { className: 'apkvm-dim' }, T('devices.current', { serial: vmInfo.externalSerial || '' }))
                : null,
              deviceError ? h('div', { className: 'apkvm-inline-error' }, deviceError) : null,
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
                setupActions.map(function (entry) {
                  var label = entry.id === 'create-avd'
                    ? T('setup.createAvd')
                    : entry.id === 'install-tools'
                      ? T('setup.installTools')
                      : entry.id === 'bootstrap-sdk'
                        ? T('setup.bootstrapSdk')
                        : T('setup.installImage');
                  return actionBtn(label, {
                    key: 'setup-' + entry.id,
                    small: true,
                    disabled: setupBusy,
                    onClick: function () {
                      runSetupAction(entry.id);
                    },
                  });
                }),
                actionBtn(T('setup.refresh'), {
                  key: 'setup-refresh',
                  small: true,
                  disabled: setupBusy,
                  onClick: function () {
                    loadSetup(true);
                  },
                })
              )
            )
          );
        }

        var apkCard = h(
          'div',
          { className: 'apkvm-card apkvm-apkcard' },
          h(
            'div',
            { className: 'apkvm-cardhead' },
            h('span', { className: 'apkvm-card-title' }, T('apks.title')),
            h(
              'span',
              { className: 'apkvm-dim', style: { marginLeft: 'auto' } },
              apks === null ? (apksBusy ? T('apks.scanning') : '') : T('apks.count', { n: apks.length })
            ),
            actionBtn(T('upload.button'), {
              key: 'upload-apk',
              small: true,
              disabled: !ready || installing !== '' || Boolean(upload),
              onClick: pickApkFile,
            }),
            actionBtn(apksBusy ? T('apks.scanning') : T('action.rescan'), {
              key: 'rescan',
              small: true,
              disabled: apksBusy,
              onClick: function () {
                loadApks();
              },
            })
          ),
          h('input', {
            ref: fileInputRef,
            className: 'apkvm-fileinput',
            type: 'file',
            accept: '.apk,.apks,.xapk,application/vnd.android.package-archive,application/octet-stream',
            onChange: onFileInputChange,
            'aria-label': T('upload.button'),
          }),
          upload
            ? h(
                'div',
                { className: 'apkvm-uploadbar' },
                h('div', { className: 'apkvm-uploadbar-text' }, T('upload.uploading', { name: upload.name })),
                h('div', { className: 'apkvm-uploadbar-pct' }, upload.pct + '%'),
                h(
                  'div',
                  { className: 'apkvm-progress' },
                  h('div', { className: 'apkvm-progress-fill', style: { width: Math.max(2, upload.pct) + '%' } })
                )
              )
            : null,
          apksError ? h('div', { className: 'apkvm-inline-error' }, T('err.apks') + ': ' + apksError) : null,
          h(
            'div',
            { className: 'apkvm-list apkvm-scroll' },
            apks === null
              ? h(
                  'div',
                  { className: 'apkvm-empty' },
                  apksBusy ? h('span', { className: 'apkvm-spinner apkvm-spinner-sm' }) : null,
                  h('span', null, T('apks.scanning'))
                )
              : apks.length === 0
                ? h('div', { className: 'apkvm-empty' }, T('apks.empty'))
                : apks.map(renderApkRow)
          ),
          h(
            'div',
            { className: 'apkvm-toolsline', title: T('manual.hint') },
            h('input', {
              className: 'apkvm-input',
              type: 'text',
              value: pathInput,
              placeholder: apkInfo && apkInfo.path ? apkInfo.path : T('manual.placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: onPathChange,
              onKeyDown: onPathKeyDown,
              disabled: installing !== '',
              'aria-label': T('manual.title'),
            }),
            actionBtn(installing !== '' ? T('apks.installing') : T('action.installLaunch'), {
              key: 'install-path',
              variant: 'primary',
              small: true,
              disabled: !ready || installing !== '' || !pathInput.trim(),
              onClick: function () {
                installApk(pathInput);
              },
            })
          ),
          roots.length
            ? h('div', { className: 'apkvm-dim', title: roots.join('\n') }, T('apks.roots', { roots: rootsLabel }))
            : null
        );

        var debugBadgeStyle = {
          fontSize: '10px',
          lineHeight: '15px',
          padding: '0 6px',
          borderRadius: '999px',
          border: '1px solid ' + (rootActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'),
          color: rootActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
        };
        var instancesCard = instancesList.length > 1
          ? h(
              'details',
              { className: 'apkvm-card apkvm-instances' },
              h(
                'summary',
                { className: 'apkvm-debug-summary' },
                h('span', { className: 'apkvm-card-title' }, T('instances.manage')),
                h('span', { className: 'apkvm-dim', style: { marginLeft: 'auto' } }, String(instancesList.length)),
                h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
              ),
              h(
                'div',
                { className: 'apkvm-instlist' },
                instancesList.map(function (entry) {
                  var isDefault = entry.id === 'default';
                  var owner = entry.owner ? String(entry.owner).replace(/^agent-/, '').slice(0, 14) : '';
                  var idle = Number(entry.idleMs) >= 0 ? Math.max(0, Math.round(Number(entry.idleMs) / 1000)) : null;
                  return h(
                    'div',
                    { className: 'apkvm-instrow', key: entry.id },
                    h(
                      'div',
                      { className: 'apkvm-instname', title: entry.id },
                      isDefault ? T('instances.default') : entry.id,
                      h('span', { className: 'apkvm-dim' }, ' · ' + (entry.state || '?') + (owner ? ' · ' + owner : ''))
                    ),
                    h(
                      'div',
                      { className: 'apkvm-instmeta' },
                      idle !== null && !isDefault ? T('instances.idle', { seconds: idle }) : ''
                    ),
                    isDefault
                      ? null
                      : h(
                          'div',
                          { className: 'apkvm-instactions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'apkvm-mini',
                              title: T('instances.stop'),
                              onClick: function (event) {
                                event.preventDefault();
                                stopInstanceById(entry.id);
                              },
                            },
                            T('instances.stop')
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'apkvm-mini danger',
                              title: T('instances.delete'),
                              onClick: function (event) {
                                event.preventDefault();
                                destroyInstanceById(entry.id);
                              },
                            },
                            T('instances.delete')
                          )
                        )
                  );
                })
              )
            )
          : null;

        var appsCard = h(
          'details',
          {
            className: 'apkvm-card apkvm-apps',
            open: appsOpen,
            onToggle: function (event) {
              var next = Boolean(event && event.target && event.target.open);
              if (next !== appsOpen) {
                setAppsOpen(next);
                if (next) loadInstalledApps();
              }
            },
          },
          h(
            'summary',
            { className: 'apkvm-debug-summary' },
            h('span', { className: 'apkvm-card-title' }, T('apps.title')),
            h('span', { className: 'apkvm-dim', style: { marginLeft: 'auto' } }, installedApps.length ? String(installedApps.length) : ''),
            h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
          ),
          h(
            'div',
            { className: 'apkvm-appsbody' },
            h(
              'div',
              { className: 'apkvm-toolsline' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'apkvm-mini',
                  disabled: !ready || appsBusy,
                  onClick: function (event) {
                    event.preventDefault();
                    loadInstalledApps();
                  },
                },
                appsBusy ? T('apps.loading') : T('apps.refresh')
              ),
              h('span', { className: 'apkvm-dim' }, T('apps.thirdParty'))
            ),
            appsError ? h('div', { className: 'apkvm-error' }, appsError) : null,
            installedApps.length
              ? h(
                  'div',
                  { className: 'apkvm-appslist apkvm-scroll' },
                  installedApps.map(function (app) {
                    var pkg = app.packageName;
                    var busyKey = appActionBusy && appActionBusy.indexOf(':' + pkg) >= 0;
                    return h(
                      'div',
                      { className: 'apkvm-approw', key: pkg },
                      h('span', { className: 'apkvm-appname', title: pkg }, pkg),
                      h(
                        'span',
                        { className: 'apkvm-appactions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'apkvm-mini',
                            disabled: !ready || Boolean(appActionBusy),
                            onClick: function (event) {
                              event.preventDefault();
                              runAppAction('force-stop', pkg);
                            },
                          },
                          T('apps.stop')
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'apkvm-mini',
                            disabled: !ready || Boolean(appActionBusy),
                            onClick: function (event) {
                              event.preventDefault();
                              runAppAction('clear-data', pkg);
                            },
                          },
                          T('apps.clear')
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'apkvm-mini danger',
                            disabled: !ready || Boolean(appActionBusy),
                            onClick: function (event) {
                              event.preventDefault();
                              runAppAction('uninstall', pkg);
                            },
                          },
                          T('apps.uninstall')
                        )
                      ),
                      busyKey ? h('span', { className: 'apkvm-dim' }, T('debug.busy')) : null
                    );
                  })
                )
              : h('div', { className: 'apkvm-dim' }, appsBusy ? T('apps.loading') : T('apps.empty'))
          )
        );

        var debugCard = h(
          'details',
          { className: 'apkvm-card apkvm-debug' },
          h(
            'summary',
            { className: 'apkvm-debug-summary' },
            h('span', { className: 'apkvm-card-title' }, T('debug.title')),
            h('span', { style: debugBadgeStyle, title: 'adbd uid' }, rootActive ? T('debug.state.root') : T('debug.state.shell')),
            h(
              'span',
              { className: 'apkvm-dim', style: { marginLeft: 'auto' }, title: identityText || T('debug.title') },
              videoMode === 'h264'
                ? T('stream.h264', { fps: h264Meta && h264Meta.maxFps ? h264Meta.maxFps : 60 })
                : identityText
            ),
            h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
          ),
          h(
            'div',
            { className: 'apkvm-debug-body' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
            h('input', {
              className: 'apkvm-input',
              type: 'text',
              value: debugCommand,
              placeholder: T('debug.placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              disabled: !ready || debugBusy,
              onChange: function (event) {
                setDebugCommand(event && event.target ? String(event.target.value) : '');
              },
              onKeyDown: function (event) {
                if (event && event.key === 'Enter') {
                  event.preventDefault();
                  runDebugCommand();
                }
              },
              'aria-label': T('debug.placeholder'),
            }),
            actionBtn(debugBusy ? T('debug.busy') : T('debug.run'), {
              key: 'debug-run',
              variant: 'primary',
              small: true,
              disabled: !ready || debugBusy || !debugCommand.trim(),
              onClick: runDebugCommand,
            })
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
            actionBtn(T('debug.logcat'), { key: 'debug-logcat', small: true, disabled: !ready || debugBusy, onClick: runDebugLogcat }),
            actionBtn(logLive ? T('debug.liveStop') : T('debug.live'), {
              key: 'debug-live-logcat',
              small: true,
              disabled: !ready,
              onClick: toggleLiveLogcat,
            }),
            actionBtn(T('debug.crash'), { key: 'debug-crash', small: true, disabled: !ready || debugBusy, onClick: runCrashLogcat }),
            actionBtn(T('debug.clipboardSet'), {
              key: 'debug-clipboard-set',
              small: true,
              disabled: !ready,
              onClick: setDeviceClipboard,
            }),
            actionBtn(T('debug.clipboardGet'), {
              key: 'debug-clipboard-get',
              small: true,
              disabled: !ready,
              onClick: getDeviceClipboard,
            }),
            actionBtn(T('debug.props'), { key: 'debug-props', small: true, disabled: !ready || debugBusy, onClick: runDebugInfo }),
            actionBtn(T('debug.rootAction'), { key: 'debug-root', small: true, disabled: !ready || debugBusy || rootActive, onClick: runDebugRoot }),
            actionBtn(T('debug.ui'), { key: 'debug-ui', small: true, disabled: !ready || debugBusy, onClick: runDebugUi }),
            actionBtn(T('debug.perf'), { key: 'debug-perf', small: true, disabled: !ready || debugBusy, onClick: runDebugPerf }),
            actionBtn(T('debug.record'), { key: 'debug-record', small: true, disabled: !ready || debugBusy, onClick: runDebugRecord }),
            actionBtn(T('debug.rotate'), { key: 'debug-rotate', small: true, disabled: !ready || debugBusy, onClick: runDebugRotate })
          ),
          h(
            'label',
            {
              title: T('fps.hint'),
              style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
            },
            h('span', null, T('fps.target')),
            h(
              'select',
              {
                value: String(targetFps),
                disabled: !ready || videoMode === 'h264' || activeInstance !== 'default',
                onChange: function (event) {
                  setStreamTarget(event && event.target ? event.target.value : targetFps);
                },
                style: {
                  font: 'inherit',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '6px',
                  padding: '1px 4px',
                },
              },
              [1, 2, 4, 6, 8].map(function (n) {
                return h('option', { key: n, value: String(n) }, n + ' fps');
              })
            ),
            videoMode === 'h264'
              ? h('span', null, T('stream.h264', { fps: h264Meta && h264Meta.maxFps ? h264Meta.maxFps : 60 }))
              : actualFps > 0
                ? h('span', null, '· ' + T('fps.actual', { fps: actualFps.toFixed(1) }))
                : null
          ),
          h(
            'pre',
            {
              className: 'apkvm-scroll',
              style: {
                margin: 0,
                maxHeight: '170px',
                overflow: 'auto',
                padding: '6px 7px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-secondary)',
                font: '11px/15px ui-monospace, SFMono-Regular, Menlo, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            },
            debugOutput || T('debug.empty')
          )
          )
        );

        var flowCard = h(
          'details',
          { className: 'apkvm-card apkvm-debug' },
          h(
            'summary',
            { className: 'apkvm-debug-summary' },
            h('span', { className: 'apkvm-card-title' }, T('flow.title')),
            h('span', { className: 'apkvm-tag' + (flowRecording ? ' ok' : '') }, flowRecording ? T('flow.recording') : T('flow.count', { n: flows.length })),
            h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
          ),
          h(
            'div',
            { className: 'apkvm-debug-body' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: flowName,
                placeholder: T('flow.name'),
                disabled: flowRecording,
                onChange: function (event) {
                  setFlowName(event && event.target ? String(event.target.value) : '');
                },
                'aria-label': T('flow.name'),
              }),
              actionBtn(flowRecording ? T('flow.stop') : T('flow.start'), {
                key: 'flow-record',
                small: true,
                variant: flowRecording ? 'danger' : 'primary',
                disabled: !ready,
                onClick: toggleFlowRecording,
              })
            ),
            flows.length
              ? h(
                  'div',
                  { className: 'apkvm-list', style: { maxHeight: '140px' } },
                  flows.slice(0, 12).map(function (flow) {
                    return h(
                      'div',
                      { className: 'apkvm-apk', key: flow.id },
                      h('span', { className: 'apkvm-apk-name' }, flow.name || flow.id),
                      h(
                        'span',
                        { style: { display: 'flex', gap: '5px', alignItems: 'center' } },
                        h('span', { className: 'apkvm-dim' }, T('flow.count', { n: flow.events || 0 })),
                        actionBtn(T('flow.play'), {
                          key: 'flow-play-' + flow.id,
                          small: true,
                          disabled: !ready || Boolean(flowBusy),
                          onClick: function () {
                            replayFlow(flow.id);
                          },
                        }),
                        actionBtn(T('flow.delete'), {
                          key: 'flow-delete-' + flow.id,
                          small: true,
                          variant: 'danger',
                          disabled: Boolean(flowBusy),
                          onClick: function () {
                            deleteFlow(flow.id);
                          },
                        })
                      )
                    );
                  })
                )
              : h('div', { className: 'apkvm-dim' }, T('flow.empty'))
          )
        );

        var networkCard = h(
          'details',
          { className: 'apkvm-card apkvm-debug' },
          h(
            'summary',
            { className: 'apkvm-debug-summary' },
            h('span', { className: 'apkvm-card-title' }, T('network.title')),
            h('span', { className: 'apkvm-tag' }, T('network.proxy')),
            h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
          ),
          h(
            'div',
            { className: 'apkvm-debug-body' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: proxy.host,
                placeholder: T('network.host'),
                spellCheck: false,
                disabled: proxyBusy,
                onChange: function (event) {
                  setProxy({ host: event && event.target ? String(event.target.value) : '', port: proxy.port });
                },
                'aria-label': T('network.host'),
              }),
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: proxy.port,
                placeholder: T('network.port'),
                spellCheck: false,
                disabled: proxyBusy,
                style: { maxWidth: '86px' },
                onChange: function (event) {
                  setProxy({ host: proxy.host, port: event && event.target ? String(event.target.value) : '' });
                },
                'aria-label': T('network.port'),
              })
            ),
            h('input', {
              className: 'apkvm-input',
              type: 'text',
              value: caPath,
              placeholder: T('network.caPath'),
              spellCheck: false,
              disabled: proxyBusy,
              onChange: function (event) {
                setCaPath(event && event.target ? String(event.target.value) : '');
              },
              'aria-label': T('network.caPath'),
            }),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
              actionBtn(T('network.apply'), {
                key: 'proxy-apply',
                small: true,
                disabled: !ready || proxyBusy || !proxy.host.trim() || !proxy.port.trim(),
                onClick: applyProxy,
              }),
              actionBtn(T('network.clear'), {
                key: 'proxy-clear',
                small: true,
                disabled: !ready || proxyBusy,
                onClick: clearProxy,
              }),
              actionBtn(T('network.installCa'), {
                key: 'ca-install',
                small: true,
                disabled: !ready || proxyBusy,
                onClick: installCa,
              })
            ),
            h('div', { className: 'apkvm-dim' }, T('network.caPath')),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
              h('span', null, T('network.mode')),
              h(
                'select',
                {
                  value: (network && network.mode) || 'isolated',
                  disabled: Boolean(networkBusy) || !ready,
                  onChange: function (event) {
                    networkAction('mode', { mode: event && event.target ? String(event.target.value) : 'isolated' });
                  },
                  style: {
                    font: 'inherit',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: '6px',
                    padding: '1px 4px',
                  },
                },
                h('option', { value: 'isolated' }, T('network.isolated')),
                h('option', { value: 'shared' }, T('network.shared'))
              )
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
              h('span', { className: 'apkvm-card-title' }, T('network.forwards')),
              actionBtn(T('network.test'), {
                key: 'network-test',
                small: true,
                disabled: !ready || Boolean(networkBusy),
                onClick: function () {
                  networkAction('test', { host: proxy.host || '', port: proxy.port || undefined });
                },
              })
            ),
            network && Array.isArray(network.forwards) && network.forwards.length
              ? network.forwards.map(function (rule) {
                  return h(
                    'div',
                    { key: 'forward-' + rule.localPort, className: 'apkvm-dim', style: { display: 'flex', alignItems: 'center', gap: '5px' } },
                    h('span', { style: { flex: '1 1 auto' } }, 'tcp:' + rule.localPort + ' -> guest tcp:' + rule.remotePort),
                    rule.shared ? h('span', { className: 'apkvm-tag ok' }, 'shared') : null,
                    actionBtn(T('network.remove'), {
                      key: 'forward-remove-' + rule.localPort,
                      small: true,
                      variant: 'danger',
                      disabled: Boolean(networkBusy),
                      onClick: function () {
                        removePortForward(rule.localPort);
                      },
                    })
                  );
                })
              : h('div', { className: 'apkvm-dim' }, T('network.forwards')),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: forwardLocal,
                placeholder: T('network.forwardLocal'),
                spellCheck: false,
                disabled: Boolean(networkBusy),
                onChange: function (event) {
                  setForwardLocal(event && event.target ? String(event.target.value) : '');
                },
                'aria-label': T('network.forwardLocal'),
              }),
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: forwardRemote,
                placeholder: T('network.forwardRemote'),
                spellCheck: false,
                disabled: Boolean(networkBusy),
                onChange: function (event) {
                  setForwardRemote(event && event.target ? String(event.target.value) : '');
                },
                'aria-label': T('network.forwardRemote'),
              }),
              actionBtn(T('network.addForward'), {
                key: 'forward-add',
                small: true,
                disabled: !ready || Boolean(networkBusy) || !forwardLocal.trim() || !forwardRemote.trim(),
                onClick: addPortForward,
              })
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
              h('input', {
                type: 'checkbox',
                checked: forwardShared,
                disabled: Boolean(networkBusy),
                onChange: function (event) {
                  setForwardShared(Boolean(event && event.target && event.target.checked));
                },
              }),
              h('span', null, T('network.shared'))
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: dnsText,
                placeholder: T('network.dns'),
                spellCheck: false,
                disabled: Boolean(networkBusy),
                onChange: function (event) {
                  setDnsText(event && event.target ? String(event.target.value) : '');
                },
                'aria-label': T('network.dns'),
              }),
              actionBtn(T('network.applyDns'), {
                key: 'dns-apply',
                small: true,
                disabled: !ready || Boolean(networkBusy),
                onClick: applyDns,
              })
            ),
            h('textarea', {
              className: 'apkvm-input',
              value: hostsText,
              placeholder: T('network.hosts'),
              spellCheck: false,
              disabled: Boolean(networkBusy),
              style: { minHeight: '46px', height: '46px', resize: 'vertical', padding: '4px 8px' },
              onChange: function (event) {
                setHostsText(event && event.target ? String(event.target.value) : '');
              },
              'aria-label': T('network.hosts'),
            }),
            h('input', {
              className: 'apkvm-input',
              type: 'text',
              value: pcapPath,
              placeholder: T('network.pcapPath'),
              spellCheck: false,
              disabled: Boolean(networkBusy),
              onChange: function (event) {
                setPcapPath(event && event.target ? String(event.target.value) : '');
              },
              'aria-label': T('network.pcapPath'),
            }),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
              actionBtn(T('network.applyHosts'), {
                key: 'hosts-apply',
                small: true,
                disabled: !ready || Boolean(networkBusy),
                onClick: applyHosts,
              }),
              actionBtn('pcap', {
                key: 'pcap-apply',
                small: true,
                disabled: !ready || Boolean(networkBusy) || !pcapPath.trim(),
                onClick: function () {
                  networkAction('pcap', { path: pcapPath.trim() });
                },
              }),
              network && network.pcap && network.pcap.enabled
                ? h(
                    'a',
                    {
                      href: instancePath('/network/pcap'),
                      download: 'capture.pcap',
                      style: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary)' },
                    },
                    T('network.pcap')
                  )
                : null
            ),
            network && network.mode === 'shared' ? h('div', { className: 'apkvm-dim' }, T('network.sharedHint')) : null
          )
        );

        var storageCard = h(
          'details',
          { className: 'apkvm-card apkvm-debug' },
          h(
            'summary',
            { className: 'apkvm-debug-summary' },
            h('span', { className: 'apkvm-card-title' }, T('storage.title')),
            h(
              'span',
              { className: 'apkvm-dim', style: { marginLeft: 'auto' } },
              storage ? formatBytes((storage.totals && storage.totals.avdBytes) || 0) : '…'
            ),
            h('span', { className: 'apkvm-chevron', 'aria-hidden': 'true' }, '▸')
          ),
          h(
            'div',
            { className: 'apkvm-debug-body' },
            !storage
              ? h('div', { className: 'apkvm-dim' }, storageError || T('storage.empty'))
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 } },
                  h(
                    'div',
                    { className: 'apkvm-dim', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
                    h('span', null, T('storage.avds', { size: (storage.avds || []).length }) + ': ' + formatBytes((storage.totals && storage.totals.avdBytes) || 0)),
                    h('span', null, T('storage.snapshots') + ': ' + formatBytes((storage.totals && storage.totals.snapshotBytes) || 0)),
                    h('span', null, T('storage.sdk') + ': ' + formatBytes((storage.totals && storage.totals.sdkBytes) || 0)),
                    h('span', null, T('storage.temp') + ': ' + formatBytes((storage.totals && storage.totals.tempBytes) || 0)),
                    storage.disk
                      ? h('span', null, T('storage.free') + ': ' + formatBytes(storage.disk.freeBytes))
                      : null
                  ),
                  (storage.avds || []).slice(0, 4).map(function (avd) {
                    return h(
                      'div',
                      {
                        key: 'storage-' + avd.name,
                        className: 'apkvm-apk',
                        style: { padding: '5px 7px', gap: '3px' },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                        h('span', { className: 'apkvm-apk-name', title: avd.path }, avd.name),
                        avd.active ? h('span', { className: 'apkvm-tag ok' }, T('storage.active')) : null,
                        avd.orphan ? h('span', { className: 'apkvm-tag' }, T('storage.orphan')) : null
                      ),
                      h(
                        'div',
                        { className: 'apkvm-dim' },
                        formatBytes(avd.totalBytes || 0) +
                          ' · ' +
                          T('storage.snapshots') +
                          ' ' +
                          formatBytes(avd.snapshotBytes || 0)
                      )
                    );
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } },
                    actionBtn(storageBusy === 'load' ? '…' : T('storage.refresh'), {
                      key: 'storage-refresh',
                      small: true,
                      disabled: Boolean(storageBusy),
                      onClick: loadStorage,
                    }),
                    actionBtn(storageBusy === 'temp' ? '…' : T('storage.cleanTemp'), {
                      key: 'storage-temp',
                      small: true,
                      disabled: Boolean(storageBusy),
                      onClick: function () {
                        cleanStorage('temp');
                      },
                    }),
                    actionBtn(
                      storageConfirm === 'snapshots'
                        ? T('storage.confirm')
                        : storageBusy === 'snapshots'
                          ? '…'
                          : T('storage.cleanSnapshots'),
                      {
                        key: 'storage-snapshots',
                        small: true,
                        disabled: Boolean(storageBusy),
                        onClick: function () {
                          cleanStorage('snapshots');
                        },
                      }
                    ),
                    (storage.recommendations || []).some(function (item) {
                      return item.code === 'orphan-avds';
                    }) || (storage.avds || []).some(function (item) {
                      return item.orphan;
                    })
                      ? actionBtn(
                          storageConfirm === 'orphan-avds'
                            ? T('storage.confirm')
                            : storageBusy === 'orphan-avds'
                              ? '…'
                              : T('storage.cleanOrphans'),
                          {
                            key: 'storage-orphans',
                            small: true,
                            disabled: Boolean(storageBusy),
                            onClick: function () {
                              cleanStorage('orphan-avds');
                            },
                          }
                        )
                      : null
                  ),
                  storageError ? h('div', { className: 'apkvm-dim' }, storageError) : null
                )
          )
        );

        var primaryAction =
          ready || busyState
            ? actionBtn(vmBusy ? T('action.stopping') : T('action.stop'), {
                key: 'vm-stop',
                variant: 'danger',
                disabled: vmBusy,
                onClick: function () {
                  runVmAction('stop');
                },
              })
            : actionBtn(vmBusy ? T('action.starting') : T('action.start'), {
                key: 'vm-start',
                variant: 'primary',
                disabled: vmBusy || displayState === 'loading',
                onClick: function () {
                  runVmAction('start');
                },
              });

        function openInBetterSidebar() {
          var service = getBetterSidebar();
          if (!service || typeof service.openTab !== 'function') {
            setToast({ id: Date.now(), kind: 'error', text: T('sidebar.unavailable') });
            return;
          }
          var snapshot = null;
          try {
            snapshot = typeof service.getSnapshot === 'function' ? service.getSnapshot() : null;
          } catch (error) {
            snapshot = null;
          }
          if (!snapshot || !snapshot.sessionId) {
            setToast({ id: Date.now(), kind: 'error', text: T('sidebar.noSession') });
            return;
          }
          try {
            service.openTab({ type: BETTER_SIDEBAR_TAB_ID, target: 'right' });
            setToast({ id: Date.now(), kind: 'success', text: T('sidebar.opened') });
          } catch (error) {
            setToast({
              id: Date.now(),
              kind: 'error',
              text: (error && error.message) || T('sidebar.unavailable'),
            });
          }
        }

        var instanceOptions = instancesList.length
          ? instancesList
          : [{ id: 'default', kind: 'default', state: displayState }];
        var instanceSelector = h(
          'select',
          {
            className: 'apkvm-instance-select',
            value: activeInstance,
            title: T('instances.label'),
            'aria-label': T('instances.label'),
            disabled: instanceBusy,
            onChange: function (event) {
              setActiveInstanceId(event && event.target ? String(event.target.value) : 'default');
            },
          },
          instanceOptions.map(function (entry) {
            var label = entry.id === 'default' ? T('instances.default') : entry.id;
            var owner = entry.owner ? String(entry.owner).replace(/^agent-/, '').slice(0, 10) : '';
            return h(
              'option',
              { key: entry.id, value: entry.id },
              label + (entry.state ? ' · ' + entry.state : '') + (owner ? ' · ' + owner : '')
            );
          })
        );

        var headerEl = h(
          'header',
          { className: 'apkvm-header' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
            h('span', { className: 'apkvm-headicon' }, h(PhoneIcon, { size: 18 })),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('h1', { className: 'apkvm-title' }, T('title')),
              h('p', { className: 'apkvm-subtitle', title: subtitleText }, subtitleText)
            )
          ),
          h('span', { className: 'apkvm-spacer' }),
          h(
            'span',
            { className: 'apkvm-pill', title: pillMeta.join(' · ') || stateLabel },
            h('span', { className: 'apkvm-dot ' + displayState }),
            h('span', null, stateLabel),
            pillMeta.length ? h('span', { className: 'apkvm-pillmeta' }, '· ' + pillMeta.join(' · ')) : null
          ),
          instanceSelector,
          actionBtn(T('instances.new'), {
            key: 'new-instance',
            small: true,
            disabled: instanceBusy,
            onClick: createInstance,
          }),
          activeInstance !== 'default'
            ? actionBtn(T('instances.delete'), {
                key: 'destroy-instance',
                small: true,
                variant: 'danger',
                disabled: instanceBusy,
                onClick: destroyActiveInstance,
              })
            : null,
          h(
            'span',
            {
              className: 'apkvm-fps',
              title: T('fps.hint'),
              style: {
                fontSize: '11px',
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-secondary)',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                flex: 'none',
              },
            },
            T('fps.label') +
              ' ' +
              (actualFps > 0 ? T('fps.actual', { fps: actualFps.toFixed(1) }) : '—') +
              ' · ' +
              (videoMode === 'h264' ? T('fps.mode.h264') : T('fps.mode.png'))
          ),
          primaryAction,
          !embedded && sidebarService
            ? actionBtn(T('action.openSidebar'), {
                key: 'open-sidebar',
                icon: h(PhoneIcon, { size: 13 }),
                ariaLabel: T('a11y.openSidebar'),
                onClick: openInBetterSidebar,
              })
            : null,
          actionBtn(T('action.refresh'), {
            key: 'refresh',
            icon: h(IconRefresh, { size: 13 }),
            ariaLabel: T('a11y.refresh'),
            onClick: refreshAll,
          })
        );

        var toastBanner = toast
          ? h(
              'div',
              { className: 'apkvm-banner ' + (toast.kind === 'success' ? 'success' : 'error'), role: 'status' },
              h('span', { className: 'apkvm-banner-text' }, toast.text),
              h(
                'button',
                {
                  type: 'button',
                  className: 'apkvm-banner-close',
                  onClick: function () {
                    setToast(null);
                  },
                  'aria-label': T('action.dismiss'),
                },
                '×'
              )
            )
          : null;

        var stateErrorBanner =
          stateError && !toast
            ? h(
                'div',
                { className: 'apkvm-banner error', role: 'alert' },
                h('span', { className: 'apkvm-banner-text' }, T('err.state') + ': ' + stateError),
                actionBtn(T('overlay.retry'), {
                  key: 'state-retry',
                  small: true,
                  ariaLabel: T('a11y.retry'),
                  onClick: refreshAll,
                })
              )
            : null;

        function onScreenKeyDown(event) {
          if (!ready || inspectMode || !event) return;
          var target = event.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
          var keyMap = {
            Backspace: 'DEL',
            Delete: 'FORWARD_DEL',
            Enter: 'ENTER',
            Escape: 'BACK',
            Tab: 'TAB',
            ArrowUp: 'DPAD_UP',
            ArrowDown: 'DPAD_DOWN',
            ArrowLeft: 'DPAD_LEFT',
            ArrowRight: 'DPAD_RIGHT',
            Home: 'MOVE_HOME',
          };
          if (keyMap[event.key]) {
            event.preventDefault();
            sendInput({ type: 'key', key: keyMap[event.key] });
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (typeof event.key === 'string' && event.key.length === 1 && !event.isComposing) {
            event.preventDefault();
            sendInput({ type: 'text', text: event.key });
          }
        }

        var screenEl = h(
          'div',
          {
            ref: screenRef,
            className: 'apkvm-screen' + (ready ? ' ready' : ''),
            style: { aspectRatio: screenAspect },
            tabIndex: 0,
            'aria-label': T('screen.hint'),
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerCancel: onPointerCancel,
            onKeyDown: onScreenKeyDown,
            onContextMenu: onContextMenu,
            onDragStart: onContextMenu,
          },
          frameUrl && videoMode !== 'h264'
            ? h('img', { className: 'apkvm-frame', src: frameUrl, alt: T('screen.alt'), draggable: false })
            : null,
          videoMode === 'h264'
            ? h('canvas', {
                ref: canvasRef,
                className: 'apkvm-video',
                width: h264Meta && h264Meta.width ? h264Meta.width : 720,
                height: h264Meta && h264Meta.height ? h264Meta.height : 1280,
                style: {
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  pointerEvents: 'none',
                },
              })
            : null,
          renderInspector(),
          renderOverlay()
        );

        var stageEl = h(
          'section',
          { className: 'apkvm-stage' },
          h('div', { className: 'apkvm-phonewrap' }, h('div', { className: 'apkvm-phone' }, screenEl)),
          h(
            'div',
            { className: 'apkvm-controls' },
            h(
              'div',
              { className: 'apkvm-keys' },
              keyBtn(T('keys.back'), h(IconBack, { size: 13 }), 'back'),
              keyBtn(T('keys.home'), h(IconHome, { size: 13 }), 'home'),
              keyBtn(T('keys.recents'), h(IconRecents, { size: 13 }), 'recents'),
              keyBtn(T('keys.power'), h(IconPower, { size: 13 }), 'power')
            ),
            actionBtn(T('debug.screenshot'), {
              key: 'save-shot',
              small: true,
              disabled: !ready,
              onClick: downloadScreenshot,
            }),
            actionBtn(inspectMode ? T('inspect.close') : T('inspect.toggle'), {
              key: 'inspect-toggle',
              small: true,
              variant: inspectMode ? 'primary' : undefined,
              disabled: !ready || inspectBusy,
              onClick: toggleInspectMode,
            }),
            h(
              'div',
              { className: 'apkvm-textrow' },
              h('input', {
                className: 'apkvm-input',
                type: 'text',
                value: textInput,
                placeholder: T('input.placeholder'),
                disabled: !ready,
                spellCheck: false,
                autoComplete: 'off',
                onChange: onTextChange,
                onKeyDown: onTextKeyDown,
                'aria-label': T('input.send'),
              }),
              actionBtn(T('input.send'), {
                key: 'send-text',
                small: true,
                disabled: !ready || !textInput,
                onClick: sendText,
              })
            )
          ),
          h('div', { className: 'apkvm-stagehint' }, T('screen.hint')),
          ready && videoMode !== 'h264' && clientReport && clientReport.h264Supported === false
            ? h('div', { className: 'apkvm-stagehint' }, T('fps.fallbackHint'))
            : null,
          ready && frameError
            ? h('div', { className: 'apkvm-stagehint error' }, T('err.frame') + ': ' + frameError)
            : null
        );

        return h(
          'div',
          {
            className: 'apkvm-page' + (embedded ? ' apkvm-embedded' : ''),
            onDragEnter: onPageDragEnter,
            onDragOver: onPageDragOver,
            onDragLeave: onPageDragLeave,
            onDrop: onPageDrop,
          },
          h('style', { key: 'apkvm-style' }, CSS_TEXT),
          headerEl,
          stateErrorBanner,
          toastBanner,
          h(
            'div',
            { className: 'apkvm-body' },
            h(
              'aside',
              { className: 'apkvm-aside apkvm-scroll' },
              setupCard,
              apkCard,
              instancesCard,
              debugCard,
              flowCard,
              networkCard,
              storageCard,
              appsCard,
              diagCard,
              h('div', { className: 'apkvm-footnote', title: T('hint.boot') }, T('hint.short')),
              h('span', { className: 'apkvm-sr-only' }, T('hint.boot'))
            ),
            stageEl
          ),
          dragging
            ? h(
                'div',
                { className: 'apkvm-drop-overlay' },
                h('span', null, T('upload.drop')),
                h('span', { className: 'apkvm-dim' }, T('upload.detail'))
              )
            : null
        );
      }

      ApkVmPage.displayName = 'ApkVmPage';
      return ApkVmPage;
    }

    /* ------------------------------------------------------------------ *
     * Cordis plugin wiring.
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      if (!isObject(ctx)) return;

      var localeService = ctx.locale;
      var registered = function () {
        return localeService.register(NS, { en: EN, zh: ZH });
      };
      if (localeService && typeof localeService.register === 'function') {
        if (typeof ctx.effect === 'function') {
          ctx.effect(registered, NS + ': dictionaries');
        } else {
          registered();
        }
      }

      var t = null;
      if (localeService && typeof localeService.bind === 'function') {
        try {
          t = localeService.bind(NS);
        } catch (error) {
          t = null;
        }
      }
      if (typeof t !== 'function') {
        t = function (key) {
          return hasOwn(EN, key) ? EN[key] : String(key);
        };
      }

      var Page = createPage(getTranslate);
      var Boundary = createBoundary();
      var BoundaryPage = function ApkVmSlot(props) {
        var translate = props && typeof props.t === 'function' ? props.t : getTranslate();
        return h(Boundary, { translate: translate }, h(Page, props));
      };
      BoundaryPage.displayName = 'ApkVmSlot';

      var slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return;
      }

      slots.inject('main', function () {
        return slots.register({ name: 'main', key: NS, locale: NS }, BoundaryPage);
      });

      slots.inject('sidebar.panellist', function () {
        return slots.register(
          {
            name: 'sidebar.panellist',
            id: NS,
            order: 30,
            label: function () {
              return t('nav.label');
            },
            locale: NS,
          },
          function (props) {
            return h(PhoneIcon, { size: props && typeof props.size === 'number' ? props.size : 18 });
          }
        );
      });

      /* ---- optional dsh-better-sidebar tab integration ----------------- *
       * The service is published by that plugin as `ctx.betterSidebar`; it may
       * activate before or after this bundle, so defer through ctx.inject and
       * register one tab descriptor with the documented API. On deployments
       * without the plugin nothing is registered and the `main` panel remains
       * the only surface.                                                 */

      function registerBetterSidebarTab(sub, service) {
        if (!service || typeof service.registerTab !== 'function') return;
        var mount = function () {
          var dispose = service.registerTab({
            id: BETTER_SIDEBAR_TAB_ID,
            title: function () {
              return t('sidebar.tab');
            },
            description: function () {
              return t('sidebar.desc');
            },
            icon: function (size) {
              return h(PhoneIcon, { size: typeof size === 'number' ? size : 18 });
            },
            order: 60,
            single: true,
            component: function (tabProps) {
              return h(Boundary, { translate: t }, h(Page, Object.assign({}, tabProps, { embedded: true })));
            },
          });
          publishBetterSidebar(service);
          return function () {
            if (typeof dispose === 'function') dispose();
            if (getBetterSidebar() === service) publishBetterSidebar(null);
          };
        };
        var effect =
          sub && typeof sub.effect === 'function'
            ? sub.effect
            : typeof ctx.effect === 'function'
              ? ctx.effect
              : null;
        if (effect) {
          effect(mount, NS + ': dsh-better-sidebar tab');
        } else {
          mount();
        }
      }

      function attachBetterSidebar(root) {
        if (!isObject(root)) return;
        if (typeof root.inject === 'function') {
          try {
            root.inject(['betterSidebar'], function (sub) {
              var service = null;
              try {
                service =
                  sub && (sub.betterSidebar || (typeof sub.get === 'function' ? sub.get('betterSidebar') : null));
              } catch (error) {
                service = null;
              }
              if (service) registerBetterSidebarTab(sub, service);
            });
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.error === 'function') {
              console.error('[apk-vm] optional dsh-better-sidebar service is unavailable', error);
            }
          }
          return;
        }
        var existing = null;
        try {
          existing = typeof root.get === 'function' ? root.get('betterSidebar') : null;
        } catch (error) {
          existing = null;
        }
        if (existing) registerBetterSidebarTab(root, existing);
      }

      attachBetterSidebar(ctx);

      function getTranslate() {
        return t;
      }
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});
