/**
 * App Skills: a small, portable recipe format for "go to this page" flows.
 *
 * A Skill embeds its own Control Codebook and a list of semantic steps. Replay
 * never uses recorded coordinates when a code resolves; repeated `waitFor`
 * polling replaces fixed sleeps, so a replay is both faster and more reliable
 * than raw input replay. Raw coordinate steps remain as an explicit fallback.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseUiHierarchy, snapshotIdForXml } from './ui-inspector.js';
import {
  ControlMatchError,
  findCodeEntry,
  listCodes,
  matchNodeFeatures,
  normalizeCodebook,
  resolveControl,
  resolveSelector,
} from './control-codebook.js';
import { computeImageFeatures, decodePng } from './image-features.js';

export const SKILL_SCHEMA_VERSION = 1;

const STEP_ACTIONS = new Map([
  ['tap', 'tap'],
  ['click', 'tap'],
  ['longpress', 'longPress'],
  ['long_press', 'longPress'],
  ['long-press', 'longPress'],
  ['input', 'input'],
  ['type', 'input'],
  ['settext', 'input'],
  ['launch', 'launch'],
  ['open', 'launch'],
  ['start', 'launch'],
  ['waitfor', 'waitFor'],
  ['wait', 'waitFor'],
  ['assert', 'assert'],
  ['key', 'key'],
  ['press', 'key'],
  ['swipe', 'swipe'],
  ['scroll', 'swipe'],
  ['sleep', 'sleep'],
  ['delay', 'sleep'],
  ['back', 'key'],
]);

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_WAIT_MS = 6000;
const MAX_WAIT_MS = 120000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function asString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function slugifySkillName(name) {
  const base = asString(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `skill-${Date.now().toString(36)}`;
}

function selectorFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selector = {};
  for (const key of [
    'resourceId',
    'resourceIdContains',
    'text',
    'textAny',
    'textContains',
    'contentDesc',
    'contentDescContains',
    'className',
    'classNameContains',
    'packageName',
    'clickable',
    'enabled',
    'x',
    'y',
    'boundsRatio',
    'image',
  ]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') selector[key] = raw[key];
  }
  return Object.keys(selector).length ? selector : null;
}

/** Normalise one recorded/declared step. Throws on a missing target. */
export function normalizeSkillStep(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const actionKey = asString(source.action || source.type || 'tap').toLowerCase();
  const action = STEP_ACTIONS.get(actionKey);
  if (!action) throw new Error(`step #${index + 1} has unsupported action ${JSON.stringify(source.action)}`);
  const step = { action };
  const code = asString(source.code);
  if (code) step.code = code;
  const selector = selectorFromRaw(source.selector || (source.x !== undefined ? source : null));
  if (selector) step.selector = selector;
  if (source.value !== undefined) step.value = String(source.value);
  if (source.text !== undefined && action === 'input' && step.value === undefined) step.value = String(source.text);
  if (source.key !== undefined) step.key = String(source.key);
  if (source.package !== undefined) step.package = asString(source.package);
  if (source.packageName !== undefined && !step.package) step.package = asString(source.packageName);
  if (source.activity !== undefined) step.activity = asString(source.activity);
  if (source.timeoutMs !== undefined) step.timeoutMs = clampNumber(source.timeoutMs, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
  if (source.index !== undefined) step.index = clampNumber(source.index, null, 0, 500);
  if (source.submit !== undefined) step.submit = source.submit === true;
  if (source.exists !== undefined) step.exists = source.exists !== false;
  if (source.durationMs !== undefined) step.durationMs = clampNumber(source.durationMs, 300, 1, 60000);
  if (source.settleMs !== undefined) step.settleMs = clampNumber(source.settleMs, 250, 0, 10000);
  if (source.description !== undefined) step.description = asString(source.description).slice(0, 200);

  if (action === 'tap' || action === 'longPress' || action === 'input' || action === 'waitFor' || action === 'assert') {
    if (!step.code && !step.selector) throw new Error(`step #${index + 1} (${action}) requires code or selector`);
  }
  if (action === 'input' && step.value === undefined) step.value = '';
  if (action === 'key') {
    if (!step.key && source.action && asString(source.action).toLowerCase() === 'back') step.key = 'BACK';
    if (!step.key) throw new Error(`step #${index + 1} (key) requires key`);
  }
  if (action === 'swipe') {
    const from = asString(source.fromCode || source.from);
    const to = asString(source.toCode || source.to);
    if (from) step.fromCode = from;
    if (to) step.toCode = to;
    if (!from && !to) {
      for (const key of ['x1', 'y1', 'x2', 'y2']) {
        if (!Number.isFinite(Number(source[key]))) throw new Error(`step #${index + 1} (swipe) requires x1,y1,x2,y2 or fromCode/toCode`);
        step[key] = Number(source[key]);
      }
    }
  }
  if (action === 'sleep') step.ms = clampNumber(source.ms ?? source.durationMs, 250, 0, 60000);
  return step;
}

export function normalizeSkillSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((step, index) => normalizeSkillStep(step, index));
}

