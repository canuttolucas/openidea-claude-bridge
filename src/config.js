import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensurePrivateDir } from './fsutil.js';

export const DEFAULT_PORT = 38911;
export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'openidea-claude-bridge');

/** Lê (ou cria, 0600) um segredo persistente. Recusa arquivo com permissões abertas ou conteúdo curto. */
function persistentSecret(name, dir = configDir()) {
  const file = path.join(dir, name);
  const read = () => {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid()) throw new Error(`${file}: não é um arquivo seu`);
    if (st.mode & 0o077) throw new Error(`${file}: permissões abertas; rode chmod 600`);
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length < 32) throw new Error(`${file}: conteúdo curto demais; apague-o para gerar outro`);
    return t;
  };
  ensurePrivateDir(dir);
  try { return read(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(file, t + '\n', { mode: 0o600, flag: 'wx' });
    return t;
  } catch (e) {
    if (e.code === 'EEXIST') return read(); // outra instância criou primeiro
    throw e;
  }
}

/** Autoriza o canal de controle (plugin -> sidecar). Vai no segredo `bridge-token` do plugin. */
export const controlToken = (dir) => persistentSecret('control-token', dir);
/** Chave com que o sidecar prova quem é ao plugin, antes de ele enviar o token. */
export const serverKey = (dir) => persistentSecret('server-key', dir);
