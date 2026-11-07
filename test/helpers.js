import { WebSocket } from 'ws';

export const connect = (srv, token = srv.authToken) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, ['mcp'], { headers: { 'x-claude-code-ide-authorization': token } });
    ws.on('open', () => res(ws)); ws.on('error', rej);
    ws.on('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });

/** Request/response JSON-RPC com timeout: falta de resposta vira falha, não suíte travada. */
export const rpc = (ws, id, method, params, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => { ws.off('message', h); rej(new Error(`sem resposta a ${method}`)); }, ms);
  const h = (d) => { const m = JSON.parse(d); if (m.id === id) { clearTimeout(t); ws.off('message', h); res(m); } };
  ws.on('message', h); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});

export const post = (srv, token, body) =>
  fetch(`http://127.0.0.1:${srv.port}/bridge/state`, { method: 'POST', headers: token ? { 'x-bridge-token': token } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });

export const CT = 'c'.repeat(40);
