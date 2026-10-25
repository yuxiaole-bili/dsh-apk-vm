'use strict';

/**
 * UI smoke test for the dsh-apk-vm static web client half.
 *
 * The package is "type": "module", so client.js is NOT loaded with require():
 * it is evaluated in a vm sandbox that supplies `window.__ModuleLoader__`
 * (exactly what the DSH Web boot does) plus fake globals (fetch / URL / timers).
 * A miniature React hook runtime renders the real component tree and we drive
 * the real UI handlers against a fake same-origin Host (/apk-vm/*).
 *
 * Usage: node spike/ui-smoke.cjs   (exits non-zero on failure)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const clientPath = path.join(root, 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');

let failures = 0;
const failuresList = [];
function check(name, condition, detail) {
  if (condition) {
    console.log('PASS  ' + name);
    return true;
  }
  failures += 1;
  failuresList.push(name + (detail !== undefined ? ' — ' + detail : ''));
  console.error('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''));
  return false;
}

/* ------------------------------------------------------------------ *
 * 1. Bundle wrapper (evaluated in a browser-like sandbox).
 * ------------------------------------------------------------------ */

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: function (mod) {
        loaded = mod;
      },
    },
  },
  console: console,
};
vm.createContext(sandbox);
let loadError = null;
try {
  vm.runInContext(source, sandbox, { filename: clientPath });
} catch (error) {
  loadError = error;
}

check('bundle evaluates without throwing', loadError === null, loadError && loadError.stack);
check('bundle calls window.__ModuleLoader__.load', !!loaded);
check('bundle id is dsh-apk-vm', !!loaded && loaded.id === 'dsh-apk-vm', loaded && loaded.id);
check('factory is a function', !!loaded && typeof loaded.factory === 'function');

/* ------------------------------------------------------------------ *
 * 2. Miniature React (hook runtime) used by the real component code.
 * ------------------------------------------------------------------ */

let activeRuntime = null;
let scheduledSetState = false;

function createRuntime() {
  return {
    index: 0,
    states: [],
    refs: [],
    deps: [],
    cleanups: [],
    pending: [],
    effectErrors: [],
    resetRender() {
      this.index = 0;
      this.pending = [];
    },
  };
}

