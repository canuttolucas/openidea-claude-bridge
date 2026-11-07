#!/usr/bin/env node
import path from 'node:path';
import { EditorState } from './state.js';
import { startServer } from './server.js';
import { cleanStale, writeLock, removeLock } from './lockfile.js';
import { controlToken, serverKey, DEFAULT_PORT, configDir } from './config.js';

const USAGE = `uso: openidea-claude-bridge [--port N] [pasta...]
     openidea-claude-bridge --print-token   mostra o token de controle e a chave do servidor
env: BRIDGE_PORT, BRIDGE_DEBUG=1 (loga o protocolo, sem tokens)`;
const die = (m) => { console.error(`openidea-claude-bridge: ${m}`); process.exit(1); };

const args = process.argv.slice(2);
let portArg = process.env.BRIDGE_PORT ?? DEFAULT_PORT;
const folders = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else if (a === '--print-token') {
    console.log(`bridge-token (segredo do plugin): ${controlToken()}\nserverKey    (configuração do plugin): ${serverKey()}`);
    process.exit(0);
  } else if (a === '--port') portArg = args[++i];
  else if (a.startsWith('--port=')) portArg = a.slice(7);
  else if (a.startsWith('-')) die(`opção desconhecida: ${a}\n${USAGE}`);
  else folders.push(path.resolve(a));
}
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) die(`porta inválida: ${portArg}`);

const state = new EditorState();
if (folders.length) state.update({ workspaceFolders: folders });
const removed = cleanStale();
const log = process.env.BRIDGE_DEBUG ? (...a) => console.error('[bridge]', ...a) : undefined;

let srv;
try { srv = await startServer({ state, port, controlToken: controlToken(), serverKey: serverKey(), log }); }
catch (e) { die(e.code === 'EADDRINUSE' ? `porta ${port} ocupada (outra instância rodando?)` : e.message); }

// O lock precisa refletir as pastas abertas no IDE (o CLI casa o cwd contra elas). A gravação é atômica.
let lock;
const publish = () => { lock = writeLock({ port: srv.port, authToken: srv.authToken, workspaceFolders: state.workspaceFolders }); };
try { publish(); } catch (e) { await srv.close(); die(e.message); }
state.on('workspace_changed', () => { try { publish(); } catch (e) { console.error(`openidea-claude-bridge: lock: ${e.message}`); } });
console.error(`openidea-claude-bridge: porta ${srv.port} (export CLAUDE_CODE_SSE_PORT=${srv.port}), segredos em ${configDir()}${removed ? `, ${removed} lock(s) órfão(s) removido(s)` : ''}`);

let done = false;
const shutdown = async () => { if (done) return; done = true; removeLock(lock); await srv.close(); process.exit(0); };
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, shutdown);
process.on('exit', () => lock && removeLock(lock));
