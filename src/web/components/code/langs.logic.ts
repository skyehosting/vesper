/**
 * Fence-name normalisation for the code highlighter: "ts" → typescript, "sh" → shellscript, "c#" → csharp; unknown
 * or plain-text names → null (render unhighlighted). Also the human label shown in the code block header.
 */

export const SUPPORTED_LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'jsonc', 'python', 'shellscript', 'powershell', 'bat', 'html', 'css',
  'scss', 'markdown', 'yaml', 'toml', 'ini', 'xml', 'csv', 'sql', 'graphql', 'rust', 'go', 'java', 'kotlin', 'scala',
  'swift', 'objective-c', 'c', 'cpp', 'csharp', 'php', 'ruby', 'lua', 'perl', 'r', 'dart', 'zig', 'haskell', 'elixir',
  'vue', 'svelte', 'diff', 'dockerfile', 'make', 'cmake', 'nginx', 'latex', 'regex'
] as const

export type SupportedLang = (typeof SUPPORTED_LANGS)[number]

const ALIASES: Record<string, SupportedLang> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', python3: 'python', py3: 'python',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', shellsession: 'shellscript',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  cmd: 'bat', batch: 'bat',
  htm: 'html', xhtml: 'html', svg: 'xml', plist: 'xml',
  md: 'markdown', mdx: 'markdown',
  yml: 'yaml',
  cfg: 'ini', conf: 'ini', properties: 'ini',
  gql: 'graphql',
  rs: 'rust', golang: 'go', kt: 'kotlin', kts: 'kotlin',
  objc: 'objective-c', 'obj-c': 'objective-c',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp', h: 'c',
  cs: 'csharp', 'c#': 'csharp',
  rb: 'ruby', pl: 'perl', ex: 'elixir', exs: 'elixir', hs: 'haskell',
  docker: 'dockerfile', makefile: 'make', mk: 'make',
  tex: 'latex', patch: 'diff', regexp: 'regex'
}

const LABELS: Partial<Record<SupportedLang, string>> = {
  javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON', jsonc: 'JSON', python: 'Python',
  shellscript: 'Shell', powershell: 'PowerShell', bat: 'Batch', html: 'HTML', css: 'CSS', scss: 'SCSS', markdown: 'Markdown',
  yaml: 'YAML', toml: 'TOML', ini: 'INI', xml: 'XML', csv: 'CSV', sql: 'SQL', graphql: 'GraphQL', rust: 'Rust', go: 'Go',
  java: 'Java', kotlin: 'Kotlin', scala: 'Scala', swift: 'Swift', 'objective-c': 'Objective-C', c: 'C', cpp: 'C++',
  csharp: 'C#', php: 'PHP', ruby: 'Ruby', lua: 'Lua', perl: 'Perl', r: 'R', dart: 'Dart', zig: 'Zig', haskell: 'Haskell',
  elixir: 'Elixir', vue: 'Vue', svelte: 'Svelte', diff: 'Diff', dockerfile: 'Dockerfile', make: 'Makefile', cmake: 'CMake',
  nginx: 'nginx', latex: 'LaTeX', regex: 'Regex'
}

const KNOWN = new Set<string>(SUPPORTED_LANGS)

/** Fence info string ("ts title=x.ts", "{.python}", "Python") → a supported grammar, or null for plain text. */
export function normalizeLang(info: string | null | undefined): SupportedLang | null {
  if (!info) return null
  const first = info.trim().split(/[\s{},]+/).filter(Boolean)[0] ?? ''
  const name = first.replace(/^\.|^language-/, '').toLowerCase()
  if (KNOWN.has(name)) return name as SupportedLang
  return ALIASES[name] ?? null
}

/** Header label: the language's proper name, or the fence text as written (e.g. "text", "prisma"). */
export function langLabel(info: string | null | undefined): string {
  const lang = normalizeLang(info)
  if (lang) return LABELS[lang] ?? lang
  const raw = (info ?? '').trim().split(/\s+/)[0] ?? ''
  return raw && raw.length <= 24 ? raw : 'Text'
}
