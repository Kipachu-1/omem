# AGENTS.md

Repo knowledge for `@kipachu/omem` (Obsidian-vault-first memory server for AI agents, MCP-over-HTTP). Append-only; do not rewrite existing bullets.

## Build
- TypeScript ESM project (`"type": "module"`). Build via `npm run prepack` → `tsc -p tsconfig.build.json`. Type-check only: `npm run typecheck`.
- The published npm package is the source of truth for the Docker image, NOT this repo's working tree. The Dockerfile installs `@kipachu/omem@<x.y.z>` from the npm registry.
- `npm install` pulls native `better-sqlite3`; first test run downloads the ONNX embedding model (~30MB via `@huggingface/transformers`).
- Node 20+ required (`engines.node`).

## Test
- `npm test` → `node --test "test/*.test.ts"`. Node's built-in test runner; no jest/vitest.
- ~~83 tests, ~17s with model cached.~~ (actual: 89 as of OME-9 — 88 pre-existing + 1 instructions test)
- 92 tests, ~19s with model cached (OME-13 added 3 memory_status tests). OME-14 added 14 kind/pinned tests (8 indexer/search + 6 MCP) → 106 total.
- 110 tests, ~30s with model cached (OME-12 added per-client watermark: 3 memory_recent since:'lastSeen' tests + 1 resolveHttpClientName unit test). OME-17 added 9 (5 MCP `memory_recall` + 4 search `recall`/`noteMeta`) → 119 total.
- 127 tests, ~34s with model cached (OME-10 added 8 dedup/supersedes tests incl. partial-failure guard). OME-16 added the `memory_graph` tool + tests → 130 total. OME-15 added 5 `memory_usage`/observability tests (aggregation, error counting, OMEM_USAGE_LOG=off/json stderr) → 132 total. Tool surface is now twelve (added `memory_usage`).

## Conventions
- Version pins: `Dockerfile:24` pins the installed npm package version. When `package.json` version bumps, the Dockerfile pin must be bumped to match (or CI/deploy will lag by one release). The npm registry is the source of truth for available versions.
- Conventional-commits style (`feat:`, `fix:`, `chore:`, `perf:`, `ci:`, etc.).
- `// ponytail: <reason>` is the in-repo marker for acknowledged tech debt ("fine for now, fix when it shows up in a profile"). Don't remove without addressing the debt.
- `src/config.ts` is stdlib-only on purpose — it must not drag env-reading deps into the import graph; `applyEnvDefaults()` runs before any other module reads env.

