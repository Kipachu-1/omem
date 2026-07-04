#!/bin/sh
# Container boot: clone the vault on first run (a volume at /vault keeps it after),
# then serve MCP over HTTP. omem's git auto-sync (OMEM_GIT=1) commits agent writes
# and pushes/pulls on a timer using GITHUB_TOKEN from the environment.
set -e
: "${VAULT_REPO:?set VAULT_REPO, e.g. youruser/your-vault}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN (fine-grained PAT with read/write on $VAULT_REPO)}"

if [ ! -d /vault/.git ]; then
  # token goes in the clone URL once, then the remote is reset to the plain URL so the
  # secret never persists in .git/config — omem reads GITHUB_TOKEN from env at push/pull time
  git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${VAULT_REPO}.git" /vault
  git -C /vault remote set-url origin "https://github.com/${VAULT_REPO}.git"
fi

exec omem serve --port "${PORT:-8080}"
