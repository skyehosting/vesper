/**
 * Migration 3 (memory): `vectors` becomes a rowid table. Same columns, same primary key (now a unique index).
 *
 * Why: in a WITHOUT ROWID table the whole row lives in the index b-tree, whose largest local payload on a 4 KiB page
 * is ~1,000 bytes — so every 1 KiB int8 vector spilled into its own 4 KiB overflow page (measured: 4.5 KiB per vector,
 * one overflow page each; 1M vectors ≈ 4.4 GB). A rowid table keeps rows up to ~4 KiB inline: ~1.1 KiB per vector
 * and one page read fewer per rescored candidate. The data is copied, so existing vectors survive (in practice the
 * table is empty or small when this runs: memory shipped with this migration).
 */
import type { Db, Migration } from '../sqlite'

export const m003Memory: Migration = {
  version: 3,
  name: 'memory',
  up(db: Db) {
    db.exec(`
      CREATE TABLE vectors_rowid (
        message_id INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        gen INTEGER NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        v BLOB NOT NULL,
        PRIMARY KEY (message_id, chunk, gen)
      );
      INSERT INTO vectors_rowid (message_id, chunk, gen, model, dim, v) SELECT message_id, chunk, gen, model, dim, v FROM vectors;
      DROP TABLE vectors;
      ALTER TABLE vectors_rowid RENAME TO vectors;
    `)
  }
}
