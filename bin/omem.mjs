#!/usr/bin/env node
// plain-JS shim: friendly version gate (the entrypoint itself would die cryptically),
// then run built JS when present (published package) or raw TS (repo checkout).
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * True when `version` (e.g. '23.6.1') meets a [major, minor] requirement.
 * Full major.minor compare — a ceil() on the minor would reject Node 23.6-23.9
 * while the printed message still said ">= 23.6". Exported for unit tests.
 */
export function meetsRequirement(version, needed) {
  const [maj = 0, min = 0] = version.split('.').map(Number)
  return maj > needed[0] || (maj === needed[0] && min >= needed[1])
}

const dist = new URL('../dist/cli.js', import.meta.url)
const usingDist = existsSync(dist)
const needed = usingDist ? [20, 0] : [23, 6]

// only run the CLI when invoked as the entrypoint; a test importing this module
// for meetsRequirement must not drag in the whole CLI.
// npm installs global bins as SYMLINKS (argv[1] = the link) while Node's ESM loader
// resolves import.meta.url to the realpath — compare realpaths or the CLI silently
// no-ops (exit 0, no output) on the one layout every published install uses.
const invokedAsMain = (() => {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false // argv[1] unreadable: assume we are not the entrypoint
  }
})()

if (invokedAsMain) {
  if (!meetsRequirement(process.versions.node, needed)) {
    console.error(`omem requires Node >= ${needed.join('.')} (you have ${process.versions.node}).`)
    process.exit(1)
  }
  await import(usingDist ? dist : new URL('../src/cli.ts', import.meta.url))
}
