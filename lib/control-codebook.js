/**
 * Control Codebook: stable, human-readable control identities for Agent Skills.
 *
 * A codebook is embedded in each Skill (not global), so a Skill keeps working
 * when the app or another Agent changes. Codes are either short numeric names
 * (`A01`) or semantic names (`LOGIN_BTN`); matching uses structural UIAutomator
 * features first, with an optional image-feature check for icon-only controls.
 *
 * Matching is deliberately strict: every declared feature must match, and an
 * ambiguous match is an error unless the entry declares a deterministic
 * `index`. Runtime control IDs from `inspect_ui` are never persisted in a Skill.
 */

import { createHash } from 'node:crypto';
import { selectorForNode } from './ui-inspector.js';
import { compareImageFeatures, normalizeImageFeatures } from './image-features.js';

export const CODEBOOK_SCHEMA_VERSION = 1;

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_ENTRIES = 500;

const FEATURE_KEYS = [
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
  'boundsRatio',
  'image',
];

export class ControlMatchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ControlMatchError';
    Object.assign(this, details);
  }
}

function asString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function asBoolean(value) {
  return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
}

function normalizeRatio(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const ratio = { x, y };
  if (Number.isFinite(Number(raw.tolerance))) ratio.tolerance = Math.min(0.2, Math.max(0.001, Number(raw.tolerance)));
  if (Number.isFinite(Number(raw.width))) ratio.width = Math.min(1, Math.max(0, Number(raw.width)));
  if (Number.isFinite(Number(raw.height))) ratio.height = Math.min(1, Math.max(0, Number(raw.height)));
  return ratio;
}

/** Normalise structural + optional image features; throws on an empty matcher. */
export function normalizeControlFeatures(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const features = {};
  for (const key of FEATURE_KEYS) {
    if (key === 'image' || key === 'boundsRatio') continue;
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    if (key === 'clickable' || key === 'enabled') {
      const value = asBoolean(source[key]);
      if (value !== undefined) features[key] = value;
    } else if (key === 'textAny') {
      const list = (Array.isArray(source.textAny) ? source.textAny : [source.textAny])
        .map(asString)
        .filter(Boolean)
        .slice(0, 20);
      if (list.length) features.textAny = list;
    } else {
      const value = asString(source[key]);
      if (value) features[key] = value.slice(0, 300);
    }
  }
  const ratio = normalizeRatio(source.boundsRatio || source.area);
  if (ratio) features.boundsRatio = ratio;
  const image = normalizeImageFeatures(source.image);
  if (image) features.image = image;
  if (!Object.keys(features).length) {
    throw new Error('control features need at least one of resourceId/text/contentDesc/className/clickable/boundsRatio/image');
  }
  return features;
}

export function normalizeCodeEntry(raw, position = 0) {
  if (!raw || typeof raw !== 'object') throw new Error(`codebook entry #${position + 1} must be an object`);
  const code = asString(raw.code);
  if (!code || !CODE_RE.test(code)) {
    throw new Error(`codebook entry #${position + 1} has an invalid code (1-64 chars: letters, digits, . _ : -)`);
  }
  const aliases = [...new Set((Array.isArray(raw.aliases) ? raw.aliases : []).map((item) => asString(item)).filter(Boolean))];
  for (const alias of aliases) {
    if (!CODE_RE.test(alias)) throw new Error(`codebook entry ${code} has an invalid alias ${JSON.stringify(alias)}`);
  }
  const name = asString(raw.name).slice(0, 120);
  const description = asString(raw.description).slice(0, 300);
  const features = normalizeControlFeatures(raw.features || raw);
  let index = null;
  if (raw.index !== undefined && raw.index !== null && raw.index !== '') {
    index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0 || index > 500) throw new Error(`codebook entry ${code} index must be 0-500`);
  }
  return {
    code,
    ...(name ? { name } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(description ? { description } : {}),
    features,
    ...(index !== null ? { index } : {}),
  };
}

/** Normalise a Skill-embedded codebook. Accepts an entry array or `{entries}`. */
export function normalizeCodebook(raw = {}) {
  const source = Array.isArray(raw) ? { entries: raw } : raw && typeof raw === 'object' ? raw : {};
  const entries = Array.isArray(source.entries) ? source.entries : [];
  if (entries.length > MAX_ENTRIES) throw new Error(`codebook supports at most ${MAX_ENTRIES} entries`);
  const normalized = entries.map((entry, index) => normalizeCodeEntry(entry, index));
  const seen = new Map();
  for (const entry of normalized) {
    for (const key of [entry.code, ...(entry.aliases || [])]) {
      const lookup = key.toUpperCase();
      if (seen.has(lookup)) throw new Error(`duplicate code/alias ${JSON.stringify(key)} in codebook`);
      seen.set(lookup, entry.code);
    }
  }
  return {
    schemaVersion: CODEBOOK_SCHEMA_VERSION,
    ...(asString(source.name) ? { name: asString(source.name).slice(0, 120) } : {}),
    entries: normalized,
  };
}

