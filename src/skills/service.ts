import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const SKILLS_SERVICE_LABEL = 'com.kipachu.omem.skills'
const MARKER = `<!-- omem skills service: ${SKILLS_SERVICE_LABEL} -->`
const absolutePath = z.string().min(1).refine(isAbsolute, 'Expected an absolute path')
const remoteUrl = z.string().url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}, 'Expected an HTTP URL without credentials')

export const skillWatchConfigSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), vault: absolutePath }).strict(),
    z.object({ kind: z.literal('remote'), url: remoteUrl, token: z.string().min(1).optional() }).strict(),
  ]),
  claude: z.boolean().optional(),
  legacyWindsurf: z.boolean().optional(),
  interval: z.number().finite().positive().optional(),
}).strict()
export type SkillWatchConfig = z.infer<typeof skillWatchConfigSchema>
export type LaunchctlRunner = (args: string[]) => Promise<{ stdout: string; stderr?: string }>
export type ServiceStatus = {
  label: string
  installed: boolean
  loaded: boolean
  running: boolean
  plistPath: string
  configPath: string
}
export type ServiceOptions = {
  home?: string
  stateDir?: string
  nodePath?: string
  cliPath?: string
  platform?: NodeJS.Platform
  uid?: number
  run?: LaunchctlRunner
}

const exec = promisify(execFile)
const launchctl: LaunchctlRunner = args => exec('launchctl', args)

function servicePath(value: string): string {
  const path = resolve(value)
  // macOS provides these root-owned aliases for its temporary directories.
  if (process.platform === 'darwin') {
    for (const alias of ['/var', '/tmp']) {
      if ((path === alias || path.startsWith(`${alias}/`)) && lstatSync(alias).uid === 0) {
        return join(realpathSync(alias), path.slice(alias.length))
      }
    }
  }
  return path
}

function paths(options: ServiceOptions) {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('Skills services require macOS launchd. Use omem skills watch on this platform.')
  }
  const home = servicePath(options.home ?? homedir())
  const stateDir = servicePath(options.stateDir ?? join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'omem'))
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('Cannot determine the current user for launchd')
  return {
    home, stateDir, uid,
    plistPath: join(home, 'Library', 'LaunchAgents', `${SKILLS_SERVICE_LABEL}.plist`),
    configPath: join(stateDir, 'skills-service.json'),
    run: options.run ?? launchctl,
  }
}
type ServicePaths = ReturnType<typeof paths>

