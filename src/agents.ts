import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { dim, ok, warn } from './ui.ts'
import { getSkillsSyncStatus } from './skills/sync.ts'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const home = (...p: string[]) => join(homedir(), ...p)
const hasBin = (bin: string): Promise<boolean> =>
  run(process.platform === 'win32' ? 'where' : 'which', [bin]).then(() => true).catch(() => false)

export type AgentState = 'registered' | 'missing' | 'unknown'

export interface Agent {
  name: string
  /** detected when the binary is on PATH or the config dir exists */
  bin?: string
  dir?: string
  /** config file omem would be registered in (informational) */
  config?: string
  /** cheap registration check; undefined when there is no config-file probe */
  state?: () => AgentState
  /** registers omem and returns where it was written */
  register: (serveCmd: string[]) => Promise<string>
  note?: string
}

/** deep-pick a cfg object at keys, true when the leaf exists (omem entry present) */
const omemAt =
  (...keys: string[]) =>
  (cfg: Record<string, unknown>): boolean => {
    let cur: unknown = cfg
    for (const k of keys) {
      if (!cur || typeof cur !== 'object') return false
      cur = (cur as Record<string, unknown>)[k]
    }
    return cur !== undefined
  }

/** pure: JSON config state — no file or absent entry → missing, unparseable → unknown */
export function jsonRegistered(path: string, get: (cfg: Record<string, unknown>) => boolean): AgentState {
  if (!existsSync(path)) return 'missing'
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return 'unknown'
  }
  if (!cfg || typeof cfg !== 'object') return 'unknown'
  return get(cfg) ? 'registered' : 'missing'
}

// ponytail: append-only TOML — no parser dep; idempotence via a plain-text section check
const omemTomlSection = (s: string): boolean => /^\[mcp_servers\.omem\]/m.test(s)

/** pure: TOML config state for the codex-style [mcp_servers.omem] section */
export function tomlRegistered(path: string): AgentState {
  if (!existsSync(path)) return 'missing'
  try {
    return omemTomlSection(readFileSync(path, 'utf8')) ? 'registered' : 'missing'
  } catch {
    return 'unknown'
  }
}

/** merge into the de-facto standard { mcpServers: { name: { command, args } } } shape */
export const mcpJson =
  (path: string) =>
  async (cmd: string[]): Promise<string> => {
    const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    if (existsSync(path)) writeFileSync(`${path}.omem-backup`, readFileSync(path))
    cfg.mcpServers = { ...cfg.mcpServers, omem: { command: cmd[0], args: cmd.slice(1) } }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
    return path
  }

/** an agent registered via the standard mcpServers JSON shape — config, state, register wired to one path */
const mcpJsonAgent = (path: string): Pick<Agent, 'config' | 'state' | 'register'> => ({
  config: path,
  state: () => jsonRegistered(path, omemAt('mcpServers', 'omem')),
  register: mcpJson(path),
})

