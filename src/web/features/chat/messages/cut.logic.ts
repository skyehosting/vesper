/** Cut a reply at the last word boundary at or before `n` characters (interrupted replies, 07 C15). */
export function cutAt(text: string, n: number): string {
  if (n >= text.length) return text
  const s = text.slice(0, n)
  const ws = s.search(/\s\S*$/)
  return ws > n * 0.3 ? s.slice(0, ws) : s
}
