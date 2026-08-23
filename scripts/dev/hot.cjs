#!/usr/bin/env node
/*
 * Hot dev loop for the Electron app.
 *
 * Runs the Next.js dev server (frontend fast refresh) and points Electron at it
 * via FLO_DEV_URL. Electron still runs the real backend (Express :3001); the
 * Next dev server (:3000) proxies /api to it (see frontend/next.config.ts
 * rewrites), so the app is fully functional while UI edits apply live without a
 * full static rebuild.
 *
 * Scope: this hot-reloads the FRONTEND. Backend (main/) changes still need a
 * rebuild + restart — rerun `npm run hot` (it recompiles main/ first). KDS
 * WebSocket live updates are not proxied by Next, so drive the KDS screen from
 * a normal `npm run dev` when you need to test realtime.
 *
 * Usage: npm run hot   (package.json cleans ports + builds the backend first)
 */
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const FRONTEND_PORT = 3000;

const children = [];
let shuttingDown = false;

function run(cmd, args, opts) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(code == null ? 1 : code);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function waitForPort(port, timeoutMs = 90_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timed out waiting for port ${port}`));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function main() {
  // 1. Frontend dev server (Next.js fast refresh) on FRONTEND_PORT.
  run('npm', ['run', 'dev'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(FRONTEND_PORT) },
  });

  console.log(`[hot] waiting for the Next dev server on :${FRONTEND_PORT} …`);
  await waitForPort(FRONTEND_PORT);

  // 2. Electron — runs the backend (:3001) and loads the dev server for HMR.
  console.log(`[hot] launching Electron → http://localhost:${FRONTEND_PORT}`);
  run('electron', ['.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      FLO_DEV_URL: `http://localhost:${FRONTEND_PORT}`,
    },
  });
}

main().catch((err) => {
  console.error('[hot]', err.message);
  shutdown(1);
});
