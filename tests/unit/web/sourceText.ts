/**
 * Source scanning for copy tests: every .ts/.tsx file under a folder, and the text tokens of a file that could reach
 * the owner (string literals, template pieces, JSX text — comments and module specifiers are not tokens).
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Every user-visible-capable text token of a file: string literals, template pieces, JSX text. */
export function textTokens(source: string, jsx: boolean): string[] {
  const out: string[] = []
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      // Module specifiers are paths, not text.
      if (!(n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isExternalModuleReference(n.parent)))) out.push(n.text)
    } else if (ts.isJsxText(n)) {
      if (n.text.trim()) out.push(n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
