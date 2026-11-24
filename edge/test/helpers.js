// Test helpers: an in-memory SQLite db with the same interface as doDb(), fixtures, pages.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

export function memoryDb() {
  const db = new DatabaseSync(":memory:");
  const norm = (params) => params.map((p) => (typeof p === "boolean" ? Number(p) : p));
  return {
    all: (q, ...p) => db.prepare(q).all(...norm(p)).map((r) => ({ ...r })),
    one: (q, ...p) => {
      const r = db.prepare(q).get(...norm(p));
      return r ? { ...r } : null;
    },
    run: (q, ...p) => {
      db.prepare(q).run(...norm(p));
    },
  };
}

export function fixture(name) {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
}

export const PAGES = {
  index: readFileSync(join(ROOT, "personal", "static", "index.html"), "utf8"),
  lab: readFileSync(join(ROOT, "champions", "static", "lab.html"), "utf8"),
};

export const PUBLIC = "https://champions-a2a.example.workers.dev";
export const CLIENT_SECRET = "test-client-secret-not-the-demo-one";
export const LAB_PASSWORD = "test-lab-password";

export function basic(user, password) {
  return { Authorization: "Basic " + btoa(`${user}:${password}`) };
}
