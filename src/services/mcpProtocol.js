const { MCP_INSTRUCTIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION } = require('../constants/lifeContext');
const { getSettings } = require('./lifeContextSettings');
const {
  loadPortrait,
  renderBoundaries,
  renderLifeCapsule,
  renderPublicProfile,
  searchLifeSignals,
} = require('./lifeContextDistill');

const TOOLS = [
  {
    name: 'get_public_profile',
    description:
      'Return the user’s public Data Dance identity: display name, handle, and connected life sources. Safe at every share level.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_boundaries',
    description:
      'Return what this lifestyle portrait allows an assistant to say. Call this before advice that could expose private facts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_life_capsule',
    description:
      'Return a distilled lifestyle portrait from Data Dance traces (shopping rhythm, travel places, events). Not raw receipts. Respects the user’s share level.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'search_life_signals',
    description:
      'Search distilled lifestyle themes for a question such as travel, gifts, food, or refusals. Returns short hits, not a full dump.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short question or keywords, e.g. "Kyoto trip" or "what I buy for the studio".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(id, text, isError = false) {
  return ok(id, {
    resultType: 'complete',
    content: [{ type: 'text', text }],
    isError,
  });
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function callTool(userId, name, args) {
  const [settings, portrait] = await Promise.all([getSettings(userId), loadPortrait(userId)]);
  switch (name) {
    case 'get_public_profile':
      return renderPublicProfile(portrait);
    case 'get_boundaries':
      return renderBoundaries(settings, portrait);
    case 'get_life_capsule':
      return renderLifeCapsule(settings, portrait);
    case 'search_life_signals':
      return searchLifeSignals(settings, portrait, args.query);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcpMessage(userId, body) {
  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const handled = await handleMcpMessage(userId, item);
      if (handled.response !== null) results.push(handled.response);
    }
    return { response: results.length ? results : null, notification: false };
  }

  const req = body && typeof body === 'object' ? body : {};
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const isNotification = req.id === undefined || method.startsWith('notifications/');

  if (req.jsonrpc !== '2.0' || !method) {
    if (isNotification) return { response: null, notification: true };
    return { response: fail(id, -32600, 'Invalid JSON-RPC request.'), notification: false };
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { response: null, notification: true };
  }
  if (method === 'ping') return { response: ok(id, {}), notification: false };

  if (method === 'initialize') {
    const params = asRecord(req.params);
    const requested =
      typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
        ? params.protocolVersion.trim()
        : '2025-03-26';
    return {
      response: ok(id, {
        protocolVersion: requested.includes('2024-11-05') ? '2024-11-05' : requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      }),
      notification: false,
    };
  }

  if (method === 'tools/list') {
    return { response: ok(id, { tools: TOOLS }), notification: false };
  }

  if (method === 'tools/call') {
    const params = asRecord(req.params);
    const name = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments);
    if (!name) return { response: fail(id, -32602, 'Tool name is required.'), notification: false };
    try {
      const text = await callTool(userId, name, args);
      return { response: toolResult(id, text), notification: false };
    } catch (error) {
      return {
        response: toolResult(id, error instanceof Error ? error.message : 'Tool failed.', true),
        notification: false,
      };
    }
  }

  if (isNotification) return { response: null, notification: true };
  return { response: fail(id, -32601, `Method not found: ${method}`), notification: false };
}

module.exports = { handleMcpMessage, TOOLS };
