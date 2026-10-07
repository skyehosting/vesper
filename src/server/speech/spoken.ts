/**
 * Spoken-text rules for one run of visible text (07 C14): what a voice should say for it. Each output char keeps the
 * index of the input char it came from, so the segmenter can map spoken text back to source offsets.
 *
 * Rules: bare URLs → "link"; emoji dropped; stray markdown characters dropped; a few number/unit forms read naturally
 * ("10–20" → "10 to 20", "5 km" → "5 kilometers", "20°C" → "20 degrees Celsius", "~5" → "about 5"); common
 * abbreviations expanded ("e.g." → "for example"). Everything else is left to the provider's own normalization.
 */

export interface Spoken {
  text: string
  /** For each char of `text`, the index in the input it came from. */
  map: number[]
}

type Rule = [RegExp, (m: RegExpExecArray) => string]

const UNITS: Record<string, string> = {
  'km/h': 'kilometers per hour',
  kph: 'kilometers per hour',
  mph: 'miles per hour',
  km: 'kilometers',
  kg: 'kilograms',
  mg: 'milligrams',
  ml: 'milliliters',
  cm: 'centimeters',
  mm: 'millimeters',
  ms: 'milliseconds',
  KB: 'kilobytes',
  MB: 'megabytes',
  GB: 'gigabytes',
  TB: 'terabytes',
  Hz: 'hertz',
  kHz: 'kilohertz',
  MHz: 'megahertz',
  GHz: 'gigahertz',
  fps: 'frames per second'
}

const RULES: Rule[] = [
  [/\b(?:https?:\/\/|www\.)[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/giu, () => 'link'],
  [/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}‍️⃣]+/gu, () => ''],
  [/\s?°\s?C\b/g, () => ' degrees Celsius'],
  [/\s?°\s?F\b/g, () => ' degrees Fahrenheit'],
  [/°/g, () => ' degrees'],
  [/(?<=\d)\s?–\s?(?=\d)/g, () => ' to '],
  [/(?<=\d)\s?×\s?(?=\d)/g, () => ' times '],
  [/~(?=\d)/g, () => 'about '],
  [/(?<=\s)&(?=\s)/g, () => 'and'],
  [/(?<=\d)\s?(km\/h|kph|mph|km|kg|mg|ml|cm|mm|ms|KB|MB|GB|TB|kHz|MHz|GHz|Hz|fps)\b/g, (m) => ` ${UNITS[m[1]]}`],
  [/\be\.g\.(?=[\s,]|$)/gi, () => 'for example'],
  [/\bi\.e\.(?=[\s,]|$)/gi, () => 'that is'],
  [/\betc(?=\.)/gi, () => 'et cetera'],
  [/\bvs\.?(?=\s)/gi, () => 'versus'],
  [/[*`#~^\\<>]/g, () => ''],
  [/[_|]/g, () => ' ']
]

function apply(s: Spoken, [re, fn]: Rule): Spoken {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  let last = 0
  let text = ''
  const map: number[] = []
  while ((m = re.exec(s.text))) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    text += s.text.slice(last, m.index)
    for (let i = last; i < m.index; i++) map.push(s.map[i])
    const out = fn(m)
    text += out
    for (let i = 0; i < out.length; i++) map.push(s.map[m.index])
    last = m.index + m[0].length
  }
  if (last === 0) return s
  text += s.text.slice(last)
  for (let i = last; i < s.text.length; i++) map.push(s.map[i])
  return { text, map }
}

export function spokenOf(value: string): Spoken {
  let s: Spoken = { text: value, map: Array.from({ length: value.length }, (_, i) => i) }
  for (const r of RULES) s = apply(s, r)
  return s
}

/** Words before a '.' that do not end a sentence. */
export const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'no', 'fig', 'inc', 'ltd', 'co', 'approx', 'dept', 'est', 'vol', 'ca'])
