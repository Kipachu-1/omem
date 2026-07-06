import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { vaultStatus } from '../../../status.ts'
import { withUsage } from '../../shared.ts'
import type { ToolCtx } from '../../ctx.ts'

/** Register memory_status: vault status snapshot (one-call orientation). */
export function registerStatus(server: McpServer, ctx: ToolCtx): void {
  const { db, deepLink, json } = ctx

  server.registerTool(
    'memory_status',
    {
      title: 'Vault status snapshot',
      description:
        'Cheap one-call orientation: vault size, last modification, top folders, top tags, ' +
        'top kinds, pinned/archived counts, and a few most-recent notes. Use on a fresh session to decide ' +
        'whether memory is worth querying, and what to query.',
      inputSchema: {}, // no inputs
      annotations: { readOnlyHint: true },
    },
    async () =>
      withUsage('memory_status', {}, async () => {
        const snap = vaultStatus(db)
        return json({
          notes: snap.notes,
          chunks: snap.chunks,
          embedded: snap.embedded,
          lastModified: snap.maxMtime == null ? null : new Date(snap.maxMtime).toISOString(),
          topFolders: snap.topFolders,
          topTags: snap.topTags,
          pinned: snap.pinned,
          archived: snap.archived,
          topKinds: snap.topKinds,
          recent: snap.recent.map(r => ({
            path: r.path,
            title: r.title,
            modified: new Date(r.mtime).toISOString(),
            link: deepLink(r.path),
          })),
        })
      }),
  )
}