/** Normalise/validate a complete Skill, including its embedded codebook. */
export function normalizeSkill(raw, defaults = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = asString(source.name) || asString(defaults.name) || 'Untitled skill';
  const idRaw = asString(source.id) || asString(defaults.id) || slugifySkillName(name);
  const id = slugifySkillName(idRaw);
  const pkg = asString(source.package || source.packageName || defaults.package || defaults.packageName);
  if (pkg && !/^[A-Za-z_][A-Za-z0-9_.]{1,200}$/.test(pkg)) throw new Error(`invalid package name: ${JSON.stringify(pkg)}`);
  const codebook = normalizeCodebook(source.codebook || source.controlCodebook || {});
  const steps = normalizeSkillSteps(source.steps || []);
  const now = Date.now();
  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    id,
    name: name.slice(0, 120),
    ...(pkg ? { package: pkg } : {}),
    ...(asString(source.description) ? { description: asString(source.description).slice(0, 300) } : {}),
    ...(asString(source.target) ? { target: asString(source.target).slice(0, 120) } : {}),
    codebook,
    steps,
    ...(source.variables && typeof source.variables === 'object' ? { variables: source.variables } : {}),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now,
    updatedAt: now,
  };
}

/** Persistent Skill storage. Skills are JSON files under the Host workspace. */
export class SkillStore {
  constructor(options = {}) {
    this.dir = path.resolve(String(options.dir || path.join(process.cwd(), '.apk-vm', 'skills')));
    this.maxSkills = clampNumber(options.maxSkills, 200, 1, 2000);
  }

  async ensure() {
    await fsp.mkdir(this.dir, { recursive: true });
    return this.dir;
  }

  validateId(id) {
    const value = asString(id);
    if (!ID_RE.test(value)) throw new Error('skill id must be 1-64 chars: letters, digits, dot, underscore or dash');
    return value;
  }

  fileFor(id) {
    return path.join(this.dir, `${this.validateId(id)}.json`);
  }

