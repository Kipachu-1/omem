import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { skillNameSchema, skillFileSchema } from '../../skills/bundle.ts'
import { createSkillStore } from '../../skills/store.ts'
import type { ToolCtx } from '../ctx.ts'
import { withUsage } from '../shared.ts'

export function registerSkillTools(server: McpServer, ctx: ToolCtx): void {
  const store = createSkillStore(ctx.db, ctx.vault)
  const revision = z.string().regex(/^[a-f0-9]{64}$/).describe('revision returned by skill_get')
  server.registerTool('skill_list', {
    title: 'Discover shared skills',
    description: 'List shared skill names and descriptions before work. Query matches names and descriptions. Load selected instructions with skill_get; supporting files stay unloaded until needed.',
    inputSchema: {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async args => ctx.json(await withUsage('skill_list', args, async () => store.list(args))))

  server.registerTool('skill_get', {
    title: 'Load a shared skill',
    description: 'Read the complete SKILL.md instructions and supporting-file manifest of a shared skill. The calling agent follows the workflow using its own tools. omem never executes scripts.',
    inputSchema: { name: skillNameSchema },
    annotations: { readOnlyHint: true },
  }, async args => withUsage('skill_get', args, async () => ctx.json(store.get(args.name))))

  server.registerTool('skill_read_file', {
    title: 'Read a shared skill file',
    description: 'Read a supporting file by bundle-relative path. Text uses utf8; binary assets use base64. The expected revision prevents mixing files from different updates.',
    inputSchema: { name: skillNameSchema, path: z.string(), expectedRevision: revision },
    annotations: { readOnlyHint: true },
  }, async args => withUsage('skill_read_file', args, async () => ctx.json(store.readFile(args))))

  server.registerTool('skill_write', {
    title: 'Create or improve a shared skill',
    description: 'Create or patch a complete skill bundle. Send changed files and explicit removeFiles; omitted files survive. expectedRevision:null creates only when absent. For updates use the revision from skill_get. Include valid SKILL.md with matching name and description. Uploaded scripts are stored, never run.',
    inputSchema: {
      name: skillNameSchema,
      files: z.array(skillFileSchema),
      removeFiles: z.array(z.string()).optional(),
      expectedRevision: revision.nullable(),
    },
  }, async args => withUsage('skill_write', args, async () => ctx.json(store.write(args))))

  server.registerTool('skill_archive', {
    title: 'Archive a shared skill',
    description: 'Archive a complete shared bundle after checking its revision. It leaves active discovery and managed native copies, while its files and Git history remain recoverable.',
    inputSchema: { name: skillNameSchema, expectedRevision: revision },
  }, async args => withUsage('skill_archive', args, async () => ctx.json(store.archive(args))))
}
