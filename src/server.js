import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { buildTools } from './tools.js';

const AUTH_HEADER = 'x-claude-code-ide-authorization';
export const CONTROL_HEADER = 'x-bridge-token';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 5e6;
const MAX_CLIENTS = 16;

/** Comparação em tempo constante (compara os hashes, então nem o tamanho vaza). */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(sha(a), sha(b));

/** Prova de identidade do sidecar: HMAC(serverKey, nonce). Não revela a chave. */
export const hello = (serverKey, nonce) => crypto.createHmac('sha256', serverKey).update(nonce).digest('hex');

/** Host padrão: sem openIDEA por trás. Não anuncia tools que não conseguiria cumprir. */
export const nullHost = {};

export async function startServer({
  state, host = nullHost, authToken = crypto.randomUUID(), controlToken = crypto.randomUUID(),
  serverKey = null, port = 0, log = () => {},
}) {
  const tools = buildTools(state, host);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // Prova de identidade, sem segredo na requisição: o plugin só envia o token depois de conferir.
    if (url.pathname === '/bridge/hello' && req.method === 'GET' && serverKey) {
      const n = url.searchParams.get('n') ?? '';
      if (!/^[0-9a-f]{16,128}$/.test(n)) return void res.writeHead(400).end();
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end(hello(serverKey, n));
    }
    if (url.pathname === '/bridge/state' && req.method === 'POST') {
      if (!safeEqual(req.headers[CONTROL_HEADER], controlToken)) return void res.writeHead(401).end();
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (size > MAX_BODY) return;
        try {
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8')); // bytes inteiros: não parte caractere multibyte
          log('control', Object.keys(patch ?? {}).join(','));
          state.update(patch);
          res.writeHead(204).end();
        } catch (e) { log('control rejeitado:', e.message); res.writeHead(400).end(); }
      });
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1e6, handleProtocols: (p) => (p.has('mcp') ? 'mcp' : false) });
  server.on('upgrade', (req, socket, head) => {
    const ok = safeEqual(req.headers[AUTH_HEADER], authToken);
    log('upgrade', req.url, 'auth=', ok ? 'ok' : 'BAD');
    if (!ok || clients.size >= MAX_CLIENTS) { socket.write(`HTTP/1.1 ${ok ? 503 : 401} ${ok ? 'Busy' : 'Unauthorized'}\r\n\r\n`); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const broadcast = (method, params) => {
    const data = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(data);
  };
  state.on('at_mentioned', (m) => broadcast('at_mentioned', m));

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (e) => { log('ws error', e.message); ws.terminate(); });
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ jsonrpc: '2.0', ...o }));

    const handle = async (msg) => {
      if (msg.method === undefined || msg.id === undefined) return; // resposta do cliente ou notificação
      const reply = (result) => send({ id: msg.id, result });
      const fail = (code, message) => send({ id: msg.id, error: { code, message } });
      log('<-', msg.method, msg.id);
      switch (msg.method) {
        case 'initialize': {
          const want = msg.params?.protocolVersion;
          return reply({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'openidea-claude-bridge', version: '0.1.0' } });
        }
        case 'ping': return reply({});
        case 'resources/list': return reply({ resources: [] });
        case 'prompts/list': return reply({ prompts: [] });
        case 'tools/list': return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const t = byName.get(msg.params?.name);
          if (!t) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
          try { return reply(await t.run(msg.params.arguments ?? {})); }
          catch (e) { return reply({ isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }); }
        }
        default: return fail(-32601, `Method not found: ${msg.method}`);
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
      handle(msg).catch((e) => log('erro no handler', e.message)); // nunca derruba o processo
    });
  });

  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  const { port: boundPort } = server.address();
  return {
    port: boundPort, authToken,
    close: () => new Promise((r) => { for (const c of clients) c.terminate(); wss.close(); server.close(r); server.closeAllConnections?.(); }),
  };
}
