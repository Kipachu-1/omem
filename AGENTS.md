# AGENTS.md

Repo knowledge for `@kipachu/omem` (Obsidian-vault-first memory server for AI agents, MCP-over-HTTP). Append-only; do not rewrite existing bullets.

## Build
- TypeScript ESM project (`"type": "module"`). Build via `npm run prepack` → `tsc -p tsconfig.build.json`. Type-check only: `npm run typecheck`.
- The published npm package is the source of truth for the Docker image, NOT this repo's working tree. The Dockerfile installs `@kipachu/omem@<x.y.z>` from the npm registry.

## Test
- `npm test` → `node --test "test/*.test.ts"`. Node's built-in test runner; no jest/vitest.

## Conventions
- Version pins: `Dockerfile:24` pins the installed npm package version. When `package.json` version bumps, the Dockerfile pin must be bumped to match (or CI/deploy will lag by one release). The npm registry is the source of truth for available versions.
- `// ponytail: <reason>` marks acknowledged tech debt ("fine for now, fix when it shows up in a profile"). Don't remove without addressing the debt.
- `src/config.ts` is stdlib-only on purpose — it must not drag env-reading deps into the import graph; `applyEnvDefaults()` runs before any other module reads env.

## Gotchas
- No Docker daemon in the swe sandbox — `docker build .` cannot be verified locally; confirm the published version exists with `npm view @kipachu/omem@<x.y.z> version` instead.
- `openDb` in `src/db.ts` builds its schema inside a single backtick template literal. Inline SQL comments in that block must NOT contain backticks (e.g. `` `raw = ?` ``) — a backtick closes the template literal and breaks the build. Use plain text in comments.
- `test/config.test.ts` "alias guard" (githubToken never outranks GITHUB_TOKEN) is environment-dependent: fails if the host shell exports `GITHUB_TOKEN`/`GH_TOKEN` (childEnv scrubs them). Not a code regression — run `node --test test/indexer.test.ts` to isolate indexer work.
- GitHub Actions runners always carry `GITHUB_TOKEN` — it defeats the alias-guard test in `test/config.test.ts` unless `childEnv()` scrubs it. `childEnv()` scrubs `GITHUB_TOKEN`/`GH_TOKEN` alongside `OMEM_*`; don't remove that (OME-2 fix).
- `npm run typecheck` fails with `tsc: not found` unless `npm install`/`npm ci` ran first (deps must be installed before `tsc` resolves). CI handles this via step order.
- `search()`'s `after`/`before` opts are ms-epoch inclusive; `allowedPaths()` short-circuits to empty fast when the window matches no notes. Exposed on the `memory_search` MCP tool and `omem search --after/--before`.

## Commands
- `npm run typecheck` — tsc --noEmit
- `npm test` — node --test test/*.test.ts
- `npm run prepack` — build (tsc -p tsconfig.build.json)
- `npm view @kipachu/omem@<x.y.z> version` — confirm a version is published to npm
- `npm run omem -- search "query" --vault <path>` — `[--json] [--limit N] [--folder F] [--tag T] [--keyword-only] [--after T] [--before T]` (T = ISO-8601 date or ms-epoch integer)
