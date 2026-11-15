// Keep the panel's build-time version constant in sync with package.json.
//
// The panel ships as plain ESM with no build step, so `CLIENT_VERSION` in
// client.js is the only client-side version marker. If it drifts, the header
// pill and the stale-client banner report the wrong version (0.12.0 and 0.12.1
// were published with CLIENT_VERSION still set to '0.11.1').
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const match = client.match(/var CLIENT_VERSION = '([^']+)';/);
if (!match) {
  console.error('check-version: could not find CLIENT_VERSION in client.js');
  process.exit(1);
}
const clientVersion = match[1];
if (clientVersion !== pkg.version) {
  console.error(
    'check-version: client.js CLIENT_VERSION (' +
      clientVersion +
      ') does not match package.json version (' +
      pkg.version +
      '); update client.js',
  );
  process.exit(1);
}
console.log('check-version: ok (' + pkg.version + ')');
