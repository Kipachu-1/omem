# AGENTS.md

Repo knowledge for `@kipachu/omem` (Obsidian-vault-first memory server for AI agents, MCP-over-HTTP). Append-only; do not rewrite existing bullets.

## Build
- TypeScript ESM project (`"type": "module"`). Build via `npm run prepack` → `tsc -p tsconfig.build.json`. Type-check only: `npm run typecheck`.
- The published npm package is the source of truth for the Docker image, NOT this repo's working tree. The Dockerfile installs `@kipachu/omem@<x.y.z>` from the npm registry.

## Test
- `npm test` → `node --test "test/*.test.ts"`. Node's built-in test runner; no jest/vitest.

## Conventions
- Version pins: `Dockerfile:24` pins the installed npm package version. When `package.json` version bumps, the Dockerfile pin must be bumped to match (or CI/deploy will lag by one release). The npm registry is the source of truth for available versions.

## Gotchas
- No Docker daemon in the swe sandbox — `docker build .` cannot be verified locally; confirm the published version exists with `npm view @kipachu/omem@<x.y.z> version` instead.
- `openDb` in `src/db.ts` builds its schema inside a single backtick template literal. Inline SQL comments in that block must NOT contain backticks (e.g. `` `raw = ?` ``) — a backtick closes the template literal and breaks the build. Use plain text in comments.
- `test/config.test.ts` "alias guard" (githubToken never outranks GITHUB_TOKEN) is environment-dependent: fails if the host shell exports `GITHUB_TOKEN`/`GH_TOKEN` (childEnv scrubs them). Not a code regression — run `node --test test/indexer.test.ts` to isolate indexer work.

## Commands
- `npm run typecheck` — tsc --noEmit
- `npm test` — node --test test/*.test.ts
- `npm run prepack` — build (tsc -p tsconfig.build.json)
- `npm view @kipachu/omem@<x.y.z> version` — confirm a version is published to npm
