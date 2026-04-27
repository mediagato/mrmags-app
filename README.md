# Mags v0

A tiny tray app that gives Claude Desktop a persistent local memory via MCP.

> **Working name** — final product name TBD. This is the v0 prototype shipped to one user (Mags, the BBF teacher) for real-world feedback before the public release.

## What it is

When you install Mags on your Mac, Claude Desktop gains seven new tools that read and write a local memory database. From any conversation you can say "remember that..." or "what do you know about my classes?" and Claude will use the database transparently.

The database lives on your machine at `~/Library/Application Support/Mags/brain/`. Nothing leaves the machine. Mags is a status indicator in the menu bar; the actual MCP server is spawned by Claude Desktop on demand.

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ Claude Desktop              │         │ Mags.app (menu-bar)          │
│ (anthropic.com installer)   │         │ - tray icon                  │
└──────────────┬──────────────┘         │ - first-run welcome dialog   │
               │                        │ - auto-writes Claude config  │
               │ spawns via stdio       │ - opens data folder on click │
               ▼                        └──────────────────────────────┘
┌─────────────────────────────┐
│ mags MCP server             │  reads/writes
│ (server/index.js, Node)     │ ────────────►  ~/Library/Application Support/Mags/brain/
│ 7 tools: memory_*, state_*, │
│ seed_pack                   │
└─────────────────────────────┘
```

The Electron app and the MCP server **never share access to the database** — PGlite is single-writer. The Electron process is just a presence indicator and config-wirer.

## Repo layout

```
mags-app/
├── main.js              # Electron main process (tray, welcome, Claude config)
├── preload.js           # No-op for v0 (no renderer)
├── server/
│   └── index.js         # MCP stdio server, 7 tools, wired to @mediagato/brain
├── packs/
│   └── teacher.yaml     # Bundled teacher pattern pack (also at /saas/spore/seed?pack=teacher)
├── icon/
│   ├── tray.png         # 16x16 placeholder
│   └── icon.png         # placeholder (real branding lands when name is chosen)
├── package.json
└── README.md
```

## Install (Mags v0 — hand-installed by Steve)

1. **On Mags's Mac**, install Node.js (one-click .pkg from nodejs.org) and Claude Desktop (.dmg from anthropic.com).
2. Build or copy `Mags.app` to `/Applications/`. (See "Build" below.)
3. Launch Mags once. It will:
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
# dist/Mags-0.1.0.dmg
```

For v0 the build is **unsigned**. On first launch Mags will need to be opened via right-click → Open to bypass Gatekeeper. Code signing + notarization land in Phase 3.

### Cross-platform from non-Mac

`electron-builder` cannot reliably build a signed Mac .dmg from Windows or Linux. Two options:

1. **Borrow Mags's Mac at install time** — clone this repo, `npm install`, `npm run build:mac`, install the resulting `.dmg`. Honest one-time setup.
2. **GitHub Actions macOS runner** — a workflow that triggers on tag push and produces the .dmg as an artifact. Free for public repos; $0.08/min for private. Standard pattern.

## Dev mode

```bash
npm install
npm start          # runs Electron with the local code
npm run server     # runs the MCP server standalone (for piping to a test MCP client)
```

Set `MAGS_DATA_DIR=/some/path` to override the data dir during dev.

Set `MAGS_SPORE_BASE=https://staging.modelreins.com` to point at staging for spore catalog.

## Dependencies

- [`@mediagato/brain`](https://www.npmjs.com/package/@mediagato/brain) — local PGlite memory engine, shared with Companion
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP server
- [`yaml`](https://www.npmjs.com/package/yaml) — bundled pack parsing
- [`electron`](https://www.electronjs.org/) — tray app shell
- [`electron-builder`](https://www.electron.build/) — .dmg/.exe packaging

## License

MIT.
