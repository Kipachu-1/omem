/**
 * Shared SQL filter builders for note queries.
 *
 * folder/tag/kinds/pinned WHERE-clause construction was duplicated across
 * search.ts (allowedPaths), browse.ts (memory_list, memory_recent), and
 * write.ts. This centralises the shared patterns.
 */

/** folder LIKE-pattern with %/_/\ escaped, shared by recent/list/search filters. */
export const folderPat = (f: string): string => f.replace(/\/+$/, '').replace(/[\\%_]/g, m => '\\' + m) + '/%'

/** Escape LIKE special characters in a tag string. */
export const tagEscape = (t: string): string => t.replace(/[\\%_]/g, m => '\\' + m)

export interface FolderFilter {
  clause: string
  param: string
}

/** Build a folder prefix LIKE clause + param. */
export function folderFilter(folder: string): FolderFilter {
  return { clause: "path LIKE ? ESCAPE '\\'", param: folderPat(folder) }
}

/** Build a tag EXISTS subquery clause + params (nested tags match by prefix). */
export function tagFilter(tag: string): { clause: string; params: unknown[] } {
  const t = tag.replace(/^#/, '')
  return {
    clause:
      "EXISTS (SELECT 1 FROM edges e WHERE e.src_path = notes.path AND e.type = 'tag' AND (e.dst = ? OR e.dst LIKE ? ESCAPE '\\'))",
    params: [t, tagEscape(t) + '/%'],
  }
}

/** Build a kind IN (...) clause + params. */
export function kindsFilter(kinds: string[]): { clause: string; params: unknown[] } {
  return {
    clause: `kind IN (${kinds.map(() => '?').join(',')})`,
    params: [...kinds],
  }
}
