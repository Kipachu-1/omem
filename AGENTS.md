# AGENTS.md

Repo knowledge for `@kipachu/omem` (Obsidian-vault-first memory server for AI agents, MCP-over-HTTP). Append-only; do not rewrite existing bullets.

## Build
- TypeScript ESM project (`"type": "module"`). Build via `npm run prepack` → `tsc -p tsconfig.build.json`. Type-check only: `npm run typecheck`.
- The published npm package is the source of truth for the Docker image, NOT this repo's working tree. The Dockerfile installs `@kipachu/omem@<x.y.z>` from the npm registry.
- `npm install` pulls native `better-sqlite3`; first test run downloads the ONNX embedding model (~30MB via `@huggingface/transformers`).
- Node 20+ required (`engines.node`).

## Test
- `npm test` → `node --test "test/*.test.ts"`. Node's built-in test runner; no jest/vitest.
- 83 tests, ~17s with model cached.
- Test count as of OME-9: 89 (88 pre-existing + 1 instructions test). The "83" above is stale.

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
- **Test env**: `childEnv()` in `test/config.test.ts` scrubs `OMEM_*` vars (except `OMEM_ENV_FILE`) AND `GITHUB_TOKEN`/`GH_TOKEN` from inherited `process.env` before spawning child processes. When writing new test fixtures that spawn child processes, do the same.
- **Incremental == rebuild invariant**: `applyNote` in `src/indexer.ts` must keep incremental and full-rebuild state identical. The "deletions first" pass in `fullIndex` and the `reResolve` edge pass both exist to preserve this. Don't reorder or skip them.
- **Path canonicalization**: `safeRel` in `src/mcp.ts` uses `realpathSync.native` on the vault root and on the resolved path. APFS case-folding, symlinks, and `./` are all normalized. If you change path handling, re-check `memory_write` (new note) and `memory_move` (rename) — both call `safeRel` twice intentionally, to pick up the canonicalized parent after `mkdirSync`.
- **Token safety**: GitHub tokens for sync come from `OMEM_GIT_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` and are passed to git's credential helper via env (never argv), so they don't leak via `ps`. `start.sh` clones with the token in the URL once, then resets the remote to the plain URL so the secret never persists in `.git/config`.
- **Embedding model swap**: changing `OMEM_EMBED_MODEL` against an already-indexed vault requires `omem rebuild` — the index records the model in the `meta` table and `embedPending` will refuse to run with a mismatched model. This is by design (a half-embedded index is worse than none).
- `/healthz` on HTTP serve is unauthenticated by design; auth is opt-in via `OMEM_HTTP_TOKEN`. The serve startup logs a loud warning if the token is unset.

## Architecture
- **Entry**: `src/cli.ts` (the `omem` command). `applyEnvDefaults()` must run before any other import reads env.
- **MCP tools**: `src/mcp.ts` — eight tools, registered on a fresh `McpServer` per HTTP request (stateless mode) or one server for stdio.
- **Hybrid search fusion**: `src/search.ts` (FTS5 + vector cosine + 1-hop wikilink graph + memory-recency boost, RRF).
- **Git sync state machine**: `src/git.ts` `createGitSync()` returns a closure with per-vault hygiene (one-shot `.gitignore` + index untracking, stale-lock detection, rebase recovery, conflict-snapshot suppression).

## Commands
- `npm run typecheck` — tsc --noEmit
- `npm test` — node --test test/*.test.ts
- `npm run prepack` — build (tsc -p tsconfig.build.json)
- `npm view @kipachu/omem@<x.y.z> version` — confirm a version is published to npm
