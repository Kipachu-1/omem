import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withUsage, usageStats, usageStartedAt, type ToolStats } from '../shared.ts'
import type { ToolCtx } from '../ctx.ts'

/** Register ops tools: memory_sync, memory_usage. */
export function registerOpsTools(server: McpServer, ctx: ToolCtx): void {
  const { vault, json } = ctx

  server.registerTool(
    'memory_sync',
    {
      title: 'Git-sync the vault now',
      description:
        'Force an immediate git commit + pull + push of the vault (same as `omem sync`). ' +
        'Use after important writes when the periodic sync is too slow; harmless if nothing changed.',
      inputSchema: {},
    },
    async () =>
      withUsage('memory_sync', {}, async () => {
        const { createGitSync } = await import('../../git.ts')
        return json(await createGitSync(vault)({ pull: true }))
      }),
  )

  server.registerTool(
    'memory_usage',
    {
      title: 'Usage stats',
      description:
        'Aggregate per-tool call counts, errors, and timing since process start — read-only ' +
        'observability for the omem MCP server. In-memory, process-lifetime; not persisted.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // memory_usage is NOT wrapped with withUsage: it would otherwise count itself,
      // and it returns the aggregate snapshot directly.
      let calls = 0,
        errors = 0,
        totalMs = 0
      const byTool: Record<string, ToolStats & { avgMs: number }> = {}
      for (const [k, s] of Object.entries(usageStats)) {
        byTool[k] = { ...s, avgMs: s.calls ? Math.round((s.totalMs / s.calls) * 100) / 100 : 0 }
        calls += s.calls
        errors += s.errors
        totalMs += s.totalMs
      }
      return json({
        since: usageStartedAt,
        totals: { calls, errors, avgMs: calls ? Math.round((totalMs / calls) * 100) / 100 : 0 },
        byTool,
      })
    },
  )
}
