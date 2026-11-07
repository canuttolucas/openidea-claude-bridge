import fs from 'node:fs';

/** Cria o diretório privado (0700) e recusa symlink, outro dono ou escrita por grupo/outros. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir}: não é um diretório (symlink?)`);
  if (st.uid !== process.getuid()) throw new Error(`${dir}: pertence a outro usuário`);
  if (st.mode & 0o022) throw new Error(`${dir}: gravável por grupo/outros (chmod go-w)`);
}

/** Grava `data` em `file` de forma atômica: arquivo temporário exclusivo (O_EXCL) + rename. */
export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch { /* não existia */ }
  fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
  fs.renameSync(tmp, file);
}
