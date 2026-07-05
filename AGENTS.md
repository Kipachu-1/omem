# AGENTS.md

Repo knowledge for the `omem` package (Obsidian-vault-first memory for AI agents).
Seeded by OME-7; OME-3 owns the fuller pass. Append-only — don't rewrite existing bullets.

## Build

- `npm run typecheck` — `tsc --noEmit` (no emit; typecheck only).
- `npm run prepack` / `tsc -p tsconfig.build.json` — emit `dist/` for publishing.
- Runtime is TypeScript run directly by Node ≥ 20 (`node --test`, `node src/cli.ts`) — `tsconfig.json` sets `allowImportingTsExtensions` + `erasableSyntaxOnly`, so source files import with `.ts` extensions.

## Test

- `npm test` — `node --test "test/*.test.ts"`.
- Tests run against an in-memory SQLite DB and a temp copy of `test/fixtures/vault`.
- `test/search.test.ts` uses a deterministic bag-of-words `fake` embedder (no model download). MCP tests in `test/mcp.test.ts` boot the real server over stdio and use the real local embedder (`localEmbedder()`), which may download the ONNX model on first run.

## Conventions

- Vault paths are forward-slash (`/`) relative to the vault root, regardless of OS.
- Tool schemas live in `src/mcp.ts`; `src/cli.ts` mirrors the same filters for the CLI.
- `search()` (`src/search.ts`) is the single retrieval entry point — MCP and CLI both call it. New filters get added to `SearchOpts`, `allowedPaths()`, the MCP `inputSchema`, and the CLI `parseArgs` + a parser helper.
- Frontmatter provenance fields (`source`, `created`, `title`) are stamped last and cannot be spoofed by untrusted `frontmatter` input.

## Gotchas

- `search()` `after`/`before` are **ms-epoch, inclusive** and are applied in `allowedPaths()` (note-level `mtime`), not per-chunk. When both are unset, `allowedPaths()` short-circuits to `null` (unfiltered) — a set filter with zero matches returns `[]` fast before any embedding work.
- `parseArgs` (`node:util`) only accepts `string` for CLI date/number options; parse + validate in a helper (`parseLimit`, `parseTime`) rather than trusting coercion.
- zod `.int()` on a numeric MCP schema field rejects strings at the SDK's JSON-schema boundary before the tool handler runs — invalid inputs surface as `isError: true`, not a thrown exception.

## Commands

- `omem setup` — interactive config write to `~/.config/omem/config.json`.
- `omem init <path>` — scaffold a new vault from the template.
- `omem index` — full sync (content-hash incremental).
- `omem watch` — sync + live file watcher.
- `omem serve [--port N] [--poll N]` — watch + MCP server (stdio, or HTTP on `--port`).
- `omem search "q" [--folder F] [--tag T] [--after D] [--before D] [--limit N] [--json] [--keyword-only]`.
- `omem sync` — git commit + pull + push once.
- `omem rebuild` — drop index, re-sync from scratch.
- `omem stats` / `omem agents` / `omem update`.
