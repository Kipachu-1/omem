import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// npm installs global bins as symlinks: argv[1] is the link, import.meta.url the
// realpath. The invoked-as-main guard must follow the link, or the published `omem`
// command silently no-ops (exit 0, no output) — the exact regression this pins.
test('bin runs when invoked through a symlink (npm-global bin layout)', () => {
  const bin = fileURLToPath(new URL('../bin/omem.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'omem-bin-'))
  const link = join(dir, 'omem')
  try {
    symlinkSync(bin, link)
    const r = spawnSync(process.execPath, [link], { encoding: 'utf8' })
    // whatever the gate or the CLI decides, a run through the bin ALWAYS writes
    // something (a version-gate message, a usage/vault error). Silent exit 0 with
    // empty output is the no-op signature this test exists to catch.
    assert.ok(
      r.stdout.length > 0 || r.stderr.length > 0,
      `bin must produce output via symlink — got status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