const fakeReact = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { type: type, props: props || {}, children: children };
  },
  Component: class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(partial) {
      this.state = Object.assign({}, this.state, typeof partial === 'function' ? partial(this.state) : partial);
    }
  },
  useState(initial) {
    const runtime = activeRuntime;
    const index = runtime.index++;
    if (!(index in runtime.states)) {
      runtime.states[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [
      runtime.states[index],
      function (next) {
        runtime.states[index] = typeof next === 'function' ? next(runtime.states[index]) : next;
        scheduledSetState = true;
      },
    ];
  },
  useRef(initial) {
    const runtime = activeRuntime;
    const index = runtime.index++;
    if (!(index in runtime.refs)) runtime.refs[index] = { current: initial };
    return runtime.refs[index];
  },
  useEffect(fn, deps) {
    const runtime = activeRuntime;
    const index = runtime.index++;
    const previous = runtime.deps[index];
    let changed = true;
    if (deps === undefined) changed = true;
    else if (previous === undefined) changed = true;
    else if (previous.length !== deps.length) changed = true;
    else {
      changed = false;
      for (let i = 0; i < deps.length; i += 1) {
        if (!Object.is(previous[i], deps[i])) {
          changed = true;
          break;
        }
      }
    }
    runtime.deps[index] = deps === undefined ? undefined : deps.slice();
    if (changed) runtime.pending.push({ index: index, fn: fn });
  },
};

const requireMock = function (id) {
  if (id === 'react') return fakeReact;
  throw new Error('unexpected require: ' + id);
};

const plugin = loaded.factory(requireMock);

check('exports name = apk-vm', plugin && plugin.name === 'apk-vm', plugin && plugin.name);
check(
  'exports inject = [slots, locale]',
  !!plugin && Array.isArray(plugin.inject) && plugin.inject.length === 2 && plugin.inject[0] === 'slots' && plugin.inject[1] === 'locale',
  JSON.stringify(plugin && plugin.inject)
);
check('exports apply is a function', !!plugin && typeof plugin.apply === 'function');

/* ------------------------------------------------------------------ *
 * 3. Fake cordis context: capture locale + slot registrations.
 * ------------------------------------------------------------------ */

const localeDictionaries = {};
const slotRegistrations = [];
const effectLabels = [];
let localeName = 'en';

const ctx = {
  effect(fn, label) {
    effectLabels.push(label);
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : function () {};
  },
  locale: {
    register(namespace, dict) {
      localeDictionaries[namespace] = dict;
      return function () {};
    },
    bind(namespace) {
      return function (key) {
        const dict = localeDictionaries[namespace];
        if (!dict) return undefined;
        const table = dict[localeName] || dict.en;
        return table ? table[key] : undefined;
      };
    },
  },
  slots: {
    inject(name, factory) {
      factory();
      return function () {};
    },
    register(spec, component) {
      slotRegistrations.push({ spec: spec, component: component });
      return function () {};
    },
  },
};

let applyError = null;
try {
  plugin.apply(ctx);
} catch (error) {
  applyError = error;
}
check('apply() does not throw', applyError === null, applyError && applyError.stack);
check('locale effect registered', effectLabels.indexOf('apk-vm: dictionaries') !== -1, JSON.stringify(effectLabels));
check('dictionary registered under apk-vm', !!localeDictionaries['apk-vm']);
check(
  'dictionary has en + zh',
  !!localeDictionaries['apk-vm'] && !!localeDictionaries['apk-vm'].en && !!localeDictionaries['apk-vm'].zh
);

const enDict = localeDictionaries['apk-vm'] ? localeDictionaries['apk-vm'].en : {};
const zhDict = localeDictionaries['apk-vm'] ? localeDictionaries['apk-vm'].zh : {};
const enKeys = Object.keys(enDict).sort();
const zhKeys = Object.keys(zhDict).sort();
check('en and zh dictionaries have identical key sets', JSON.stringify(enKeys) === JSON.stringify(zhKeys));
check('dictionary is reasonably complete (>= 60 keys)', enKeys.length >= 60, String(enKeys.length));

const requiredKeys = [
  'nav.label', 'title', 'subtitle', 'state.ready', 'state.stopped', 'state.error', 'state.loading',
  'action.start', 'action.stop', 'action.refresh', 'action.rescan', 'action.installLaunch',
  'apks.title', 'apks.empty', 'apks.scanning', 'apks.installing', 'manual.title', 'manual.hint',
  'log.title', 'log.waiting', 'hint.boot', 'overlay.connecting', 'overlay.stopped', 'overlay.error',
  'overlay.waitingFrame', 'overlay.retry', 'screen.alt', 'screen.hint', 'keys.back', 'keys.home',
  'keys.recents', 'keys.power', 'input.placeholder', 'input.send', 'tag.installed', 'tag.launched',
  'toast.started', 'toast.stopped', 'toast.installed', 'toast.installedLaunched', 'err.state', 'err.apks',
  'err.install', 'err.input', 'err.action', 'err.frame', 'err.render', 'err.pathEmpty', 'pill.boot',
  'apk.current', 'a11y.refresh', 'a11y.retry', 'action.dismiss',
  'upload.button', 'upload.drop', 'upload.detail', 'setup.title', 'setup.ok', 'setup.missing',
  'debug.ui', 'debug.perf', 'debug.record', 'debug.rotate', 'debug.screenshot',
];
requiredKeys.forEach(function (key) {
  check(
    'locale key present: ' + key,
    typeof enDict[key] === 'string' && enDict[key].length > 0 && typeof zhDict[key] === 'string' && zhDict[key].length > 0
  );
});

/* Strip comments before source-pattern scanning (the header documents the
 * contract, and comments must not be mistaken for code). */
const codeSource = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

/* Static T('...')/tr('...')/t('...') keys used by the source must exist. */
const usedKeys = new Set();
const keyPattern = /(?:^|[^A-Za-z0-9_$])(?:T|tr|t)\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)'/g;
let keyMatch = keyPattern.exec(codeSource);
while (keyMatch) {
  usedKeys.add(keyMatch[1]);
  keyMatch = keyPattern.exec(source);
}
['stopped', 'starting', 'booting', 'ready', 'error', 'loading'].forEach(function (state) {
  usedKeys.add('state.' + state);
});
const missingUsed = Array.from(usedKeys).filter(function (key) {
  return typeof enDict[key] !== 'string' || typeof zhDict[key] !== 'string';
});
check('every static locale key used by client.js exists in en+zh', missingUsed.length === 0, missingUsed.join(', '));

