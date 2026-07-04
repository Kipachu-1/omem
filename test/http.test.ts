import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearerOk } from '../src/mcp.ts'

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
