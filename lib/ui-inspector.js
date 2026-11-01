/**
 * UIAutomator hierarchy parser + stable selector generation.
 *
 * Kept dependency-free (plain XML tokenizer) so the Host half can use it on every
 * platform and the client receives a ready-to-use `apk_vm` command for each node.
 */

import { createHash } from 'node:crypto';

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value || ''));
  if (!match) return null;
  const bounds = {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
  return {
    ...bounds,
    width: Math.max(0, bounds.x2 - bounds.x1),
    height: Math.max(0, bounds.y2 - bounds.y1),
    center: {
      x: Math.round((bounds.x1 + bounds.x2) / 2),
      y: Math.round((bounds.y1 + bounds.y2) / 2),
    },
  };
}

/** Parse a UIAutomator XML document into lightweight node objects. */
export function parseUiHierarchy(xml) {
  const source = String(xml || '');
  const rotationMatch = /<hierarchy[^>]*\brotation="(-?\d+)"/i.exec(source);
  const nodes = [];
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let match;
  let order = 0;
  while ((match = nodeRe.exec(source))) {
    const attrs = {};
    let attr;
    while ((attr = attrRe.exec(match[1]))) {
      attrs[attr[1]] = decodeEntities(attr[2]);
    }
    const bounds = parseBounds(attrs.bounds);
    const text = attrs.text || '';
    const contentDesc = attrs['content-desc'] || '';
    const resourceId = attrs['resource-id'] || '';
    const className = attrs.class || '';
    if (!text && !contentDesc && !resourceId && !className && !bounds) continue;
    nodes.push({
      order: order++,
      text,
      resourceId,
      contentDesc,
      className,
      packageName: attrs.package || '',
      clickable: attrs.clickable === 'true',
      longClickable: attrs['long-clickable'] === 'true',
      enabled: attrs.enabled === 'true',
      focusable: attrs.focusable === 'true',
      focused: attrs.focused === 'true',
      scrollable: attrs.scrollable === 'true',
      selected: attrs.selected === 'true',
      password: attrs.password === 'true',
      checkable: attrs.checkable === 'true',
      checked: attrs.checked === 'true',
      bounds,
    });
  }
  return {
    rotation: rotationMatch ? Number(rotationMatch[1]) : null,
    nodes,
  };
}

function shortLabel(node) {
  const text = String(node.text || '').trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  const desc = String(node.contentDesc || '').trim();
  if (desc) return desc.length > 60 ? `${desc.slice(0, 57)}...` : desc;
  const id = String(node.resourceId || '').trim();
  if (id) return id.split('/').pop();
  const cls = String(node.className || '').split('.').pop();
  return cls || `node ${node.order}`;
}

/**
 * Build the most stable selector for a node, in this order:
 * resource-id > text > content-desc > class. The returned `args` can be passed
 * directly to the `apk_vm` find_ui/assert_text/tap_text actions.
 */
export function selectorForNode(node) {
  if (!node || typeof node !== 'object') throw new Error('selectorForNode requires a node');
  let args = null;
  let by = '';
  if (node.resourceId) {
    args = { resourceId: node.resourceId };
    by = 'resourceId';
  } else if (node.text) {
    args = { text: node.text };
    by = 'text';
  } else if (node.contentDesc) {
    args = { contentDesc: node.contentDesc };
    by = 'contentDesc';
  } else if (node.className) {
    args = { className: node.className };
    by = 'className';
  } else if (node.bounds) {
    args = { x: node.bounds.center.x, y: node.bounds.center.y };
    by = 'coordinates';
  }
  if (!args) return null;
  const json = JSON.stringify(args);
  const label = `${by}=${JSON.stringify(args[by] || `${args.x},${args.y}`)}`;
  return {
    by,
    args,
    label,
    selector: label,
    findCommand: `find_ui ${json}`,
    assertCommand: `assert_text ${json}`,
    tapCommand: `tap_text ${json}`,
    tapCoordinates:
      node.bounds && node.bounds.width > 0 && node.bounds.height > 0
        ? { x: node.bounds.center.x, y: node.bounds.center.y }
        : null,
  };
}

