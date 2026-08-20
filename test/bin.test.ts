import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetsRequirement } from '../bin/omem.mjs'

// The gate must accept every version the printed message claims to accept —
// the old ceil()-based check rejected Node 23.6-23.9 while the message said ">= 23.6".
test('bin version gate matches the message it prints', () => {
  // published-package layout: Node >= 20
  assert.equal(meetsRequirement('20.0.0', [20, 0]), true)
  assert.equal(meetsRequirement('22.23.1', [20, 0]), true)
  assert.equal(meetsRequirement('19.9.9', [20, 0]), false)

  // repo-checkout layout (raw TS): Node >= 23.6
  assert.equal(meetsRequirement('23.6.0', [23, 6]), true)
  assert.equal(meetsRequirement('23.9.0', [23, 6]), true)
  assert.equal(meetsRequirement('24.0.0', [23, 6]), true)
  assert.equal(meetsRequirement('23.5.9', [23, 6]), false)
  assert.equal(meetsRequirement('22.0.0', [23, 6]), false)
})
