import { basename } from 'node:path'
import { parseFrontmatter } from './frontmatter.ts'

export interface Chunk {
  heading: string | null
  anchor: string | null
  position: number
  text: string
}

export interface ParsedNote {
  title: string
  frontmatter: Record<string, unknown>
  chunks: Chunk[]
  wikilinks: string[]
  tags: string[]
}

const CHUNK_MAX = 1500
const OVERLAP = 200

export function parseNote(relPath: string, raw: string): ParsedNote {
  const { frontmatter, content: contentRaw } = parseFrontmatter(raw)
  const content = contentRaw.replace(/\r\n/g, '\n')

  const title =
    typeof frontmatter.title === 'string' && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : basename(relPath).replace(/\.md$/i, '')

  const scannable = stripCode(content)

  // links-to frontmatter (array of "[[target]]" strings) counts alongside body wikilinks
  const fmLinks = (Array.isArray(frontmatter['links-to']) ? frontmatter['links-to'] : [])
    .filter((x): x is string => typeof x === 'string')
    .map(s => s.replace(/^\[\[|\]\]$/g, '').split(/[#|]/)[0].trim())
  const wikilinks = [
    ...new Set(
      [...scannable.matchAll(/\[\[([^\][|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
        .map(m => m[1].trim())
        .concat(fmLinks)
        .filter(Boolean),
    ),
  ]

  const inlineTags = [...scannable.matchAll(/(?:^|[\s(])#([\p{L}\p{N}/_-]+)/gmu)].map(m => m[1])
  const tags = [...new Set([...fmTags(frontmatter.tags), ...inlineTags])]
    .map(t => t.replace(/^#/, ''))
    .filter(t => t && !/^\d+$/.test(t)) // obsidian: purely numeric is not a tag

  return { title, frontmatter, chunks: chunkContent(content), wikilinks, tags }
}

function fmTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(t => typeof t === 'string')
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean)
  return []
}

// line-based, same fence rules as chunkContent — indented fences count too
function stripCode(s: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of s.split('\n')) {
    const f = /^(```|~~~)/.exec(line.trim())
    if (f) {
      fence = fence === f[1] ? null : (fence ?? f[1])
      out.push('')
    } else out.push(fence ? '' : line)
  }
  return out.join('\n').replace(/`[^`\n]*`/g, ' ')
}

function chunkContent(content: string): Chunk[] {
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }]
  let fence: string | null = null
  for (const line of content.split('\n')) {
    const f = /^(```|~~~)/.exec(line.trim())
    if (f) fence = fence === f[1] ? null : (fence ?? f[1])
    const h = !fence && !f ? /^#{1,3}\s+(.+?)(?:\s+#+)?\s*$/.exec(line) : null
    if (h) sections.push({ heading: h[1], lines: [line] })
    else sections.at(-1)!.lines.push(line)
  }

  const chunks: Chunk[] = []
  for (const s of sections) {
    const text = s.lines.join('\n').trim()
    if (!text) continue
    for (const piece of splitLong(text)) {
      chunks.push({ heading: s.heading, anchor: s.heading, position: chunks.length, text: piece })
    }
  }
  return chunks
}

function splitLong(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text]
  const paras = text.split(/\n{2,}/).filter(p => p.trim())
  const out: string[] = []
  let cur: string[] = []
  let fresh = false // cur contains a paragraph not yet emitted
  const len = (a: string[]) => a.reduce((n, p) => n + p.length + 2, 0)
  for (const p of paras) {
    if (cur.length && len(cur) + p.length > CHUNK_MAX && fresh) {
      out.push(cur.join('\n\n'))
      const keep: string[] = []
      for (let i = cur.length - 1; i >= 0 && len(keep) + cur[i].length <= OVERLAP; i--) keep.unshift(cur[i])
      cur = keep
      fresh = false
    }
    cur.push(p) // ponytail: a single paragraph > CHUNK_MAX stays one oversized chunk
    fresh = true
  }
  if (fresh) out.push(cur.join('\n\n'))
  return out
}
