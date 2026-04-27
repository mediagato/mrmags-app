# Mr. Mags

A tiny tray app that gives Claude Desktop a persistent local memory via MCP.

**[mrmags.org](https://mrmags.org)** · Free for teachers, forever.

## The origin story

Mr. Mags is named for a school teacher whose students call him Mr. Mags. He was the first user. We built it for him because his lesson plans, rubrics, and parent emails kept evaporating into one-shot AI chats that forgot him the moment he opened a new conversation. Now Claude remembers him.

## What it is

When you install Mr. Mags on your Mac, Claude Desktop gains seven new tools that read and write a local memory database. From any conversation you can say "remember that..." or "what do you know about my classes?" and Claude will use the database transparently.

The database lives on your machine at `~/Library/Application Support/Mr. Mags/brain/`. Nothing leaves the machine. Mr. Mags is a status indicator in the menu bar; the actual MCP server is spawned by Claude Desktop on demand.

## Architecture

```text
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ Claude Desktop              │         │ Mr. Mags.app (menu-bar)      │
│ (anthropic.com installer)   │         │ - tray icon                  │
└──────────────┬──────────────┘         │ - first-run welcome dialog   │
               │                        │ - auto-writes Claude config  │
               │ spawns via stdio       │ - opens data folder on click │
               ▼                        └──────────────────────────────┘
┌─────────────────────────────┐
│ mrmags MCP server           │  reads/writes
│ (server/index.js, Node)     │ ────────────►  ~/Library/Application Support/Mr. Mags/brain/
│ 7 tools: memory_*, state_*, │
│ seed_pack                   │
└─────────────────────────────┘
```

The Electron app and the MCP server **never share access to the database** — PGlite is single-writer. The Electron process is just a presence indicator and config-wirer.

## Repo layout

```text
mrmags-app/
├── main.js              # Electron main process (tray, welcome, Claude config)
├── preload.js           # No-op for v0 (no renderer)
├── server/
│   └── index.js         # MCP stdio server, 7 tools, wired to @mediagato/brain
├── packs/
│   └── teacher.yaml     # Bundled teacher pattern pack (also at /saas/spore/seed?pack=teacher)
├── icon/
│   ├── tray.png         # 16x16 placeholder
│   └── icon.png         # placeholder (real branding lands later)
├── package.json
└── README.md
```

## Install (Mr. Mags v0 — hand-installed by Steve)

1. **On the user's Mac**, install Node.js (one-click .pkg from nodejs.org) and Claude Desktop (.dmg from anthropic.com).
2. Build or copy `Mr. Mags.app` to `/Applications/`. (See "Build" below.)
3. Launch Mr. Mags once. It will:
   - Write Claude Desktop's MCP config at `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Show a one-time welcome dialog
   - Settle into the menu bar with a "✓ Connected to Claude Desktop" status
4. Restart Claude Desktop so it picks up the new MCP server.
5. In Claude, ask: "What do you know about me?" — Claude will call `memory_list` and report nothing yet, which is correct on first run.
6. Ask: "Seed me with the teacher pack." — Claude will call `seed_pack({pack:"teacher"})` and load the starter templates.
7. Done. From now on, every Claude conversation has context.

## Build

### Mac (.dmg)

Requires a Mac. Run:

```bash
npm install
npm run build:mac
# dist/Mr.\ Mags-0.1.0.dmg
```

For v0 the build is **unsigned**. On first launch the app will need to be opened via right-click → Open to bypass Gatekeeper. Code signing + notarization land in a later phase.

### Cross-platform from non-Mac

`electron-builder` cannot reliably build a signed Mac .dmg from Windows or Linux. Two options:

1. **Build on the user's Mac at install time** — clone this repo, `npm install`, `npm run build:mac`, install the resulting `.dmg`. Honest one-time setup.
2. **GitHub Actions macOS runner** — a workflow that triggers on tag push and produces the .dmg as an artifact. Free for public repos; ~$0.08/min for private. Standard pattern.

## Dev mode

```bash
npm install
npm start          # runs Electron with the local code
npm run server     # runs the MCP server standalone (for piping to a test MCP client)
```

Set `MRMAGS_DATA_DIR=/some/path` to override the data dir during dev.
Set `MRMAGS_SPORE_BASE=https://staging.modelreins.com` to point at staging for spore catalog.

## Beyond Claude Desktop (roadmap)

The brain primitive (`@mediagato/brain`) is AI-tool-agnostic. The first front door is MCP for Claude Desktop because it's the easiest path. Future front doors on the roadmap:

- **Browser extension** — universal memory layer for any web AI chat (claude.ai, ChatGPT, Gemini). Reads the input box, prepends relevant memory based on tags. Saves AI responses on demand.
- **HTTPS / OpenAPI bridge** — a localhost endpoint that ChatGPT Custom GPTs and other tools can call as a "Custom Action."
- **Remote MCP connector** — for paid Claude.ai users when Anthropic's connector framework matures.

The same brain serves all of them.

## Dependencies

- [`@mediagato/brain`](https://www.npmjs.com/package/@mediagato/brain) — local PGlite memory engine, shared with Companion
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP server
- [`yaml`](https://www.npmjs.com/package/yaml) — bundled pack parsing
- [`electron`](https://www.electronjs.org/) — tray app shell
- [`electron-builder`](https://www.electron.build/) — .dmg/.exe packaging

## License

MIT.
