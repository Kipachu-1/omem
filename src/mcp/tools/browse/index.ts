/**
 * Read/browse tools: memory_get_note, memory_graph, memory_list, memory_recent, memory_status, memory_unused.
 *
 * Split from the original browse.ts (373 LOC single function) into per-tool
 * files for independent testability and smaller surface area per change.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolCtx } from '../../ctx.ts'
import { registerGetNote } from './get_note.ts'
import { registerGraph } from './graph.ts'
import { registerList } from './list.ts'
import { registerRecent } from './recent.ts'
import { registerStatus } from './status.ts'
import { registerUnused } from './unused.ts'

/** Register all read/browse tools. */
export function registerBrowseTools(server: McpServer, ctx: ToolCtx): void {
  registerGetNote(server, ctx)
  registerGraph(server, ctx)
  registerRecent(server, ctx)
  registerList(server, ctx)
  registerStatus(server, ctx)
  registerUnused(server, ctx)
}
