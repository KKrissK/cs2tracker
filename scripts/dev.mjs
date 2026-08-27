import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vinextCli = join(root, 'node_modules', 'vinext', 'dist', 'cli.js');

console.log('Preparing the stable read-only viewer...');
const build = spawnSync(process.execPath, [vinextCli, 'build'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const service = spawn(process.execPath, [join(root, 'service', 'server.mjs')], { cwd: root, stdio: 'inherit' });
const site = spawn(process.execPath, [vinextCli, 'dev'], { cwd: root, stdio: 'inherit' });
const viewerSite = spawn(process.execPath, [vinextCli, 'start', '--port', '3002', '--hostname', '127.0.0.1'], { cwd: root, stdio: 'inherit' });
const viewer = spawn(process.execPath, [join(root, 'service', 'viewer.mjs')], { cwd: root, stdio: 'inherit' });

function stop() {
  service.kill('SIGTERM');
  site.kill('SIGTERM');
  viewerSite.kill('SIGTERM');
  viewer.kill('SIGTERM');
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
site.on('exit', (code) => { service.kill('SIGTERM'); process.exit(code ?? 0); });
service.on('exit', (code) => { if (code && !site.killed) console.warn(`Stackline data service stopped (${code}). The web interface is still running.`); });
viewer.on('exit', (code) => { if (code && !site.killed) console.warn(`Stackline viewer stopped (${code}). The private app is still running.`); });
viewerSite.on('exit', (code) => { if (code && !site.killed) console.warn(`Stackline viewer frontend stopped (${code}). The private app is still running.`); });
