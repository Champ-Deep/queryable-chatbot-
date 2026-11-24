// Uniform SQL access over Durable Object SQLite (ctx.storage.sql) and, in tests,
// over node:sqlite. One statement per call; "?" placeholders.

/** Wrap a Durable Object's ctx.storage.sql. */
export function doDb(sql) {
  return {
    all: (query, ...params) => sql.exec(query, ...params).toArray(),
    one: (query, ...params) => sql.exec(query, ...params).toArray()[0] ?? null,
    run: (query, ...params) => {
      sql.exec(query, ...params);
    },
  };
}
