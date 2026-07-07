# omem

**Memory for AI agents that lives in plain markdown.**

You read it in Obsidian. Agents read and write it over MCP. Git keeps it in sync.
No LLM, no cloud, no lock-in — just markdown, an index, and a server.

[![npm](https://img.shields.io/npm/v/@kipachu/omem)](https://www.npmjs.com/package/@kipachu/omem)
[![node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://github.com/Kipachu-1/omem)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![mcp](https://img.shields.io/badge/MCP-server-purple)](https://modelcontextprotocol.io)

## How it works

```
              ┌──────────────┐        ┌──────────────┐
              │  Your vault  │ ◀────▶ │  Obsidian    │  (you)
              │  (markdown)  │        └──────────────┘
              └──────┬───────┘
                     │ chokidar poll
                     ▼
              ┌──────────────┐
              │  indexer     │── FTS5 + vector cosine (ONNX) + 1-hop wikilink graph
              │  (SQLite)    │   →  fused via RRF + recency + pinned/kind boost
              └──────┬───────┘
                     │
                     ▼
              ┌──────────────┐        ┌──────────────┐
              │  omem serve  │ ─MCP─▶ │  AI agent    │  (Claude Code, Cursor, …)
              │  (stdio/HTTP)│ ◀────  └──────────────┘
              └──────┬───────┘
                     │ git pull / push + commit
                     ▼
              ┌──────────────┐
              │  GitHub repo │  (your vault remote)
              └──────────────┘
```

The vault is the single source of truth. The SQLite index at `.omem/index.db`
is fully derived — delete it anytime, `omem rebuild` regenerates it. Retrieval
is hybrid: FTS5/BM25 keyword + brute-force vector cosine + 1-hop wikilink graph
expansion, fused with Reciprocal Rank Fusion.

No LLM and no external services in the pipeline. Embeddings run in-process via
transformers.js (ONNX); the model downloads once (~30 MB) and works offline after.

## Why omem

Most agent-memory tools are vector-DB-first. omem is **vault-first**:

- **Your memory is plain markdown.** Read, edit, search, and back it up with stock
  tools (Obsidian, vim, git, `grep`). No proprietary format, no export dance.
- **You and your agents share one store.** When you write a note in Obsidian, the
  agent sees it on the next pull. When the agent writes a note, you see it in
  Obsidian on the next push. No "agent memory" vs "human memory" split.
- **No LLM in the pipeline.** Embeddings run in-process (ONNX, ~30 MB, offline).
  Extraction, summarization, routing — those are an LLM call away if you want them,
  but omem never calls one for you.
- **Git is the audit log + sync.** Every write is a commit. Every pull is a rebase.
  Conflicts resolve local-wins; the other side stays recoverable in `git log`.
- **Obsidian is the UI.** Graph view, backlinks, daily notes, plugins — your
  existing Obsidian workflow, unchanged.

## What an agent gets

An agent that connects to omem gets a memory it can **orient, recall, read,
write, and refine** — all over MCP, all against your markdown vault.

- **Orient.** Land on a fresh session and learn the vault in one call: how many
  notes, what folders, what tags, what's recent. No guessing.
- **Recall.** Hand it a task or question; get back ranked results grouped by kind
  — decisions, gotchas, conventions float to the top. Pinned facts rank first.
- **Search & read.** Hybrid keyword + vector + graph search over every note. Full
  notes with backlinks. Browse by folder or tag without a query.
- **Write & refine.** Agents write plain markdown with frontmatter. Before writing,
  they see near-duplicate candidates so they append instead of creating dupes.
  Notes can be stamped with a `kind` (decision, gotcha, convention, …) and pinned
  for canonical facts. Superseded notes are archived, never deleted.
- **Observe.** Per-client watermarks mean an agent can ask "what changed since I
  last looked" and get a focused answer, not the whole vault.

The server ships `instructions` on the MCP `initialize` handshake — the nudge to
recall before acting travels into the agent's system prompt automatically, on every
session. ([`src/mcp/shared.ts`](./src/mcp/shared.ts), ≤400 chars, test-guarded.)

## Quick demo

Once `omem serve` is running and your MCP client is connected, an agent lands on a
task and the server `instructions` tell it to recall first. Real output from a fresh
`template/` vault:

**Orient** — one-call vault snapshot:
```json
{
  "notes": 7, "chunks": 16, "lastModified": "2026-07-06T23:11:59Z",
  "topFolders": [{"folder": "islands", "count": 3}],
  "pinned": 0, "archived": 1,
  "recent": [{"path": "CONVENTIONS.md", "title": "CONVENTIONS",
              "link": "obsidian://open?vault=…&file=CONVENTIONS"}]
}
```

**Recall** — context-in, ranked, with clickable `obsidian://` deep-links:
```json
{
  "query": "what conventions should I follow when writing notes?",
  "grouped": {"decision": [], "gotcha": [], "convention": [],
              "fact": [], "meeting": [], "log": []},
  "related": [
    {"notePath": "CONVENTIONS.md", "title": "CONVENTIONS",
     "heading": "Conventions", "score": 0.0164, "matchType": "keyword",
     "link": "obsidian://open?vault=…&file=CONVENTIONS"},
    …
  ],
  "totalScanned": 9
}
```

**Write** — creates the note **and** returns dedup candidates so the agent appends
instead of duplicating:
```json
{
  "path": "islands/example-project/2026-07-06-demo-decision.md",
  "mode": "create",
  "link": "obsidian://open?vault=…&file=islands%2Fexample-project%2F2026-07-06-demo-decision",
  "similarExisting": [
    {"path": "archive/README.md", "score": 0.857},
    {"path": "inbox/README.md", "score": 0.844},
    {"path": "CONVENTIONS.md", "score": 0.835}
  ]
}
```

## Install

```sh
# one-shot: install, pick a vault, index, register with your MCP client
npx -y @kipachu/omem setup

# or manual
npm i -g @kipachu/omem
omem init ~/my-vault   # template vault (or point at an existing one)
omem setup             # wire it up
omem agents            # register with Claude Code, Cursor, Windsurf, Gemini CLI, …
```

No vault yet? [`template/`](./template) is a ready-to-use starting structure:
per-domain `islands/`, `inbox/` for triage, `archive/` for superseded notes, and
[`CONVENTIONS.md`](./template/CONVENTIONS.md) that teaches agents the write rules.

> **npm version:** published latest is 0.6.1. The full feature set below is on
> `main` (0.7.0) and lands on the registry when `npm publish` runs. Clone the repo
> for the complete surface today.

## Run modes

**Local stdio** (single agent, same machine): `omem serve --vault ~/my-vault`
**HTTP** (remote agents or Railway deploy): `omem serve --port 8080 --vault ~/vault`
Set `OMEM_HTTP_TOKEN` for HTTP auth — **without it the endpoint is open.** Never
expose an unauthenticated port publicly.

## Conventions

Every note needs YAML frontmatter. The full schema lives in
[`template/CONVENTIONS.md`](./template/CONVENTIONS.md). The two rules that matter:

1. **Search before writing.** Agents recall before acting and append to existing
   notes instead of duplicating.
2. **Never delete.** Superseded notes are archived, not removed. History survives
   in git.

## Deploy (Railway / Docker)

The repo ships a `Dockerfile` + `start.sh` that run a 24/7 memory server: the vault
is cloned at boot, served over HTTP, git-synced both ways.

1. Create a Railway service from this repo (Dockerfile auto-detected).
2. Mount a volume at `/vault` — persists the clone, index, and ONNX model.
3. Set env vars:
   - `VAULT_REPO` — e.g. `youruser/your-vault`
   - `GITHUB_TOKEN` — fine-grained PAT, read/write contents on that repo only
   - `OMEM_HTTP_TOKEN` — `openssl rand -hex 32`
4. Generate a public domain. On each client:
   ```sh
   claude mcp add --transport http omem https://<app>.up.railway.app/mcp \
     --header "Authorization: Bearer $OMEM_HTTP_TOKEN"
   ```

## Code layout

```
src/
├── mcp/                       MCP server
│   ├── server.ts              buildServer + serveMcp/serveHttp + auth
│   ├── shared.ts              INSTRUCTIONS + withUsage observability + kindSchema
│   ├── ctx.ts                 ToolCtx + buildToolCtx closure
│   ├── index.ts               barrel
│   └── tools/
│       ├── search.ts          search + recall
│       ├── write.ts           write + move + archive
│       ├── ops.ts             sync + usage
│       └── browse/            get_note + graph + list + recent + status
├── search.ts                  Hybrid retrieval: FTS5 + vector + graph + RRF
├── indexer.ts                 Vault → SQLite index
├── graph.ts                   noteGraph() — neighborhood traversal
├── status.ts                  vaultStatus() — orientation snapshot
├── filters.ts                 SQL filter builders
├── frontmatter.ts             gray-matter wrapper
├── watcher.ts                 chokidar + embedAll sweep loop
├── git.ts                     Two-way git sync
├── embed.ts                   transformers.js ONNX embedder
├── db.ts                      better-sqlite3 schema + migrations
├── parser.ts                  markdown → chunks + wikilinks
├── setup.ts                   omem setup / init / agents
├── cli.ts                     the `omem` command
└── config.ts                  stdlib-only env reader
```

## What just shipped

Eight features landed in the 0.7–0.8 cluster — the project's whole "agents use
memory as needed" pitch:

- **Server instructions** — agents get a "recall before acting" nudge injected into
  their system prompt automatically on connect.
- **Recall** — context-in, relevant-out, grouped by kind. Decisions and conventions
  surface first; pinned facts rank above logs.
- **Orientation snapshot** — one call to learn the vault's size, folders, tags, and
  what's recent.
- **Graph browsing** — one call returns a note's neighborhood: outgoing/incoming
  wikilinks, tag neighbors, embedding-similar notes.
- **Dedup-on-write** — agents see near-duplicate candidates before creating a note,
  so they append instead of duplicating. `supersedes` archives the old note.
- **Kind + pinned ranking** — `memory_search` boosts pinned facts and load-bearing
  kinds (decision, gotcha, convention) so the important stuff floats above logs.
- **Per-client watermarks** — multi-session agents can ask "what changed since I
  last looked" and get a focused answer.
- **Usage observability** — per-tool-call stats on stderr (JSON, scrubbed) + an
  on-demand aggregate tool.

All eight are on `main`; npm publish pending (published latest is 0.6.1).

## Limits + non-goals

- **Polling, not push.** `watch` is a periodic sweep (default 30s). No OS-level file
  watching hooks.
- **Single-process counters.** Usage stats are in-memory, process-lifetime.
- **No cross-vault queries.** One omem = one vault.
- **No LLM calls in the pipeline.** Extraction, summarization, routing are your
  problem (or your agent's). omem is storage + retrieval.
- **No hard delete.** Archiving is the only sanctioned way to retire a note.

## Related

- [`template/`](./template) — ready-to-use starting vault.
- [`src/mcp/shared.ts`](./src/mcp/shared.ts) — the instructions string agents see.
- [Model Context Protocol](https://modelcontextprotocol.io) — the transport.
- [Obsidian](https://obsidian.md) — the human UI.

## License

[MIT](./LICENSE) © Kipachu.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for repo conventions. Small PRs, conventional
commits, one feature per PR.
