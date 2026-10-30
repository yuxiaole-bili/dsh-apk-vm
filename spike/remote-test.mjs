import assert from 'node:assert/strict';
import { SshAdbTunnel, buildSshTunnelArgs } from '../lib/remote.js';

let checks = 0;
let failed = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}

check('builds a loopback SSH forward with key and remote adb port', () => {
  const args = buildSshTunnelArgs({
    host: 'vm.example.test',
    user: 'opencode',
    remotePort: 5558,
    localPort: 15037,
  });
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('127.0.0.1:15037:127.0.0.1:5558'));
  const target = ['opencode', 'vm.example.test'].join('@');
  assert.ok(args.includes(target));
});

check('rejects shell metacharacters in host/user', () => {
  assert.throws(
    () => new SshAdbTunnel({ host: 'host;touch /tmp/pwn', user: 'root' }),
    /invalid SSH host/,
  );
  assert.throws(
    () => new SshAdbTunnel({ host: 'host', user: 'root;whoami' }),
    /invalid SSH user/,
  );
});

check('exposes a stable serial and stopped state', () => {
  const tunnel = new SshAdbTunnel({ host: 'vm.example.test', user: 'opencode', localPort: 15037 });
  const status = tunnel.status();
  assert.equal(status.serial, '127.0.0.1:15037');
  assert.equal(status.state, 'stopped');
});

console.log(`\n${checks - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
