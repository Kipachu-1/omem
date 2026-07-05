import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearerOk, resolveHttpClientName } from '../src/mcp.ts'

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
