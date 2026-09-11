# Conventions

Frontmatter + naming + write rules for this vault. Every note **must** follow these.

## Vocabulary

One term, one meaning — in notes, in tool descriptions, and in this file. Agents retrieve by
similarity, so a second word for the same thing splits the matches for it.

| Use | For | Never |
| -- | -- | -- |
| **note** | one markdown file in the vault | memory, entry, record, document |
| **fact** | the single claim a note states | — (a note *states* a fact; they are not synonyms) |
| **island** | a folder under `islands/` | domain, collection, namespace, category |
| **hub** | an island's `README.md`, written by omem | landing page, root note |
| **index note** | an ordinary note indexing one subfolder of a big island | sub-hub, sub-README |
| **write** | create or update a note via `memory_write` | persist, save, capture, store |
| **source** | the external document a fact came from | reference, citation |
| **archive** | retire a note via `memory_archive` | delete, remove |
| **supersede** | archive an old note as replaced by a new one | override, deprecate |

## How to write a note body

Notes are chunked and embedded for retrieval, so the prose style is not cosmetic.

- **One idea per sentence.** Active voice, present tense. State the fact, then show it.
- **Lead with the fact.** The first sentence must answer the title on its own — it is often
  the only chunk a search returns.
- **Name things in full the first time.** Never open with `it`, `this`, or `the above`; a
  chunk is read without its neighbours.
- **Keep the vocabulary above.** Same concept → same word, every time.
- **Show, don't describe.** One short quote or code block beats a paragraph about it.

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
Other fields above are the **writer's responsibility**. omem validates supplied `confidence`
as a finite number from zero through one; most missing fields remain convention violations.

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
| `memory_learn` | Research an **external** topic (library, API, protocol, product) into `islands/docs-<name>/`. Scaffolds the island, reports what it already holds, and returns a research playbook you follow with your own web tools — omem never fetches. Project/team/session knowledge has no public source: use `memory_write`. |
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
- **Cite external knowledge:** a note in a `docs-<name>` island that states a sourced fact carries
  `source_url` and `source_version` (the version or retrieval date the fact applies to) on top of the
  fields above. Without them the note rots silently when upstream changes. An island's `README.md`
  hub is exempt — it indexes notes rather than stating a fact, and lists its sources in the body.
- **No secrets:** tokens, keys, personal identifiers never go in the vault — it syncs to a remote and agents quote from it.
- **Distill, don't dump:** notes are curated facts, not raw session logs. One fact per note beats one note per session.


## Safe updates and verification

Read with `memory_get_note` before editing. Use `mode: "update"` and the returned `hash`
as `expectedHash` to replace the body while preserving omitted metadata. If the hash no
longer matches, read again and reconcile the changes. `overwrite` replaces metadata;
use it only when that replacement is intentional.

After checking a source, write `verified_at` as an ISO-8601 UTC timestamp. Set `review_after`
when a fact needs review on a specific date. Without a review date, `omem doctor` reports
verification older than 90 days. A write timestamp does not count as verification.

## Decision succession

Use `memory_write` with `supersedes` when a new decision replaces an existing one. Explain
why in the new body. omem writes `supersedes` archive paths on the new note and
`superseded_by` on each predecessor. Search excludes archived notes by default;
use `includeArchived: true` when asking about history.

## Research scope

A docs island's hub carries `research: {focus, questions: [{question, evidence: [notePath]}]}`.
Use the requested focus, or an empty string for a broad topic. Write every question from
the agreed outline. Evidence paths name notes in that island with a valid HTTP(S)
`source_url` and a specific `source_version` or retrieval date. Leave evidence empty for
unanswered questions. Three cited notes alone do not establish research completion.
Call `memory_learn` again with the same focus to inspect blockers. Ready means the
agent-supplied evidence passes structural checks, not that omem verified the sources.