  async list() {
    await this.ensure();
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const skills = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.dir, entry.name);
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
        const skill = normalizeSkill(raw, { id: entry.name.slice(0, -5) });
        skills.push(skill);
      } catch {
        /* ignore a broken skill file; a single bad file must not hide the rest */
      }
    }
    return skills.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)).slice(0, this.maxSkills);
  }

  async get(id) {
    const value = this.validateId(id);
    try {
      const raw = JSON.parse(await fsp.readFile(this.fileFor(value), 'utf8'));
      return normalizeSkill(raw, { id: value });
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(skill) {
    const normalized = normalizeSkill(skill);
    await this.ensure();
    if ((await this.list()).filter((entry) => entry.id !== normalized.id).length >= this.maxSkills) {
      throw new Error(`too many skills (limit ${this.maxSkills})`);
    }
    const file = this.fileFor(normalized.id);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, file);
    return normalized;
  }

  async remove(id) {
    const value = this.validateId(id);
    try {
      await fsp.unlink(this.fileFor(value));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

function skillSummary(skill) {
  return {
    id: skill.id,
    name: skill.name,
    package: skill.package || null,
    description: skill.description || null,
    target: skill.target || null,
    steps: skill.steps.length,
    codes: skill.codebook.entries.length,
    codebookName: skill.codebook.name || null,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export { skillSummary };

/** In-memory recording session per VM instance. */
export class SkillRecorder {
  constructor(options = {}) {
    this.store = options.store;
    this.sessions = new Map();
  }

  async start(instanceId, options = {}) {
    const id = asString(instanceId) || 'default';
    if (this.sessions.has(id)) throw new Error(`instance ${id} is already recording a Skill; stop or cancel it first`);
    const name = asString(options.name) || `recorded-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const skillId = slugifySkillName(options.id || name);
    const existing = await this.store.get(skillId).catch(() => null);
    const suffix = existing ? `-${Date.now().toString(36).slice(-4)}` : '';
    const draft = normalizeSkill({
      id: skillId + suffix,
      name,
      package: options.packageName || options.package,
      description: options.description,
      target: options.target,
      codebook: options.codebook || {},
      steps: [],
    });
    const session = {
      instanceId: id,
      skill: draft,
      startedAt: Date.now(),
    };
    this.sessions.set(id, session);
    return { ...skillSummary(draft), recording: true, instance: id };
  }

  active(instanceId) {
    return this.sessions.get(asString(instanceId) || 'default') || null;
  }

  async updateCodebook(instanceId, rawCodebook) {
    const session = this.active(instanceId);
    if (!session) throw new Error('no active Skill recording; call skill_start first');
    session.skill.codebook = normalizeCodebook(rawCodebook);
    return session.skill.codebook;
  }

  add(instanceId, step) {
    const session = this.active(instanceId);
    if (!session) throw new Error('no active Skill recording; call skill_start first');
    const normalized = normalizeSkillStep(step, session.skill.steps.length);
    session.skill.steps.push(normalized);
    return { steps: session.skill.steps.length };
  }

  cancel(instanceId) {
    const id = asString(instanceId) || 'default';
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session ? skillSummary(session.skill) : null;
  }

  async stop(instanceId, options = {}) {
    const id = asString(instanceId) || 'default';
    const session = this.sessions.get(id);
    if (!session) throw new Error('no active Skill recording; call skill_start first');
    const merged = {
      ...session.skill,
      ...(options.name ? { name: options.name } : {}),
      ...(options.packageName || options.package ? { package: options.packageName || options.package } : {}),
      ...(options.description ? { description: options.description } : {}),
      steps: session.skill.steps,
    };
    if (!merged.steps.length) throw new Error('Skill recording has no steps; use control_tap/control_input while recording or cancel');
    const saved = await this.store.save(merged);
    this.sessions.delete(id);
    return saved;
  }
}

function interpolate(value, variables) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g, (_match, key) => {
    if (!variables || !Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`missing Skill variable ${JSON.stringify(key)}`);
    }
    return String(variables[key]);
  });
}

async function hierarchy(api) {
  const dump = await api.uiDump();
  const parsed = parseUiHierarchy(dump.xml);
  return {
    dump,
    parsed,
    nodes: parsed.nodes,
    snapshotId: snapshotIdForXml(dump.xml),
    screen: await api.screenSize().catch(() => null),
  };
}

function isAmbiguous(error) {
  return error instanceof ControlMatchError
    && (error.ambiguous === true || /is ambiguous/i.test(String(error.message || '')));
}

async function attachImageFeatures(entry, nodes, api, screen) {
  if (!entry || !entry.features || !entry.features.image) return;
  const structural = nodes.filter((node) => matchNodeFeatures(node, { ...entry.features, image: undefined }, { screen }).ok);
  if (!structural.length) return;
  if (typeof api.screenshotBuffer !== 'function') return;
  const buffer = await api.screenshotBuffer();
  const decoded = decodePng(buffer);
  for (const node of structural) {
    if (!node.bounds) continue;
    try {
      node.imageFeatures = computeImageFeatures(buffer, node.bounds, { decoded });
    } catch {
      /* a tiny/invisible crop simply cannot match an image feature */
    }
  }
}

async function resolveStepTarget(step, codebook, state, api, options) {
  if (step.code) {
    const entry = findCodeEntry(codebook, step.code);
    if (!entry) throw new ControlMatchError(`unknown control code ${JSON.stringify(step.code)}`, { code: step.code, codebookCodes: listCodes(codebook) });
    await attachImageFeatures(entry, state.nodes, api, state.screen);
    return resolveControl(codebook, step.code, state.nodes, { screen: state.screen, ...options });
  }
  return resolveSelector(step.selector, state.nodes, { screen: state.screen, ...options });
}

async function waitForStepTarget(step, codebook, api, options) {
  const timeoutMs = clampNumber(step.timeoutMs, options.timeoutMs || DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
  const pollMs = Math.max(80, Number(options.pollMs) || 180);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let state = null;
  do {
    state = await hierarchy(api);
    try {
      return { state, target: await resolveStepTarget(step, codebook, state, api, options) };
    } catch (error) {
      lastError = error;
      if (isAmbiguous(error)) throw error;
      // An unknown code is a definition error: retrying the same hierarchy
      // cannot make it appear, unlike a visible-control miss.
      if (error instanceof ControlMatchError && Array.isArray(error.codebookCodes)) throw error;
      if (Date.now() >= deadline) break;
      await delay(pollMs);
    }
  } while (Date.now() <= deadline);
  const wrapped = new Error(
    `timed out after ${timeoutMs}ms waiting for ${step.code || JSON.stringify(step.selector || {})}`,
  );
  wrapped.cause = lastError;
  wrapped.candidates = lastError && lastError.candidates ? lastError.candidates : [];
  wrapped.lastSnapshotId = state && state.snapshotId;
  throw wrapped;
}

async function runStep(step, codebook, api, options) {
  if (step.action === 'launch') {
    const pkg = step.package || options.package;
    if (!pkg) throw new Error('launch step needs package or a Skill package');
    const result = await api.launchPackage(pkg, step.activity);
    await delay(Math.max(120, (step.settleMs || 250) / options.speed));
    return { action: 'launch', package: pkg, result };
  }
  if (step.action === 'key') {
    const result = await api.input({ type: 'key', key: step.key });
    await delay(80 / options.speed);
    return { action: 'key', key: step.key, result };
  }
  if (step.action === 'sleep') {
    await delay(step.ms / options.speed);
    return { action: 'sleep', ms: step.ms };
  }
  if (step.action === 'swipe') {
    let from;
    let to;
    if (step.fromCode || step.toCode) {
      const current = await hierarchy(api);
      if (step.fromCode) from = await resolveControl(codebook, step.fromCode, current.nodes, { screen: current.screen });
      if (step.toCode) to = await resolveControl(codebook, step.toCode, current.nodes, { screen: current.screen });
      if (!from && to) from = to;
      if (!to && from) to = from;
    }
    const x1 = from ? from.node.bounds.center.x : step.x1;
    const y1 = from ? from.node.bounds.center.y : step.y1;
    const x2 = to ? to.node.bounds.center.x : step.x2;
    const y2 = to ? to.node.bounds.center.y : step.y2;
    if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('swipe needs resolvable from/to codes or x1,y1,x2,y2');
    const result =
      options.dryRun === true
        ? { dryRun: true }
        : await api.input({ type: 'swipe', x1, y1, x2, y2, durationMs: step.durationMs || 300 });
    await delay(120 / options.speed);
    return { action: 'swipe', x1, y1, x2, y2, result };
  }

  if (step.action === 'assert' && step.exists === false) {
    const state = await hierarchy(api);
    let target = null;
    let miss = null;
    try {
      target = await resolveStepTarget(step, codebook, state, api, options);
    } catch (error) {
      if (isAmbiguous(error) || (error instanceof ControlMatchError && Array.isArray(error.codebookCodes))) throw error;
      miss = error;
    }
    if (target) throw new Error(`assert failed: ${step.code || 'selector'} is visible`);
    if (miss && miss instanceof ControlMatchError && Array.isArray(miss.codebookCodes)) throw miss;
    return { action: 'assert', code: step.code || null, exists: false, snapshotId: state.snapshotId };
  }
  const waited = await waitForStepTarget(step, codebook, api, options);
  const target = waited.target;
  const center = target.node && target.node.bounds && target.node.bounds.center;
  if (step.action === 'waitFor') return { action: 'waitFor', code: target.code, snapshotId: waited.state.snapshotId };
  if (step.action === 'assert') {
    if (step.exists === false) throw new Error(`assert failed: ${step.code || 'selector'} is visible`);
    return { action: 'assert', code: target.code, exists: true, snapshotId: waited.state.snapshotId };
  }
  if (step.action === 'tap' || step.action === 'longPress' || step.action === 'input') {
    if (!center) throw new Error(`control ${target.code} has no usable bounds`);
    if (options.dryRun !== true) {
      if (step.action === 'longPress') {
        await api.input({ type: 'swipe', x1: center.x, y1: center.y, x2: center.x, y2: center.y, durationMs: step.durationMs || 800 });
      } else {
        await api.input({ type: 'tap', x: center.x, y: center.y });
      }
      await delay(120 / options.speed);
    }
    if (step.action === 'input') {
      const value = interpolate(step.value, options.variables || {});
      if (options.dryRun !== true && value) await api.input({ type: 'text', text: value.slice(0, 4096) });
      if (step.submit === true && options.dryRun !== true) await api.input({ type: 'key', key: 'ENTER' });
      await delay(100 / options.speed);
      return { action: 'input', code: target.code, value, snapshotId: waited.state.snapshotId };
    }
    if (step.action === 'longPress') {
      return { action: 'longPress', code: target.code, snapshotId: waited.state.snapshotId };
    }
    return { action: 'tap', code: target.code, snapshotId: waited.state.snapshotId };
  }
  throw new Error(`unsupported Skill step action: ${step.action}`);
}

/**
 * Replay a Skill with wait-for-control polling. Returns a JSON-friendly report
 * suitable for the Agent tool and the sidebar card.
 */
export async function runSkill(skill, api, options = {}) {
  const normalized = normalizeSkill(skill);
  if (!normalized.package && normalized.steps.some((step) => step.action === 'launch' && !step.package)) {
    throw new Error('Skill has a launch step but no package');
  }
  const startedAt = Date.now();
  const settings = {
    package: normalized.package,
    variables: { ...(normalized.variables || {}), ...(options.variables || {}) },
    timeoutMs: clampNumber(options.timeoutMs, DEFAULT_WAIT_MS, 0, MAX_WAIT_MS),
    pollMs: clampNumber(options.pollMs, 180, 80, 5000),
    speed: clampNumber(options.speed, 1, 0.1, 20),
    dryRun: options.dryRun === true,
    untilCode: asString(options.untilCode),
  };
  const events = [];
  let stepsRun = 0;
  let reached = settings.untilCode ? false : null;
  try {
    if (normalized.steps.length === 0) throw new Error('Skill has no steps');
    for (let index = 0; index < normalized.steps.length; index += 1) {
      const step = normalized.steps[index];
      const event = await runStep(step, normalized.codebook, api, settings);
      stepsRun += 1;
      events.push({ index, ...event });
      if (settings.untilCode) {
        const state = await hierarchy(api);
        try {
          const target = await resolveStepTarget({ code: settings.untilCode }, normalized.codebook, state, api, {});
          if (target && target.node) {
            reached = true;
            events.push({ index, action: 'until', code: settings.untilCode, snapshotId: state.snapshotId });
            break;
          }
        } catch {
          /* not reached yet */
        }
      }
    }
    const finalState = await hierarchy(api).catch(() => null);
    return {
      ok: true,
      skillId: normalized.id,
      name: normalized.name,
      package: normalized.package || null,
      stepsRun,
      stepsTotal: normalized.steps.length,
      reached,
      untilCode: settings.untilCode || null,
      snapshotId: finalState ? finalState.snapshotId : null,
      durationMs: Date.now() - startedAt,
      dryRun: settings.dryRun,
      events,
    };
  } catch (error) {
    const failure = new Error(error && error.message ? error.message : String(error));
    failure.name = 'SkillRunError';
    failure.skillId = normalized.id;
    failure.stepsRun = stepsRun;
    failure.stepIndex = stepsRun;
    failure.step = normalized.steps[stepsRun] || null;
    failure.candidates = error && error.candidates ? error.candidates : [];
    failure.lastSnapshotId = error && error.lastSnapshotId ? error.lastSnapshotId : null;
    failure.events = events;
    throw failure;
  }
}
