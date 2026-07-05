# omem on Railway (or any Docker host): an MCP-over-HTTP memory server for an Obsidian vault.
#
# How it works
#   - Your vault is NOT baked into the image. start.sh clones it at boot using GITHUB_TOKEN,
#     so the container can also push agent-written notes back to the repo (two-way git sync).
#   - The image installs the published npm package, not this repo's working tree —
#     pin a version with `npm i -g @kipachu/omem@<x.y.z>` if you want reproducible deploys.
#
# Required env
#   VAULT_REPO       your vault's GitHub repo, e.g. "youruser/your-vault"
#   GITHUB_TOKEN     fine-grained PAT with read/write contents on that repo only
# Strongly recommended
#   OMEM_HTTP_TOKEN  bearer token MCP clients must send — WITHOUT IT THE ENDPOINT IS OPEN
#                    (generate one: `openssl rand -hex 32`)
#   a volume mounted at /vault — persists the clone, index, and embeddings across deploys
#
# Connect a client:
#   claude mcp add --transport http omem https://<your-app>.up.railway.app/mcp \
#     --header "Authorization: Bearer $OMEM_HTTP_TOKEN"

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g @kipachu/omem@0.6.1
ENV OMEM_VAULT=/vault OMEM_GIT=1
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
