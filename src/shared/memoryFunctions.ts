/**
 * The memory functions the AI can call (R9; 07 C1, C13). One definition generates the native tool JSON schemas AND the
 * bracket-syntax documentation in protocols.md, so the two can't drift. These are compile-time constants: never
 * template them from Settings (the tool set must not change during an epoch). Bump TOOLS_VERSION on any change.
 */
import type { MemoryFunctionName } from './types/wire'

export const TOOLS_VERSION = 1

export interface FunctionParam {
  name: string
  type: 'string' | 'integer'
  description: string
  enum?: readonly string[]
  required?: boolean
}

export interface MemoryFunctionDef {
  name: MemoryFunctionName
  description: string
  params: readonly FunctionParam[]
  /** Example call in bracket syntax (text mode). */
  example: string
}

export const MEMORY_FUNCTIONS: readonly MemoryFunctionDef[] = [
  {
    name: 'memory_search',
    description:
      'Search earlier conversations for what the user may be referring to, or to check whether something was discussed before. Results carry who said it, when, and how long ago.',
    params: [
      { name: 'query', type: 'string', description: 'What to look for, in plain words.', required: true },
      { name: 'scope', type: 'string', description: 'this = this conversation only; linked = this and linked conversations; all = every conversation you may access. Default: what this conversation may access.', enum: ['this', 'linked', 'all'] },
      { name: 'after', type: 'string', description: 'Only messages on or after this date (YYYY-MM-DD).' },
      { name: 'before', type: 'string', description: 'Only messages before this date (YYYY-MM-DD).' },
      { name: 'limit', type: 'integer', description: 'Maximum results (1–10, default 8).' }
    ],
    example: '[memory_search query="the trip we planned to Lisbon" scope="all"]'
  },
  {
    name: 'memory_recall',
    description:
      "Bring back part of a specific earlier conversation by its ID (like #K7Q2MX) — usually one the user linked or named, or one memory_search pointed to. Without query or around it returns that conversation's most recent messages.",
    params: [
      { name: 'session', type: 'string', description: 'The conversation ID, e.g. #K7Q2MX.', required: true },
      { name: 'query', type: 'string', description: 'Optional focus within that conversation.' },
      { name: 'around', type: 'string', description: 'Optional date (YYYY-MM-DD) to centre on.' },
      { name: 'last', type: 'integer', description: 'How many messages (1–40, default 20).' }
    ],
    example: '[memory_recall session="#K7Q2MX" last="20"]'
  },
  {
    name: 'memory_sessions',
    description: 'List or search the conversations you may access (ID, title, dates, short summary) when you need to find which conversation something was in.',
    params: [{ name: 'query', type: 'string', description: 'Optional words to match titles and summaries.' }],
    example: '[memory_sessions query="recipes"]'
  }
]

/** JSON Schema for one function's input (strict-compatible: additionalProperties false). */
export function functionJsonSchema(def: MemoryFunctionDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const p of def.params) {
    properties[p.name] = { type: p.type, description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}) }
  }
  return {
    type: 'object',
    properties,
    required: def.params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false
  }
}

/** Markdown documentation of the functions in bracket syntax (inserted into protocols.md text mode). */
export function functionDocsText(): string {
  return MEMORY_FUNCTIONS.map((f) => {
    const params = f.params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(' ')
    const lines = f.params.map((p) => `  - \`${p.name}\`${p.required ? ' (required)' : ''}: ${p.description}`)
    return `\`${f.example}\`\n- ${f.description}\n- Parameters (${params}):\n${lines.join('\n')}`
  }).join('\n\n')
}

/** Markdown documentation for native mode (the model sees real tool definitions; this explains when to use them). */
export function functionDocsNative(): string {
  return MEMORY_FUNCTIONS.map((f) => `- \`${f.name}\`: ${f.description}`).join('\n')
}
