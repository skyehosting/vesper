/**
 * Reads the shared zod settings schema (src/shared/settings.ts — the only place ranges and choices live, 07 E12):
 * every leaf path (for the "every setting has a control" test, 07 D12), and a leaf's number range or choices so
 * forms never hard-code min/max.
 *
 * Arrays of objects are walked with `[]` ('llm.profiles[].baseUrl'); records and arrays of scalars are leaves.
 */
import { settingsSchema } from '@shared/settings'

/** The parts of zod's internal definition this walker needs (zod 4 `_zod.def`). */
interface Def {
  type: string
  innerType?: Node
  shape?: Record<string, Node>
  element?: Node
  options?: Node[] | string[]
  values?: unknown[]
  entries?: Record<string, string>
}
interface Node {
  _zod: { def: Def }
  minValue?: number | null
  maxValue?: number | null
  isInt?: boolean
  options?: readonly string[]
}

const WRAPPERS = new Set(['default', 'prefault', 'optional', 'nullable', 'readonly', 'catch'])

function unwrap(n: Node): Node {
  let cur = n
  while (WRAPPERS.has(cur._zod.def.type) && cur._zod.def.innerType) cur = cur._zod.def.innerType
  return cur
}

const root = settingsSchema as unknown as Node

/** Every leaf path of the settings schema. */
export function settingLeaves(): string[] {
  const out: string[] = []
  const walk = (n: Node, prefix: string): void => {
    const u = unwrap(n)
    const d = u._zod.def
    if (d.type === 'object' && d.shape) {
      for (const [k, child] of Object.entries(d.shape)) walk(child, prefix ? `${prefix}.${k}` : k)
      return
    }
    if (d.type === 'array' && d.element && unwrap(d.element)._zod.def.type === 'object') {
      walk(d.element, `${prefix}[]`)
      return
    }
    out.push(prefix)
  }
  walk(root, '')
  return out
}

/** The schema node at a dotted path (array items as `[]` or an index). */
function nodeAt(path: string): Node | null {
  let cur: Node | null = root
  for (const raw of path.split('.')) {
    if (!cur) return null
    const parts = raw.split('[]')
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i]
      let u: Node = unwrap(cur as Node)
      if (key) {
        if (/^\d+$/.test(key) && u._zod.def.type === 'array' && u._zod.def.element) {
          cur = u._zod.def.element
          continue
        }
        const shape = u._zod.def.shape
        if (!shape || !shape[key]) return null
        cur = shape[key]
      }
      if (i < parts.length - 1) {
        u = unwrap(cur as Node)
        if (u._zod.def.type !== 'array' || !u._zod.def.element) return null
        cur = u._zod.def.element
      }
    }
  }
  return cur
}

export interface NumberRange {
  min: number
  max: number
  int: boolean
}

/** min/max of a number setting (throws for a path that isn't a bounded number: a programming error). */
export function rangeOf(path: string): NumberRange {
  const n = nodeAt(path)
  const u = n ? unwrap(n) : null
  if (!u || u._zod.def.type !== 'number' || u.minValue == null || u.maxValue == null) throw new Error(`settings: ${path} is not a bounded number`)
  return { min: u.minValue, max: u.maxValue, int: !!u.isInt }
}

/** The allowed values of an enum (or literal-union) setting. */
export function choicesOf(path: string): string[] {
  const n = nodeAt(path)
  const u = n ? unwrap(n) : null
  if (!u) throw new Error(`settings: no ${path}`)
  const d = u._zod.def
  if (d.type === 'enum' && u.options) return [...u.options]
  if (d.type === 'enum' && d.entries) return Object.values(d.entries)
  if (d.type === 'union' && Array.isArray(d.options))
    return (d.options as Node[]).flatMap((o) => (unwrap(o)._zod.def.values ?? []).map((v) => String(v)))
  throw new Error(`settings: ${path} has no fixed choices`)
}

/** max length of a string setting. */
export function maxLengthOf(path: string): number | null {
  const n = nodeAt(path)
  const u = n ? (unwrap(n) as Node & { maxLength?: number | null }) : null
  return u?.maxLength ?? null
}
