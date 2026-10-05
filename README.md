# omem

**Shared memory and skills for AI agents, stored in your Obsidian vault.**

Edit notes in Obsidian; agents access them over MCP. Git sync is optional.

[![npm](https://img.shields.io/npm/v/@kipachu/omem)](https://www.npmjs.com/package/@kipachu/omem)
[![node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://github.com/Kipachu-1/omem)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![mcp](https://img.shields.io/badge/MCP-server-purple)](https://modelcontextprotocol.io)

## Install

```sh
npm i -g @kipachu/omem
omem init ~/my-vault   # Create a template vault
omem setup             # Configure omem
omem agents            # Register with detected agents

omem                   # Interactive search; /help lists commands
omem doctor            # Check infrastructure and memory health
```

The [`template/`](./template) provides topic folders, an inbox, an archive, and
[note conventions](./template/CONVENTIONS.md).

## How it works

omem indexes Markdown in SQLite and combines keyword, vector, and wikilink search.
Embeddings run locally after a one-time model download (~30 MB). The index is
derived from the vault; `omem rebuild` regenerates it.

## Run

```sh
omem serve --vault ~/my-vault             # Local MCP over stdio
omem serve --port 8080 --vault ~/my-vault  # MCP over HTTP
omem serve --git --vault ~/my-vault       # Enable Git auto-sync
```

Set `OMEM_HTTP_TOKEN` before exposing HTTP publicly; without it, the endpoint is open.

## Shared skills

Store workflows in `skills/<name>/SKILL.md`, with optional scripts, references,
and assets. Agents manage them over MCP; native sync copies them to agent folders.
omem stores scripts without executing them.

Skills use the [Agent Skills format](https://agentskills.io/specification).
`SKILL.md` must start with YAML containing `name` and `description`. The name must
match the folder and use lowercase letters, numbers, and single hyphens, with a
maximum of 64 characters. The description must contain 1–1024 characters.
Imports preserve file bytes, executable flags, and extra frontmatter.

Skills are available through five MCP tools:

| Tool | Purpose |
| --- | --- |
| `skill_list` | List skills; filter names and descriptions with `query`. |
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

Native copies live in `~/.agents/skills/<name>/`; detected Claude Code installations
also receive aliases in `~/.claude/skills/`. Claude Desktop uses MCP.
For older Windsurf versions, add `--legacy-windsurf`.

Sync never overwrites unmanaged folders or local edits by default. It reports
conflicts and exits unsuccessfully for a one-shot sync. Use `--adopt` to take
ownership of an identical copy, or `--overwrite-local` to explicitly replace a
conflicting copy after backup. Importing a replacement central bundle requires
`--expected-revision HASH`. Native edits do not automatically upload.

The watcher syncs immediately, then every 30 seconds (`--interval SECONDS` to change).
Reload skills or restart your agent session after syncing.

### Background updates on macOS

```sh
omem skills service install --server https://your-server.example/mcp
omem skills service status --json
omem skills service uninstall
```

The service starts at login. Uninstalling it leaves installed skills intact.
Other platforms can run `omem skills watch` in the foreground.
`OMEM_SKILLS_TOKEN` takes precedence over `OMEM_HTTP_TOKEN` for authentication.

## Working with memory

Use `memory_status` to inspect the vault, `memory_recall` for task context,
`memory_search` for queries, and `memory_get_note` to read a complete note.
Search and recall exclude archived notes by default; set `includeArchived: true`
or use `omem search "query" --include-archived` to include them.

### Budgeted task context

```json
{
  "context": "Implement authentication in project X",
  "folder": "islands/project-x",
  "limit": 10,
  "maxTokens": 2000
}
```

Pass these arguments to `memory_recall`. `limit` caps the total results;
`maxTokens` limits the estimated response size (minimum 256).

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

`update` replaces the body and shallow-merges metadata; omitted fields survive.
`overwrite` replaces all metadata; `append` adds body text. Each accepts
`expectedHash` and rejects stale writes. Use `tags: []` to clear tags.

On creation, `supersedes: ["path/to/old-note.md"]` archives previous notes and
records links between them. Explain the change in the new note body.

### Research readiness

`memory_learn` starts a research workflow for the calling agent. The agent fetches
sources and writes findings with `source_url` and a specific `source_version` or
retrieval date.

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

Use the same `focus` on subsequent calls. Readiness requires at least three cited
notes, a hub index, and evidence for every question in the matching plan. The agent
must verify that the sources answer the questions.

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

## License

[MIT](./LICENSE) © Kipachu.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for repo conventions. Small PRs, conventional
commits, one feature per PR.