/* ------------------------------------------------------------------ *
 * 4. Slot registrations.
 * ------------------------------------------------------------------ */

check('two slots registered', slotRegistrations.length === 2, String(slotRegistrations.length));
const mainReg = slotRegistrations.find(function (entry) {
  return entry.spec && entry.spec.name === 'main';
});
const sideReg = slotRegistrations.find(function (entry) {
  return entry.spec && entry.spec.name === 'sidebar.panellist';
});
check('main slot registered', !!mainReg);
check(
  'main slot spec = {name: main, key: apk-vm, locale: apk-vm}',
  !!mainReg &&
    mainReg.spec.key === 'apk-vm' &&
    mainReg.spec.locale === 'apk-vm' &&
    Object.keys(mainReg.spec).sort().join(',') === 'key,locale,name',
  mainReg && JSON.stringify(mainReg.spec)
);
check('main slot component is a function', !!mainReg && typeof mainReg.component === 'function');
check('sidebar.panellist slot registered', !!sideReg);
check(
  'sidebar slot spec = {name, id: apk-vm, order: 30, label, locale}',
  !!sideReg &&
    sideReg.spec.id === 'apk-vm' &&
    sideReg.spec.order === 30 &&
    sideReg.spec.locale === 'apk-vm' &&
    typeof sideReg.spec.label === 'function',
  sideReg && JSON.stringify(Object.assign({}, sideReg.spec, { label: typeof sideReg.spec.label }))
);
localeName = 'en';
check('sidebar label (en) = "APK VM"', !!sideReg && sideReg.spec.label() === 'APK VM', sideReg && sideReg.spec.label());
localeName = 'zh';
check('sidebar label (zh) = "APK 虚拟机"', !!sideReg && sideReg.spec.label() === 'APK 虚拟机', sideReg && sideReg.spec.label());
localeName = 'en';

const glyphElement = sideReg.component({ size: 16 });
const glyphRenderedTree = typeof glyphElement.type === 'function' ? glyphElement.type(glyphElement.props) : glyphElement;
const glyphSvg = findFirst(glyphRenderedTree, function (node) {
  return node && node.type === 'svg';
});
check('sidebar glyph renders an svg', !!glyphSvg && glyphSvg.props.width === 16 && glyphSvg.props.viewBox === '0 0 24 24');
check('sidebar glyph uses currentColor stroke', !!glyphSvg && glyphSvg.props.stroke === 'currentColor');

/* ------------------------------------------------------------------ *
 * 5. Faked browser globals inside the sandbox (Host HTTP, object URLs,
 *    timers; the sandbox is where client.js resolves those globals).
 * ------------------------------------------------------------------ */

const fakeTimers = [];
let blobCounter = 0;
const revokedUrls = [];

const fetchLog = [];
const READY_STATE = {
  ok: true,
  vm: {
    state: 'ready',
    serial: 'emulator-5554',
    avd: 'dsh_api34',
    bootMs: 125000,
    error: '',
    logTail: ['[boot] kernel ready', '[boot] android ready'],
  },
  screen: { width: 1080, height: 2400 },
  apk: { path: 'D:\\apks\\demo.apk', packageName: 'com.demo.app', label: 'Demo App', launched: true },
};
const APK_LIST = {
  ok: true,
  roots: ['D:\\apks', 'C:\\apks', 'E:\\more', 'F:\\extra'],
  apks: [
    { path: 'D:\\apks\\demo.apk', name: 'demo.apk', size: 2048, mtime: 1700000000000 },
    { path: 'D:\\apks\\other.apk', name: 'other.apk', size: 5 * 1024 * 1024, mtime: 1700000001000 },
  ],
};

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: function () {
      return Promise.resolve(JSON.stringify(payload));
    },
  };
}

