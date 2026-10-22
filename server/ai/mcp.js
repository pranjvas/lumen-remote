// MCP endpoint (streamable HTTP transport, JSON responses, no SSE stream) that exposes the Lumen
// tools to MCP clients on this PC. Only loopback callers holding the bearer mcpToken get in.
import { timingSafeEqual } from 'node:crypto';
import { TOOL_DEFINITIONS, callTool, describeResult, hasTool } from './tools.js';

const MAX_BODY_BYTES = 1 << 20;
const DEFAULT_PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'lumen', version: '0.1.0' };
const INSTRUCTIONS = "Tools that control the user's Samsung TV through Lumen Remote.";
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function reply(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...(body !== undefined && { 'Content-Type': 'application/json' }),
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function bearerMatches(header, token) {
  const presented = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!presented || !token) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// getToken: () => mcpToken (sync or async); toolContext: { hub, store, catalog } for tools.js.
export function createMcpHandler({ getToken, toolContext, log }) {
  async function dispatch({ id, method, params }) {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return result(id, {
          protocolVersion: typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: TOOL_DEFINITIONS });
      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string' || !hasTool(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
        const out = await callTool(name, params.arguments ?? {}, toolContext);
        log.info(`tool ${name}`, { ok: !out.isError, summary: describeResult(out.result) });
        return result(id, { content: [{ type: 'text', text: out.text }], ...(out.isError && { isError: true }) });
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async function mcpHandler(req, res) {
    // No browser has any business here; refusing every Origin also blocks DNS-rebinding tricks.
    if (!LOOPBACK.has(req.socket.remoteAddress) || req.headers.origin) return reply(res, 403, { error: 'forbidden' });
    if (!bearerMatches(req.headers.authorization, await getToken())) {
      return reply(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="lumen"' });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, { error: 'expected application/json' });

    const body = await readBody(req);
    if (body === null) return reply(res, 413, rpcError(null, -32600, 'Request too large'));
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return reply(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return reply(res, 400, rpcError(message?.id, -32600, 'Invalid Request'));
    }
    // Notifications (no id) and the client's own responses are acknowledged without a body.
    if (typeof message.method !== 'string' || message.id === undefined || message.id === null) return reply(res, 202);

    try {
      reply(res, 200, await dispatch(message));
    } catch (err) {
      log.error('mcp request failed', { method: message.method, error: err.message });
      reply(res, 200, rpcError(message.id, -32603, 'Internal error'));
    }
  };
}
