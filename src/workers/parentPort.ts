/**
 * One message loop for a script that runs either as an Electron utilityProcess (`process.parentPort`, messages wrapped
 * in `{data}`) or as a Node child_process.fork child (`process.on('message')` / `process.send`).
 */
type Reply = (m: unknown) => void

interface UtilityParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(m: unknown): void
}

export function onParentMessage(handler: (m: unknown, reply: Reply) => void): void {
  const pp = (process as unknown as { parentPort?: UtilityParentPort }).parentPort
  if (pp) {
    pp.on('message', (e) => handler(e.data, (r) => pp.postMessage(r)))
    return
  }
  process.on('message', (m) => handler(m, (r) => process.send?.(r as Parameters<NonNullable<typeof process.send>>[0])))
}
