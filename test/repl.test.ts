import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSlash, SLASH_COMMANDS, helpText } from '../src/repl.ts'
import { suggest, levenshtein, bar } from '../src/ui.ts'

// --- parseSlash ---

test('parseSlash: bare text → cmd="" args=[text]', () => {
  const r = parseSlash('how does search work')
  assert.equal(r.cmd, '')
  assert.deepEqual(r.args, ['how does search work'])
})

test('parseSlash: /search with args', () => {
  const r = parseSlash('/search foo bar baz')
  assert.equal(r.cmd, 'search')
  assert.deepEqual(r.args, ['foo', 'bar', 'baz'])
})

test('parseSlash: /quit no args', () => {
  const r = parseSlash('/quit')
  assert.equal(r.cmd, 'quit')
  assert.deepEqual(r.args, [])
})

test('parseSlash: empty line', () => {
  const r = parseSlash('   ')
  assert.equal(r.cmd, '')
  assert.deepEqual(r.args, [''])
})

test('parseSlash: trims whitespace', () => {
  const r = parseSlash('  /status  ')
  assert.equal(r.cmd, 'status')
  assert.deepEqual(r.args, [])
})

// --- suggest (Levenshtein) ---

test('suggest: exact match returns it', () => {
  assert.equal(suggest('index', KNOWN_CMDS), 'index')
})

test('suggest: one-char typo → corrects', () => {
  assert.equal(suggest('indx', KNOWN_CMDS), 'index')
  assert.equal(suggest('statz', KNOWN_CMDS), 'stats')
  assert.equal(suggest('serch', KNOWN_CMDS), 'search')
})

test('suggest: two-char distance → still matches', () => {
  assert.equal(suggest('inex', KNOWN_CMDS), 'index')
})

test('suggest: too far → undefined', () => {
  assert.equal(suggest('zzzzz', KNOWN_CMDS), undefined)
  assert.equal(suggest('xyzzy', KNOWN_CMDS), undefined)
})

test('suggest: empty input → undefined', () => {
  assert.equal(suggest('', KNOWN_CMDS), undefined)
})

// --- levenshtein ---

test('levenshtein: identical → 0', () => {
  assert.equal(levenshtein('index', 'index'), 0)
})

test('levenshtein: one substitution', () => {
  assert.equal(levenshtein('index', 'indax'), 1)
})

test('levenshtein: one insertion', () => {
  assert.equal(levenshtein('cat', 'cats'), 1)
})

test('levenshtein: one deletion', () => {
  assert.equal(levenshtein('cats', 'cat'), 1)
})

test('levenshtein: empty strings', () => {
  assert.equal(levenshtein('', ''), 0)
  assert.equal(levenshtein('abc', ''), 3)
  assert.equal(levenshtein('', 'abc'), 3)
})

// --- bar ---

test('bar: 0 → all empty', () => {
  assert.equal(bar(0), '░░░░░░░░░░')
})

test('bar: 1 → all filled', () => {
  assert.equal(bar(1), '██████████')
})

test('bar: 0.5 → half', () => {
  assert.equal(bar(0.5, 10).length, 10)
  assert.ok(bar(0.5, 10).includes('█'))
  assert.ok(bar(0.5, 10).includes('░'))
})

test('bar: clamps out of range', () => {
  assert.equal(bar(-1), '░░░░░░░░░░')
  assert.equal(bar(2), '██████████')
})

// --- helpText ---

test('helpText: includes all slash commands', () => {
  const txt = helpText()
  for (const cmd of SLASH_COMMANDS) {
    assert.ok(txt.includes(`/${cmd}`), `helpText missing /${cmd}`)
  }
})

test('helpText: includes MCP mapping', () => {
  const txt = helpText()
  assert.ok(txt.includes('memory_search'), 'helpText missing MCP mapping')
  assert.ok(txt.includes('memory_write'), 'helpText missing memory_write mapping')
})

// local command list for suggest tests (mirrors cli.ts KNOWN_COMMANDS)
const KNOWN_CMDS = [
  'setup', 'init', 'index', 'watch', 'serve', 'search', 'doctor',
  'sync', 'rebuild', 'stats', 'agents', 'update', 'help',
]