/** Stable ID for one UIAutomator hierarchy, used to scope ephemeral control IDs. */
export function snapshotIdForXml(xml) {
  return `ui-${createHash('sha1').update(String(xml || '')).digest('hex').slice(0, 12)}`;
}

function controlFeaturesForNode(node, screen) {
  const features = {};
  if (node.resourceId) features.resourceId = node.resourceId;
  else if (node.text) features.text = node.text;
  else if (node.contentDesc) features.contentDesc = node.contentDesc;
  else if (node.className) features.className = node.className;
  if (node.clickable) features.clickable = true;
  if (screen && Number(screen.width) > 0 && Number(screen.height) > 0 && node.bounds) {
    features.boundsRatio = {
      x: Math.round(((node.bounds.x1 + node.bounds.x2) / 2 / Number(screen.width)) * 1000) / 1000,
      y: Math.round(((node.bounds.y1 + node.bounds.y2) / 2 / Number(screen.height)) * 1000) / 1000,
    };
  }
  return features;
}

function controlTags(node) {
  const tags = [];
  if (node.resourceId) tags.push(`id:${node.resourceId}`);
  if (node.text) tags.push(`text:${String(node.text).slice(0, 60)}`);
  if (node.contentDesc) tags.push(`desc:${String(node.contentDesc).slice(0, 60)}`);
  if (node.className) tags.push(`class:${String(node.className).split('.').pop()}`);
  if (node.clickable) tags.push('clickable');
  if (node.scrollable) tags.push('scrollable');
  if (node.focusable) tags.push('focusable');
  if (node.enabled === false) tags.push('disabled');
  return tags;
}

/** Add stable labels/selectors and keep the result bounded for browser transport. */
export function decorateUiNodes(nodes, options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 400));
  const all = Array.isArray(nodes) ? nodes : [];
  const snapshotId = options.snapshotId || null;
  const decorated = [];
  for (const node of all) {
    if (!node) continue;
    if (!node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) continue;
    const selector = selectorForNode(node);
    const controlId = Number.isInteger(node.order) ? `c${node.order + 1}` : `c${decorated.length + 1}`;
    decorated.push({
      ...node,
      controlId,
      ...(snapshotId ? { snapshotId } : {}),
      label: shortLabel(node),
      selector,
      features: controlFeaturesForNode(node, options.screen),
      tags: controlTags(node),
      // Overlay only needs interactive/meaningful boxes; containers are still
      // returned to the inspector list so Agents can see hierarchy.
      interactive: node.clickable || node.focusable || node.scrollable || Boolean(node.text),
    });
    if (decorated.length >= limit) break;
  }
  return { nodes: decorated, total: all.length, truncated: all.length > decorated.length };
}

/** Complete payload used by GET /apk-vm/debug/inspect and the apk_vm tool. */
export function buildInspectorPayload(dump, screen, options = {}) {
  const xml = dump && dump.xml;
  const snapshotId = options.snapshotId || (xml ? snapshotIdForXml(xml) : null);
  const parsed = parseUiHierarchy(xml);
  const decorated = decorateUiNodes(parsed.nodes, { ...options, screen, snapshotId });
  const controls = decorated.nodes
    .filter((node) => node.interactive)
    .map((node) => ({
      controlId: node.controlId,
      label: node.label,
      features: node.features,
      tags: node.tags,
      selector: node.selector,
      bounds: node.bounds,
      clickable: Boolean(node.clickable),
      enabled: node.enabled !== false,
      ...(screen && (screen.width || screen.height) ? { screen } : {}),
    }));
  return {
    ok: true,
    snapshotId,
    rotation: parsed.rotation,
    screen: screen || null,
    nodes: decorated.nodes,
    controls,
    total: decorated.total,
    truncated: decorated.truncated,
    xmlBytes: dump && dump.bytes ? dump.bytes : null,
    remotePath: dump && dump.remotePath ? dump.remotePath : null,
  };
}
