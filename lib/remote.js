/**
 * SSH adb tunnel for running the Android VM on a remote Linux host.
 *
 * The tunnel is deliberately generic: it forwards a local loopback port to the
 * remote emulator's adb port (normally 5558) with `ssh -N -L`, then the normal
 * AndroidVm attach path runs `adb connect 127.0.0.1:<localPort>`. Nothing is
 * stored, logged or sent to a third party. The caller owns the key path.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

function asPort(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function safeHost(value) {
  const host = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) throw new Error('invalid SSH host');
  return host;
}

function safeUser(value) {
  const user = String(value || '').trim() || 'root';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new Error('invalid SSH user');
  return user;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`SSH tunnel did not listen on port ${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export class SshAdbTunnel {
  constructor(options = {}) {
    this.sshHost = safeHost(options.host);
    this.sshUser = safeUser(options.user);
    this.sshPort = asPort(options.sshPort, 22);
    this.remotePort = asPort(options.remotePort, 5558);
    this.localPort = asPort(options.localPort, 0);
    this.keyPath = String(options.keyPath || '').trim() ? path.resolve(String(options.keyPath)) : '';
    if (this.keyPath && !existsSync(this.keyPath)) throw new Error(`SSH key not found: ${this.keyPath}`);
    this.sshPath = String(options.sshPath || 'ssh');
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    this.startedAt = 0;
  }

  buildArgs() {
    const args = [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-p',
      String(this.sshPort),
    ];
    if (this.keyPath) args.push('-i', this.keyPath);
    args.push(
      '-L',
      `127.0.0.1:${this.localPort}:127.0.0.1:${this.remotePort}`,
      `${this.sshUser}@${this.sshHost}`,
    );
    return args;
  }

  async start() {
    if (this.state === 'running') return { ok: true, ...this.status() };
    if (this.state === 'starting') throw new Error('SSH tunnel is already starting');
    if (!this.localPort) this.localPort = await findFreePort();
    this.state = 'starting';
    const args = this.buildArgs();
    const child = spawn(this.sshPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8').slice(0, 4000);
    });
    child.once('error', (error) => {
      this.state = 'error';
      this.lastError = error.message;
    });
    child.once('exit', (code) => {
      if (this.state === 'running' || this.state === 'starting') {
        this.state = 'error';
        this.lastError = `ssh exited (${code}): ${stderr.trim().slice(0, 500)}`;
      }
      this.child = null;
    });
    await waitForPort(this.localPort, 20000);
    this.state = 'running';
    this.startedAt = Date.now();
    return { ok: true, ...this.status() };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    if (!child) return { ok: true, ...this.status() };
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { ok: true, ...this.status() };
  }

  status() {
    return {
      sshHost: this.sshHost,
      sshUser: this.sshUser,
      remotePort: this.remotePort,
      localPort: this.localPort,
      serial: this.localPort ? `127.0.0.1:${this.localPort}` : null,
      state: this.state,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }
}

export function buildSshTunnelArgs(options) {
  const tunnel = new SshAdbTunnel({ ...options, localPort: options.localPort || 15037 });
  return tunnel.buildArgs();
}
