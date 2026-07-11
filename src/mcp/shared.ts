import { z } from 'zod'
import type { DB } from '../db.ts'
import type { Embedder } from '../embed.ts'

/** cosine similarity floor for pre-write dedup suggestions (tune as the vault grows) */
export const DEDUP_THRESHOLD = 0.78

/**
 * Server-level instructions injected into the agent's system prompt by MCP clients.
 * Accurate to the current 13-tool surface — sibling issues append lines here as new tools land.
 * Keep under ~400 chars; some clients silently trim long instructions.
 */
export const INSTRUCTIONS =
  'Shared Obsidian memory vault via omem. memory_recall before acting (groups by kind, pinned first); ' +
  'memory_search FIRST for prior context. Search before memory_write to avoid duplicates. ' +
  'memory_get_note for full notes, memory_graph for a note\'s neighborhood, memory_recent since:lastSeen ' +
  'for changes, memory_list to browse, memory_status for snapshot, memory_unused for stale notes. Prefer append.'

/** ms-epoch windows for the `since` short forms on memory_recent. */
export const SINCE_MS: Record<string, number> = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000 }

// memory class taxonomy — agents pick; search ranks decision/gotcha/convention higher
export const kindSchema = z.enum(['decision', 'gotcha', 'convention', 'fact', 'meeting', 'log'])

// ---- OME-15: per-tool-call usage observability (in-memory, process-lifetime) ----
// One structured JSON event to stderr per MCP tool call (when OMEM_USAGE_LOG != 'off'),
// plus a read-only `memory_usage` tool that returns aggregate counts. No DB, no deps.
type UsageMode = 'off' | 'json' | 'stats'
function resolveUsageMode(): UsageMode {
  const v = (process.env.OMEM_USAGE_LOG ?? 'json').toLowerCase()
  return v === 'off' || v === 'stats' ? v : 'json'
}
let usageMode: UsageMode = resolveUsageMode()
export function getUsageMode(): UsageMode {
  return usageMode
}

export interface ToolStats {
  calls: number
  errors: number
  totalMs: number
  totalResults: number
}
export const usageStartedAt = new Date().toISOString()
export const usageStats: Record<string, ToolStats> = {}

/** Drop large/sensitive args; truncate free-text fields; keep path/folder full. */
function scrubArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k === 'content' || k === 'frontmatter') {
      out[k] = '<redacted>'
      continue
    }
    if (typeof v === 'string' && (k === 'query' || k === 'context')) {
      out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v
      continue
    }
    out[k] = v
  }
  return out
}

/** Best-effort result count across the tool return shapes (array | {notes} | {grouped,related}). */
function countResults(result: unknown): number {
  if (Array.isArray(result)) return result.length
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (Array.isArray(r.notes)) return (r.notes as unknown[]).length
    if (r.grouped && typeof r.grouped === 'object') {
      const g = r.grouped as Record<string, unknown[]>
      const grouped = Object.values(g).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
      const related = Array.isArray(r.related) ? (r.related as unknown[]).length : 0
      return grouped + related
    }
  }
  return 0
}

/**
 * Wrap a tool handler: time the call, record aggregate counts, emit one stderr JSON
 * event (unless OMEM_USAGE_LOG=off), and rethrow on error so the MCP error path is
 * preserved. Does NOT change the handler signature — pure composition.
 */
export async function withUsage<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  let ok = true
  let errMsg: string | undefined
  let resultCount = 0
  let result: T | undefined
  try {
    result = await fn()
    resultCount = countResults(result)
    return result
  } catch (e) {
    ok = false
    errMsg = (e as Error)?.message
    throw e
  } finally {
    const ms = Date.now() - t0
    const s = usageStats[tool] ?? { calls: 0, errors: 0, totalMs: 0, totalResults: 0 }
    s.calls++
    if (!ok) s.errors++
    s.totalMs += ms
    if (ok) s.totalResults += resultCount
    usageStats[tool] = s
    if (usageMode !== 'off') {
      const event: Record<string, unknown> = {
        ts: new Date().toISOString(),
        tool,
        ms,
        ok,
        args: scrubArgs(args),
      }
      if (errMsg) event.error = errMsg.slice(0, 200)
      if (ok) event.resultCount = resultCount
      console.error(JSON.stringify(event))
    }
  }
}

/** folder LIKE-pattern with %/_/\ escaped, shared by recent/list-style filters.
 *  Re-exported from src/filters.ts (the canonical home) for backwards compatibility. */
export { folderPat } from '../filters.ts'
