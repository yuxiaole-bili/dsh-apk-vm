/**
 * Interaction flow recorder for the APK VM.
 *
 * The Host records validated input payloads (tap/swipe/key/text) as they arrive
 * through the panel or the apk_vm tool, then replays them with the original
 * relative timing. Flows are plain JSON files under the OS temp dir, so they can
 * be listed, downloaded, copied to another machine, or replayed later.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_EVENTS = 2000;
const MAX_FLOW_FILES = 100;

function safePart(value, fallback) {
  const text = String(value == null ? '' : value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 64);
  return text || fallback;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const type = String(payload.type || payload.action || payload.kind || '').toLowerCase();
  if (type === 'tap') {
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { type: 'tap', x: Math.round(x), y: Math.round(y) };
  }
  if (type === 'swipe') {
    const values = [payload.x1, payload.y1, payload.x2, payload.y2].map(Number);
    if (!values.every(Number.isFinite)) return null;
    const durationMs = Math.max(1, Math.min(60000, Math.round(Number(payload.durationMs ?? payload.duration) || 300)));
    return {
      type: 'swipe',
      x1: Math.round(values[0]),
      y1: Math.round(values[1]),
      x2: Math.round(values[2]),
      y2: Math.round(values[3]),
      durationMs,
    };
  }
  if (type === 'key' || type === 'keyevent') {
    const key = String(payload.key ?? payload.keycode ?? payload.code ?? '');
    return key ? { type: 'key', key } : null;
  }
  if (type === 'text') {
    const text = payload.text ?? payload.value;
    if (typeof text !== 'string' || !text || text.length > 4096) return null;
    return { type: 'text', text };
  }
  return null;
}

function publicFlow(flow) {
  if (!flow) return null;
  return {
    id: flow.id,
    name: flow.name,
    instanceId: flow.instanceId,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    durationMs: flow.durationMs || 0,
    events: Array.isArray(flow.events) ? flow.events.length : 0,
  };
}

export class FlowRecorder {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.dir = opts.dir || path.join(os.tmpdir(), 'dsh-apk-vm-flows');
    this.active = new Map();
    this._writeQueue = Promise.resolve();
  }

  _fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  async _ensureDir() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  start(instanceId, name) {
    const instance = safePart(instanceId, 'default');
    const id = `${instance}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const flow = {
      id,
      name: safePart(name, 'flow') || 'flow',
      instanceId: instance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      startedAtMs: Date.now(),
    };
    this.active.set(instance, flow);
    return publicFlow(flow);
  }

  isRecording(instanceId) {
    return this.active.has(safePart(instanceId, 'default'));
  }

  record(instanceId, payload) {
    const instance = safePart(instanceId, 'default');
    const flow = this.active.get(instance);
    if (!flow) return false;
    const normalized = normalizePayload(payload);
    if (!normalized) return false;
    if (flow.events.length >= MAX_EVENTS) return false;
    flow.events.push({ at: Date.now() - flow.startedAtMs, payload: normalized });
    return true;
  }

  async stop(instanceId) {
    const instance = safePart(instanceId, 'default');
    const flow = this.active.get(instance);
    if (!flow) throw new Error(`no flow recording is active for instance ${instance}`);
    this.active.delete(instance);
    flow.updatedAt = new Date().toISOString();
    flow.durationMs = flow.events.length ? flow.events[flow.events.length - 1].at : 0;
    delete flow.startedAtMs;
    await this._ensureDir();
    await fsp.writeFile(this._fileFor(flow.id), `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
    return publicFlow(flow);
  }

  async list(instanceId) {
    const instance = instanceId ? safePart(instanceId, 'default') : '';
    await this._ensureDir();
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const jsonNames = names.filter((name) => name.endsWith('.json')).sort().reverse().slice(0, MAX_FLOW_FILES);
    const flows = [];
    for (const name of jsonNames) {
      try {
        const raw = await fsp.readFile(path.join(this.dir, name), 'utf8');
        const flow = JSON.parse(raw);
        if (!flow || typeof flow !== 'object') continue;
        if (instance && flow.instanceId !== instance) continue;
        flows.push(publicFlow(flow));
      } catch {
        /* ignore corrupt flow files */
      }
    }
    return flows;
  }

  async get(id, instanceId) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(id || ''))) throw new Error('invalid flow id');
    await this._ensureDir();
    const raw = await fsp.readFile(this._fileFor(id), 'utf8');
    const flow = JSON.parse(raw);
    if (instanceId && flow.instanceId !== safePart(instanceId, 'default')) {
      throw new Error(`flow ${id} belongs to another instance`);
    }
    return flow;
  }

  async remove(id, instanceId) {
    const flow = await this.get(id, instanceId);
    await fsp.unlink(this._fileFor(flow.id));
    return publicFlow(flow);
  }

  /** Replay a saved flow through the provided async input function. */
  async replay(id, inputFn, options = {}) {
    if (typeof inputFn !== 'function') throw new Error('replay requires an input function');
    const flow = await this.get(id, options.instanceId);
    const delayCap = Math.max(0, Math.min(30000, Number(options.delayCapMs) || 5000));
    const events = Array.isArray(flow.events) ? flow.events : [];
    let previous = 0;
    let replayed = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || !event.payload) continue;
      const at = Math.max(0, Number(event.at) || 0);
      const wait = Math.min(delayCap, Math.max(0, at - previous));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      previous = at;
      try {
        await inputFn(event.payload);
      } catch (error) {
        throw new Error(`flow replay failed at step ${index + 1}/${events.length}: ${error.message}`);
      }
      replayed += 1;
    }
    return { id: flow.id, name: flow.name, steps: replayed, durationMs: flow.durationMs || 0 };
  }
}
