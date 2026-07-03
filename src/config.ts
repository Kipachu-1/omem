// stdlib-only on purpose: this module must never drag env-reading deps into the import graph
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface OmemConfig {
  vault?: string
  git?: boolean
  poll?: number
  gitPullInterval?: number
  githubToken?: string
  embedModel?: string
  dbPath?: string
}

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'omem', 'config.json')
}

const expand = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

export function readConfigFile(): OmemConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as OmemConfig
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`omem: ignoring malformed config at ${configPath()}: ${(e as Error).message}`)
    return {}
  }
}

export function writeConfigFile(cfg: OmemConfig): string {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600) // the mode option only applies on create
  return p
}

/**
 * Fill process.env where undefined. Precedence: flags (handled by cli) > real env
 * > repo-root .env (dev checkout; OMEM_ENV_FILE overrides the location)
 * > user config file. All existing env readers keep working unchanged.
 */
export function applyEnvDefaults(): void {
  const envFile = process.env.OMEM_ENV_FILE ?? fileURLToPath(new URL('../.env', import.meta.url))
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
    }
  } catch {
    // no .env (e.g. global install) — fine
  }

  const cfg = readConfigFile()
  const setIf = (key: string, value: string | undefined): void => {
    if (value && process.env[key] === undefined) process.env[key] = value
  }
  setIf('OMEM_VAULT', cfg.vault ? expand(cfg.vault) : undefined)
  setIf('OMEM_DB_PATH', cfg.dbPath ? expand(cfg.dbPath) : undefined)
  setIf('OMEM_POLL', cfg.poll?.toString())
  if (cfg.git === true) setIf('OMEM_GIT', '1')
  setIf('OMEM_GIT_PULL_INTERVAL', cfg.gitPullInterval?.toString())
  setIf('OMEM_EMBED_MODEL', cfg.embedModel)
  // alias group: a real GITHUB_TOKEN/GH_TOKEN must not be outranked by the config token
  if (cfg.githubToken && !process.env.OMEM_GIT_TOKEN && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN)
    process.env.OMEM_GIT_TOKEN = cfg.githubToken
}
