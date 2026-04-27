#!/usr/bin/env node
/**
 * Mr. Mags — MCP server (thin HTTP relay).  https://mrmags.org
 *
 * Spawned by Claude Desktop via stdio. Does NOT touch the brain database
 * directly — translates each MCP tool call into an HTTP request to the
 * Mr. Mags Electron app's localhost API (127.0.0.1:11436).
 *
 * The Electron app must be running. If it isn't, every tool call returns a
 * helpful error pointing the user to open Mr. Mags from /Applications.
 *
 * Why this layer exists at all (and isn't just direct HTTP from Claude):
 * Claude Desktop only knows MCP. The MCP SDK + stdio transport is what it
 * spawns. This file is the protocol bridge — it accepts MCP, speaks HTTP.
 * Same brain serves Claude Desktop, the browser extension, future tools.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const API_BASE = process.env.MRMAGS_API_BASE || 'http://127.0.0.1:11436';

function log(...args) { process.stderr.write(`[mrmags-relay] ${args.join(' ')}\n`); }

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function brainGet(pathAndQuery) {
  const r = await fetch(`${API_BASE}${pathAndQuery}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} on GET ${pathAndQuery}: ${txt}`);
  }
  return r.json();
}

async function brainPost(pathAndQuery, body) {
  const r = await fetch(`${API_BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} on POST ${pathAndQuery}: ${txt}`);
  }
  return r.json();
}

const APP_NOT_RUNNING_HINT =
  'Mr. Mags isn\'t running. Open Mr. Mags from your Applications folder ' +
  'so the brain is reachable, then try again.';

function ok(text) { return { content: [{ type: 'text', text }] }; }
function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

function wrapNetErr(e, op) {
  const code = e && e.cause && e.cause.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return err(APP_NOT_RUNNING_HINT);
  }
  return err(`${op} failed: ${e.message}`);
}

// ── tool definitions (unchanged contract — only the impl is now HTTP) ─────

const TOOLS = [
  {
    name: 'memory_save',
    description:
      'Save a long-form memory to the user\'s local brain. Use this when the user says "remember that..." or similar. ' +
      'The filename is the slug; pick something descriptive (e.g. "current_curriculum.md", "student_sam_504.md").',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Read a single memory by filename. Returns the full content.',
    inputSchema: {
      type: 'object',
      properties: { filename: { type: 'string' } },
      required: ['filename'],
    },
  },
  {
    name: 'memory_list',
    description:
      'List all memories the user has stored, with metadata (filename, layer, updated_at). ' +
      'Use this when the user asks "what do you know about me" or to discover what to recall.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'state_set',
    description:
      'Set a small key/value state (e.g. current_subject="biology", grade_level="9"). ' +
      'Use for compact context the user wants tracked.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'state_get',
    description: 'Read a single state value by key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'state_list',
    description: 'List all state key/value pairs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'seed_pack',
    description:
      'Pull a profession-specific pattern pack and seed the brain with template memories. ' +
      'Available packs include: teacher. Idempotent — running twice does not duplicate or overwrite the user\'s edits.',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', enum: ['teacher'] },
      },
      required: ['pack'],
    },
  },
];

// ── tool dispatch ─────────────────────────────────────────────────────────

async function handleCall(name, args) {
  switch (name) {
    case 'memory_save': {
      try {
        const r = await brainPost('/memory', { filename: args.filename, content: args.content, updatedBy: 'claude' });
        return ok(`Saved memory: ${r.saved} (${r.length} chars).`);
      } catch (e) { return wrapNetErr(e, 'memory_save'); }
    }
    case 'memory_recall': {
      try {
        const r = await brainGet(`/memory/${encodeURIComponent(args.filename)}`);
        return ok(r.content);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return ok(`No memory found for "${args.filename}".`);
        return wrapNetErr(e, 'memory_recall');
      }
    }
    case 'memory_list': {
      try {
        const all = await brainGet('/memories');
        if (all.length === 0) return ok('No memories saved yet.');
        const lines = all.map((m) => `- ${m.filename} (${m.layer}, updated ${m.updated_at})`);
        return ok(`${all.length} memories:\n${lines.join('\n')}`);
      } catch (e) { return wrapNetErr(e, 'memory_list'); }
    }
    case 'state_set': {
      try {
        await brainPost(`/state/${encodeURIComponent(args.key)}`, { value: args.value, updatedBy: 'claude' });
        return ok(`Set state ${args.key} = ${args.value}.`);
      } catch (e) { return wrapNetErr(e, 'state_set'); }
    }
    case 'state_get': {
      try {
        const r = await brainGet(`/state/${encodeURIComponent(args.key)}`);
        return ok(`${args.key} = ${r.value} (${r.layer}, updated ${r.updated_at})`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return ok(`No state for key "${args.key}".`);
        return wrapNetErr(e, 'state_get');
      }
    }
    case 'state_list': {
      try {
        const all = await brainGet('/state');
        if (all.length === 0) return ok('No state set yet.');
        const lines = all.map((s) => `- ${s.key} = ${s.value} (${s.layer})`);
        return ok(`${all.length} state entries:\n${lines.join('\n')}`);
      } catch (e) { return wrapNetErr(e, 'state_list'); }
    }
    case 'seed_pack': {
      try {
        const r = await brainPost('/spore/seed', { pack: args.pack || 'teacher' });
        const verb = (r.addedMemories + r.addedState) > 0 ? 'seeded' : 're-seeded (idempotent — nothing new)';
        return ok(`Pack "${r.pack}" ${verb}. ${r.addedMemories} memories + ${r.addedState} state added.`);
      } catch (e) { return wrapNetErr(e, 'seed_pack'); }
    }
    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ── server lifecycle ──────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'mrmags', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Mr. Mags is a persistent memory layer for this conversation. ' +
        'When the user says "remember that...", call memory_save. ' +
        'When the user asks "what do you know about me / my classes / etc", call memory_list and memory_recall. ' +
        'For small key/value context (current subject, grade level), use state_*. ' +
        'On first use, ask the user their profession; if "teacher", call seed_pack({pack:"teacher"}) to load starter templates.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    log(`call ${name} ${JSON.stringify(args || {})}`);
    try {
      return await handleCall(name, args || {});
    } catch (e) {
      log(`error in ${name}: ${e.message}`);
      return err(`Tool ${name} failed: ${e.message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Mr. Mags MCP relay ready (stdio → ${API_BASE})`);
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
