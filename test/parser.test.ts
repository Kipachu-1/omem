import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNote } from '../src/parser.ts'

test('wikilink variants: plain, alias, heading, dedupe', () => {
  const p = parseNote('a.md', 'See [[Foo]], [[Foo|the foo]], [[Bar#Section]], [[Baz|x]] and [[Foo]] again.')
  assert.deepEqual(p.wikilinks.sort(), ['Bar', 'Baz', 'Foo'])
})

test('links and tags inside code are ignored', () => {
  const p = parseNote('a.md', 'Real #realtag [[RealLink]]\n\n```\n#nottag [[NotALink]]\n```\n\nAnd `#inline [[nope]]` too.')
  assert.deepEqual(p.wikilinks, ['RealLink'])
  assert.deepEqual(p.tags, ['realtag'])
})

test('tags: frontmatter + inline union, numeric excluded, nested kept', () => {
  const p = parseNote('a.md', '---\ntags: [alpha, beta/nested]\n---\nInline #gamma and #123 and #alpha again.')
  assert.deepEqual(p.tags.sort(), ['alpha', 'beta/nested', 'gamma'])
})

test('headings are not tags', () => {
  const p = parseNote('a.md', '# Heading One\n## Heading Two\nBody #yes')
  assert.deepEqual(p.tags, ['yes'])
})

test('title: frontmatter wins, else filename sans .md', () => {
  assert.equal(parseNote('dir/some-note.md', 'hi').title, 'some-note')
  assert.equal(parseNote('dir/some-note.md', '---\ntitle: Nice Title\n---\nhi').title, 'Nice Title')
})

test('chunking: preamble + h1-h3 boundaries, h4 stays inside', () => {
  const p = parseNote('a.md', 'preamble\n\n# One\nbody1\n\n#### Sub4\nstill in one\n\n## Two\nbody2\n\n### Three\nbody3')
  assert.deepEqual(p.chunks.map(c => c.heading), [null, 'One', 'Two', 'Three'])
  assert.ok(p.chunks[1].text.includes('still in one'))
  assert.deepEqual(p.chunks.map(c => c.position), [0, 1, 2, 3])
})

test('chunking: # inside fenced code is not a heading', () => {
  const p = parseNote('a.md', '# Real\n```bash\n# comment not heading\n```\nafter')
  assert.equal(p.chunks.length, 1)
  assert.equal(p.chunks[0].heading, 'Real')
})

test('chunking: empty note -> no chunks; blank sections skipped', () => {
  assert.deepEqual(parseNote('a.md', '').chunks, [])
  assert.deepEqual(parseNote('a.md', '# Only Heading\n\n\n').chunks.length, 1)
})

test('chunking: long section splits on paragraphs with overlap', () => {
  const para = 'Word stuff filler sentence to occupy space in the paragraph body here. '.repeat(6) // ~430 chars
  const p = parseNote('a.md', `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`)
  assert.ok(p.chunks.length >= 2, `expected split, got ${p.chunks.length}`)
  for (const c of p.chunks) {
    assert.equal(c.heading, 'Big')
    assert.ok(c.text.length <= 2200, 'piece too large')
  }
})

test('chunking: single paragraph larger than max stays one chunk', () => {
  const huge = 'x'.repeat(4000)
  assert.equal(parseNote('a.md', huge).chunks.length, 1)
})

test('malformed frontmatter does not throw', () => {
  const p = parseNote('a.md', '---\ntags: [unclosed\n:::\n---\nbody')
  assert.equal(p.title, 'a')
})

test('self and empty link targets filtered', () => {
  const p = parseNote('a.md', '[[  ]] and [[#same-file-heading]] only')
  assert.deepEqual(p.wikilinks, [])
})

test('indented code fences (inside lists) are still code', () => {
  const p = parseNote('a.md', '- item\n    ```\n    #nottag [[NotALink]]\n    ```\n- next #yes')
  assert.deepEqual(p.wikilinks, [])
  assert.deepEqual(p.tags, ['yes'])
})

test('unclosed [[ produces no phantom link', () => {
  const p = parseNote('a.md', 'Type [[ to insert a link in Obsidian')
  assert.deepEqual(p.wikilinks, [])
})

test('leading horizontal rule is not swallowed as frontmatter', () => {
  const p = parseNote('a.md', '---\nJust some plain text\n---\nAfter the rule')
  const all = p.chunks.map(c => c.text).join('\n')
  assert.ok(all.includes('Just some plain text'), 'text before the second --- must survive')
  assert.ok(all.includes('After the rule'))
  assert.deepEqual(p.frontmatter, {})
})

test('CRLF files chunk and split like LF files', () => {
  const para = 'Filler sentence for a windows-authored note body here. '.repeat(8)
  const crlf = `# One\r\n\r\n${para}\r\n\r\n${para}\r\n\r\n${para}\r\n\r\n${para}\r\n\r\n# Two\r\nshort`
  const p = parseNote('a.md', crlf)
  assert.deepEqual([...new Set(p.chunks.map(c => c.heading))], ['One', 'Two'])
  assert.ok(p.chunks.length >= 3, 'long CRLF section must split')
})

test('headings ending in # keep it; ATX closing #s are stripped', () => {
  assert.equal(parseNote('a.md', '# Notes on C#\nbody').chunks[0].heading, 'Notes on C#')
  assert.equal(parseNote('a.md', '# Title ##\nbody').chunks[0].heading, 'Title')
})

test('links-to frontmatter array counts as wikilinks', () => {
  const p = parseNote('a.md', '---\nlinks-to: ["[[git-commit-style]]", "[[pr-conventions|alias]]"]\n---\nbody with [[Body Link]]')
  assert.deepEqual(p.wikilinks.sort(), ['Body Link', 'git-commit-style', 'pr-conventions'])
})