export function codebookLookup(codebook) {
  const map = new Map();
  for (const entry of codebook && Array.isArray(codebook.entries) ? codebook.entries : []) {
    map.set(entry.code.toUpperCase(), entry);
    for (const alias of entry.aliases || []) map.set(alias.toUpperCase(), entry);
  }
  return map;
}

export function findCodeEntry(codebook, code) {
  const value = asString(code);
  if (!value) return null;
  return codebookLookup(codebook).get(value.toUpperCase()) || null;
}

export function listCodes(codebook) {
  return (codebook && Array.isArray(codebook.entries) ? codebook.entries : []).map((entry) => entry.code);
}

function nodeText(node) {
  return asString(node && node.text);
}

function nodeDesc(node) {
  return asString(node && node.contentDesc);
}

function nodeId(node) {
  return asString(node && node.resourceId);
}

function nodeClass(node) {
  return asString(node && node.className);
}

function nodePkg(node) {
  return asString(node && node.packageName);
}

function includes(value, needle) {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function matchesBoundsRatio(node, ratio, screen) {
  if (!screen || !Number.isFinite(Number(screen.width)) || !Number.isFinite(Number(screen.height))) return false;
  const bounds = node && node.bounds;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  const width = Number(screen.width);
  const height = Number(screen.height);
  const centerX = (bounds.x1 + bounds.x2) / 2 / width;
  const centerY = (bounds.y1 + bounds.y2) / 2 / height;
  const tolerance = ratio.tolerance || 0.03;
  if (Math.abs(centerX - ratio.x) > tolerance || Math.abs(centerY - ratio.y) > tolerance) return false;
  if (Number.isFinite(ratio.width) && Math.abs(bounds.width / width - ratio.width) > tolerance) return false;
  if (Number.isFinite(ratio.height) && Math.abs(bounds.height / height - ratio.height) > tolerance) return false;
  return true;
}

/** Match one node against normalised features. Returns a reason list for diagnostics. */
export function matchNodeFeatures(node, features, options = {}) {
  if (!node || !features) return { ok: false, reasons: ['missing node or features'] };
  const reasons = [];
  if (features.resourceId && nodeId(node) !== features.resourceId) reasons.push(`resourceId != ${features.resourceId}`);
  if (features.resourceIdContains && !includes(nodeId(node), features.resourceIdContains)) reasons.push(`resourceId does not contain ${features.resourceIdContains}`);
  if (features.text && nodeText(node) !== features.text) reasons.push(`text != ${features.text}`);
  if (features.textAny && !features.textAny.includes(nodeText(node))) reasons.push('text is not in textAny');
  if (features.textContains && !includes(nodeText(node), features.textContains)) reasons.push(`text does not contain ${features.textContains}`);
  if (features.contentDesc && nodeDesc(node) !== features.contentDesc) reasons.push(`contentDesc != ${features.contentDesc}`);
  if (features.contentDescContains && !includes(nodeDesc(node), features.contentDescContains)) reasons.push(`contentDesc does not contain ${features.contentDescContains}`);
  if (features.className && nodeClass(node) !== features.className) reasons.push(`className != ${features.className}`);
  if (features.classNameContains && !includes(nodeClass(node), features.classNameContains)) reasons.push(`className does not contain ${features.classNameContains}`);
  if (features.packageName && nodePkg(node) !== features.packageName) reasons.push(`packageName != ${features.packageName}`);
  if (features.clickable !== undefined && Boolean(node.clickable) !== features.clickable) reasons.push(`clickable != ${features.clickable}`);
  if (features.enabled !== undefined && Boolean(node.enabled) !== features.enabled) reasons.push(`enabled != ${features.enabled}`);
  if (features.boundsRatio && !matchesBoundsRatio(node, features.boundsRatio, options.screen)) reasons.push('boundsRatio does not match');
  if (features.image) {
    const comparison = compareImageFeatures(features.image, node.imageFeatures, options);
    if (!comparison.ok) reasons.push(`image: ${comparison.reason || comparison.details.join(', ') || 'mismatch'}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function candidateView(node) {
  return {
    order: node.order,
    label: node.label || nodeText(node) || nodeDesc(node) || nodeId(node) || nodeClass(node) || `node ${node.order}`,
    resourceId: nodeId(node),
    text: nodeText(node),
    contentDesc: nodeDesc(node),
    className: nodeClass(node),
    bounds: node.bounds ? { x1: node.bounds.x1, y1: node.bounds.y1, x2: node.bounds.x2, y2: node.bounds.y2 } : null,
  };
}

function resultFor(entry, node, candidates) {
  let selector = null;
  try {
    selector = selectorForNode(node);
  } catch {
    selector = null;
  }
  return {
    ok: true,
    code: entry.code,
    entry,
    node,
    selector,
    candidates,
    matchCount: candidates.length,
  };
}

/**
 * Resolve a code against the current hierarchy.
 * @param {object} codebook normalised codebook
 * @param {string} code code or alias
 * @param {Array} nodes parsed UIAutomator nodes
 * @param {{screen?:object}} options screen dimensions for boundsRatio and image crop
 */
export function resolveControl(codebook, code, nodes, options = {}) {
  const entry = findCodeEntry(codebook, code);
  if (!entry) {
    throw new ControlMatchError(`unknown control code ${JSON.stringify(asString(code))}`, {
      code: asString(code),
      codebookCodes: listCodes(codebook),
    });
  }
  const list = Array.isArray(nodes) ? nodes : [];
  const matched = [];
  for (const node of list) {
    const result = matchNodeFeatures(node, entry.features, options);
    if (result.ok) matched.push(node);
  }
  if (!matched.length) {
    throw new ControlMatchError(`control ${entry.code} is not visible`, {
      code: entry.code,
      features: entry.features,
      candidates: list.slice(0, 5).map(candidateView),
    });
  }
  if (entry.index !== undefined) {
    if (entry.index >= matched.length) {
      throw new ControlMatchError(`control ${entry.code} index ${entry.index} is out of range (${matched.length} candidate(s))`, {
        code: entry.code,
        candidates: matched.map(candidateView),
      });
    }
    return resultFor(entry, matched[entry.index], matched);
  }
  if (matched.length > 1) {
    throw new ControlMatchError(
      `control ${entry.code} is ambiguous (${matched.length} candidates); add index or more features`,
      { code: entry.code, ambiguous: true, matchCount: matched.length, candidates: matched.map(candidateView) },
    );
  }
  return resultFor(entry, matched[0], matched);
}

/** Resolve a selector object captured by a recording or supplied by an Agent. */
export function resolveSelector(selector, nodes, options = {}) {
  const source = selector && typeof selector === 'object' ? selector : {};
  const hasCoordinates = Number.isFinite(Number(source.x)) && Number.isFinite(Number(source.y));
  const hasStructural = FEATURE_KEYS.some((key) => key !== 'image' && key !== 'boundsRatio' && source[key] !== undefined && source[key] !== null && source[key] !== '');
  const features = hasStructural ? normalizeControlFeatures(source) : {};
  if (hasCoordinates) {
    const x = Number(source.x);
    const y = Number(source.y);
    const list = Array.isArray(nodes) ? nodes : [];
    const matching = list
      .filter((node) => node.bounds && node.bounds.width > 0 && node.bounds.height > 0)
      .filter((node) => x >= node.bounds.x1 && x <= node.bounds.x2 && y >= node.bounds.y1 && y <= node.bounds.y2)
      .sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height);
    if (matching.length) {
      return resultFor({ code: `@coords:${x},${y}`, features: { ...features } }, matching[0], matching);
    }
    return {
      ok: true,
      code: `@coords:${x},${y}`,
      entry: { code: `@coords:${x},${y}`, features },
      node: { bounds: { x1: x, y1: y, x2: x, y2: y, width: 0, height: 0, center: { x, y } }, order: 0 },
      selector: { by: 'coordinates', args: { x, y }, label: `coordinates=${x},${y}`, selector: `coordinates=${x},${y}`, tapCoordinates: { x, y } },
      candidates: [],
      matchCount: 0,
    };
  }
  const list = Array.isArray(nodes) ? nodes : [];
  const matched = list.filter((node) => matchNodeFeatures(node, features, options).ok);
  if (!matched.length) throw new ControlMatchError('selector did not match the current UI', { selector: source });
  if (matched.length > 1) {
    throw new ControlMatchError(`selector is ambiguous (${matched.length} candidates)`, {
      selector: source,
      candidates: matched.map(candidateView),
    });
  }
  return resultFor({ code: 'selector', features }, matched[0], matched);
}

/** Stable hash of the hierarchy; Skills/inspect_ui use it to scope ephemeral control IDs. */
export function snapshotIdForXml(xml) {
  return `ui-${createHash('sha1').update(String(xml || '')).digest('hex').slice(0, 12)}`;
}

/** Feature tags shown in the inspector and useful as recording metadata. */
export function nodeFeatureTags(node) {
  if (!node) return [];
  const tags = [];
  if (node.resourceId) tags.push(`id:${node.resourceId}`);
  if (node.text) tags.push(`text:${String(node.text).slice(0, 60)}`);
  if (node.contentDesc) tags.push(`desc:${String(node.contentDesc).slice(0, 60)}`);
  if (node.className) tags.push(`class:${String(node.className).split('.').pop()}`);
  if (node.clickable) tags.push('clickable');
  if (node.scrollable) tags.push('scrollable');
  if (node.focusable) tags.push('focusable');
  return tags;
}

/** Infer permissive structural features from a node; used by the UI code editor. */
export function suggestFeatures(node) {
  if (!node) return {};
  const features = {};
  if (node.resourceId) features.resourceId = node.resourceId;
  else if (node.text) features.text = node.text;
  else if (node.contentDesc) features.contentDesc = node.contentDesc;
  else if (node.className) features.className = node.className;
  if (node.clickable) features.clickable = true;
  return features;
}
