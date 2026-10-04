import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'

const executableMetadata = '.omem-executables.json'

export const skillNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Skill names must use lowercase letters, numbers, and single hyphens')
export const skillPathSchema = z.string().min(1).refine(path => !path.includes('\\') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'File paths must be POSIX relative paths without traversal')
export const skillFileSchema = z.object({
  path: skillPathSchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  executable: z.boolean().default(false),
})
export type SkillFile = z.infer<typeof skillFileSchema>
export const skillSummarySchema = z.object({ name: skillNameSchema, description: z.string().min(1).max(1024).refine(value => value.trim().length > 0), revision: z.string().regex(/^[a-f0-9]{64}$/) })
export const skillManifestEntrySchema = z.object({ path: skillPathSchema, hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), executable: z.boolean() })
export const skillDetailsSchema = skillSummarySchema.extend({ instructions: z.string(), manifest: z.array(skillManifestEntrySchema) })
export type SkillSummary = z.infer<typeof skillSummarySchema>
export type SkillDetails = z.infer<typeof skillDetailsSchema>
export type SkillBundle = SkillDetails & { files: SkillFile[] }

export function bytesFor(file: SkillFile): Buffer {
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error(`Invalid base64 content for ${file.path}`)
  return Buffer.from(file.content, 'base64')
}

function validatePaths(files: SkillFile[]): void {
  const paths = new Map<string, string>()
  const prefixes = new Map<string, string>()
  for (const file of files) {
    if (file.path.split('/')[0].toLowerCase() === executableMetadata) throw new Error('File path is reserved for executable metadata')
    const folded = file.path.normalize('NFC').toLowerCase()
    if (paths.has(folded)) throw new Error(`Duplicate or case-colliding file path: ${file.path}`)
    paths.set(folded, file.path)
    const parts = file.path.split('/')
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/')
      const key = prefix.normalize('NFC').toLowerCase()
      const previous = prefixes.get(key)
      if (previous !== undefined && previous !== prefix) throw new Error(`Case-colliding path: ${prefix}`)
      prefixes.set(key, prefix)
    }
  }
  for (const path of paths.keys()) {
    const parts = path.split('/')
    parts.pop()
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new Error(`File is also a directory: ${path}`)
      parts.pop()
    }
  }
}

export function createBundle(input: SkillFile[], expectedName?: string): SkillBundle {
  const files = input.map(file => skillFileSchema.parse(file)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  validatePaths(files)
  const entry = files.find(file => file.path === 'SKILL.md')
  if (!entry) throw new Error('A skill bundle requires SKILL.md')
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytesFor(entry))
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(raw)) throw new Error('SKILL.md must start with closed YAML frontmatter')
  const parsed = matter(raw)
  const metadata = skillSummarySchema.omit({ revision: true }).parse(parsed.data)
  if (expectedName !== undefined && metadata.name !== skillNameSchema.parse(expectedName)) throw new Error(`Skill name ${metadata.name} does not match directory name ${expectedName}`)
  const revision = createHash('sha256')
  const manifest = files.map(file => {
    const bytes = bytesFor(file)
    // Length-prefix each field so different path/content boundaries cannot share a revision.
    for (const field of [Buffer.from(file.path), bytes, Buffer.from(file.executable ? '1' : '0')]) {
      revision.update(`${field.length}:`)
      revision.update(field)
    }
    return { path: file.path, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, executable: file.executable }
  })
  return { ...metadata, revision: revision.digest('hex'), instructions: parsed.content, manifest, files }
}

export function readBundle(directory: string, expectedName = basename(resolve(directory))): SkillBundle {
  const root = realpathSync(directory)
  if (!lstatSync(root).isDirectory()) throw new Error('Skill bundle must be a directory')
  const files: SkillFile[] = []
  const metadataPath = resolve(root, executableMetadata)
  let executables: Set<string> | undefined
  if (existsSync(metadataPath)) {
    const stat = lstatSync(metadataPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Executable metadata must be a regular file')
    executables = new Set(z.array(skillPathSchema).parse(JSON.parse(readFileSync(metadataPath, 'utf8'))))
  }
  const ancestors = new Set<string>()
  function walk(path: string, prefix: string): void {
    const canonical = realpathSync(path)
    const rel = relative(root, canonical)
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== canonical) throw new Error(`Symlink escapes skill bundle: ${prefix}`)
    const stat = lstatSync(canonical)
    if (stat.isDirectory()) {
      if (ancestors.has(canonical)) throw new Error(`Symlink cycle in skill bundle: ${prefix}`)
      ancestors.add(canonical)
      for (const child of readdirSync(canonical).sort()) {
        if (!prefix && child === executableMetadata) continue
        walk(resolve(canonical, child), prefix ? `${prefix}/${child}` : child)
      }
      ancestors.delete(canonical)
    } else if (stat.isFile()) {
      const bytes = readFileSync(canonical)
      let content: string
      let encoding: SkillFile['encoding'] = 'utf8'
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { content = bytes.toString('base64'); encoding = 'base64' }
      files.push({ path: prefix, content, encoding, executable: executables !== undefined ? executables.has(prefix) : (stat.mode & 0o111) !== 0 })
    } else throw new Error(`Unsupported file in skill bundle: ${prefix}`)
  }
  walk(root, '')
  if (executables && [...executables].some(path => !files.some(file => file.path === path))) throw new Error('Executable metadata refers to a missing file')
  return createBundle(files, expectedName)
}

/** Only write into a new staging directory. Existing directories are never replaced. */
export function writeBundle(directory: string, input: SkillFile[]): void {
  const bundle = createBundle(input)
  if (existsSync(directory)) throw new Error(`Staging directory already exists: ${directory}`)
  mkdirSync(directory, { recursive: false })
  for (const file of bundle.files) {
    const target = resolve(directory, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytesFor(file), { flag: 'wx', mode: file.executable ? 0o755 : 0o644 })
    chmodSync(target, file.executable ? 0o755 : 0o644)
  }
  if (process.platform === 'win32')
    writeFileSync(resolve(directory, executableMetadata), JSON.stringify(bundle.files.filter(file => file.executable).map(file => file.path)), { flag: 'wx' })
}
