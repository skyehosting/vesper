/**
 * Runtime parity guard (07 E6): `npm test` runs vitest on Electron's own Node (ELECTRON_RUN_AS_NODE=1), so node:sqlite,
 * crypto and N-API behave as in the product. When the suite is started that way, the forked workers must really be
 * Electron; a plain-Node run (`npm run test:node`, `npx vitest`) skips this check instead of failing.
 */
import { describe, expect, it } from 'vitest'

const onElectron = !!process.env.ELECTRON_RUN_AS_NODE

describe('runtime', () => {
  it.skipIf(!onElectron)('runs on Electron 44 Node with SQLite 3.53.4 and FTS5', async () => {
    expect(process.versions.electron, 'vitest workers are not Electron processes').toBeTruthy()
    expect(process.versions.electron?.split('.')[0]).toBe('44')
    expect(process.versions.sqlite).toBe('3.53.4')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61 remove_diacritics 2'); INSERT INTO t VALUES ('café au lait')")
    expect(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'cafe'").get()).toEqual({ n: 1 })
    db.close()
  })

  it.runIf(!onElectron)('notes that the parity check is skipped on plain Node', () => {
    console.info(`runtime.test: ELECTRON_RUN_AS_NODE is not set, running on plain Node ${process.version}; Electron parity not checked (use npm test)`)
    expect(process.versions.node).toBeTruthy()
  })
})