export async function registerCodex(path: string, cmd: string[]): Promise<string> {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const section = `[mcp_servers.omem]\ncommand = ${JSON.stringify(cmd[0])}\nargs = ${JSON.stringify(cmd.slice(1))}\nstartup_timeout_sec = 120\n`
  if (tomlRegistered(path) === 'registered') {
    writeFileSync(`${path}.omem-backup`, cur)
    writeFileSync(path, cur.replace(/^\[mcp_servers\.omem\][\s\S]*?(?=^\[|$(?![\s\S]))/m, () => section))
    return `${path} (repaired; backup saved)`
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(
    path,
    `${cur && !cur.endsWith('\n') ? '\n' : ''}\n${section}`,
  )
  return path
}
const codexToml = (cmd: string[]): Promise<string> => registerCodex(home('.codex', 'config.toml'), cmd)

const opencodeJson = async (cmd: string[]): Promise<string> => {
  const path = home('.config', 'opencode', 'opencode.json')
  const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { $schema: 'https://opencode.ai/config.json' }
  if (existsSync(path)) writeFileSync(`${path}.omem-backup`, readFileSync(path))
  cfg.mcp = { ...cfg.mcp, omem: { type: 'local', command: cmd, enabled: true } }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
  return path
}

export const AGENTS: Agent[] = [
  {
    name: 'Claude Code',
    bin: 'claude',
    dir: home('.claude'),
    // user scope (what `claude mcp add -s user` writes) lives in ~/.claude.json
    config: home('.claude.json'),
    state: () => jsonRegistered(home('.claude.json'), omemAt('mcpServers', 'omem')),
    register: async cmd => {
      // `claude` may be off PATH (VS Code launched from the Dock, extension-only install):
      // fall back to writing the same user-scope config the CLI would
      if (!(await hasBin('claude'))) return mcpJson(home('.claude.json'))(cmd)
      await run('claude', ['mcp', 'remove', 'omem', '-s', 'user']).catch(() => null)
      await run('claude', ['mcp', 'add', 'omem', '-s', 'user', '--', ...cmd])
      return 'user scope (restart sessions to pick it up)'
    },
  },
  {
    name: 'Codex CLI',
    bin: 'codex',
    dir: home('.codex'),
    config: home('.codex', 'config.toml'),
    state: () => tomlRegistered(home('.codex', 'config.toml')),
    register: codexToml,
  },
  {
    name: 'pi',
    bin: 'pi',
    dir: home('.pi'),
    note: 'pi needs the pi-mcp-adapter extension to load MCP servers',
    ...mcpJsonAgent(home('.pi', 'agent', 'mcp.json')),
  },
  { name: 'Cursor', dir: home('.cursor'), ...mcpJsonAgent(home('.cursor', 'mcp.json')) },
  { name: 'Windsurf', dir: home('.codeium', 'windsurf'), ...mcpJsonAgent(home('.codeium', 'windsurf', 'mcp_config.json')) },
  { name: 'Gemini CLI', bin: 'gemini', dir: home('.gemini'), ...mcpJsonAgent(home('.gemini', 'settings.json')) },
  {
    name: 'opencode',
    bin: 'opencode',
    dir: home('.config', 'opencode'),
    config: home('.config', 'opencode', 'opencode.json'),
    state: () => jsonRegistered(home('.config', 'opencode', 'opencode.json'), omemAt('mcp', 'omem')),
    register: opencodeJson,
  },
  {
    name: 'Claude Desktop',
    dir: join(homedir(), 'Library', 'Application Support', 'Claude'),
    note: 'restart the app to pick it up',
    ...mcpJsonAgent(join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')),
  },
  {
    name: 'VS Code',
    bin: 'code',
    // no cheap config-file probe — `code --add-mcp` writes into its own storage; state stays unknown
    register: async cmd => {
      await run('code', ['--add-mcp', JSON.stringify({ name: 'omem', command: cmd[0], args: cmd.slice(1) })])
      return 'via code --add-mcp'
    },
  },
]

/** Absolute Node and package entry point work with GUI clients' minimal PATH. */
export async function serveCmd(): Promise<string[]> {
  const entry = fileURLToPath(new URL('../bin/omem.mjs', import.meta.url))
  if (entry.split(/[\\/]/).includes('_npx'))
    throw new Error('Cannot register a temporary npx installation. Install persistently with npm install -g @kipachu/omem, then run omem agents.')
  if (!existsSync(entry)) throw new Error(`Omem entry point not found: ${entry}`)
  return [process.execPath, entry, 'serve', ...(process.env.OMEM_VAULT ? ['--vault', process.env.OMEM_VAULT] : [])]
}

export async function detectAgents(): Promise<Agent[]> {
  const flags = await Promise.all(
    AGENTS.map(async a => (a.bin && (await hasBin(a.bin))) || (a.dir !== undefined && existsSync(a.dir))),
  )
  return AGENTS.filter((_, i) => flags[i])
}

export interface AgentStatus {
  name: string
  detected: boolean
  state: AgentState
  config?: string
  connection: 'not_verified'
  launch: { status: 'launchable' | 'broken' | 'unknown'; detail?: string }
  skills: { mode: 'native' | 'mcp'; directory?: string; managed: number; conflicts: number; reload?: string; error?: string }
}

/** every known agent with its detected flag and registration state */
export async function agentsStatus(): Promise<AgentStatus[]> {
  const found = await detectAgents()
  let status: ReturnType<typeof getSkillsSyncStatus> = { installed: [], last: null }
  let skillsError: string | undefined
  try { status = getSkillsSyncStatus() }
  catch (error) { skillsError = error instanceof Error ? error.message : String(error) }
  const shared = home('.agents', 'skills')
  return Promise.all(AGENTS.map(async a => {
    const directory = a.name === 'Claude Desktop' ? undefined : a.name === 'Claude Code' ? home('.claude', 'skills') : shared
    const managed = a.name === 'Claude Desktop' ? 0 : a.name === 'Claude Code' ?
      status.installed.filter(skill => skill.aliases.some(alias => alias.path.startsWith(directory + '/'))).length : status.installed.length
    const last = status.last?.result
    const conflicts = last && typeof last === 'object' && 'conflicts' in last && Array.isArray(last.conflicts) ? last.conflicts.length : 0
    const reload = a.name === 'Gemini CLI' ? '/skills reload' : a.name === 'pi' ? '/reload' :
      a.name === 'Claude Code' ? '/reload-skills if the skills root was created during the session' :
        directory ? 'Restart the session if changes do not appear' : undefined
    return { name: a.name, detected: found.includes(a), state: a.state?.() ?? 'unknown', config: a.config, connection: 'not_verified' as const, launch: await checkLaunch(a.config),
      skills: { mode: directory ? 'native' : 'mcp', directory, managed, conflicts: directory ? conflicts : 0, reload,
        ...(directory && skillsError ? { error: skillsError } : {}),
      },
    }
  }))
}

/** Static launch validation is deliberately separate from a live MCP handshake. */
export async function checkLaunch(path?: string): Promise<AgentStatus['launch']> {
  if (!path || !existsSync(path)) return { status: 'unknown', detail: 'No readable launch configuration' }
  try {
    const text = readFileSync(path, 'utf8')
    let command: unknown
    let args: unknown
    if (path.endsWith('.toml')) {
      const section = text.match(/^\[mcp_servers\.omem\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]
      const value = section?.match(/^command\s*=\s*(.+)$/m)?.[1]?.trim()
      command = value?.startsWith("'") ? value.slice(1, -1) : value ? JSON.parse(value) : undefined
      const rawArgs = section?.match(/^args\s*=\s*(\[.*\])$/m)?.[1]
      if (rawArgs) {
        try { args = JSON.parse(rawArgs) } catch { /* non-JSON TOML arrays remain unverified */ }
      }
    } else {
      const config = JSON.parse(text)
      const entry = config.mcpServers?.omem ?? config.mcp?.omem
      command = Array.isArray(entry?.command) ? entry.command[0] : entry?.command
      args = Array.isArray(entry?.command) ? entry.command.slice(1) : entry?.args
      if (entry?.url) return { status: 'unknown', detail: 'Remote endpoint requires a live handshake' }
    }
    if (typeof command !== 'string' || !command) return { status: 'unknown', detail: 'Launch command could not be parsed' }
    if (!(isAbsolute(command) ? existsSync(command) : await hasBin(command)))
      return { status: 'broken', detail: 'Executable is missing or not on PATH; run omem agents --repair --yes' }
    if (Array.isArray(args) && typeof args[0] === 'string' && /\.(mjs|cjs|js|ts)$/.test(args[0]) && isAbsolute(args[0]) && !existsSync(args[0]))
      return { status: 'broken', detail: 'Configured script is missing' }
    return { status: 'launchable', detail: 'Executable found; MCP handshake and client reload not verified' }
  } catch { return { status: 'unknown', detail: 'Configuration cannot be read or parsed' } }
}

/** Detect installed agents and offer to register the MCP server in each (already-registered ones are skipped). */
export async function offerAgents(yes: (q: string) => Promise<boolean>, found?: Agent[], repair = false): Promise<void> {
  const list = found ?? (await detectAgents())
  if (!list.length) {
    console.error(dim('no known agent tools detected — register manually with: <agent> mcp add omem -- omem serve'))
    return
  }
  const cmd = await serveCmd()
  console.error(`detected: ${list.map(a => a.name).join(', ')}`)
  for (const a of list) {
    if (a.state?.() === 'registered' && !repair) {
      console.error(dim(`  ${a.name}: configured; connection not verified. Use omem agents --repair --yes to refresh registration.`))
      continue
    }
    if (!(await yes(`  register omem MCP in ${a.name}?`))) continue
    try {
      ok(`${a.name}: ${await a.register(cmd)}${a.note ? dim(` — ${a.note}`) : ''}`)
    } catch (e) {
      warn(`${a.name}: ${(e as Error).message}`)
    }
  }
}
