/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` members dropped. The wire transcript is replayed
 * byte-for-byte to providers (Anthropic preserved thinking, prompt caching), so every serialization of the same value
 * must produce the same string regardless of how the object was built.
 */
export function djson(value: unknown): string {
  return write(value)
}

function write(v: unknown): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v)
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('djson: non-finite number')
      return JSON.stringify(v)
    case 'boolean':
      return v ? 'true' : 'false'
    case 'bigint':
      throw new TypeError('djson: bigint is not serializable')
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : write(x))).join(',')}]`
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(obj[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`djson: unsupported ${typeof v}`)
  }
}
