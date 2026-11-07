import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from './fsutil.js';

export const ideDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide');

/** Só `ESRCH` prova que o processo morreu; EPERM (outro usuário) conta como vivo. */
const dead = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};

/** Remove lockfiles cujo PID morreu (órfãos de um crash). Ignora o que não for lockfile legível e válido. */
export function cleanStale(dir = ideDir()) {
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const p = path.join(dir, f);
    try {
      const { pid } = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && dead(pid)) { fs.unlinkSync(p); removed++; }
    } catch { /* de outro dono ou ilegível: não mexer */ }
  }
  return removed;
}

/** Grava (ou substitui, atomicamente) o lockfile da porta. */
export function writeLock({ port, authToken, workspaceFolders, ideName = 'openIDEA', dir = ideDir() }) {
  ensurePrivateDir(dir);
  const file = path.join(dir, `${port}.lock`);
  const body = { pid: process.pid, workspaceFolders, ideName, transport: 'ws', runningInIDE: true, runningInWindows: false, authToken };
  writeFileAtomic(file, JSON.stringify(body));
  return file;
}

export const removeLock = (file) => { try { fs.unlinkSync(file); } catch { /* já removido */ } };
