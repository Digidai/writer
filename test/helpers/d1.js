// A D1-shaped wrapper over node:sqlite, so tests can run the real
// migrations and the real SQL instead of matching query strings.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

export function createTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  }
  return wrap(db);
}

function wrap(db) {
  return {
    raw: db,
    prepare(sql) {
      return statement(db, sql, []);
    },
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    // Test conveniences, not part of the D1 surface.
    all(sql, ...binds) {
      return db.prepare(sql).all(...normalize(binds)).map((row) => ({ ...row }));
    },
    get(sql, ...binds) {
      const row = db.prepare(sql).get(...normalize(binds));
      return row ? { ...row } : null;
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}

function statement(db, sql, binds) {
  return {
    bind(...args) {
      return statement(db, sql, args);
    },
    async first(column) {
      const row = db.prepare(sql).get(...normalize(binds));
      if (!row) return null;
      const plain = { ...row };
      return column ? plain[column] ?? null : plain;
    },
    async all() {
      const results = db.prepare(sql).all(...normalize(binds)).map((row) => ({ ...row }));
      return { success: true, results };
    },
    async run() {
      const info = db.prepare(sql).run(...normalize(binds));
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  };
}

// D1 binds undefined as NULL and booleans as integers; mirror that.
function normalize(values) {
  return values.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}
