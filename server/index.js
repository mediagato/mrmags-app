#!/usr/bin/env node
/**
 * mags MCP server — gives Claude Desktop a persistent local memory.
 *
 * Spawned by Claude Desktop via stdio. Connects to a local @mediagato/brain
 * (PGlite) database at the user's data dir. Exposes 7 tools:
 *
 *   memory_save / memory_recall / memory_list — long-form notes by filename
 *   state_set   / state_get     / state_list   — simple key/value config
 *   seed_pack                                  — one-time pull of a profession
 *                                                 pack from the spore catalog
 *
 * Data location:
 *   Mac:     ~/Library/Application Support/Mags/brain/
 *   Windows: %APPDATA%/Mags/brain/
 *   Linux:   ~/.local/share/mags/brain/
 *
 * Spore seed catalog (pattern packs): https://app.modelreins.com/saas/spore/seed?pack=<id>
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const brain = require('@mediagato/brain');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── data dir resolution ───────────────────────────────────────────────────

function defaultDataDir() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Mags');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'Mags');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mags');
}

const DATA_DIR = process.env.MAGS_DATA_DIR || defaultDataDir();
const SPORE_BASE = process.env.MAGS_SPORE_BASE || 'https://app.modelreins.com';

// stderr-only logging so we don't pollute stdio MCP transport
function log(...args) { process.stderr.write(`[mags-server] ${args.join(' ')}\n`); }

// ── tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_save',
    description:
      'Save a long-form memory to the user\'s local brain. Use this when the user says "remember that..." or similar. ' +
      'The filename is the slug; pick something descriptive (e.g. "current_curriculum.md", "student_sam_504.md").',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Slug filename, including extension. Use markdown by default.' },
        content: { type: 'string', description: 'The full memory content. Markdown is fine.' },
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
      'Pull a profession-specific pattern pack from the catalog and seed the brain with template memories. ' +
      'Available packs include: teacher. Idempotent — running it twice does not duplicate or overwrite the user\'s edits. ' +
      'Use this on first use, when the user identifies their profession.',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', enum: ['teacher'], description: 'Pack ID. Currently only "teacher" is supported.' },
      },
      required: ['pack'],
    },
  },
];

// ── tool dispatch ─────────────────────────────────────────────────────────

function ok(text) { return { content: [{ type: 'text', text }] }; }
function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

async function handleCall(name, args) {
  switch (name) {
    case 'memory_save': {
      await brain.setMemory(args.filename, args.content, 'claude');
      return ok(`Saved memory: ${args.filename} (${args.content.length} chars).`);
    }
    case 'memory_recall': {
      const row = await brain.getMemory(args.filename);
      if (!row) return ok(`No memory found for "${args.filename}".`);
      return ok(row.content);
    }
    case 'memory_list': {
      const all = await brain.getAllMemories();
      if (all.length === 0) return ok('No memories saved yet.');
      const lines = all.map(m => `- ${m.filename} (${m.layer}, updated ${m.updated_at})`);
      return ok(`${all.length} memories:\n${lines.join('\n')}`);
    }
    case 'state_set': {
      await brain.setState(args.key, args.value, 'claude');
      return ok(`Set state ${args.key} = ${args.value}.`);
    }
    case 'state_get': {
      const row = await brain.getState(args.key);
      if (!row) return ok(`No state for key "${args.key}".`);
      return ok(`${args.key} = ${row.value} (${row.layer}, updated ${row.updated_at})`);
    }
    case 'state_list': {
      const all = await brain.getAllState();
      if (all.length === 0) return ok('No state set yet.');
      const lines = all.map(s => `- ${s.key} = ${s.value} (${s.layer})`);
      return ok(`${all.length} state entries:\n${lines.join('\n')}`);
    }
    case 'seed_pack': {
      const pack = args.pack || 'teacher';
      const url = `${SPORE_BASE}/saas/spore/seed?pack=${encodeURIComponent(pack)}`;

      // Check if already seeded — idempotent message
      const already = await brain.isSeeded();
      const beforeCount = (await brain.getAllMemories()).length + (await brain.getAllState()).length;

      let payload;
      try {
        // Try remote catalog first
        const res = await fetch(url, { headers: { 'accept': 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        payload = await res.json();
      } catch (e) {
        // Fallback: bundled pack (shipped inside the app)
        const bundled = path.join(__dirname, '..', 'packs', `${pack}.yaml`);
        if (!fs.existsSync(bundled)) {
          return err(`Could not fetch pack "${pack}" from ${url} (${e.message}) and no bundled fallback at ${bundled}.`);
        }
        const yaml = require('yaml');
        payload = yaml.parse(fs.readFileSync(bundled, 'utf8'));
        log(`fell back to bundled pack: ${bundled}`);
      }

      const count = await brain.seedFromSpore(payload);
      const afterCount = (await brain.getAllMemories()).length + (await brain.getAllState()).length;
      const added = afterCount - beforeCount;

      const verb = already ? 're-seeded (idempotent — only new templates added)' : 'seeded';
      return ok(`Pack "${pack}" ${verb}. ${added} new template(s) added. Total memories+state: ${afterCount}.`);
    }
    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ── server lifecycle ──────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await brain.init(DATA_DIR);
  log(`brain initialized at ${brain.dbPath()}`);

  const server = new Server(
    { name: 'mags', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Mags is a persistent memory layer for this conversation. ' +
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
  log('mags MCP server ready (stdio)');
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => { await brain.close(); process.exit(0); });
process.on('SIGINT', async () => { await brain.close(); process.exit(0); });
