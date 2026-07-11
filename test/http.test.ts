import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { request } from 'node:http'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

// ---- pure-function tests (no server needed) ----

import { bearerOk, resolveHttpClientName } from '../src/mcp/index.ts'

test('bearerOk: auth is opt-in and constant-time-compared when enabled', () => {
  // no token configured -> open, whatever the client sends
  assert.equal(bearerOk(undefined, undefined), true)
  assert.equal(bearerOk('Bearer anything', undefined), true)
  // token configured -> exact bearer match required
  assert.equal(bearerOk('Bearer s3cret', 's3cret'), true)
  assert.equal(bearerOk('Bearer wrong', 's3cret'), false)
  assert.equal(bearerOk('Bearer s3cret-longer', 's3cret'), false)
  assert.equal(bearerOk('s3cret', 's3cret'), false) // missing Bearer prefix
  assert.equal(bearerOk(undefined, 's3cret'), false)
  assert.equal(bearerOk('', 's3cret'), false)
})

test('resolveHttpClientName: explicit header wins; else token hash; else "default"', () => {
  // explicit header overrides everything
  assert.equal(resolveHttpClientName({ 'x-omem-client': 'claude-code' }, 'tok'), 'claude-code')
  assert.equal(resolveHttpClientName({ 'x-omem-client': 'claude-code' }, undefined), 'claude-code')
  // no header + token -> sha256(token).slice(0,16); same token = same client
  const expected = '9f86d081884c7d65'
  assert.equal(resolveHttpClientName({}, 'test'), expected)
  assert.equal(resolveHttpClientName({ authorization: 'Bearer test' }, 'test'), expected)
  // no header, no token -> open endpoint, shared 'default' client
  assert.equal(resolveHttpClientName({}, undefined), 'default')
  assert.equal(resolveHttpClientName({ authorization: 'Bearer anything' }, undefined), 'default')
  // header takes precedence even when token differs
  assert.equal(resolveHttpClientName({ 'x-omem-client': 'cursor' }, 'other'), 'cursor')
  // array-valued header (node http quirk) -> first entry
  assert.equal(resolveHttpClientName({ 'x-omem-client': ['a', 'b'] }, undefined), 'a')
})

// ---- HTTP-level tests ----

/** Helper: send one HTTP request and collect {status, headers, body}. */
function send(port: number, opts: { method: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, method: opts.method, path: opts.path ?? '/', headers: opts.headers }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** Spawn `omem serve --port`, resolve when healthz responds. */
function startServe(port: number, vault: string, env: Record<string, string> = {}): ReturnType<typeof spawn> {
  return spawn(process.execPath, [join(ROOT, 'src/cli.ts'), 'serve', '--port', String(port), '--vault', vault], {
    env: { ...process.env, OMEM_USAGE_LOG: 'off', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

test('healthz returns 200 ok without auth, even when token is set', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'omem-http-'))
  cpSync(FIXTURE, vault, { recursive: true })
  const port = 18000 + Math.floor(Math.random() * 1000)
  const proc = startServe(port, vault, { OMEM_HTTP_TOKEN: 's3cret' })
  try {
    // poll healthz until ready
    let ok = false
    for (let i = 0; i < 50 && !ok; i++) {
      try { const r = await send(port, { method: 'GET', path: '/healthz' }); ok = r.status === 200 } catch { /* not ready */ }
      if (!ok) await new Promise(r => setTimeout(r, 200))
    }
    assert.ok(ok, 'server should be ready')
    const r = await send(port, { method: 'GET', path: '/healthz' })
    assert.equal(r.status, 200)
    assert.equal(r.body, 'ok')
  } finally {
    proc.kill()
    rmSync(vault, { recursive: true, force: true })
  }
})

test('auth: missing bearer returns 401 when token is set', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'omem-http-'))
  cpSync(FIXTURE, vault, { recursive: true })
  const port = 18000 + Math.floor(Math.random() * 1000)
  const proc = startServe(port, vault, { OMEM_HTTP_TOKEN: 's3cret' })
  try {
    let ok = false
    for (let i = 0; i < 50 && !ok; i++) {
      try { const r = await send(port, { method: 'GET', path: '/healthz' }); ok = r.status === 200 } catch { /* not ready */ }
      if (!ok) await new Promise(r => setTimeout(r, 200))
    }
    assert.ok(ok, 'server should be ready')
    const r = await send(port, { method: 'POST', path: '/', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' })
    assert.equal(r.status, 401)
    assert.equal(r.body, 'unauthorized')
  } finally {
    proc.kill()
    rmSync(vault, { recursive: true, force: true })
  }
})
