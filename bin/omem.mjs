#!/usr/bin/env node
// plain-JS shim: friendly version gate (the entrypoint itself would die cryptically),
// then run built JS when present (published package) or raw TS (repo checkout).
import { existsSync } from 'node:fs'

const [maj = 0] = process.versions.node.split('.').map(Number)
const dist = new URL('../dist/cli.js', import.meta.url)
const needed = existsSync(dist) ? 20 : 23.6
if (maj < Math.ceil(needed)) {
  console.error(`omem requires Node >= ${needed} (you have ${process.versions.node}).`)
  process.exit(1)
}
await import(existsSync(dist) ? dist : new URL('../src/cli.ts', import.meta.url))
