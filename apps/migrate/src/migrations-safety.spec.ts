/**
 * Migration safety gate: a review-time lint over migrations/*.sql.
 *
 * A migration runs while the previous release still serves traffic, so DDL
 * that breaks the old code or locks a busy table for the length of a build is
 * flagged. A file that has been read and judged safe opts out with a line
 * `-- migration-safety: reviewed` — coarse on purpose: a reviewer who sees it
 * on a PR knows to read the SQL.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { loadMigrations } from "./migrate.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "migrations");
const REVIEWED = "-- migration-safety: reviewed";

interface Rule {
  name: string;
  /** Anchored at line start, so the same words in a comment do not match. */
  pattern: RegExp;
  why: string;
}

const RULES: Rule[] = [
  {
    name: "DROP COLUMN",
    pattern: /^\s*ALTER\s+TABLE\s[^;]*?\bDROP\s+COLUMN\b/imu,
    why: "the running release still reads it — stop using it in one release, drop it in the next",
  },
  {
    name: "RENAME COLUMN",
    pattern: /^\s*ALTER\s+TABLE\s[^;]*?\bRENAME\s+COLUMN\b/imu,
    why: "the running release reads the old name — add new, dual-write, switch reads, drop old",
  },
  {
    name: "DROP TABLE",
    pattern: /^\s*DROP\s+TABLE\b/imu,
    why: "the running release still reads it — drop it a release after the code stops using it",
  },
  {
    name: "ALTER COLUMN TYPE without USING",
    pattern:
      /^\s*ALTER\s+TABLE\s[^;]*?\bALTER\s+COLUMN\s+(?:"[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b(?![^;]*\bUSING\b)/imu,
    why: "an implicit cast can truncate or fail on existing rows — make it explicit with USING",
  },
  {
    name: "SET NOT NULL",
    pattern: /^\s*ALTER\s+TABLE\s[^;]*?\bALTER\s+COLUMN\s+(?:"[^"]+"|\w+)\s+SET\s+NOT\s+NULL\b/imu,
    why: "fails on existing NULLs and scans the table under a lock — backfill first",
  },
  {
    name: "CREATE INDEX without CONCURRENTLY",
    // An index on a table this same file creates is harmless (it is empty);
    // see existingTableIndexes().
    pattern: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b(?![^;]*\bCONCURRENTLY\b)/imu,
    why:
      "blocks writes for the whole build — use CONCURRENTLY, alone in a file headed " +
      "`-- migrate: no-transaction`",
  },
];

/** Tables created in this SQL — an index on one of them needs no CONCURRENTLY. */
function createdTables(sql: string): Set<string> {
  const names = sql.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gimu);
  return new Set([...names].map((m) => (m[1] ?? "").toLowerCase()));
}

/** Rule names `sql` violates. */
function findings(sql: string): string[] {
  const fresh = createdTables(sql);
  return RULES.filter(({ name, pattern }) => {
    if (name !== "CREATE INDEX without CONCURRENTLY") return pattern.test(sql);
    // Only indexes on a table that already existed count.
    const indexes = sql.matchAll(
      /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b(?![^;]*\bCONCURRENTLY\b)[^;]*?\bON\s+(?:ONLY\s+)?"?(\w+)"?/gimu,
    );
    return [...indexes].some((m) => !fresh.has((m[1] ?? "").toLowerCase()));
  }).map((r) => r.name);
}

/** Statements in `sql`, comments and blank fragments aside (no dollar-quoting in our files). */
function statementCount(sql: string): number {
  return sql
    .replaceAll(/--[^\n]*/gu, "")
    .split(";")
    .filter((s) => s.trim() !== "").length;
}

describe("migration safety gate", () => {
  meta({
    epic: "nodejs-basics",
    feature: "migrations",
    owner: "@team-platform",
    tags: ["migrate"],
  });
  const migrations = loadMigrations(MIGRATIONS);

  it("no risky DDL unless the file is marked reviewed", async () => {
    await testCase("NB-913", "risky migrations need an explicit review mark");
    expect(migrations.length).toBeGreaterThan(0);
    const problems = migrations
      .filter((m) => !m.sql.includes(REVIEWED))
      .flatMap((m) =>
        findings(m.sql).map((name) => {
          const why = RULES.find((r) => r.name === name)?.why ?? "";
          return `${m.version}_${m.name}.sql: ${name} — ${why} (or add "${REVIEWED}")`;
        }),
      );
    expect(problems).toEqual([]);
  });

  it("a no-transaction migration holds exactly one statement", async () => {
    await testCase("NB-914", "no-transaction migrations are single statements");
    // pg's simple query protocol runs a multi-statement string as ONE implicit
    // transaction — CONCURRENTLY would fail there exactly as inside BEGIN.
    const multi = migrations
      .filter((m) => !m.transactional && statementCount(m.sql) !== 1)
      .map((m) => `${m.version}_${m.name}.sql`);
    expect(multi).toEqual([]);
  });

  it.each([
    { sql: "ALTER TABLE t ADD COLUMN c JSONB;", hits: [] },
    { sql: "ALTER TABLE t ADD COLUMN n INT NOT NULL DEFAULT 0;", hits: [] },
    { sql: "ALTER TABLE t DROP COLUMN c;", hits: ["DROP COLUMN"] },
    { sql: 'ALTER TABLE "t" RENAME COLUMN a TO b;', hits: ["RENAME COLUMN"] },
    { sql: "DROP TABLE t;", hits: ["DROP TABLE"] },
    { sql: "ALTER TABLE t ALTER COLUMN c TYPE JSONB;", hits: ["ALTER COLUMN TYPE without USING"] },
    { sql: "ALTER TABLE t ALTER COLUMN c TYPE JSONB USING c::jsonb;", hits: [] },
    { sql: "ALTER TABLE t ALTER COLUMN c SET NOT NULL;", hits: ["SET NOT NULL"] },
    { sql: "CREATE INDEX i ON t (c);", hits: ["CREATE INDEX without CONCURRENTLY"] },
    { sql: "CREATE UNIQUE INDEX i ON t (c);", hits: ["CREATE INDEX without CONCURRENTLY"] },
    { sql: "CREATE INDEX CONCURRENTLY i ON t (c);", hits: [] },
    { sql: "CREATE TABLE t (c INT);\nCREATE INDEX i ON t (c);", hits: [] },
    { sql: "-- DROP TABLE t;\nSELECT 1;", hits: [] },
  ])("pattern: $sql → $hits", async ({ sql, hits }) => {
    await testCase("NB-915", "migration safety patterns match what they should");
    expect(findings(sql)).toEqual(hits);
  });
});
