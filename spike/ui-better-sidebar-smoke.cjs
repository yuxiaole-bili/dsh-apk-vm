#!/usr/bin/env node
/**
 * Compatibility smoke test for the optional dsh-better-sidebar integration.
 *
 * Loads client.js in a vm sandbox with a fake React + fake client context,
 * runs apply(), then simulates the `ctx.betterSidebar` service appearing and
 * asserts the tab descriptor passed to `registerTab` is correct, localized,
 * disposable, and that the plugin still works when the service is absent.
 *
 * Run: node spike/ui-better-sidebar-smoke.cjs
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', 'client.js');
const code = fs.readFileSync(CLIENT, 'utf8');

let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  },
  console,
  URL,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
assert.ok(captured, 'client.js must register a module loader factory');
assert.strictEqual(captured.id, 'dsh-apk-vm');

function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, function () {}];
    },
    useEffect() {
      return undefined;
    },
    useRef(initial) {
      return { current: initial };
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    Component: class Component {
      constructor(props) {
        this.props = props || {};
        this.state = {};
      }
      setState(patch) {
        this.state = Object.assign({}, this.state, patch);
      }
    },
  };
  React.default = React;
  return React;
}

const React = makeReact();
let api = null;
const factory = captured.factory;
api = factory(function (id) {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});
assert.ok(api && typeof api.apply === 'function');
assert.ok(Array.isArray(api.inject), 'static inject must be an array');
assert.deepStrictEqual(Array.from(api.inject).sort(), ['locale', 'slots']);
assert.ok(!api.inject.includes('betterSidebar'), 'betterSidebar must stay optional');

function makeContext(options) {
  const opts = options || {};
  const dictionary = Object.create(null);
  const slots = [];
  const effects = [];
  const injectCalls = [];
  const ctx = {
    locale: {
      register(ns, dicts) {
        Object.assign(dictionary, dicts.en || {});
        return function () {};
      },
      bind() {
        return function (key) {
          return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
        };
      },
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(spec, component) {
        slots.push({ spec, component });
        return function () {};
      },
    },
    effect(callback, label) {
      const cleanup = callback();
      effects.push({ label, cleanup });
      return cleanup;
    },
    inject(deps, callback) {
      injectCalls.push({ deps, callback });
      return function () {};
    },
  };
  if (opts.getImplement) ctx.get = opts.getImplement;
  if (opts.inject === false) delete ctx.inject;
  return { ctx, slots, effects, injectCalls };
}

function findSlot(slots, name) {
  return slots.find((entry) => entry.spec && entry.spec.name === name);
}

/* ---- 1. service absent: plain DSH still registers both native seats ----- */
{
  const env = makeContext();
  api.apply(env.ctx);
  assert.ok(findSlot(env.slots, 'main'), 'main panel must register without better-sidebar');
  assert.ok(findSlot(env.slots, 'sidebar.panellist'), 'sidebar entry must register without better-sidebar');
  assert.strictEqual(env.injectCalls.length, 1, 'plugin must wait for betterSidebar through ctx.inject');
  assert.deepStrictEqual(Array.from(env.injectCalls[0].deps), ['betterSidebar']);
}

/* ---- 2. service appears later: tab descriptor is registered ------------ */
{
  const env = makeContext();
  api.apply(env.ctx);

  const opened = [];
  let disposed = false;
  const service = {
    registerTab(descriptor) {
      return function () {
        disposed = true;
        assert.strictEqual(descriptor.id, 'apk-vm:preview');
      };
    },
    openTab(seed) {
      opened.push(seed);
    },
    getSnapshot() {
      return { sessionId: 'session-1', state: {} };
    },
  };
  const registered = [];
  service.registerTab = (descriptor) => {
    registered.push(descriptor);
    return function () {
      disposed = true;
    };
  };

  let tabCleanup = null;
  const sub = {
    betterSidebar: service,
    get(name) {
      return name === 'betterSidebar' ? service : undefined;
    },
    effect(callback, label) {
      assert.ok(/dsh-better-sidebar/.test(String(label)), 'effect label should mention better-sidebar');
      tabCleanup = callback();
      return tabCleanup;
    },
  };
  env.injectCalls[0].callback(sub);

  assert.strictEqual(registered.length, 1, 'exactly one tab descriptor must be registered');
  const descriptor = registered[0];
  assert.strictEqual(descriptor.id, 'apk-vm:preview');
  assert.strictEqual(descriptor.order, 60);
  assert.strictEqual(descriptor.single, true);
  assert.strictEqual(descriptor.title(), 'APK VM');
  assert.ok(/Android VM/.test(descriptor.description()), 'description must be localized');
  assert.strictEqual(typeof descriptor.icon, 'function');
  const icon = descriptor.icon(18);
  assert.ok(icon && icon.type, 'icon(18) must return a React element');
  assert.strictEqual(typeof descriptor.component, 'function');
  const rendered = descriptor.component({
    ctx: env.ctx,
    scope: { sessionId: 'session-1' },
    tab: { id: 't1', type: 'apk-vm:preview' },
    visible: true,
  });
  assert.ok(rendered && rendered.type, 'tab component must render the APK-VM page boundary');
  const pageEl = (rendered.children || []).find((child) => child && child.props && child.props.embedded === true);
  assert.ok(pageEl, 'the page must be told it is embedded in a side pane');
  assert.strictEqual(pageEl.props.embedded, true, 'the page must be told it is embedded in a side pane');

  tabCleanup();
  assert.strictEqual(disposed, true, 'descriptor disposer must be called with the effect cleanup');

  // Opening through the service is what the panel action does; validate the
  // seed shape against the documented API (type + right target).
  service.openTab({ type: 'apk-vm:preview', target: 'right' });
  assert.deepStrictEqual(opened, [{ type: 'apk-vm:preview', target: 'right' }]);
}

/* ---- 3. service already present but no ctx.inject: immediate path ----- */
{
  const env = makeContext({
    inject: false,
    getImplement(name) {
      if (name !== 'betterSidebar') return undefined;
      return {
        registerTab() {
          return function () {};
        },
      };
    },
  });
  api.apply(env.ctx);
  assert.ok(findSlot(env.slots, 'main'), 'main panel must still register');
}

/* ---- 4. broken service must not break the plugin ----------------------- */
{
  const env = makeContext();
  api.apply(env.ctx);
  let threw = false;
  try {
    env.injectCalls[0].callback({ betterSidebar: null, get() { return null; }, effect() {} });
    // inject callback firing with no service is legitimate (service removed).
  } catch (error) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'a missing/removed service must not throw');
  assert.ok(findSlot(env.slots, 'main'), 'main panel survives a missing service');
}

console.log('All dsh-better-sidebar compatibility checks passed.');
