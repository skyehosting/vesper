/**
 * fix5-ui P29 (2nd pass): one setting, one name. `desktop.closeToTray` has switches in Settings → General, the wizard's
 * Look step, Settings → Access (the This PC card and the "Closing the window quits Vesper" callout) and the wizard's
 * Access step; every one of them reads the same label as the Settings search catalog. Scans every text token under
 * src/web (the same scanner as the doc-reference test) for a "Keep … running in the tray …" label.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLOSE_TO_TRAY_LABEL, catalogEntry } from '../../../src/web/features/settings/catalog.logic'
import { files, textTokens } from './sourceText'

const ROOT = path.resolve(__dirname, '../../..')

describe('the keep-in-tray switch has one name (P29)', () => {
  it('the catalog (Settings search) uses the shared label', () => {
    expect(catalogEntry('desktop.closeToTray')?.label).toBe(CLOSE_TO_TRAY_LABEL)
  })

  it('no page spells the switch differently', () => {
    const odd: string[] = []
    for (const f of files(path.join(ROOT, 'src/web'))) {
      for (const tok of textTokens(fs.readFileSync(f, 'utf8'), f.endsWith('.tsx'))) {
        const t = tok.trim()
        if (/^keep (vesper )?running in the tray/i.test(t) && t !== CLOSE_TO_TRAY_LABEL) odd.push(`${path.relative(ROOT, f)}: "${t}"`)
      }
    }
    expect(odd).toEqual([])
  })
})
