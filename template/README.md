# my-vault

Obsidian vault **as code** — a single shared memory store for you and your AI agents,
served by [omem](https://github.com/Kipachu-1/omem). This repo *is* the vault: clone it,
open the folder in Obsidian, and you're in the graph.

- **You** read, edit, and browse memory natively in Obsidian (graph view, backlinks, search).
- **Agents** read and write the same markdown files via omem's MCP tools.
- **Git** versions everything — portable, backed up, diffable.

## Folder layout

```
vault/
├── islands/
│   ├── example-project/       # one folder per knowledge domain ("island")
│   ├── user-me/               # your preferences, style, decisions
│   └── shared-conventions/    # cross-island facts every agent must know
├── inbox/                     # untriaged notes — move to an island once placed
├── memory/                    # omem's default write folder — treat as inbox, triage it
└── archive/                   # superseded notes (via memory_archive; never deleted)
```

An **island** = a scoped knowledge domain — a project, a person, a team. Every note
belongs to exactly one island (set in frontmatter). Adding an island = new folder +
a README stating its tag prefix and who writes there. Rename `example-project` and
`user-me` to fit; the structure is the template, not the names.

## Getting started

```sh
# 1. make this folder a git repo with a private remote
git init && git add -A && git commit -m "vault: init from omem template"
git remote add origin <your-private-repo> && git push -u origin main

# 2. index it and register the MCP server in your agent tools
omem setup

# 3. (optional) keep it synced 24/7 — see "Deploy" in the omem README
```

## Conventions

Every note needs YAML frontmatter — field reference and write rules live in
[`CONVENTIONS.md`](./CONVENTIONS.md). The two rules that matter most:

1. **Search before writing** — agents update existing notes instead of duplicating them.
2. **Never delete** — superseded notes are archived (`memory_archive`), so history survives.

## Sync model

| Actor  | How it touches the vault |
| ------ | ------------------------ |
| You    | Obsidian on a local clone; commit + push (or let `omem watch --git` do it). |
| Agents | omem MCP tools; the serve process auto-commits, pulls, and pushes. |

**Conflict rule:** git-level, hunk-granular, local-wins. omem pulls with
`git pull --rebase -X theirs`: on a true conflict the writing machine's version wins
and the other version stays recoverable in git history (`git log -p <note>`).
Practical rule: don't have a human and an agent editing the same note in the same window.
