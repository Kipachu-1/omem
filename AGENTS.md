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

## Commands
- `npm run typecheck` — tsc --noEmit
- `npm test` — node --test test/*.test.ts
- `npm run prepack` — build (tsc -p tsconfig.build.json)
- `npm view @kipachu/omem@<x.y.z> version` — confirm a version is published to npm
