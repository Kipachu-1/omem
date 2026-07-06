/**
 * Shared SQL filter helpers for note queries.
 *
 * folder/tag escape patterns were duplicated across search.ts (allowedPaths),
 * browse.ts (memory_list, memory_recent), and write.ts. This centralises them.
 */

/** folder LIKE-pattern with %/_/\ escaped, shared by recent/list/search filters. */
export const folderPat = (f: string): string => f.replace(/\/+$/, '').replace(/[\\%_]/g, m => '\\' + m) + '/%'

/** Escape LIKE special characters in a tag string. */
export const tagEscape = (t: string): string => t.replace(/[\\%_]/g, m => '\\' + m)
