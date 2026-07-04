# omem — Obsidian-vault-first memory for AI agents

The vault is the single source of truth. The SQLite index at `<vault>/.omem/index.db`
is fully derived — delete it anytime, `omem index` rebuilds it. Retrieval is hybrid:
FTS5/BM25 keyword + brute-force vector cosine + 1-hop wikilink graph expansion,
fused with Reciprocal Rank Fusion.

No LLM and no external services in the pipeline. Embeddings run in-process via
transformers.js (ONNX); the model downloads once (~30MB) and works offline after.

## Install

```sh
npm i -g @kipachu/omem     # or: npx @kipachu/omem setup
omem setup                 # interactive: vault, git sync, first index, MCP registration
omem agents                # re-run detection anytime: finds Claude Code, Codex, pi, Cursor,
                           # Windsurf, Gemini CLI, opencode, Claude Desktop, VS Code and
                           # offers to register the omem MCP server in each
omem update                # self-update to the latest npm release
```

Config lives at `~/.config/omem/config.json` (chmod 600; may hold an optional GitHub PAT).
Precedence: flags > env > repo `.env` (dev) > config file.

## Start a vault from the template

No vault yet? The [`template/`](./template) folder is a ready-to-use starting structure —
islands (per-domain folders with per-island conventions), `inbox/` + `memory/` triage flow,
`archive/` instead of deletion, and a `CONVENTIONS.md` that teaches agents the write rules
(frontmatter schema, search-before-write, distill-don't-dump).

```sh
omem init ~/my-vault   # template + .gitignore + git init + first commit
omem setup             # point it at ~/my-vault
```

(`omem setup` also offers this when you give it a path that doesn't exist yet.)

Rename `islands/example-project` and `islands/user-me` to fit; the structure is the
template, not the names.

## Use (repo checkout)

```sh
npm install
npm run omem -- index --vault ~/vault      # full sync (incremental, hash-diffed)
npm run omem -- search "what did we decide about auth" --vault ~/vault
npm run omem -- watch --vault ~/vault      # sync then follow live edits [--poll N: sweep every N s]
npm run omem -- serve --vault ~/vault      # watch + MCP server on stdio (the normal run mode)
npm run omem -- rebuild --vault ~/vault    # drop index, re-sync from scratch
npm run omem -- stats --vault ~/vault
```

Search flags: `--json`, `--limit N`, `--folder projects`, `--tag project/canvas`, `--keyword-only`.

## MCP server

`omem serve` exposes eight tools over stdio (register with your MCP client, e.g.
`claude mcp add omem -- node <repo>/src/cli.ts serve --vault <vault>`):

- `memory_search` — hybrid search; ranked chunks + `obsidian://` links. Filters: folder, tags, expandGraph.
- `memory_get_note` — full note: content, frontmatter, backlinks.
- `memory_write` — create `memory/YYYY-MM-DD-slug.md` (or `folder`), or update via `path` + `mode: overwrite|append`.
  `tags`/`links`/arbitrary `frontmatter` supported; the note is indexed and embedded before the call returns.
- `memory_recent` — recently modified notes.
- `memory_list` — enumerate notes by folder and/or tag, no query needed.
- `memory_move` — relocate/rename a note (inbox triage); wikilinks are not rewritten.
- `memory_archive` — supersede a note: `pinned: false`, `archived_at`, moved to `archive/<path>`.
- `memory_sync` — force an immediate git commit + pull + push (same as `omem sync`).

Writes are plain markdown — no hard-delete tool; archiving preserves the note, deleting is a human action in Obsidian.
The serve process also watches the vault (`--poll` defaults to 30s full-sync sweeps).

`omem serve --port 8080` serves MCP over streamable HTTP instead of stdio (plus `GET /healthz`).
Auth is optional: set `OMEM_HTTP_TOKEN` and clients must send `Authorization: Bearer <token>` —
without it the endpoint is open, so never expose an unauthenticated port publicly.

## Deploy (Railway / Docker)

The repo ships a `Dockerfile` + `start.sh` that run a 24/7 memory server: the vault is cloned
from GitHub at boot, served over HTTP, and git-synced both ways (agent writes get committed and
pushed; edits from your other devices get pulled).

1. Create a Railway service from this repo (it picks up the Dockerfile).
2. Mount a volume at `/vault` — persists the clone, index, and embedding model across deploys.
3. Set env vars: `VAULT_REPO` (e.g. `youruser/your-vault`), `GITHUB_TOKEN` (fine-grained PAT,
   read/write contents on that repo only), `OMEM_HTTP_TOKEN` (`openssl rand -hex 32`).
4. Generate a public domain, then on each client:

```sh
claude mcp add --transport http omem https://<app>.up.railway.app/mcp \
  --header "Authorization: Bearer <your OMEM_HTTP_TOKEN>"
```

## Git sync

`--git` (or `OMEM_GIT=1`) on `watch`/`serve` keeps a GitHub-hosted vault in sync:
every sweep tick with changes → one `omem: sync N note(s)` commit + push; pulls run
every `--git-pull-interval` seconds (default 300) and pulled notes are re-indexed
automatically. Conflicts resolve local-wins (`rebase -X theirs`) — the remote version
stays recoverable in history; nothing is ever force-pushed. Without an upstream the
vault still gets local commits (commit-only mode). `omem sync` runs one cycle for cron.
First run adds `.omem/`, `.DS_Store`, `.obsidian/workspace*` to `.gitignore` and
untracks `.omem/` if it was ever committed.

## Config (env)

- `OMEM_VAULT` — vault path (or pass `--vault`)
- `OMEM_DB_PATH` — index location, default `<vault>/.omem/index.db`
- `OMEM_EMBED_MODEL` — default `Xenova/multilingual-e5-small` (384d, multilingual).
  Switching models requires `omem rebuild`.

## Memory convention

An agent "remembering" = writing `memory/YYYY-MM-DD-slug.md` with frontmatter
(`created`, `source: agent`, `tags`) and `[[wikilinks]]` to related notes.
Updating = editing the file. Superseding = new note linking the old one; results
from `memory/` get a recency boost so the newest fact ranks first. Deleting is a
human action in Obsidian. The watcher indexes all of it within a second.

Requires Node >= 23.6 (runs TypeScript natively). Tests: `npm test`.
