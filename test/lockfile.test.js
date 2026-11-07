import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanStale, writeLock } from '../src/lockfile.js';
import { controlToken, serverKey } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oicb-'));

test('lockfile: transport "ws", modo 0600, sem arquivo temporário sobrando', () => {
  const dir = tmp();
  const f = writeLock({ port: 9, authToken: 't', workspaceFolders: ['/w'], dir });
  writeLock({ port: 9, authToken: 't2', workspaceFolders: ['/w', '/v'], dir }); // substitui
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(lock.transport, 'ws'); assert.equal(lock.pid, process.pid); assert.equal(lock.authToken, 't2');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['9.lock']);
});

test('lockfile: não segue symlink plantado no lugar do arquivo', () => {
  const dir = tmp(); const alvo = path.join(tmp(), 'alvo');
  fs.writeFileSync(alvo, 'intacto'); fs.symlinkSync(alvo, path.join(dir, '7.lock'));
  writeLock({ port: 7, authToken: 't', workspaceFolders: [], dir });
  assert.equal(fs.readFileSync(alvo, 'utf8'), 'intacto'); // o rename troca o link, não escreve no alvo
  assert.equal(fs.lstatSync(path.join(dir, '7.lock')).isSymbolicLink(), false);
});

test('lockfile: recusa diretório gravável por outros ou symlink', () => {
  const dir = tmp(); fs.chmodSync(dir, 0o777);
  assert.throws(() => writeLock({ port: 1, authToken: 't', workspaceFolders: [], dir }), /gravável/);
  const real = tmp(); const link = path.join(tmp(), 'ide'); fs.symlinkSync(real, link);
  assert.throws(() => writeLock({ port: 1, authToken: 't', workspaceFolders: [], dir: link }), /não é um diretório/);
});

test('cleanStale remove só lock de PID morto e ignora o resto', () => {
  const dir = tmp();
  const live = writeLock({ port: 1, authToken: 't', workspaceFolders: [], dir });
  fs.writeFileSync(path.join(dir, '2.lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  fs.writeFileSync(path.join(dir, '3.lock'), 'lixo');
  fs.writeFileSync(path.join(dir, '4.lock'), JSON.stringify({ pid: 1.5 }));
  fs.writeFileSync(path.join(dir, '5.lock'), JSON.stringify({ pid: 1 })); // init: vivo, de outro dono (EPERM)
  assert.equal(cleanStale(dir), 1);
  for (const f of [live, '3.lock', '4.lock', '5.lock']) assert.ok(fs.existsSync(path.isAbsolute(f) ? f : path.join(dir, f)), f);
});

test('segredos persistentes: criados com 0600, estáveis, e recusados se abertos', () => {
  const dir = path.join(tmp(), 'cfg');
  const t = controlToken(dir); const k = serverKey(dir);
  assert.match(t, /^[0-9a-f]{48}$/); assert.notEqual(t, k);
  assert.equal(controlToken(dir), t);
  assert.equal(fs.statSync(path.join(dir, 'control-token')).mode & 0o777, 0o600);
  fs.chmodSync(path.join(dir, 'control-token'), 0o644);
  assert.throws(() => controlToken(dir), /chmod 600/);
  fs.chmodSync(path.join(dir, 'control-token'), 0o600); fs.writeFileSync(path.join(dir, 'server-key'), 'curto\n', { mode: 0o600 });
  assert.throws(() => serverKey(dir), /curto/);
});
