import { styleText } from 'node:util'

// ponytail: one gate for both streams — if either is piped, all color is off; never corrupts pipes
const on = !('NO_COLOR' in process.env) && !!process.stdout.isTTY && !!process.stderr.isTTY

type Fmt = Parameters<typeof styleText>[0]
const paint = (fmt: Fmt, s: string): string => (on ? styleText(fmt, s) : s)

export const bold = (s: string): string => paint('bold', s)
export const dim = (s: string): string => paint('dim', s)
export const cyan = (s: string): string => paint('cyan', s)
export const green = (s: string): string => paint('green', s)
export const yellow = (s: string): string => paint('yellow', s)
export const magenta = (s: string): string => paint('magenta', s)
export const red = (s: string): string => paint('red', s)

export const ok = (msg: string): void => console.error(`${green('✓')} ${msg}`)
export const warn = (msg: string): void => console.error(`${yellow('!')} ${msg}`)
export const fail = (msg: string): void => console.error(`${red('✗')} ${msg}`)
export const stamp = (): string => dim(new Date().toLocaleTimeString('en-GB'))

/** Levenshtein distance (iterative two-row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Best fuzzy match within maxDistance, or undefined if none close enough. */
export function suggest(input: string, list: readonly string[], maxDistance = 2): string | undefined {
  let best: string | undefined
  let bestDist = maxDistance + 1
  for (const cand of list) {
    const d = levenshtein(input, cand)
    if (d < bestDist || (d === bestDist && cand.length < (best?.length ?? Infinity))) {
      best = cand
      bestDist = d
    }
  }
  return best
}

/** A simple fractional bar: bar(0.5) → '█████░░░░░'. */
export function bar(frac: number, width = 10): string {
  const f = Math.max(0, Math.min(1, frac))
  const filled = Math.round(f * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Braille spinner on stderr; no-op frames when not a TTY (pipes, logs, MCP stdio). */
export function spin(label: string): { done: (msg?: string) => void } {
  if (!on) return { done: msg => msg !== undefined && msg !== '' && console.error(msg) }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const render = () => process.stderr.write(`\r\x1b[2K${cyan(frames[i++ % frames.length])} ${label}`)
  render()
  const t = setInterval(render, 80)
  t.unref()
  return {
    done: msg => {
      clearInterval(t)
      process.stderr.write('\r\x1b[2K')
      if (msg !== undefined && msg !== '') console.error(msg)
    },
  }
}
