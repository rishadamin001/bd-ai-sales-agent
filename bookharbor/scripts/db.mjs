import { DatabaseSync } from "node:sqlite";
export function database(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  const wrap = (sql, args = []) => ({
    bind(...values) {
      return wrap(sql, values);
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async first() {
      return sqlite.prepare(sql).get(...args) || null;
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const r = [];
        for (const stmt of statements) r.push(await stmt.run());
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    exec: (sql) => sqlite.exec(sql),
    close: () => sqlite.close(),
  };
}