function frameResponse() {
  return {
    ok: true,
    status: 200,
    blob: function () {
      return Promise.resolve({ size: 16, type: 'image/png' });
    },
  };
}

let offlineMode = false;
sandbox.fetch = function (url, init) {
  const target = String(url);
  fetchLog.push({ url: target, init: init || {} });
  if (offlineMode) return Promise.reject(new Error('network down'));
  if (target.indexOf('/apk-vm/frame') === 0) return Promise.resolve(frameResponse());
  if (target === '/apk-vm/state') return Promise.resolve(jsonResponse(READY_STATE));
  if (target === '/apk-vm/apks') return Promise.resolve(jsonResponse(APK_LIST));
  if (target === '/apk-vm/vm') return Promise.resolve(jsonResponse({ ok: true }));
  if (target === '/apk-vm/install') {
    return Promise.resolve(jsonResponse({ ok: true, packageName: 'com.demo.app', label: 'Demo App', launched: true }));
  }
  if (target === '/apk-vm/input') return Promise.resolve(jsonResponse({ ok: true }));
  return Promise.resolve(jsonResponse({ ok: false, error: 'unexpected route: ' + target }));
};

sandbox.URL = {
  createObjectURL: function () {
    blobCounter += 1;
    return 'blob:apk-vm/' + blobCounter;
  },
  revokeObjectURL: function (url) {
    revokedUrls.push(url);
  },
};

sandbox.setTimeout = function (fn, ms) {
  fakeTimers.push({ fn: fn, ms: ms });
  return fakeTimers.length;
};
sandbox.clearTimeout = function () {};
sandbox.setInterval = function () {
  return 0;
};
sandbox.clearInterval = function () {};

function flushAsync() {
  let chain = Promise.resolve();
  for (let i = 0; i < 8; i += 1) {
    chain = chain.then(function () {
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      });
    });
  }
  return chain;
}

/* Element-tree helpers (fake createElement output). */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach(function (child) {
      walk(child, visit);
    });
    return;
  }
  if (typeof node !== 'object' || node.type === undefined) return;
  visit(node);
  if (Array.isArray(node.children)) {
    node.children.forEach(function (child) {
      walk(child, visit);
    });
  }
}

function findFirst(node, predicate) {
  let found = null;
  walk(node, function (element) {
    if (!found && predicate(element)) found = element;
  });
  return found;
}

function findAll(node, predicate) {
  const matches = [];
  walk(node, function (element) {
    if (predicate(element)) matches.push(element);
  });
  return matches;
}

function textOf(node) {
  const parts = [];
  walk(node, function (element) {
    if (typeof element.props.children === 'string') parts.push(element.props.children);
    element.children.forEach(function (child) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    });
  });
  return parts.join(' ');
}

function buttonWithText(tree, label) {
  return findFirst(tree, function (element) {
    return element.type === 'button' && textOf(element).indexOf(label) !== -1;
  });
}

async function settlePage(runtime, Page, translate) {
  activeRuntime = runtime;
  let first = null;
  let last = null;
  for (let pass = 0; pass < 14; pass += 1) {
    runtime.resetRender();
    scheduledSetState = false;
    const element = Page({ t: translate });
    last = element;
    if (pass === 0) first = element;
    const effects = runtime.pending.slice();
    runtime.pending = [];
    effects.forEach(function (effect) {
      const cleanup = runtime.cleanups[effect.index];
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (error) {
          runtime.effectErrors.push(error);
        }
      }
      runtime.cleanups[effect.index] = null;
      let result = null;
      try {
        result = effect.fn();
      } catch (error) {
        runtime.effectErrors.push(error);
      }
      if (typeof result === 'function') runtime.cleanups[effect.index] = result;
    });
    await flushAsync();
    if (effects.length === 0 && !scheduledSetState) break;
  }
  return { first: first, last: last };
}