function checkAncestors(path: string): void {
  const parent = dirname(path)
  if (parent !== path) checkAncestors(parent)
  if (!existsSync(path)) {
    // existsSync follows symlinks, so also catch a dangling link.
    try { lstatSync(path); throw new Error(`Unsafe symlink: ${path}`) }
    catch (error) { if (!isMissing(error)) throw error }
    return
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe service directory: ${path}`)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function ownedFile(path: string, uid: number, read = true): string | undefined {
  checkAncestors(dirname(path))
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if (isMissing(error)) return undefined; throw new Error(`Cannot safely read service file: ${path}`) }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      throw new Error(`Service file must be an owned regular file with mode 0600: ${path}`)
    }
    return read ? readFileSync(fd, 'utf8') : ''
  } finally { closeSync(fd) }
}

export function readSkillsWatchConfig(path: string): SkillWatchConfig {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Cannot verify skills config ownership')
  const value = ownedFile(servicePath(path), uid)
  if (value === undefined) throw new Error(`Skills config does not exist: ${path}`)
  return parseConfig(value)
}

function parseConfig(value: string): SkillWatchConfig {
  try { return skillWatchConfigSchema.parse(JSON.parse(value)) }
  catch { throw new Error('The skills service config is not a valid omem watch profile') }
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('Invalid character in service path')
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function readOwned(paths: ServicePaths) {
  const configText = ownedFile(paths.configPath, paths.uid)
  const config = configText === undefined ? undefined : parseConfig(configText)
  const plist = ownedFile(paths.plistPath, paths.uid)
  if (plist !== undefined && (!plist.includes(MARKER)
    || !plist.includes(`<key>Label</key><string>${SKILLS_SERVICE_LABEL}</string>`)
    || !plist.includes(`<string>${xml(paths.configPath)}</string>`))) {
    throw new Error('Refusing to modify a LaunchAgent not owned by omem skills')
  }
  return { config, configText, plist }
}

function absentService(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && (error.code === 113 || error.code === 3)) return true
  return 'stderr' in error && typeof error.stderr === 'string' && /Could not find service|No such process/i.test(error.stderr)
}

async function loadedState(paths: ServicePaths): Promise<{ loaded: boolean; running: boolean }> {
  try {
    const { stdout } = await paths.run(['print', `gui/${paths.uid}/${SKILLS_SERVICE_LABEL}`])
    return { loaded: true, running: /\bstate\s*=\s*running\b/.test(stdout) || /\bpid\s*=\s*\d+/.test(stdout) }
  } catch (error) {
    if (absentService(error)) return { loaded: false, running: false }
    throw new Error('Could not inspect the omem skills LaunchAgent')
  }
}

function status(paths: ServicePaths, installed: boolean, state: { loaded: boolean; running: boolean }): ServiceStatus {
  return { label: SKILLS_SERVICE_LABEL, installed, ...state, plistPath: paths.plistPath, configPath: paths.configPath }
}

export async function skillsServiceStatus(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const p = paths(options)
  const current = readOwned(p)
  return status(p, current.plist !== undefined && current.config !== undefined, await loadedState(p))
}

function ensureDirectory(path: string, uid: number, privateMode: boolean): void {
  checkAncestors(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).uid !== uid) throw new Error(`Service directory is not owned by this user: ${path}`)
  if (privateMode) chmodSync(path, 0o700)
}

function atomicWrite(path: string, text: string, uid: number): void {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, text)
    ownedFile(path, uid)
    renameSync(temp, path)
  } finally { closeSync(fd); if (existsSync(temp)) unlinkSync(temp) }
}

function buildPlist(p: ServicePaths, options: ServiceOptions): string {
  const args = [options.nodePath ?? process.execPath,
    options.cliPath ?? fileURLToPath(new URL('../../bin/omem.mjs', import.meta.url)),
    'skills', 'watch', '--skills-config', p.configPath,
    '--skills-home', p.home, '--skills-state-dir', p.stateDir]
  for (const path of args.slice(0, 2)) if (!isAbsolute(path)) throw new Error('Node and CLI paths must be absolute')
  const logDir = join(p.stateDir, 'logs')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n${MARKER}\n<plist version="1.0"><dict>
<key>Label</key><string>${SKILLS_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(logDir, 'skills-service.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, 'skills-service.stderr.log'))}</string>
</dict></plist>\n`
}

async function stop(p: ServicePaths): Promise<void> {
  try { await p.run(['bootout', `gui/${p.uid}/${SKILLS_SERVICE_LABEL}`]) }
  catch (error) { if (!absentService(error)) throw new Error('Could not stop the omem skills LaunchAgent') }
}

export async function installSkillsService(options: ServiceOptions & { config: SkillWatchConfig }): Promise<ServiceStatus> {
  const p = paths(options)
  const config = parseConfig(JSON.stringify(options.config))
  const current = readOwned(p)
  const state = await loadedState(p)
  // Never stop an unrelated loaded job merely because it has the same label.
  if (state.loaded && current.plist === undefined) throw new Error('The omem skills label is loaded without an owned LaunchAgent')
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const plist = buildPlist(p, options)
  if (current.configText === configText && current.plist === plist && state.running) return status(p, true, state)
  ensureDirectory(p.stateDir, p.uid, true)
  ensureDirectory(dirname(p.plistPath), p.uid, false)
  const logDir = join(p.stateDir, 'logs')
  ensureDirectory(logDir, p.uid, true)
  for (const name of ['stdout', 'stderr']) {
    const log = join(logDir, `skills-service.${name}.log`)
    if (ownedFile(log, p.uid, false) === undefined) atomicWrite(log, '', p.uid)
  }
  if (state.loaded) await stop(p)
  readOwned(p)
  atomicWrite(p.configPath, configText, p.uid)
  atomicWrite(p.plistPath, plist, p.uid)
  try { await p.run(['bootstrap', `gui/${p.uid}`, p.plistPath]) }
  catch { throw new Error('Could not bootstrap the omem skills LaunchAgent; the saved profile remains available for retry') }
  return status(p, true, await loadedState(p))
}

export async function uninstallSkillsService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const p = paths(options)
  const current = readOwned(p)
  const state = await loadedState(p)
  if (state.loaded && current.plist === undefined) throw new Error('Refusing to stop a loaded label without an owned LaunchAgent')
  if (state.loaded) await stop(p)
  // Recheck file types and ownership after the asynchronous launchctl command.
  const checked = readOwned(p)
  if (checked.plist !== undefined) unlinkSync(p.plistPath)
  if (checked.config !== undefined) unlinkSync(p.configPath)
  return status(p, false, { loaded: false, running: false })
}
