/**
 * Shared gray-matter frontmatter parse wrapper.
 *
 * The same try/catch pattern for parsing frontmatter (with graceful fallback
 * for malformed YAML) was duplicated across ctx.ts, write.ts, browse.ts, and
 * parser.ts. This centralises it.
 */
import matter from 'gray-matter'

export interface ParsedFrontmatter {
  /** The parsed frontmatter object (empty {} if none or malformed). */
  frontmatter: Record<string, unknown>
  /** The body content with frontmatter stripped. */
  content: string
}

/**
 * Parse a raw markdown string into frontmatter + content.
 * Malformed YAML → returns the raw string as content with empty frontmatter.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  let frontmatter: Record<string, unknown> = {}
  let content = raw
  try {
    const fm = matter(raw)
    if (fm.data && typeof fm.data === 'object' && !Array.isArray(fm.data)) {
      frontmatter = fm.data
      content = fm.content
    }
  } catch {
    // malformed frontmatter: return the raw file
  }
  return { frontmatter, content }
}

/** Stringify content + frontmatter back to a markdown string with YAML frontmatter. */
export function stringifyFrontmatter(content: string, frontmatter: Record<string, unknown>): string {
  return matter.stringify(content, frontmatter)
}
