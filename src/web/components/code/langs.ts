/**
 * Languages the code highlighter knows (fine-grained shiki grammars, each its own lazy chunk — research 03 §5.3) and
 * the fence names that map to them. Anything else renders as plain text. Pure name logic lives in langs.logic.ts.
 */
import type { LanguageRegistration } from 'shiki/core'

type LangModule = { default: LanguageRegistration[] }

export const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  python: () => import('@shikijs/langs/python'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  bat: () => import('@shikijs/langs/bat'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  csv: () => import('@shikijs/langs/csv'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  scala: () => import('@shikijs/langs/scala'),
  swift: () => import('@shikijs/langs/swift'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  r: () => import('@shikijs/langs/r'),
  dart: () => import('@shikijs/langs/dart'),
  zig: () => import('@shikijs/langs/zig'),
  haskell: () => import('@shikijs/langs/haskell'),
  elixir: () => import('@shikijs/langs/elixir'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  make: () => import('@shikijs/langs/make'),
  cmake: () => import('@shikijs/langs/cmake'),
  nginx: () => import('@shikijs/langs/nginx'),
  latex: () => import('@shikijs/langs/latex'),
  regex: () => import('@shikijs/langs/regex')
}
