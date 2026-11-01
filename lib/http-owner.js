/**
 * Parse owner identity from HTTP headers/query and decide whether a mutating
 * request may touch a VM. Pure helpers: the caller owns the HTTP response and
 * the InstanceManager lease book.
 */

const HEADER_NAMES = [
  ['key', 'x-apk-vm-owner'],
  ['scope', 'x-apk-vm-scope'],
  ['sessionId', 'x-apk-vm-session'],
  ['workspace', 'x-apk-vm-workspace'],
  ['label', 'x-apk-vm-label'],
];

function decodeHeaderValue(value) {
  const text = String(value);
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function firstValue(headers, query, header) {
  const source = headers || {};
  const direct = source[header];
  if (direct !== undefined && direct !== null) {
    if (Array.isArray(direct)) return decodeHeaderValue(String(direct[0] || '').trim());
    return decodeHeaderValue(String(direct).trim());
  }
  if (query && typeof query.get === 'function') {
    const fromQuery = query.get(header.replace(/^x-apk-vm-/, ''));
    if (fromQuery !== undefined && fromQuery !== null) return decodeHeaderValue(String(fromQuery).trim());
  }
  return '';
}

/** Extract a normalized owner request, or null when the caller sends no key. */
export function ownerFromHttp(headers, query) {
  const key = firstValue(headers, query, 'x-apk-vm-owner');
  if (!key) return null;
  return {
    key,
    scope: firstValue(headers, query, 'x-apk-vm-scope') || 'shared',
    sessionId: firstValue(headers, query, 'x-apk-vm-session') || null,
    workspace: firstValue(headers, query, 'x-apk-vm-workspace') || null,
    label: firstValue(headers, query, 'x-apk-vm-label') || key,
    source: 'http',
  };
}

/** Compare an incoming owner with the current lease; never mutate state. */
export function checkOwnerAccess(lease, incoming, instanceId = 'default') {
  const id = String(instanceId || 'default');
  if (!lease) {
    return { ok: true, autoClaim: Boolean(incoming), touch: false };
  }
  if (!incoming) {
    return {
      ok: false,
      status: 409,
      code: 'vm-busy',
      error: `VM ${id} is in use by ${lease.label || lease.key}; include x-apk-vm-owner or claim it first`,
      owner: lease,
    };
  }
  if (incoming.key === lease.key) {
    return { ok: true, autoClaim: false, touch: true };
  }
  return {
    ok: false,
    status: 409,
    code: 'vm-busy',
    error: `VM ${id} is in use by ${lease.label || lease.key}; owner ${incoming.key} cannot control it`,
    owner: lease,
  };
}

export const HTTP_OWNER_HEADERS = HEADER_NAMES.map(([, header]) => header);
