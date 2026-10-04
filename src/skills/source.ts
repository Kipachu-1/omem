import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../db.ts'
import { createBundle, skillSummarySchema, skillDetailsSchema, skillFileSchema } from './bundle.ts'
import type { SkillBundle, SkillDetails, SkillFile, SkillSummary } from './bundle.ts'
import { createSkillStore } from './store.ts'

export type SkillCatalogue = { skills: SkillSummary[]; total: number; diagnostics: { name: string; error: string }[] }
export type SkillWrite = { name: string; files: SkillFile[]; removeFiles?: string[]; expectedRevision: string | null }
export interface SkillSource {
  id: string
  list(): Promise<SkillCatalogue>
  get(name: string): Promise<SkillBundle>
  write(args: SkillWrite): Promise<SkillDetails>
  close(): Promise<void>
}

export function localSkillSource(vault: string): SkillSource {
  const root = realpathSync(vault)
  const db = openDb(process.env.OMEM_DB_PATH ?? join(root, '.omem', 'index.db'))
  const store = createSkillStore(db, root)
  return {
    id: `local:${root}`,
    async list() {
      const result: SkillCatalogue = { skills: [], total: 0, diagnostics: [] }
      for (let offset = 0; ;) {
        const page = store.list({ limit: 100, offset })
        result.total = page.total
        result.skills.push(...page.skills)
        for (const diagnostic of page.diagnostics) if (!result.diagnostics.some(entry => entry.name === diagnostic.name && entry.error === diagnostic.error)) result.diagnostics.push(diagnostic)
        if (offset + page.skills.length >= page.total || page.skills.length === 0) break
        offset += page.skills.length
      }
      return result
    },
    async get(name) {
      const details = store.get(name)
      const files = details.manifest.map(entry => store.readFile({ name, path: entry.path, expectedRevision: details.revision }))
      return checkedBundle(details, files, name)
    },
    async write(args) { return store.write(args) },
    async close() { db.close() },
  }
}

const catalogueSchema = z.object({
  skills: z.array(skillSummarySchema), total: z.number().int().nonnegative(),
  diagnostics: z.array(z.object({ name: z.string(), error: z.string() })),
})
const resultSchema = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough()

function checkedBundle(details: SkillDetails, files: SkillFile[], name: string): SkillBundle {
  const bundle = createBundle(files, name)
  if (details.name !== name || bundle.revision !== details.revision ||
      JSON.stringify(bundle.manifest) !== JSON.stringify(details.manifest) ||
      bundle.description !== details.description || bundle.instructions !== details.instructions) {
    throw new Error(`Skill ${name} changed during download or failed manifest verification`)
  }
  return bundle
}

export async function remoteSkillSource(args: { url: string; token?: string }): Promise<SkillSource> {
  const url = new URL(args.url)
  if (url.username || url.password) throw new Error('Skill source URL must not contain credentials')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Skill source requires an HTTP or HTTPS URL')
  url.hash = ''
  const client = new Client({ name: 'omem-skills', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: args.token ? { Authorization: `Bearer ${args.token}` } : {} } })
  function safeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(args.token ? message.split(args.token).join('[redacted]') : message)
  }
  async function call(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    try {
      const result = resultSchema.parse(await client.callTool({ name, arguments: parameters }))
      const first = result.content[0]
      if (result.isError) throw new Error(first?.text ?? `${name} failed`)
      if (first?.type !== 'text' || first.text === undefined) throw new Error(`${name} returned no JSON text`)
      return JSON.parse(first.text)
    } catch (error) { throw safeError(error) }
  }
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn() } catch (error) { throw safeError(error) }
  }
  try {
    await client.connect(transport)
    const tools: string[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools.map(tool => tool.name))
      cursor = page.nextCursor
    } while (cursor)
    const required = ['skill_list', 'skill_get', 'skill_read_file', 'skill_write']
    const missing = required.filter(name => !tools.includes(name))
    if (missing.length) throw new Error(`Skill source does not support required tools: ${missing.join(', ')}. Upgrade the omem server.`)
  } catch (error) {
    await client.close().catch(() => undefined)
    throw safeError(error)
  }
  return {
    id: `remote:${url.href}`,
    async list() { return guarded(async () => {
      const result: SkillCatalogue = { skills: [], total: 0, diagnostics: [] }
      const seen = new Set<string>()
      let expectedTotal: number | undefined
      for (let offset = 0; ;) {
        const page = catalogueSchema.parse(await call('skill_list', { limit: 100, offset }))
        if (expectedTotal !== undefined && expectedTotal !== page.total) throw new Error('Skill catalogue changed during pagination; retry sync')
        expectedTotal = page.total
        result.total = page.total
        for (const skill of page.skills) {
          if (seen.has(skill.name)) throw new Error('Skill catalogue changed during pagination; duplicate skill')
          seen.add(skill.name)
          result.skills.push(skill)
        }
        for (const diagnostic of page.diagnostics) if (!result.diagnostics.some(entry => entry.name === diagnostic.name && entry.error === diagnostic.error)) result.diagnostics.push(diagnostic)
        if (result.skills.length === page.total) break
        if (page.skills.length === 0 || result.skills.length > page.total) throw new Error('Incomplete skill catalogue; no native files were removed')
        offset += page.skills.length
      }
      return result
    }) },
    async get(name) { return guarded(async () => {
      const details = skillDetailsSchema.parse(await call('skill_get', { name }))
      const files: SkillFile[] = []
      for (const entry of details.manifest) files.push(skillFileSchema.parse(await call('skill_read_file', { name, path: entry.path, expectedRevision: details.revision })))
      return checkedBundle(details, files, name)
    }) },
    async write(parameters) { return guarded(async () => skillDetailsSchema.parse(await call('skill_write', parameters))) },
    async close() { await guarded(async () => client.close()) },
  }
}
