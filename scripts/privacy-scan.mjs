#!/usr/bin/env node
/**
 * Privacy scan for the tracked tree.
 *
 * This is intentionally conservative but avoids common false positives:
 * - loopback addresses and test fixtures are allowed;
 * - binary files are skipped;
 * - emails are only flagged outside LICENSE/NOTICE/upstream URLs.
 *
 * Exit code 1 means at least one finding. Run with `--all` to also scan the
 * full git history (maintainers only; development history may be intentionally
 * unpublished — publish the clean `open-source` branch instead).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = new Set(process.argv.slice(2));
const scanHistory = args.has('--all');

const rules = [
  { id: 'windows-personal-path', re: /[A-Za-z]:\\Users\\[^\\\s]+/i, why: 'Windows user profile path' },
  { id: 'chinese-workspace-path', re: /[A-Za-z]:\\(?:滚木|[^\s\\]*[\u4e00-\u9fff][^\s\\]*)/, why: 'non-ASCII workspace path' },
  { id: 'posix-home-path', re: /(?:^|[^\w])\/(?:Users|home)\/[A-Za-z0-9._-]+\//, why: 'POSIX user home path' },
  { id: 'private-ipv4', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/, why: 'private-network IPv4 address' },
  { id: 'agent-instance-id', re: /\bagent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'DSH agent instance id' },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, why: 'email address', allowFiles: /^(LICENSE|NOTICE|CODE_OF_CONDUCT\.md|SECURITY\.md)$/ },
  { id: 'secret-assignment', re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}/i, why: 'credential-like assignment' },
  { id: 'private-key', re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, why: 'private key block' },
  { id: 'known-token', re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,})\b/, why: 'cloud/API token pattern' },
];

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function scanFile(file, text) {
  const findings = [];
  for (const rule of rules) {
    if (rule.allowFiles && rule.allowFiles.test(file)) continue;
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text))) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(text.length, match.index + match[0].length + 40);
      findings.push({
        file,
        id: rule.id,
        why: rule.why,
        sample: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
      if (!rule.re.global) break;
    }
  }
  return findings;
}

const findings = [];
for (const file of listFiles()) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.includes(0)) continue; // binary (JAR/APK/PNG/MP4)
  findings.push(...scanFile(file, buffer.toString('utf8')));
}

if (scanHistory) {
  let history = '';
  try {
    history = execFileSync('git', ['log', '--all', '-p', '--format=commit %H'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    console.error('privacy scan: git history unavailable:', error.message);
  }
  findings.push(...scanFile('<git-history>', history));
}

if (findings.length === 0) {
  console.log(`privacy scan: clean (${listFiles().length} tracked files${scanHistory ? ' + history' : ''})`);
  process.exit(0);
}

console.error(`privacy scan: ${findings.length} finding(s)`);
for (const finding of findings.slice(0, 100)) {
  console.error(`- [${finding.id}] ${finding.file}: ${finding.why}`);
  console.error(`  ${finding.sample}`);
}
if (findings.length > 100) console.error(`... and ${findings.length - 100} more`);
process.exit(1);
