#!/bin/sh
# Container boot: clone the vault on first run (a volume at /vault keeps it after),
# then serve MCP over HTTP. omem's git auto-sync (OMEM_GIT=1) commits agent writes
# and pushes/pulls on a timer using GITHUB_TOKEN from the environment.
set -e
: "${VAULT_REPO:?set VAULT_REPO, e.g. youruser/your-vault}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN (fine-grained PAT with read/write on $VAULT_REPO)}"

if [ ! -d /vault/.git ]; then
  # a fresh volume is NOT empty (ext4 puts lost+found in it), so `git clone /vault` refuses;
  # clone the metadata elsewhere, adopt it, then materialize the files
  git clone --no-checkout "https://x-access-token:${GITHUB_TOKEN}@github.com/${VAULT_REPO}.git" /tmp/vault-clone
  mv /tmp/vault-clone/.git /vault/.git
  rmdir /tmp/vault-clone
  git -C /vault reset --hard -q
  # keep volume artifacts out of the repo, locally only
  echo lost+found >> /vault/.git/info/exclude
  # token went in the clone URL once; reset the remote to the plain URL so the secret
  # never persists in .git/config — omem reads GITHUB_TOKEN from env at push/pull time
  git -C /vault remote set-url origin "https://github.com/${VAULT_REPO}.git"
fi

# headless box has no global git identity; rebase/commit need one (repo-local, idempotent)
git -C /vault config user.name omem
git -C /vault config user.email omem@localhost

exec omem serve --port "${PORT:-8080}"
