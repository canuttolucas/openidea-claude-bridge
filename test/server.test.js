import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '../src/state.js';
import { startServer, hello } from '../src/server.js';
import { connect, rpc, post, CT } from './helpers.js';

const up = async (opts = {}) => {
  const state = opts.state ?? new EditorState();
  const srv = await startServer({ state, controlToken: CT, ...opts });
  return { srv, state, done: () => srv.close() };
};

test('rejeita token errado no WebSocket e aceita o certo', async () => {
  const { srv, done } = await up();
  await assert.rejects(connect(srv, 'errado'), /401/);
  (await connect(srv)).close(); await done();
});

test('initialize, tools/list e tools/call; só anuncia o que o host cumpre', async () => {
  const { srv, state, done } = await up();
  state.update({ workspaceFolders: ['/w'], openEditors: [{ filePath: '/w/a ç.ts', isActive: true }] });
  const ws = await connect(srv);
  assert.equal((await rpc(ws, 1, 'initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(ws, 2, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  const names = (await rpc(ws, 3, 'tools/list')).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['getCurrentSelection', 'getLatestSelection', 'getOpenEditors', 'getWorkspaceFolders']);
  const ed = JSON.parse((await rpc(ws, 4, 'tools/call', { name: 'getOpenEditors', arguments: {} })).result.content[0].text);
  assert.equal(ed.tabs[0].uri, 'file:///w/a%20%C3%A7.ts'); // URI percent-encoded
  assert.equal((await rpc(ws, 5, 'tools/call', { name: 'getDiagnostics', arguments: {} })).error.code, -32602);
  assert.equal((await rpc(ws, 6, 'tools/call', { name: 'executeCode', arguments: {} })).error.code, -32602);
  assert.deepEqual((await rpc(ws, 7, 'ping')).result, {});
  assert.deepEqual((await rpc(ws, 8, 'resources/list')).result, { resources: [] });
  ws.close(); await done();
});

test('tools opcionais aparecem só quando o host as implementa', async () => {
  const host = { openFile: async () => {}, diagnostics: true, openDiff: async () => ({ accepted: false }) };
  const { srv, done } = await up({ host }); const ws = await connect(srv);
  const names = (await rpc(ws, 1, 'tools/list')).result.tools.map((t) => t.name);
  for (const n of ['openFile', 'getDiagnostics', 'openDiff', 'close_tab', 'closeAllDiffTabs']) assert.ok(names.includes(n), n);
  ws.close(); await done();
});

test('mensagens malformadas não derrubam o sidecar', async () => {
  const { srv, done } = await up(); const ws = await connect(srv);
  const next = () => new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));
  ws.send('null'); assert.equal((await next()).error.code, -32600);
  ws.send('[1,2]'); assert.equal((await next()).error.code, -32600);
  ws.send('{nao json'); assert.equal((await next()).error.code, -32700);
  ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false }); // UTF-8 inválido num frame de texto
  await new Promise((r) => ws.once('close', r)); // o ws encerra a conexão, o processo continua
  const ws2 = await connect(srv);
  assert.deepEqual((await rpc(ws2, 1, 'ping')).result, {});
  ws2.close(); await done();
});

test('at_mentioned chega ao cliente; seleção só alimenta getCurrentSelection', async () => {
  const { srv, done } = await up(); const ws = await connect(srv);
  assert.equal((await post(srv, CT, { workspaceFolders: ['/w'] })).status, 204);
  const got = new Promise((res) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.method) res(m); }));
  const r = await post(srv, CT, { selection: { filePath: '/w/a.ts', text: 'x' }, atMention: { filePath: '/w/a.ts', lineStart: 2, lineEnd: 5 } });
  assert.equal(r.status, 204);
  const m = await got;
  assert.equal(m.method, 'at_mentioned'); assert.deepEqual(m.params, { filePath: '/w/a.ts', lineStart: 2, lineEnd: 5 });
  assert.equal(JSON.parse((await rpc(ws, 1, 'tools/call', { name: 'getCurrentSelection', arguments: {} })).result.content[0].text).text, 'x');
  ws.close(); await done();
});

test('texto multibyte grande atravessa o canal de controle intacto', async () => {
  const { srv, state, done } = await up();
  const text = 'á😀'.repeat(150_000); // ~1 MB, com caracteres de 2 e 4 bytes cruzando chunks
  assert.equal((await post(srv, CT, { selection: { filePath: '/w/a.ts', text } })).status, 204);
  assert.equal(state.selection.text, text); await done();
});

test('canal de controle: 401 sem token certo, token do WS não serve, 404 em rota inexistente', async () => {
  const { srv, done } = await up();
  assert.equal((await post(srv, 'errado', {})).status, 401);
  assert.equal((await post(srv, srv.authToken, {})).status, 401);
  assert.equal((await post(srv, null, {})).status, 401);
  assert.equal((await post(srv, CT, {})).status, 204);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/outra`)).status, 404);
  assert.equal((await post(srv, CT, '{nao json')).status, 400);
  await done();
});

test('canal de controle rejeita estado inválido e @-menção fora do workspace', async () => {
  const { srv, state, done } = await up();
  assert.equal((await post(srv, CT, { workspaceFolders: '/w' })).status, 400);
  assert.equal((await post(srv, CT, { workspaceFolders: ['relativo'] })).status, 400);
  assert.equal((await post(srv, CT, { openEditors: [{ filePath: 'x' }] })).status, 400);
  assert.equal((await post(srv, CT, null)).status, 400);
  assert.equal((await post(srv, CT, { __proto__: { x: 1 }, workspaceFolders: ['/w'] })).status, 204);
  assert.equal(({}).x, undefined);
  assert.equal((await post(srv, CT, { atMention: { filePath: '/etc/passwd' } })).status, 400);
  assert.equal((await post(srv, CT, { atMention: { filePath: '/w/../etc/passwd' } })).status, 400);
  assert.equal((await post(srv, CT, { atMention: { filePath: '/w/a.ts', lineStart: 'x' } })).status, 400);
  assert.equal((await post(srv, CT, { atMention: { filePath: '/w/a.ts', lineStart: 1, lineEnd: 2 } })).status, 204);
  assert.deepEqual(state.workspaceFolders, ['/w']); await done();
});

test('prova de identidade: HMAC do nonce com a chave do servidor, sem segredo na requisição', async () => {
  const { srv, done } = await up({ serverKey: 'k'.repeat(40) });
  const n = 'ab'.repeat(16);
  const r = await fetch(`http://127.0.0.1:${srv.port}/bridge/hello?n=${n}`);
  assert.equal(r.status, 200); assert.equal(await r.text(), hello('k'.repeat(40), n));
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/bridge/hello?n=zz`)).status, 400);
  await done();
  const s2 = await up(); // sem serverKey, o endpoint não existe
  assert.equal((await fetch(`http://127.0.0.1:${s2.srv.port}/bridge/hello?n=${n}`)).status, 404);
  await s2.done();
});
