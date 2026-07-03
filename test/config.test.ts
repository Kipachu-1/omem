import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))
const CLI = join(ROOT, 'src/cli.ts')

let tmp: string
let cfgHome: string
let vault: string

// child env with a controlled config home and NO repo .env / inherited omem vars
const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: cfgHome, OMEM_ENV_FILE: '/nonexistent' }
  for (const k of Object.keys(env)) if (k.startsWith('OMEM_') && k !== 'OMEM_ENV_FILE') delete env[k]
  return { ...env, ...extra }
}

const writeCfg = (cfg: object): void => {
  mkdirSync(join(cfgHome, 'omem'), { recursive: true })
  writeFileSync(join(cfgHome, 'omem', 'config.json'), JSON.stringify(cfg))
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omem-cfg-'))
  cfgHome = join(tmp, 'xdg')
  vault = join(tmp, 'vault')
  cpSync(FIXTURE, vault, { recursive: true })
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

test('vault resolves from the user config file with no flags or env', () => {
  writeCfg({ vault })
  execFileSync(process.execPath, [CLI, 'stats'], { encoding: 'utf8', env: childEnv() })
  assert.ok(existsSync(join(vault, '.omem', 'index.db')), 'db must be created inside the config-file vault')
})

test('.env beats the config file; real env beats .env', () => {
  const otherVault = join(tmp, 'other-vault')
  mkdirSync(otherVault)
  writeFileSync(join(otherVault, 'solo.md'), 'only note here')
  writeCfg({ vault: otherVault })

  const envFile = join(tmp, 'test.env')
  writeFileSync(envFile, `OMEM_VAULT=${vault}\n`)
  // .env wins over config file
  execFileSync(process.execPath, [CLI, 'stats'], { encoding: 'utf8', env: childEnv({ OMEM_ENV_FILE: envFile }) })
  assert.ok(existsSync(join(vault, '.omem', 'index.db')), '.env vault must beat config vault')
  assert.ok(!existsSync(join(otherVault, '.omem')), 'config vault must not have been touched')
  // real env wins over .env
  execFileSync(process.execPath, [CLI, 'stats'], {
    encoding: 'utf8',
    env: childEnv({ OMEM_ENV_FILE: envFile, OMEM_VAULT: otherVault }),
  })
  assert.ok(existsSync(join(otherVault, '.omem', 'index.db')), 'real env vault must beat .env vault')
})

test('config githubToken never outranks a real GITHUB_TOKEN (alias guard)', async () => {
  writeCfg({ vault, githubToken: 'config-token' })
  const probe = `import('${join(ROOT, 'src/config.ts').replace(/\\/g, '/')}').then(m => { m.applyEnvDefaults(); console.log(process.env.OMEM_GIT_TOKEN ?? '(unset)') })`
  const withReal = execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    env: childEnv({ GITHUB_TOKEN: 'real-token' }),
  }).trim()
  assert.equal(withReal, '(unset)', 'config token must not be injected when GITHUB_TOKEN exists')
  const without = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: childEnv() }).trim()
  assert.equal(without, 'config-token')
})

test('setup wizard end-to-end through a pipe: writes 600 config, config drives commands', () => {
  // answers: vault, git? n (fixture vault is not a repo -> question skipped), poll 45, index? n, (no claude question if claude missing — feed extra lines harmlessly)
  const answers = `${vault}\n45\nn\nn\n`
  const r = spawnSync(process.execPath, [CLI, 'setup'], {
    encoding: 'utf8',
    input: answers,
    env: childEnv({ OMEM_SETUP_STDIN: '1', PATH: '/usr/bin:/bin' }), // strip claude/omem from PATH for determinism
  })
  assert.equal(r.status, 0, `setup failed: ${r.stderr}`)
  const cfgPath = join(cfgHome, 'omem', 'config.json')
  assert.ok(existsSync(cfgPath), 'config written')
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'config must be chmod 600')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(cfg.vault, vault)
  assert.equal(cfg.poll, 45)
  assert.equal(cfg.git, undefined)
  assert.equal(cfg.githubToken, undefined)

  // a plain command now picks everything up from the config file
  execFileSync(process.execPath, [CLI, 'stats'], { encoding: 'utf8', env: childEnv() })
  assert.ok(existsSync(join(vault, '.omem', 'index.db')), 'db must land in the wizard-configured vault')
})

test('setup refuses non-TTY without the test escape hatch', () => {
  const r = spawnSync(process.execPath, [CLI, 'setup'], { encoding: 'utf8', input: '\n', env: childEnv() })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /interactive/)
})

test('malformed config file warns but does not break --vault', () => {
  mkdirSync(join(cfgHome, 'omem'), { recursive: true })
  writeFileSync(join(cfgHome, 'omem', 'config.json'), '{ not json')
  const out = execFileSync(process.execPath, [CLI, 'stats', '--vault', vault], { encoding: 'utf8', env: childEnv() })
  assert.match(out, /notes:/)
})
