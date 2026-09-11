import { join } from 'node:path'
import { openDb } from '../../src/db.ts'
import { buildToolCtx } from '../../src/mcp/ctx.ts'
import { writeNote } from '../../src/mcp/tools/write.ts'
import { bow } from './bow.ts'

const [vault, path, expectedHash, content] = process.argv.slice(2)
const db = openDb(join(vault, '.omem', 'index.db'))
try {
  console.log(JSON.stringify(await writeNote(buildToolCtx(db, vault, bow, () => 'write-worker'), {
    title: 'Concurrent note', path, expectedHash, content, mode: 'update',
  })))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  db.close()
}
