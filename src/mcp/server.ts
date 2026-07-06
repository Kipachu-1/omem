import { createHash, timingSafeEqual } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { DB } from '../db.ts'
import type { Embedder } from '../embed.ts'
import { INSTRUCTIONS, getUsageMode } from './shared.ts'
import { buildToolCtx } from './ctx.ts'
import { registerSearchTools } from './tools/search.ts'
import { registerBrowseTools } from './tools/browse.ts'
import { registerWriteTools } from './tools/write.ts'
import { registerOpsTools } from './tools/ops.ts'

/**
 * Stable client identity for a stdio serve process: an explicit env override wins (lets agents
 * and tests pin a name), otherwise derive from the parent pid + the launched executable basename
 * so two agents spawned separately stay distinct.
 */
export function stdioClientName(): string {
  return (
    process.env.OMEM_CLIENT_NAME ||
    `stdio:${process.ppid}:${basename(process.argv[1] ?? process.execPath)}`
  )
}

/**
 * Resolve a client name for an HTTP request.
 * Priority: explicit `X-Omem-Client` header > sha256(OMEM_HTTP_TOKEN).slice(0,16) (same token = same client)
 * > `'default'` (open endpoint, no header).
 */
export function resolveHttpClientName(
  headers: { 'x-omem-client'?: string | string[] | undefined; authorization?: string },
  token: string | undefined,
): string {
  const raw = headers['x-omem-client']
  const hdr = Array.isArray(raw) ? raw[0] : raw
  if (hdr) return hdr
  if (token) return createHash('sha256').update(token).digest('hex').slice(0, 16)
  return 'default'
}

/** Build a fresh McpServer with all memory tools registered (db/embedder are shared). */
export function buildServer(
  db: DB,
  vault: string,
  embedder: Embedder,
  getClientName: () => string = stdioClientName,
): McpServer {
  const ctx = buildToolCtx(db, vault, embedder, getClientName)
  const server = new McpServer({ name: 'omem', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  registerSearchTools(server, ctx)
  registerBrowseTools(server, ctx)
  registerWriteTools(server, ctx)
  registerOpsTools(server, ctx)
  return server
}

export async function serveMcp(db: DB, vault: string, embedder: Embedder): Promise<void> {
  const clientName = stdioClientName()
  await buildServer(db, vault, embedder, () => clientName).connect(new StdioServerTransport())
  console.error(`omem mcp server on stdio — vault: ${basename(realpathSync.native(resolve(vault)))}`)

  // the SDK transport doesn't watch for stdin EOF; without this, a crashed/closed
  // client leaves an orphaned serve process sweeping the vault db forever
  const shutdown = () => {
    console.error('mcp client disconnected — exiting')
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
}

/** constant-time bearer check; no token configured = open (opt-in auth) */
export function bearerOk(authHeader: string | undefined, token: string | undefined): boolean {
  if (!token) return true
  if (!authHeader?.startsWith('Bearer ')) return false
  const sha = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(sha(authHeader.slice(7)), sha(token))
}

/** MCP over streamable HTTP. Auth is optional: set OMEM_HTTP_TOKEN to require `Authorization: Bearer <token>`. */
export async function serveHttp(db: DB, vault: string, embedder: Embedder, port: number): Promise<void> {
  const { createServer } = await import('node:http')
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const token = process.env.OMEM_HTTP_TOKEN

  createServer(async (req, res) => {
    if (req.url?.split('?')[0] === '/healthz') return void res.end('ok')
    if (!bearerOk(req.headers.authorization, token)) {
      return void res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
    }
    // stateless mode: a fresh server+transport per request, no session bookkeeping to leak
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    try {
      const clientName = resolveHttpClientName(req.headers, token)
      await buildServer(db, vault, embedder, () => clientName).connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      console.error('mcp http error:', e)
      if (!res.headersSent) res.writeHead(500).end()
    }
  }).listen(port, () => {
    console.error(`omem mcp server on http://0.0.0.0:${port} — vault: ${basename(realpathSync.native(resolve(vault)))}`)
    if (!token) console.error('warning: OMEM_HTTP_TOKEN not set — the endpoint is UNAUTHENTICATED; anyone who can reach it can read/write the vault')
  })
}

// re-export shared public API so `import { ... } from './mcp/index.ts'` keeps the old surface
export { getUsageMode }
