import { closeSync, fsyncSync, lstatSync, openSync } from 'node:fs'

/** Node cannot flush directory handles on Windows. File failures still propagate. */
export function durable(path: string): void {
  if (process.platform === 'win32' && lstatSync(path).isDirectory()) return
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
