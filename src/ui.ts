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