## Gotchas
- No Docker daemon in the swe sandbox — `docker build .` cannot be verified locally; confirm the published version exists with `npm view @kipachu/omem@<x.y.z> version` instead.
- `openDb` in `src/db.ts` builds its schema inside a single backtick template literal. Inline SQL comments in that block must NOT contain backticks (e.g. `` `raw = ?` ``) — a backtick closes the template literal and breaks the build. Use plain text in comments.
- `test/config.test.ts` "alias guard" (githubToken never outranks GITHUB_TOKEN) is environment-dependent: fails if the host shell exports `GITHUB_TOKEN`/`GH_TOKEN` (childEnv scrubs them). Not a code regression — run `node --test test/indexer.test.ts` to isolate indexer work.
- GitHub Actions runners always carry `GITHUB_TOKEN`; it defeats the alias-guard test in `test/config.test.ts` unless `childEnv()` scrubs it — `childEnv()` does, don't remove.
- `npm run typecheck` fails with `tsc: not found` unless `npm install`/`npm ci` ran first (deps must be installed before `tsc` resolves). CI handles this via step order.
- `search()`'s `after`/`before` opts are ms-epoch inclusive; `allowedPaths()` short-circuits to empty fast when the window matches no notes. Exposed on the `memory_search` MCP tool and `omem search --after/--before`.
- `topSimilar` (in `src/search.ts`) is the pre-write dedup primitive reused by `memory_write` — pure (no MCP types), model-mismatch aware, never throws. Test it via the fake BOW embedder in `test/search.test.ts`.
- **Test env**: `childEnv()` in `test/config.test.ts` scrubs `OMEM_*` vars (except `OMEM_ENV_FILE`) AND `GITHUB_TOKEN`/`GH_TOKEN` from inherited `process.env` before spawning child processes. When writing new test fixtures that spawn child processes, do the same.
- **Incremental == rebuild invariant**: `applyNote` in `src/indexer.ts` must keep incremental and full-rebuild state identical. The "deletions first" pass in `fullIndex` and the `reResolve` edge pass both exist to preserve this. Don't reorder or skip them.
- **Path canonicalization**: `safeRel` in `src/mcp.ts` uses `realpathSync.native` on the vault root and on the resolved path. APFS case-folding, symlinks, and `./` are all normalized. If you change path handling, re-check `memory_write` (new note) and `memory_move` (rename) — both call `safeRel` twice intentionally, to pick up the canonicalized parent after `mkdirSync`.
- **Token safety**: GitHub tokens for sync come from `OMEM_GIT_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` and are passed to git's credential helper via env (never argv), so they don't leak via `ps`. `start.sh` clones with the token in the URL once, then resets the remote to the plain URL so the secret never persists in `.git/config`.
- **Embedding model swap**: changing `OMEM_EMBED_MODEL` against an already-indexed vault requires `omem rebuild` — the index records the model in the `meta` table and `embedPending` will refuse to run with a mismatched model. This is by design (a half-embedded index is worse than none).
- **Dedup is non-blocking**: `memory_write` (mode `create`) runs `topSimilar` AFTER the write completes — the note is always created; `similarExisting` is advisory only. Embedder failure / model mismatch degrades silently to an empty list (never throws). `skipDedup: true` bypasses it entirely for bulk imports. `supersedes` archives old notes BEFORE the new write using the shared `archiveNote` helper (same logic as `memory_archive`).
- `/healthz` on HTTP serve is unauthenticated by design; auth is opt-in via `OMEM_HTTP_TOKEN`. The serve startup logs a loud warning if the token is unset.
- **CI disabled** (2026-07-05): GitHub Actions workflow `ci.yml` is `disabled_manually` (billing lock on the Kipachu-1 account). There is NO CI backstop — agents must run `npm run typecheck` + `npm test` locally and confirm green before opening a PR. Re-enable via `gh workflow enable ci` or the GitHub UI once billing is resolved.
- **Usage observability** (OME-15): every MCP tool call is wrapped in `withUsage(tool, args, fn)` (`src/mcp.ts`) — times the call, records in-memory `usageStats` (process-lifetime, no DB), and emits one JSON event to stderr. `OMEM_USAGE_LOG=off|json|stats` controls the stderr log (default `json`); `off` still counts aggregates but emits nothing. The read-only `memory_usage` tool returns `{since, totals, byTool}` and is NOT itself wrapped (so it doesn't count itself). Args are scrubbed: `query`/`context` truncated to 80 chars, `content`/`frontmatter` redacted, `path`/`folder` kept full. `countResults` best-effort-counts across array / `{notes}` / `{grouped,related}` return shapes. New tools MUST register their handler inside `withUsage(name, args, async () => {...})` to be counted.
- **kind/pinned columns** (OME-14): `notes.kind TEXT` + `notes.pinned INTEGER NOT NULL DEFAULT 0` are added to `openDb` both in the CREATE TABLE and via idempotent `ALTER TABLE ... ADD COLUMN` (try/catch on "duplicate column name") for existing dbs. `applyNote` stamps them from frontmatter; `fullIndex` backfills. `pinned` frontmatter accepts bool / `"true"` / `1` / `"1"` (coerced in `indexer.ts`). `memory_search`/`memory_list` expose `kinds`/`pinned` filters; ranking multiplies pinned ×1.4 and decision/gotcha/convention ×1.2. `memory_status` reports `topKinds` and reads `pinned` from the column (not json_extract).
- **Per-client watermark** (OME-12): `memory_recent since:"lastSeen"` reads/seeds a `client.lastSeen.<name>` meta key. Client name = `X-Omem-Client` header (HTTP) → `sha256(OMEM_HTTP_TOKEN).slice(0,16)` (HTTP) → `OMEM_CLIENT_NAME` env → `stdio:<ppid>:<exe>` (stdio). Watermark is set AFTER the query, so a client always sees notes that existed when it called; the next call with no changes returns an empty list. `memory_search` does NOT touch the watermark (intentionally — recall vs. "what changed"). Two stdio serves on one vault share the SQLite `meta` table, so per-client keys are per-name global, not per-process.
- **`memory_recall` + `noteMeta` (OME-17)**: `recall()` (`src/search.ts`) is a thin layer over `search()` — it delegates kind/pinned filtering and the pinned ×1.4 / load-bearing-kind ×1.2 boost to `search()` (do NOT re-apply the boost in `recall`), then buckets results by `kind` with per-kind caps (`KIND_CAPS`) and fills `related`. `noteMeta(db, paths)` reads `notes.kind`/`notes.pinned` columns (the OME-14 columns) — not `json_extract`.
- **`memory_graph` + `topSimilarNotes` (OME-16)**: new read-only tool — one-call note neighborhood (outgoing/incoming k-hop wikilinks, byTag, byEmbedding). k-hop traversal uses per-direction visited sets (independent BFS); a final cross-list dedup (outgoing > incoming > byTag > byEmbedding) enforces "each path listed once", and `limit` caps the total union by trimming lowest-priority lists first. `topSimilarNotes(db, embedder, text, k)` in `src/search.ts` is the note-level cosine helper (best score per note) — NOT shared with `search()`'s vector leg (that one ranks chunks for RRF). Returns `[]` (no error) when the embedder is unavailable or the recorded model mismatches. Tool surface is now twelve.
- **INSTRUCTIONS ≤400 chars**: `src/mcp.ts` `INSTRUCTIONS` is asserted ≤400 chars by `test/mcp.test.ts` ("server advertises memory-usage instructions"). When adding a tool reference, trim existing prose to fit — some MCP clients silently trim long instructions.

## Architecture
- **Entry**: `src/cli.ts` (the `omem` command). `applyEnvDefaults()` must run before any other import reads env.
- **MCP tools**: `src/mcp/` module tree — twelve tools (added `memory_usage` in OME-15), registered on a fresh `McpServer` per HTTP request (stateless mode) or one server for stdio. Layout (OME-18 split): `server.ts` (buildServer + serveMcp/serveHttp + bearerOk + client-name resolvers), `shared.ts` (withUsage observability + constants + folderPat re-export + kindSchema), `ctx.ts` (ToolCtx + buildToolCtx closure factory), `tools/{search,browse,write,ops}.ts` (register*Tools functions grouped by concern), `index.ts` (barrel re-export). `usageStats` lives in `shared.ts` only — tool files import it read-only. `archiveNote` lives on `ToolCtx` (shared between memory_archive + memory_write's supersedes path).
- **Browse tools split** (OME-19): `src/mcp/tools/browse/` is now a per-tool directory — `get_note.ts`, `graph.ts`, `list.ts`, `recent.ts`, `status.ts` each register one tool; `index.ts` is the barrel re-exporting `registerBrowseTools`. The old monolithic `browse.ts` (373 LOC single fn) was decomposed. Graph traversal lives in `src/graph.ts` (`noteGraph()`); status snapshot in `src/status.ts` (`vaultStatus()`).
- **Shared helpers** (OME-19): `src/frontmatter.ts` (`parseFrontmatter`/`stringifyFrontmatter` — single gray-matter wrapper used by parser, ctx, write, get_note), `src/filters.ts` (`folderPat`/`tagEscape`/`folderFilter`/`tagFilter`/`kindsFilter` — SQL filter builders shared by search.ts + browse tools), `src/watcher.ts` (`startWatcher` + `embedAll` extracted from cli.ts).
- **Git sync phases** (OME-19): `src/git.ts` `createGitSync()` now splits the 99-line `gitSync` into named phases — `preflight()`, `hygiene()`, `commitPhase()`, `pullPhase()`, `pushPhase()` — all closing over the same per-vault state.
- **Hybrid search fusion**: `src/search.ts` (FTS5 + vector cosine + 1-hop wikilink graph + memory-recency boost, RRF; + pinned/kind ranking boost per OME-14).
- **Git sync state machine**: `src/git.ts` `createGitSync()` returns a closure with per-vault hygiene (one-shot `.gitignore` + index untracking, stale-lock detection, rebase recovery, conflict-snapshot suppression).
- **Stale Git lock recovery**: `createGitSync()` removes `.git/index.lock` only after it is older than 10 minutes and `ps -eo comm=` finds no active `git` process; if process inspection fails or a process exists, sync skips safely.

## Commands
- `npm run typecheck` — tsc --noEmit
- `npm test` — node --test test/*.test.ts
- `npm run prepack` — build (tsc -p tsconfig.build.json)
- `npm view @kipachu/omem@<x.y.z> version` — confirm a version is published to npm
- `OMEM_USAGE_LOG=off|json|stats` — per-tool-call stderr log mode (default `json`); `memory_usage` MCP tool returns aggregate counts

