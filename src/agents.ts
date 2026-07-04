import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { dim, ok, warn } from './ui.ts'

const run = promisify(execFile)
const home = (...p: string[]) => join(homedir(), ...p)
const hasBin = (bin: string): Promise<boolean> =>
  run(process.platform === 'win32' ? 'where' : 'which', [bin]).then(() => true).catch(() => false)

export interface Agent {
  name: string
  /** detected when the binary is on PATH or the config dir exists */
  bin?: string
  dir?: string
  /** registers omem and returns where it was written */
  register: (serveCmd: string[]) => Promise<string>
  note?: string
}

/** merge into the de-facto standard { mcpServers: { name: { command, args } } } shape */
export const mcpJson =
  (path: string) =>
  async (cmd: string[]): Promise<string> => {
    const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    cfg.mcpServers = { ...cfg.mcpServers, omem: { command: cmd[0], args: cmd.slice(1) } }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
    return path
  }

// ponytail: append-only TOML — no parser dep; idempotence via a plain-text section check
const codexToml = async (cmd: string[]): Promise<string> => {
  const path = home('.codex', 'config.toml')
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (/^\[mcp_servers\.omem\]/m.test(cur)) return `${path} (already registered)`
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(
    path,
    `${cur && !cur.endsWith('\n') ? '\n' : ''}\n[mcp_servers.omem]\ncommand = ${JSON.stringify(cmd[0])}\nargs = ${JSON.stringify(cmd.slice(1))}\n`,
  )
  return path
}

const opencodeJson = async (cmd: string[]): Promise<string> => {
  const path = home('.config', 'opencode', 'opencode.json')
  const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { $schema: 'https://opencode.ai/config.json' }
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
    register: async cmd => {
      // `claude` may be off PATH (VS Code launched from the Dock, extension-only install):
      // fall back to writing the same user-scope config the CLI would
      if (!(await hasBin('claude'))) return mcpJson(home('.claude.json'))(cmd)
      await run('claude', ['mcp', 'remove', 'omem', '-s', 'user']).catch(() => null)
      await run('claude', ['mcp', 'add', 'omem', '-s', 'user', '--', ...cmd])
      return 'user scope (restart sessions to pick it up)'
    },
  },
  { name: 'Codex CLI', bin: 'codex', dir: home('.codex'), register: codexToml },
  {
    name: 'pi',
    bin: 'pi',
    dir: home('.pi'),
    register: mcpJson(home('.pi', 'agent', 'mcp.json')),
    note: 'pi needs the pi-mcp-adapter extension to load MCP servers',
  },
  { name: 'Cursor', dir: home('.cursor'), register: mcpJson(home('.cursor', 'mcp.json')) },
  { name: 'Windsurf', dir: home('.codeium', 'windsurf'), register: mcpJson(home('.codeium', 'windsurf', 'mcp_config.json')) },
  { name: 'Gemini CLI', bin: 'gemini', dir: home('.gemini'), register: mcpJson(home('.gemini', 'settings.json')) },
  { name: 'opencode', bin: 'opencode', dir: home('.config', 'opencode'), register: opencodeJson },
  {
    name: 'Claude Desktop',
    dir: join(homedir(), 'Library', 'Application Support', 'Claude'),
    register: mcpJson(join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')),
    note: 'restart the app to pick it up',
  },
  {
    name: 'VS Code',
    bin: 'code',
    register: async cmd => {
      await run('code', ['--add-mcp', JSON.stringify({ name: 'omem', command: cmd[0], args: cmd.slice(1) })])
      return 'via code --add-mcp'
    },
  },
]

/** ['omem','serve'] when globally installed, npx fallback otherwise */
export async function serveCmd(): Promise<string[]> {
  return (await hasBin('omem')) ? ['omem', 'serve'] : ['npx', '-y', '@kipachu/omem', 'serve']
}

export async function detectAgents(): Promise<Agent[]> {
  const flags = await Promise.all(
    AGENTS.map(async a => (a.bin && (await hasBin(a.bin))) || (a.dir !== undefined && existsSync(a.dir))),
  )
  return AGENTS.filter((_, i) => flags[i])
}

/** Detect installed agents and offer to register the MCP server in each. */
export async function offerAgents(yes: (q: string) => Promise<boolean>): Promise<void> {
  const found = await detectAgents()
  if (!found.length) {
    console.error(dim('no known agent tools detected — register manually with: <agent> mcp add omem -- omem serve'))
    return
  }
  const cmd = await serveCmd()
  console.error(`detected: ${found.map(a => a.name).join(', ')}`)
  for (const a of found) {
    if (!(await yes(`  register omem MCP in ${a.name}?`))) continue
    try {
      ok(`${a.name}: ${await a.register(cmd)}${a.note ? dim(` — ${a.note}`) : ''}`)
    } catch (e) {
      warn(`${a.name}: ${(e as Error).message}`)
    }
  }
}
