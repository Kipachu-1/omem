import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { detectAgents } from '../agents.ts'
import { readBundle } from './bundle.ts'
import { localSkillSource, remoteSkillSource, type SkillSource } from './source.ts'
import { syncSkills, getSkillsSyncStatus, recordSkillsSyncFailure } from './sync.ts'
import {
  installSkillsService, skillsServiceStatus, uninstallSkillsService,
  readSkillsWatchConfig, skillWatchConfigSchema, type SkillWatchConfig,
} from './service.ts'

export interface SkillsCliOptions {
  vault?: string
  server?: string
  query?: string
  limit?: string
  offset?: string
  interval?: string
  json?: boolean
  adopt?: boolean
  'overwrite-local'?: boolean
  'expected-revision'?: string
  'legacy-windsurf'?: boolean
  'skills-config'?: string
  'skills-home'?: string
  'skills-state-dir'?: string
}

const HELP = `omem skills list [--query TEXT] [--limit N] [--offset N] [--json]
omem skills import <directory> [--expected-revision HASH]
omem skills sync [--adopt] [--overwrite-local] [--legacy-windsurf]
omem skills watch [--interval SECONDS]
omem skills status [--json]
omem skills service install|status|uninstall [--json]

Sources: --vault PATH or --server URL. Saved skillsServer / OMEM_SKILLS_SERVER
selects the remote source. OMEM_SKILLS_TOKEN, then OMEM_HTTP_TOKEN supplies
its bearer token. Native copies update every 30 seconds while watch runs.
--skills-config PATH loads an owned mode-0600 watch profile.
--skills-home PATH and --skills-state-dir PATH override local destinations.
`

const report = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
const integer = (raw: string | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  return z.coerce.number().int().min(minimum).max(maximum).parse(raw ?? fallback)
}

function watchConfig(options: SkillsCliOptions): SkillWatchConfig {
  const saved = options['skills-config'] ? readSkillsWatchConfig(resolve(options['skills-config'])) : undefined
  const vault = options.vault ?? process.env.OMEM_VAULT
  const token = process.env.OMEM_SKILLS_TOKEN ?? process.env.OMEM_HTTP_TOKEN
  const remote = (url: string) => ({ kind: 'remote', url, ...(token ? { token } : {}) })
  const source = options.server ? remote(options.server) :
    options.vault ? { kind: 'local', vault: resolve(options.vault) } :
      saved?.source ?? (process.env.OMEM_SKILLS_SERVER ? remote(process.env.OMEM_SKILLS_SERVER) :
        vault ? { kind: 'local', vault: resolve(vault) } : undefined)
  if (!source) throw new Error('No skill source. Pass --vault PATH or --server URL, or configure OMEM_VAULT / OMEM_SKILLS_SERVER.')
  return skillWatchConfigSchema.parse({
    ...saved, source,
    ...(options.interval ? { interval: integer(options.interval, 30, 1, 86400) } : {}),
    ...(options['legacy-windsurf'] ? { legacyWindsurf: true } : {}),
  })
}

async function openSource(config: SkillWatchConfig): Promise<SkillSource> {
  return config.source.kind === 'local' ? localSkillSource(config.source.vault) :
    remoteSkillSource({ url: config.source.url, token: config.source.token })
}

function destinations(options: SkillsCliOptions) {
  return {
    home: options['skills-home'] ? resolve(options['skills-home']) : undefined,
    stateDir: options['skills-state-dir'] ? resolve(options['skills-state-dir']) : undefined,
  }
}

async function nativeOptions(config: SkillWatchConfig, options: SkillsCliOptions) {
  const detected = config.claude === undefined ? await detectAgents() : []
  return {
    ...destinations(options),
    claude: config.claude ?? detected.some(agent => agent.name === 'Claude Code'),
    legacyWindsurf: config.legacyWindsurf ?? false,
    adopt: options.adopt ?? false,
    overwriteLocal: options['overwrite-local'] ?? false,
  }
}

