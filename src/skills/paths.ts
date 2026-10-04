/** Skills have their own read/write API and must never become memory chunks. */
export function isSkillPath(rel: string): boolean {
  const path = rel.replaceAll('\\', '/').toLowerCase()
  return path === 'skills' || path.startsWith('skills/') ||
    path === 'archive/skills' || path.startsWith('archive/skills/')
}
