# omem

**Shared memory and skills for AI agents, stored in your Obsidian vault.**

You read and write it in Obsidian. Agents read and write it over MCP. Git keeps it in sync.
No LLM, no cloud, no lock-in — just markdown, an index, and a server.

[![npm](https://img.shields.io/npm/v/@kipachu/omem)](https://www.npmjs.com/package/@kipachu/omem)
[![node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://github.com/Kipachu-1/omem)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![mcp](https://img.shields.io/badge/MCP-server-purple)](https://modelcontextprotocol.io)

## Install

```sh
# install persistently so MCP clients have a stable launch path
npm i -g @kipachu/omem
omem init ~/my-vault   # template vault (or point at an existing one)
omem setup             # wire it up
omem agents            # register with Claude Code, Cursor, Windsurf, Gemini CLI, …

omem                   # no args → interactive REPL: query the vault, /help for slash commands
omem doctor            # infrastructure and knowledge health checks
omem doctor --json     # structured report
```

No vault yet? [`template/`](./template) is a ready-to-use starting structure:
per-domain `islands/`, `inbox/` for triage, `archive/` for superseded notes, and
[`CONVENTIONS.md`](./template/CONVENTIONS.md) that teaches agents the write rules.

Shared skills are available starting with [v0.11.0](https://www.npmjs.com/package/@kipachu/omem/v/0.11.0). See [Shared skills](#shared-skills) for MCP tools, imports, native sync, and background service setup.

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

## Shared skills

### Windows and connection troubleshooting

`omem agents --json` distinguishes configuration presence (`state`) from executable
availability (`launch`). `connection: "not_verified"` means no live handshake was
performed; a saved entry alone does not prove the client has connected.

After moving or reinstalling Omem, use `omem agents --repair --yes` to refresh
detected clients. Existing file configurations are backed up beside the originals
with an `.omem-backup` suffix. Restart the client/session to load changes.
Registration uses absolute Node and Omem entry paths with the configured vault.
A temporary npx installation must be installed persistently first:
`npm install -g @kipachu/omem`, then `omem agents`.

On Windows, directory fsync is unsupported and is skipped; regular files are still
flushed and their errors propagate. Windows-written bundles preserve executable
flags in the reserved `.omem-executables.json` metadata file. Keep this file with
the bundle when copying or syncing it, including through Git. It is not exposed
as a skill asset; when present it supplies the declared executable flags across
platforms. Omem does not execute scripts. Unix bundles without this metadata use
filesystem executable bits as before.

`omem --help`, `omem -h`, and subcommand help work without a vault configuration.
Doctor returns null counters when it cannot read the index and reports operation
error codes rather than treating failed reads as an empty vault. An inaccessible
configuration is reported separately from invalid JSON; repair access before
running setup or rebuilding an existing index.

Keep reusable workflows in `skills/<name>/SKILL.md` inside the vault. Each folder
can include scripts, references, binary assets, and client-specific metadata.
You edit the central files; agents discover and update them over MCP. Git sync
backs up the complete bundles. omem stores scripts without executing them.

Repository sync runs separately from native skill distribution. Enable Git
auto-sync with `omem serve --git` or `"git": true` in the saved omem config.
It commits and pushes vault changes on the watcher's sync ticks. The native
skills service only updates agent folders. Git sync uses a crash-safe SQLite
lease on macOS and Windows, and `flock` on Linux. Lock failures report an error;
only an active competing sync reports `omem sync held`.

Skills use the [Agent Skills format](https://agentskills.io/specification).
`SKILL.md` must start with YAML containing `name` and `description`. The name must
match the folder and use lowercase letters, numbers, and single hyphens, with a
maximum of 64 characters. The description must contain 1–1024 characters.
Imports preserve file bytes, executable flags, and extra frontmatter.

```text
skills/
  code-review/
    SKILL.md
    references/checklist.md
    scripts/check.sh
    assets/example.bin
```

The server adds five tools to the fourteen memory tools:

| Tool | Purpose |
| --- | --- |
| `skill_list` | Discover paginated names, descriptions, revisions, and invalid-bundle diagnostics. Optional `query` searches names and descriptions. |
| `skill_get` | Load instructions and the complete file manifest. |
| `skill_read_file` | Read a bundle-relative file at `expectedRevision`. Binary files use base64. |
| `skill_write` | Create or patch files, with explicit `removeFiles` for deletions. |
| `skill_archive` | Move a complete bundle into `archive/skills/` after checking its revision. |

For creation, pass `expectedRevision: null`. For an update or archive, pass the
revision returned by `skill_get`. A stale revision fails before changing files.
Unmentioned files survive a patch. A file entry has `path`, `content`, optional
`encoding` (`utf8` or `base64`), and optional `executable`. All skill operations
reject paths or symlinks that escape their bundle. Skill folders and archived
skills are excluded from memory indexing, and memory tools cannot modify them.

### Import and distribute selected skills

```sh
# Import one existing folder; its original files stay intact.
omem skills import ~/.agents/skills/code-review --vault ~/my-vault
omem skills list --vault ~/my-vault --query review --json

# Install the active library into native skill folders.
omem skills sync --vault ~/my-vault
omem skills status --json

# Keep native copies updated from a central HTTP server, without a vault clone.
# Set OMEM_SKILLS_TOKEN in the environment when the server requires bearer auth.
omem skills watch --server https://your-server.example/mcp
```

Native bundles live in `~/.agents/skills/<name>/`, which recent Codex, Cursor,
Gemini CLI, pi, OpenCode, VS Code Copilot, and Cascade clients can discover.
Detected Claude Code installations also receive per-skill aliases in
`~/.claude/skills/`. Names reserved by Claude (`synced` and `anthropic-skills`)
keep their shared copy and report a native compatibility conflict instead of
creating a Claude alias. Claude Desktop uses MCP. For a legacy Windsurf client that
requires its private folder, add `--legacy-windsurf`. Runtime requirements and
client-specific invocation controls remain the client's responsibility.

Sync never overwrites unmanaged folders or local edits by default. It reports
conflicts and exits unsuccessfully for a one-shot sync. Use `--adopt` to take
ownership of an identical copy, or `--overwrite-local` to explicitly replace a
conflicting copy after backup. Importing a replacement central bundle requires
`--expected-revision HASH`. Native edits do not automatically upload.

The watcher synchronizes immediately, then every 30 seconds. Change this with
`--interval SECONDS`. Downloads are checked against revisions and manifests
before installation. Connection errors, incomplete downloads, and invalid
bundles preserve the last valid native copies. Successful sync removes only
unchanged managed copies whose central skill disappeared or was archived.
SQLite coordinates cooperating installers, and journals retain the evidence
needed to recover interrupted replacements. Central writers must share the
same configured vault index to coordinate their revision checks. External
editors do not participate in SQLite locks; recovery preserves conflicting
external edits for inspection.

### Background updates on macOS

```sh
omem skills service install --server https://your-server.example/mcp
omem skills service status --json
omem skills service uninstall
```

Installation creates a user launchd service that starts at login. It saves its
source and bearer token in an owner-only `skills-service.json` profile under
the omem config directory. Credentials never enter process arguments or the
LaunchAgent plist. Uninstall stops the service and removes its owned profile
and plist; installed skills and sync history remain intact. Other platforms
can run `omem skills watch` in the foreground.

Source precedence is explicit `--server`, explicit `--vault`, an explicit
`--skills-config` profile, then `OMEM_SKILLS_SERVER` and `OMEM_VAULT`.
`skillsServer` in the existing omem config supplies the server environment
default. `OMEM_SKILLS_TOKEN` takes precedence over `OMEM_HTTP_TOKEN`.
`omem agents --json` reports native skill destinations and sync status separately
from MCP registration. Gemini may need `/skills reload`, pi `/reload`, and
other clients may need a session restart. Claude Code needs `/reload-skills`
when its skills root was created after the session started.

For isolated installations and tests, `--skills-home PATH` and
`--skills-state-dir PATH` override the native destination and ownership state.
Native discovery depends on the installed client version. Test shared-folder
and Claude-alias coexistence before relying on a particular client release.
See the discovery rules for [Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[Cascade](https://docs.devin.ai/desktop/cascade/skills).

Run `npm run verify:skills -- gemini opencode codex` for repeatable native checks in
temporary projects. The check covers discovery, alias coexistence, updates,
removal, reference reading, and a harmless script. Gemini 0.38.2, OpenCode
1.4.10, and bundled Codex CLI 0.160.0 passed these checks. Other clients need
equivalent picker checks in an isolated project; older clients may require an
upgrade for native skill support.

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
- **Write & refine.** Agents write plain markdown with frontmatter. After creation,
  they receive similarity candidates to review. Similarity alone does not establish duplication.
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

**Write** — creates the note and returns similarity candidates for review:
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

## Retrieval, updates, and memory health

Search and recall exclude `archive/` notes and notes with `archived_at` by default.
Use `includeArchived: true` for history, or `omem search "query" --include-archived`.
Folder filters do not override this default. Browse and direct reads still expose history.
Link-only and heading-only chunks receive lower priority, including before candidate limits,
so navigation cannot crowd answer text out of a retrieval leg. No reindex is required.

### Budgeted task context

```json
{
  "context": "Implement authentication in project X",
  "folder": "islands/project-x",
  "limit": 10,
  "maxTokens": 2000
}
```

Pass these arguments to `memory_recall`. It returns each note once and respects the total
`limit` across groups and related notes. Optional `maxTokens` trims excerpts while retaining
note paths, titles, and source links. The `budget` field reports estimated usage and whether
results were shortened or omitted. The estimate is UTF-8 bytes divided by three for the
compact JSON response, including links and metadata; it is not a model-specific token count.
The minimum budget is 256. An oversized query can leave too little space for response metadata
and returns an explicit error.

### Metadata-preserving updates

Read the note with `memory_get_note`, then use its `hash` in an update:

```json
{
  "path": "islands/project-x/auth.md",
  "mode": "update",
  "title": "Authentication policy",
  "content": "The revised note body.",
  "expectedHash": "<hash returned by memory_get_note>",
  "frontmatter": { "verified_at": "2026-09-11T00:00:00Z" }
}
```

`update` replaces the body and shallow-merges supplied metadata. Omitted fields, including
sources, tags, kind, and island ownership, survive. Existing `created` and `source` values
remain intact; `updated` records the update time. Supply `tags: []` to clear tags. Nested
metadata objects are replaced as a whole. `overwrite` still replaces all metadata, and
`append` adds body text. Both accept `expectedHash`. A stale hash rejects the write before
any file changes. Supplied `confidence` must be a finite number from zero through one.

Writes use temporary files and atomic renames. Cooperating writers sharing the same SQLite
index serialize their checks and mutations. External editors and writers using separate
indexes do not share this lock. Multi-file operations roll back ordinary write failures;
a process crash midway through an operation is not a crash-atomic transaction.

### Decision history

On creation, `supersedes: ["path/to/old-note.md"]` archives predecessors and writes:

- `supersedes` on the new note, containing the resulting archive paths.
- `superseded_by` on each archived note, pointing to the successor.

`memory_get_note` exposes these as `history.supersedes` and `history.supersededBy`.
Later supersession and archiving update existing history pointers when a successor moves.
The note body should state why the decision changed. Manual moves and `memory_move` do not
rewrite these pointers; the health report can identify missing replacement targets.

### Research readiness

`memory_learn` still delegates research to the calling agent. Three valid cited notes now
mean `evidenceStatus: "minimum-present"`; that alone does not make the island ready.
Each counted note needs an HTTP(S) `source_url` and a specific `source_version` or retrieval
date. Placeholders such as `latest` do not count.

Write the research plan on the hub with `memory_write`, using metadata like this:

```json
{
  "research": {
    "focus": "authentication and retries",
    "questions": [
      { "question": "How does authentication work?", "evidence": ["islands/docs-example/auth.md"] },
      { "question": "Which failures can be retried?", "evidence": [] }
    ]
  }
}
```

Focus is limited to 300 characters; whitespace, case, and Markdown markers are normalized.
Use the same `focus` when calling `memory_learn` again; use an empty string for a broad topic.
Evidence paths must name cited notes in the same island. Empty evidence arrays preserve
unanswered questions for later runs. Readiness requires at least three valid cited notes,
a hub index, and evidence for every question in the matching plan. Responses include
`blockers`, `unansweredQuestions`, and `scopeStatus`. Plans support up to 100 questions;
larger plans remain incomplete and must be split.

These are structural checks of agent-supplied evidence. They do not verify source contents,
prove that a note answers its question, or establish that the plan covers the whole topic.
A new focus requires a new scope review.

### Read-only health checks

`omem doctor` includes a knowledge audit. Use `omem doctor --json` or
`memory_status({"includeHealth": true})` for structured findings:

- Verification overdue: `review_after` is due, or `verified_at` is older than 90 days when no review date is set.
- Unverified notes: no valid `verified_at`; file modification time is not verification.
- Research notes missing a valid source URL or specific version.
- Unresolved wikilinks from active notes.
- Duplicate candidates with matching titles or normalized indexed bodies, for human or agent review.
- Archived decisions without an existing `superseded_by` target.

Each category includes a complete count and at most 20 examples. The audit reads the current
index and changes no notes. Doctor opens an existing index read-only; it does not create or
rebuild a missing index. Unindexed or stale index contents limit the report.

### Retrieval benchmark

Run `npm run benchmark:retrieval` from a checkout. The fixture contains eight curated
questions, eight answer notes, eight archived notes, and 192 navigation notes. It uses
deterministic test embeddings and measures top-1/top-5 answer hits, archived results, and
navigation results for keyword and hybrid search. It makes no network calls.

Against the original implementation, this fixture returned navigation in all 40 top-five
slots for both modes, with zero answer hits. The revised implementation has 8/8 top-1 and
8/8 top-5 answer hits in both modes, zero archived results, and navigation in 17/40 keyword
slots and 0/40 hybrid slots. This is a regression benchmark for navigation saturation,
not a measurement of live-vault accuracy or production embedding quality.

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
