/**
 * Minimal X.509 helpers for installing a local proxy CA certificate in Android.
 *
 * Android names user CA files by the OpenSSL "subject hash" (`<hash>.0`). Modern
 * Node has no OpenSSL CLI, so we parse the DER certificate here and compute the
 * same legacy hash: MD5 of the DER-encoded subject, first four bytes as a
 * little-endian 32-bit hex value.
 */
import { createHash } from 'node:crypto';

function readTlv(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('truncated DER');
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buffer.length) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer[offset + 2 + i];
    header += count;
  }
  const start = offset + header;
  const end = start + length;
  if (end > buffer.length) throw new Error('truncated DER value');
  return { tag, start, end, der: buffer.subarray(offset, end) };
}

function children(buffer, tlv) {
  const result = [];
  let offset = tlv.start;
  while (offset < tlv.end) {
    const child = readTlv(buffer, offset);
    result.push(child);
    offset = child.end;
    if (result.length > 64) throw new Error('unexpected DER structure');
  }
  return result;
}

function pemToDer(input) {
  const text = String(input || '');
  if (!/-----BEGIN CERTIFICATE-----/.test(text)) {
    // Accept raw DER too.
    if (text.length && text.charCodeAt(0) === 0x30) return Buffer.from(text, 'latin1');
    throw new Error('certificate is not PEM/DER encoded');
  }
  const matches = text.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g) || [];
  if (!matches.length) throw new Error('no PEM certificate block found');
  const body = matches[0]
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

function printableName(subjectDer) {
  // Best effort only; this is diagnostic metadata, not used for trust decisions.
  const parts = [];
  for (const match of subjectDer.toString('latin1').matchAll(/([\x20-\x7e]{2,80})/g)) {
    const text = match[1].trim();
    if (text && /[A-Za-z]/.test(text)) parts.push(text);
  }
  return parts.slice(0, 6).join(' ');
}

/** Extract the DER-encoded subject Name from a certificate. */
export function extractSubjectDer(der) {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('certificate is not a DER SEQUENCE');
  const certChildren = children(der, cert);
  if (!certChildren.length) throw new Error('empty certificate');
  const tbs = certChildren[0];
  if (tbs.tag !== 0x30) throw new Error('certificate tbsCertificate is not a SEQUENCE');
  const fields = children(der, tbs);
  let index = 0;
  // Optional [0] EXPLICIT version (0xA0).
  if (fields[index] && fields[index].tag === 0xa0) index += 1;
  // serialNumber, signatureAlgorithm, issuer, validity, subject
  const subject = fields[index + 4];
  if (!subject || subject.tag !== 0x30) throw new Error('certificate subject not found');
  return subject.der;
}

/** OpenSSL-compatible subject_hash_old (used by Android's user CA directory). */
export function subjectHashOld(der) {
  if (!Buffer.isBuffer(der) || !der.length) throw new Error('subjectHashOld requires DER bytes');
  const subject = extractSubjectDer(der);
  const digest = createHash('md5').update(subject).digest();
  const value = digest.readUInt32LE(0);
  return value.toString(16).padStart(8, '0');
}

/** Parse a PEM/DER certificate into the fields needed for CA installation. */
export function inspectCertificate(input) {
  const der = pemToDer(input);
  const subjectDer = extractSubjectDer(der);
  const hash = subjectHashOld(der);
  return {
    der,
    derBytes: der.length,
    hash,
    fileName: `${hash}.0`,
    subject: printableName(subjectDer),
    pem: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