function translateFor(table) {
  return function (key, vars) {
    const value = table ? table[key] : undefined;
    if (typeof value !== 'string') return undefined;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  };
}

/* Locate the real page component through the registered slot wrapper. */
const wrapperElement = mainReg.component({ t: translateFor(enDict) });
const pageElement = findFirst(wrapperElement, function (element) {
  return typeof element.type === 'function' && element.type.displayName === 'ApkVmPage';
});
check('main slot wrapper renders the ApkVmPage component', !!pageElement);
const Page = pageElement ? pageElement.type : null;

/* ------------------------------------------------------------------ *
 * 6. Ready-state render (English), then drive the real UI.
 * ------------------------------------------------------------------ */

(async function runScenarios() {
  const runtimeEn = createRuntime();
  const settled = await settlePage(runtimeEn, Page, translateFor(enDict));
  const firstText = textOf(settled.first);
  const lastText = textOf(settled.last);
  const tree = settled.last;

  check('loading render shows connecting overlay', firstText.indexOf('Connecting to the VM service') !== -1, firstText.slice(0, 160));
  check(
    'loading render disables device input',
    (function () {
      const input = findFirst(settled.first, function (element) {
        return element.type === 'input' && element.props.placeholder && element.props.placeholder.indexOf('Text to type') === 0;
      });
      return !!input && input.props.disabled === true;
    })()
  );

  check('no effect threw during render', runtimeEn.effectErrors.length === 0, runtimeEn.effectErrors.map(String).join(' | '));
  check('ready render title present', lastText.indexOf('APK Virtual Machine') !== -1);
  check('ready render status pill shows Ready', lastText.indexOf('Ready') !== -1, lastText.slice(0, 200));
  check('ready render shows serial', lastText.indexOf('emulator-5554') !== -1);
  check('ready render shows boot time', lastText.indexOf('boot 125s') !== -1);
  check('ready render lists scanned APKs', lastText.indexOf('demo.apk') !== -1 && lastText.indexOf('other.apk') !== -1);
  check('ready render formats APK sizes', lastText.indexOf('2 KB') !== -1 && lastText.indexOf('5 MB') !== -1);
  check('ready render marks current APK as launched', lastText.indexOf('launched') !== -1);
  check('ready render shows scan roots truncated', lastText.indexOf('Scan roots') !== -1 && lastText.indexOf('+2') !== -1);
  check('ready render shows current subtitle', lastText.indexOf('Current APK: Demo App') !== -1);
  check('ready render shows upload button', lastText.indexOf('Upload APK') !== -1);
  check('ready render shows boot hint', lastText.indexOf('hardware acceleration') !== -1);
  check('ready render has no connecting overlay', lastText.indexOf('Connecting to the VM service') === -1);
  check('ready render has no VM log panel when healthy', lastText.indexOf('VM log') === -1);

  const frameImages = findAll(tree, function (element) {
    return element.type === 'img' && element.props && element.props.className !== 'apkvm-apk-icon';
  });
  check(
    'frame image rendered from blob URL',
    frameImages.length === 1 && String(frameImages[0].props.src).indexOf('blob:apk-vm/') === 0,
    frameImages.length ? String(frameImages[0].props.src) : 'none'
  );
  check(
    'frame polling requested /apk-vm/frame',
    fetchLog.some(function (entry) {
      return entry.url.indexOf('/apk-vm/frame?t=') === 0;
    })
  );
  check(
    'state + apks were fetched from the Host',
    fetchLog.some(function (entry) {
      return entry.url === '/apk-vm/state';
    }) &&
      fetchLog.some(function (entry) {
        return entry.url === '/apk-vm/apks';
      })
  );

  const screenElement = findFirst(tree, function (element) {
    return element.props && element.props.className === 'apkvm-screen ready';
  });
  check(
    'phone screen is 1080x2400 aspect ratio',
    !!screenElement && screenElement.props.style && screenElement.props.style.aspectRatio === '1080 / 2400',
    screenElement && JSON.stringify(screenElement.props.style)
  );

  check('header shows Stop while ready', !!buttonWithText(tree, 'Stop'));
  check(
    'toolbar shows Home/Back/Recents/Power',
    !!buttonWithText(tree, 'Home') && !!buttonWithText(tree, 'Back') && !!buttonWithText(tree, 'Recents') && !!buttonWithText(tree, 'Power')
  );
  check('send text button rendered', !!buttonWithText(tree, 'Send'));

  /* Drive: Stop -> POST /apk-vm/vm {action:'stop'} */
  const stopButton = buttonWithText(tree, 'Stop');
  if (stopButton) stopButton.props.onClick();
  await flushAsync();
  const vmPost = fetchLog.filter(function (entry) {
    return entry.url === '/apk-vm/vm';
  })[0];
  check(
    'Stop posts /apk-vm/vm with action=stop',
    !!vmPost && vmPost.init.method === 'POST' && String(vmPost.init.body).indexOf('"action":"stop"') !== -1,
    vmPost && String(vmPost.init.body)
  );

  /* Drive: Home key -> POST /apk-vm/input {type:'key', key:'home'} */
  const homeButton = buttonWithText(tree, 'Home');
  if (homeButton) homeButton.props.onClick();
  await flushAsync();
  const homePost = fetchLog.filter(function (entry) {
    return entry.url === '/apk-vm/input' && String(entry.init.body).indexOf('"key":"home"') !== -1;
  })[0];
  check('Home key posts /apk-vm/input key=home', !!homePost, homePost && String(homePost.init.body));

  /* Drive: row install -> POST /apk-vm/install {path} */
  const installButton = buttonWithText(tree, 'Install & launch');
  if (installButton) installButton.props.onClick();
  await flushAsync();
  const installPost = fetchLog.filter(function (entry) {
    return entry.url === '/apk-vm/install';
  })[0];
  check(
    'APK row install posts /apk-vm/install with a path',
    !!installPost && String(installPost.init.body).indexOf('demo.apk') !== -1,
    installPost && String(installPost.init.body)
  );

  /* Drive: type text, re-render, send text -> POST /apk-vm/input {type:'text'} */
  const deviceInput = findFirst(tree, function (element) {
    return element.type === 'input' && element.props.placeholder && element.props.placeholder.indexOf('Text to type') === 0;
  });
  check('device text input rendered and enabled', !!deviceInput && deviceInput.props.disabled !== true);
  if (deviceInput) deviceInput.props.onChange({ target: { value: 'hello device' } });
  const settledAfterTyping = await settlePage(runtimeEn, Page, translateFor(enDict));
  const sendButton = buttonWithText(settledAfterTyping.last, 'Send');
  check('Send button enabled after typing', !!sendButton && sendButton.props.disabled !== true);
  if (sendButton) sendButton.props.onClick();
  await flushAsync();
  const textPost = fetchLog.filter(function (entry) {
    return entry.url === '/apk-vm/input' && String(entry.init.body).indexOf('"text":"hello device"') !== -1;
  })[0];
  check('Send text posts /apk-vm/input type=text', !!textPost, textPost && String(textPost.init.body));

  /* Drive: let the scheduled 500ms frame poll fire once -> blob swap + revoke. */
  activeRuntime = runtimeEn;
  const firstFrameSrc = frameImages.length ? String(frameImages[0].props.src) : '';
  fakeTimers
    .filter(function (timer) {
      return timer.ms === 500;
    })
    .forEach(function (timer) {
      timer.fn();
    });
  await flushAsync();
  const settledSwap = await settlePage(runtimeEn, Page, translateFor(enDict));
  const swappedImages = findAll(settledSwap.last, function (element) {
    return element.type === 'img' && element.props && element.props.className !== 'apkvm-apk-icon';
  });
  check(
    'frame poll swaps in a new blob URL',
    swappedImages.length === 1 &&
      String(swappedImages[0].props.src).indexOf('blob:apk-vm/') === 0 &&
      String(swappedImages[0].props.src) !== firstFrameSrc,
    swappedImages.length ? String(swappedImages[0].props.src) : 'none'
  );
  check('previous frame object URL is revoked after swap', revokedUrls.indexOf(firstFrameSrc) !== -1, JSON.stringify(revokedUrls));

  /* ------------------------------------------------------------------ *
   * 7. Chinese render of the same ready state.
   * ------------------------------------------------------------------ */
  localeName = 'zh';
  const runtimeZh = createRuntime();
  const settledZh = await settlePage(runtimeZh, Page, translateFor(zhDict));
  const zhText = textOf(settledZh.last);
  check('zh render shows localized title', zhText.indexOf('APK 虚拟机') !== -1, zhText.slice(0, 160));
  check('zh render shows localized state', zhText.indexOf('已就绪') !== -1);
  check('zh render shows localized actions', zhText.indexOf('停止') !== -1 && zhText.indexOf('安装并启动') !== -1);
  check('zh render shows localized keys', zhText.indexOf('返回') !== -1 && zhText.indexOf('多任务') !== -1);
  check('no effect threw during zh render', runtimeZh.effectErrors.length === 0, runtimeZh.effectErrors.map(String).join(' | '));
  localeName = 'en';

  /* ------------------------------------------------------------------ *
   * 8. Defensive: Host routes down -> error banner, no crash.
   * ------------------------------------------------------------------ */
  offlineMode = true;
  const runtimeOffline = createRuntime();
  const settledOffline = await settlePage(runtimeOffline, Page, translateFor(enDict));
  const offlineText = textOf(settledOffline.last);
  check('offline render does not throw', runtimeOffline.effectErrors.length === 0, runtimeOffline.effectErrors.map(String).join(' | '));
  check('offline render surfaces state error banner', offlineText.indexOf('Cannot read VM state') !== -1, offlineText.slice(0, 240));
  check('offline render still shows start/retry affordance', offlineText.indexOf('Try again') !== -1 || offlineText.indexOf('Start VM') !== -1);
  offlineMode = false;

  /* ------------------------------------------------------------------ *
   * 9. Defensive: throwing translator falls back to English.
   * ------------------------------------------------------------------ */
  const runtimeBadLocale = createRuntime();
  activeRuntime = runtimeBadLocale;
  runtimeBadLocale.resetRender();
  let badLocaleThrew = null;
  let badLocaleTree = null;
  try {
    badLocaleTree = Page({
      t: function () {
        throw new Error('locale service unavailable');
      },
    });
  } catch (error) {
    badLocaleThrew = error;
  }
  check('page renders when translate() throws', badLocaleThrew === null, badLocaleThrew && badLocaleThrew.stack);
  check('throwing translator falls back to English', !!badLocaleTree && textOf(badLocaleTree).indexOf('APK Virtual Machine') !== -1);

  /* ------------------------------------------------------------------ *
   * 10. Render boundary catches an unexpected exception.
   * ------------------------------------------------------------------ */
  const BoundaryClass = wrapperElement.type;
  const boundaryInstance = new BoundaryClass({ translate: translateFor(enDict), children: [] });
  boundaryInstance.state = { error: new Error('boom from a child') };
  let boundaryTree = null;
  let boundaryThrew = null;
  try {
    boundaryTree = boundaryInstance.render();
  } catch (error) {
    boundaryThrew = error;
  }
  check('render boundary fallback renders', boundaryThrew === null && !!boundaryTree);
  check(
    'render boundary fallback is localized',
    !!boundaryTree && textOf(boundaryTree).indexOf('failed to render') !== -1,
    boundaryTree && textOf(boundaryTree)
  );

  /* ------------------------------------------------------------------ *
   * 11. Static checks on client.js / locale / icon.
   * ------------------------------------------------------------------ */

  const requireIds = [];
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let requireMatch = requirePattern.exec(codeSource);
  while (requireMatch) {
    requireIds.push(requireMatch[1]);
    requireMatch = requirePattern.exec(codeSource);
  }
  check(
    "client.js requires only 'react'",
    requireIds.length >= 1 && requireIds.every(function (id) {
      return id === 'react';
    }),
    JSON.stringify(requireIds)
  );
  check('client.js has no ES import statements', !/^\s*import\s+/m.test(codeSource));

  const allowedTokens = [
    'bg-base', 'bg-layer-1', 'bg-layer-2', 'border-l1', 'border-l2', 'label-primary', 'label-secondary',
    'brand-primary', 'state-error-primary', 'state-success-primary', 'state-warn-primary', 'state-idle-primary',
  ];
  const usedTokens = new Set();
  const tokenPattern = /var\(--dsw-alias-([a-z0-9-]+)\)/g;
  let tokenMatch = tokenPattern.exec(codeSource);
  while (tokenMatch) {
    usedTokens.add(tokenMatch[1]);
    tokenMatch = tokenPattern.exec(codeSource);
  }
  const badTokens = Array.from(usedTokens).filter(function (token) {
    return allowedTokens.indexOf(token) === -1;
  });
  check('only allowed theme tokens are used', badTokens.length === 0, badTokens.join(', '));
  check('theme token set is broad', usedTokens.size >= 10, Array.from(usedTokens).join(', '));

  const colorPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
  check('client.js contains no literal palette colors', !colorPattern.test(codeSource));

  const fetchTargets = new Set();
  const fetchPattern = /fetch\(\s*'([^']+)'/g;
  let fetchMatch = fetchPattern.exec(codeSource);
  while (fetchMatch) {
    fetchTargets.add(fetchMatch[1]);
    fetchMatch = fetchPattern.exec(source);
  }
  check(
    'no external (http) fetch targets',
    !Array.from(fetchTargets).some(function (target) {
      return /^https?:/i.test(target);
    }),
    Array.from(fetchTargets).join(', ')
  );
  check(
    'fetch targets are the contracted /apk-vm routes',
    Array.from(fetchTargets).every(function (target) {
      return target.indexOf('/apk-vm/') === 0;
    }),
    Array.from(fetchTargets).join(', ')
  );

  const enMetaRaw = fs.readFileSync(path.join(root, 'locale', 'en.json'), 'utf8');
  const zhMetaRaw = fs.readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8');
  let enMeta = null;
  let zhMeta = null;
  try {
    enMeta = JSON.parse(enMetaRaw);
  } catch (error) {
    enMeta = null;
  }
  try {
    zhMeta = JSON.parse(zhMetaRaw);
  } catch (error) {
    zhMeta = null;
  }
  check('locale/en.json parses', !!enMeta);
  check('locale/zh.json parses', !!zhMeta);
  check(
    'en.json meta title/description',
    !!enMeta &&
      !!enMeta.meta &&
      enMeta.meta.title === 'APK Virtual Machine' &&
      typeof enMeta.meta.description === 'string' &&
      enMeta.meta.description.length > 20,
    enMeta && JSON.stringify(enMeta)
  );
  check(
    'zh.json meta title/description',
    !!zhMeta &&
      !!zhMeta.meta &&
      zhMeta.meta.title === 'APK 虚拟机' &&
      typeof zhMeta.meta.description === 'string' &&
      zhMeta.meta.description.length > 10,
    zhMeta && JSON.stringify(zhMeta)
  );

  const iconSource = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
  check('icon.svg is an svg root', /^\s*<svg[\s>]/.test(iconSource));
  check(
    'icon.svg is 24x24 with a viewBox',
    /width="24"/.test(iconSource) && /height="24"/.test(iconSource) && /viewBox="0 0 24 24"/.test(iconSource)
  );
  check('icon.svg uses currentColor', /stroke="currentColor"/.test(iconSource) && /fill="currentColor"/.test(iconSource));
  check('icon.svg has no external references', !/<image\b/i.test(iconSource) && !/href=/i.test(iconSource) && !/<script/i.test(iconSource));
  check('icon.svg closes properly', /<\/svg>\s*$/.test(iconSource));

  /* ------------------------------------------------------------------ *
   * 12. Report.
   * ------------------------------------------------------------------ */
  if (failures > 0) {
    console.error('\n' + failures + ' check(s) failed:');
    failuresList.forEach(function (item) {
      console.error('  - ' + item);
    });
    process.exitCode = 1;
  } else {
    console.log('\nAll UI smoke checks passed.');
  }
})().catch(function (error) {
  console.error('SMOKE TEST CRASHED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
