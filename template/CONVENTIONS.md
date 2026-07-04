# Conventions

Frontmatter + naming + write rules for this vault. Every note **must** follow these.

## Frontmatter fields

| Field | Type | Required | Allowed values | Description |
| -- | -- | -- | -- | -- |
| `island` | string | yes | any `islands/*/` folder name | Knowledge domain. Must exactly match the folder the note lives in. |
| `tags` | string[] | yes | free-form lowercase | Topic tags. Lowercase, hyphenated (e.g. `[git, convention]`). |
| `pinned` | boolean | yes | `true` \| `false` | `true` = canonical/authoritative; prioritized in agent retrieval. |
| `created_by` | string | yes | agent handle \| your handle | Who created the note. Agents use their own lowercase-kebab handle (e.g. `claude-code`). |
| `created_at` | string | yes | ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`) | Creation timestamp, UTC. Never updated after first write. |
| `confidence` | number | yes | `0.0` – `1.0` | `1.0` = canonical fact / direct user statement. `0.5` = unverified observation. |
| `links-to` | string[] | no | array of `[[wikilink]]` strings | Explicit outbound links. Wikilinks in the body also count. |

The omem write layer injects `title`, `created`, and `source: agent` automatically.
Everything else above is the **writer's responsibility** — omem does not reject
non-conforming notes, so a missing field is a silent convention violation, not an error.

## Full note example

```markdown
---
island: example-project
tags: [convention, git]
pinned: true
created_by: claude-code
created_at: 2026-01-01T00:00:00Z
confidence: 0.9
links-to: ["[[git-commit-style]]"]
---

# Git commit style

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`.
```

## Naming

- Filenames: `kebab-case.md`. Agent-created notes are date-prefixed by the write layer: `YYYY-MM-DD-<slug>.md`.
- Timestamps: ISO-8601 UTC (`Z` suffix). Never local timezones in frontmatter.
- Wikilinks: `[[filename]]` within an island, `[[islands/<island>/<filename>]]` across islands, `[[name|alias]]` for display text.

## MCP tools (omem ≥ 0.4.0)

| Tool | Use it to |
| -- | -- |
| `memory_search` | Find prior context. Call this FIRST on any task that may touch past decisions, conventions, people, gotchas. |
| `memory_get_note` | Read one full note + backlinks before relying on or updating it. |
| `memory_list` | Browse an island or tag without a query (`folder`/`tag` filters). |
| `memory_recent` | See what changed lately. |
| `memory_write` | Create or update notes. **Always pass `folder: islands/<island>`**; unsure where it belongs → `folder: inbox`. Updates: `path` + `mode: overwrite` (full note, never partial) or `mode: append`. |
| `memory_move` | Triage: relocate `inbox/` (or stray `memory/`) notes into their island. Wikilinks are not rewritten — keep the filename when moving. |
| `memory_archive` | Supersede a note: sets `pinned: false`, stamps `archived_at` (+ optional `archived_reason`), moves it to `archive/<original path>`. **The only sanctioned way to retire a note.** |
| `memory_sync` | Force git commit+pull+push right now — after writes that must not wait for the periodic sync. |

## Write rules

- **Search before writing.** Update the existing note (`overwrite`/`append`) instead of creating a near-duplicate.
- **Atomic writes:** one `memory_write` call per note, complete content on overwrite.
- **No deletes, ever.** Superseded → `memory_archive`. Wrong island → `memory_move`. Never `git rm`, never empty a note.
- **Triage:** anything in `inbox/` or `memory/` is untriaged; move it to its island once the `island` is known.
- **Confidence decay:** notes with `confidence < 0.5` untouched for 30 days are candidates for archiving.
- **No secrets:** tokens, keys, personal identifiers never go in the vault — it syncs to a remote and agents quote from it.
- **Distill, don't dump:** notes are curated facts, not raw session logs. One fact per note beats one note per session.