function safeMessage(error: unknown, config: SkillWatchConfig): string {
  const message = error instanceof Error ? error.message : String(error)
  return config.source.kind === 'remote' && config.source.token ? message.split(config.source.token).join('[redacted]') : message
}

function recordFailure(message: string, config: SkillWatchConfig, options: SkillsCliOptions): void {
  try {
    recordSkillsSyncFailure({ source: config.source.kind === 'local' ? `local:${config.source.vault}` : `remote:${config.source.url}`, error: message, ...destinations(options) })
  } catch (error) {
    process.stderr.write(`skills recovery failed: ${safeMessage(error, config)}\n`)
  }
}

export async function runSkillsCli(args: string[], options: SkillsCliOptions): Promise<void> {
  const [command = 'list', argument] = args
  if (command === 'help') { process.stdout.write(HELP); return }
  if (command === 'status') { report(getSkillsSyncStatus(destinations(options))); return }
  if (command === 'service' && (argument === 'status' || argument === 'uninstall')) {
    report(await (argument === 'status' ? skillsServiceStatus : uninstallSkillsService)(destinations(options)))
    return
  }
  if (!['list', 'import', 'sync', 'watch', 'service'].includes(command)) throw new Error(`Unknown skills command: ${command}\n${HELP}`)
  if (command === 'service' && argument !== 'install') throw new Error(`Expected skills service install, status, or uninstall\n${HELP}`)
  const config = watchConfig(options)
  if (command === 'service') { report(await installSkillsService({ config, ...destinations(options) })); return }
  if (command === 'watch') {
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      while (!abort.signal.aborted) {
        let source: SkillSource | undefined
        try {
          source = await openSource(config)
          const result = await syncSkills({ source, ...await nativeOptions(config, options) })
          if (options.json || result.installed.length || result.updated.length || result.removed.length || result.conflicts.length || result.diagnostics.length) report(result)
        } catch (error) {
          const message = safeMessage(error, config)
          recordFailure(message, config, options)
          process.stderr.write(`skills sync failed: ${message}\n`)
        } finally {
          try { await source?.close() }
          catch (error) { process.stderr.write(`skills connection close failed: ${safeMessage(error, config)}\n`) }
        }
        try { await setTimeout((config.interval ?? 30) * 1000, undefined, { signal: abort.signal }) }
        catch (error) { if (!abort.signal.aborted) throw error }
      }
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    return
  }
  let source: SkillSource | undefined
  try {
    source = await openSource(config)
    if (command === 'list') {
      const catalogue = await source.list()
      const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const matched = catalogue.skills.filter(skill => words.every(word => `${skill.name} ${skill.description}`.toLowerCase().includes(word)))
      const offset = integer(options.offset, 0, 0)
      const limit = integer(options.limit, 50, 1, 100)
      report({ skills: matched.slice(offset, offset + limit), total: matched.length, diagnostics: catalogue.diagnostics })
    } else if (command === 'import') {
      if (!argument) throw new Error('Usage: omem skills import <directory> [--expected-revision HASH]')
      const bundle = readBundle(resolve(argument))
      const expectedRevision = options['expected-revision'] ?? null
      const previous = expectedRevision ? await source.get(bundle.name) : undefined
      const incoming = new Set(bundle.files.map(file => file.path))
      report(await source.write({ name: bundle.name, files: bundle.files, expectedRevision,
        removeFiles: previous?.manifest.filter(file => !incoming.has(file.path)).map(file => file.path),
      }))
    } else {
      const result = await syncSkills({ source, ...await nativeOptions(config, options) })
      report(result)
      if (result.conflicts.length || result.diagnostics.length) process.exitCode = 1
    }
  } catch (error) {
    const message = safeMessage(error, config)
    if (command === 'sync') recordFailure(message, config, options)
    throw new Error(message)
  } finally { await source?.close() }
}
