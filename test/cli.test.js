import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const env = (home) => ({ ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'xdg') });
const run = (home, args = []) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...env(home), BRIDGE_PORT: '0' } });
  let err = ''; const t = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${err}`)); }, 8000);
  p.stderr.on('data', (d) => { err += d; const m = /porta (\d+) \(export/.exec(err); if (m) { clearTimeout(t); resolve({ p, port: Number(m[1]), err: () => err }); } });
  p.on('exit', (code) => { clearTimeout(t); if (code) resolve({ p, code, err: () => err }); });
});
const exited = (p) => new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', r)));

test('cli: publica o lock, republica ao mudar as pastas, remove no SIGTERM, recusa porta ocupada', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oicb-cli-'));
  const a = await run(home);
  const lock = path.join(home, 'claude/ide', `${a.port}.lock`);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).workspaceFolders, []);

  const token = fs.readFileSync(path.join(home, 'xdg/openidea-claude-bridge/control-token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${a.port}/bridge/state`, { method: 'POST', headers: { 'x-bridge-token': token }, body: JSON.stringify({ workspaceFolders: ['/proj'] }) });
  assert.equal(r.status, 204);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).workspaceFolders, ['/proj']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'claude/ide')), [`${a.port}.lock`]);
  assert.ok(!a.err().includes(token), 'o token não pode aparecer no log');

  const b = await run(home, ['--port', String(a.port)]);
  assert.equal(b.code, 1); assert.match(b.err(), /ocupada/);
  assert.ok(fs.existsSync(lock), 'a segunda instância não pode tocar no lock da primeira');

  a.p.kill('SIGTERM'); await exited(a.p);
  assert.ok(!fs.existsSync(lock), 'SIGTERM remove o lock');
});

test('cli: argumentos inválidos dão mensagem, não stack trace', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oicb-cli-'));
  for (const [args, re] of [[['--port', 'abc'], /porta inválida/], [['--nope'], /opção desconhecida/]]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: env(home), encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, re); assert.ok(!r.stderr.includes('at '), r.stderr);
  }
  const t = spawnSync(process.execPath, [CLI, '--print-token'], { env: env(home), encoding: 'utf8' });
  assert.equal(t.status, 0); assert.match(t.stdout, /bridge-token.*[0-9a-f]{48}/); assert.match(t.stdout, /serverKey.*[0-9a-f]{48}/);
});
