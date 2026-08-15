import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, withLog, withStore as withStoreShared } from "./sqlite.ts";
import type { Hit, Memory, Store } from "./types/rem.types.ts";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorText, header, indent } from "./_render-kit.mjs";

const DIR = join(homedir(), ".pi/agent/rem");
const DB_FILE = "rem.sqlite";
const SCOPE_GLOBAL = "global";

const FUZZY_MIN_OVERLAP = 3;
const FUZZY_MIN_CONTAINMENT = 0.5;
const RECIPROCAL_RANK_K = 60;
const RANK_STRENGTH_FLOOR = 0.4;
const RANK_STRENGTH_GAIN = 0.6;
const DECAY_RATE = 0.02;
const REINFORCE_RATE = 0.05;
const RECALL_K_DEFAULT = 10;
const RECALL_K_MAX = 50;
const ARM_CAP_FACTOR = 2;
const IMPORTANCE_DEFAULT = 0.5;
const REFLECTION_IMPORTANCE = 0.3;
const AUTO_REFLECTION_IMPORTANCE = 0.2;
const KIND_REFLECTION = "reflection";

const ACTION = StringEnum(["learn", "recall", "reflect", "prune"] as const);
const SCOPE_PARAM = StringEnum(["project", "global", "all"] as const);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global') OR length(scope) = 12),
  scope_label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  source TEXT,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  strength REAL NOT NULL CHECK (strength BETWEEN 0 AND 1),
  access_count INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_accessed_at TEXT,
  last_consolidated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  content_md5 TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_content ON memories (scope, content_md5);
CREATE INDEX IF NOT EXISTS memories_scope_created ON memories (scope, created_at);
CREATE TABLE IF NOT EXISTS trigrams (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  gram TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trigrams_gram_idx ON trigrams (gram);
CREATE INDEX IF NOT EXISTS trigrams_memory_idx ON trigrams (memory_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  content,
  tokenize = 'porter unicode61'
);
`;

export function __setFtsAvailable(v: boolean | undefined) {
  ftsOverride = v;
}
let ftsOverride: boolean | undefined;

function dbPath(): string {
  return join(DIR, DB_FILE);
}

function detectFts(db: DatabaseSync): boolean {
  try {
    db.exec(FTS_SCHEMA);
    return true;
  } catch {
    return false;
  }
}

const STORE_OPTS = {
  path: dbPath(),
  schema: SCHEMA,
  policy: "quarantine" as const,
  configure: (db: DatabaseSync) => db.exec("PRAGMA foreign_keys = ON"),
};

function withStore<T>(fn: (store: Store) => T): T {
  return withStoreShared(
    STORE_OPTS,
    (db) => {
      return { db, fts: ftsOverride ?? detectFts(db) };
    },
    fn,
  );
}

export function shortHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function writeScope(scope: string | undefined, cwd: string) {
  if (scope === SCOPE_GLOBAL)
    return { scope: SCOPE_GLOBAL, label: SCOPE_GLOBAL };
  if (scope != null && scope !== "project")
    fail(`scope must be project or global, got '${scope}'`);
  return { scope: shortHash(cwd), label: basename(cwd) || "root" };
}

function readScopes(scope: string | undefined, cwd: string): string[] {
  if (scope === SCOPE_GLOBAL) return [SCOPE_GLOBAL];
  const h = shortHash(cwd);
  return scope === "all" ? [h, SCOPE_GLOBAL] : [h];
}

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function isoNow(): string {
  return new Date().toISOString();
}

function daysBetween(olderIso: string, nowIso: string): number {
  const ms = Date.parse(nowIso) - Date.parse(olderIso);
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return ms / 86400000;
}

function clamp(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function decay(strength: number, days: number): number {
  if (days <= 0) return strength;
  return strength * Math.exp(-DECAY_RATE * days);
}

function reinforce(
  strength: number,
  accessCount: number,
  importance: number,
): number {
  return strength + accessCount * REINFORCE_RATE * importance;
}

function consolidate(
  strength: number,
  days: number,
  accessCount: number,
  importance: number,
): number {
  return clamp(reinforce(decay(strength, days), accessCount, importance));
}

function effectiveStrength(
  m: Pick<
    Memory,
    "strength" | "access_count" | "importance" | "last_consolidated_at"
  >,
  nowIso: string,
): number {
  return consolidate(
    m.strength,
    daysBetween(m.last_consolidated_at, nowIso),
    m.access_count,
    m.importance,
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function gramsOfWord(word: string): string[] {
  const padded = `  ${word}  `;
  const out: string[] = [];
  for (let i = 0; i + 2 < padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

function gramsOf(text: string): string[] {
  const set = new Set<string>();
  for (const word of tokenize(text)) {
    for (const gram of gramsOfWord(word)) set.add(gram);
  }
  return [...set];
}

function insertGrams(db: DatabaseSync, memoryId: number, grams: string[]) {
  const insert = db.prepare(
    "INSERT INTO trigrams (memory_id, gram) VALUES (?, ?)",
  );
  for (const gram of grams) insert.run(memoryId, gram);
}

function ftsQuery(tokens: string[]): string {
  return tokens
    .map((t) => (/^(and|or|not)$/.test(t) ? `"${t}"` : t))
    .join(" AND ");
}

function fail(message: string): never {
  throw new Error(`rem: ${message}`);
}

function semanticArm(
  db: DatabaseSync,
  tokens: string[],
  scopes: string[],
  kind: string | undefined,
  cap: number,
): { memory_id: number; arm: "fts" | "fuzzy"; rank: number }[] {
  if (!tokens.length) return [];
  const rows = db
    .prepare(
      `SELECT mf.rowid AS memory_id FROM memory_fts mf
       JOIN memories m ON m.id = mf.rowid
       WHERE memory_fts MATCH ?
         AND m.scope IN (${scopes.map(() => "?").join(",")})
         AND (? IS NULL OR m.kind = ?)
       ORDER BY rank ASC LIMIT ?`,
    )
    .all(ftsQuery(tokens), ...scopes, kind ?? null, kind ?? null, cap) as {
    memory_id: number;
  }[];
  return rows.map((r, i) => ({
    memory_id: r.memory_id,
    arm: "fts" as const,
    rank: i + 1,
  }));
}

function fuzzyArm(
  db: DatabaseSync,
  grams: string[],
  scopes: string[],
  kind: string | undefined,
  cap: number,
): { memory_id: number; arm: "fts" | "fuzzy"; rank: number }[] {
  if (!grams.length) return [];
  const minOverlap = Math.max(
    FUZZY_MIN_OVERLAP,
    Math.ceil(FUZZY_MIN_CONTAINMENT * grams.length),
  );
  const rows = db
    .prepare(
      `SELECT t.memory_id FROM trigrams t
       JOIN memories m ON m.id = t.memory_id
       WHERE t.gram IN (${grams.map(() => "?").join(",")})
         AND m.scope IN (${scopes.map(() => "?").join(",")})
         AND (? IS NULL OR m.kind = ?)
       GROUP BY t.memory_id
       HAVING COUNT(*) >= ?
       ORDER BY COUNT(*) DESC LIMIT ?`,
    )
    .all(...grams, ...scopes, kind ?? null, kind ?? null, minOverlap, cap) as {
    memory_id: number;
  }[];
  return rows.map((r, i) => ({
    memory_id: r.memory_id,
    arm: "fuzzy" as const,
    rank: i + 1,
  }));
}

function fuse(
  arms: { memory_id: number; arm: "fts" | "fuzzy"; rank: number }[][],
): Map<number, { score: number; match: "fts" | "fuzzy" | "both" }> {
  const fused = new Map<
    number,
    { score: number; match: "fts" | "fuzzy" | "both" }
  >();
  for (const arm of arms) {
    for (const hit of arm) {
      const prev = fused.get(hit.memory_id);
      const contribution = 1 / (RECIPROCAL_RANK_K + hit.rank);
      if (prev) {
        prev.score += contribution;
        prev.match = "both";
      } else {
        fused.set(hit.memory_id, { score: contribution, match: hit.arm });
      }
    }
  }
  return fused;
}

function hydrate(db: DatabaseSync, ids: number[]): Map<number, Memory> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Memory[];
  return new Map(rows.map((r) => [r.id, r]));
}

function recallScoped(
  store: Store,
  opts: {
    query: string | undefined;
    kind: string | undefined;
    scopes: string[];
    k: number;
    includeSuperseded: boolean;
    nowIso: string;
  },
): Hit[] {
  const { db } = store;
  const { query, kind, scopes, k, includeSuperseded, nowIso } = opts;
  if (!query || !query.trim()) return browse(db, scopes, kind, k, nowIso);

  const cap = k * ARM_CAP_FACTOR;
  const tokens = tokenize(query);
  const arms: { memory_id: number; arm: "fts" | "fuzzy"; rank: number }[][] =
    [];
  if (store.fts) arms.push(semanticArm(db, tokens, scopes, kind, cap));
  const grams = gramsOf(query);
  arms.push(fuzzyArm(db, grams, scopes, kind, cap));
  const fused = fuse(arms);
  if (!fused.size) return [];

  const rows = hydrate(db, [...fused.keys()]);
  const scored: Hit[] = [];
  for (const [id, f] of fused) {
    const row = rows.get(id);
    if (!row) continue;
    const eff = effectiveStrength(row, nowIso);
    scored.push({
      ...row,
      effective_strength: eff,
      match: f.match,
    });
  }
  const blend = (h: Hit) =>
    fused.get(h.id)!.score *
    (RANK_STRENGTH_FLOOR + RANK_STRENGTH_GAIN * h.effective_strength);
  const live = scored
    .filter((h) => h.superseded_by == null)
    .sort((a, b) => blend(b) - blend(a));
  const superseded = scored
    .filter((h) => h.superseded_by != null)
    .sort((a, b) => blend(b) - blend(a));
  const top = live.slice(0, k);
  if (includeSuperseded) top.push(...superseded.slice(0, k - top.length));
  return top.slice(0, k);
}

function browse(
  db: DatabaseSync,
  scopes: string[],
  kind: string | undefined,
  k: number,
  nowIso: string,
): Hit[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE scope IN (${scopes.map(() => "?").join(",")})
         AND (? IS NULL OR kind = ?)
       ORDER BY created_at DESC LIMIT ${k * ARM_CAP_FACTOR}`,
    )
    .all(...scopes, kind ?? null, kind ?? null) as Memory[];
  const hits: Hit[] = rows.map((r) => ({
    ...r,
    effective_strength: effectiveStrength(r, nowIso),
    match: "browse",
  }));
  return hits
    .sort((a, b) => b.effective_strength - a.effective_strength)
    .slice(0, k);
}

function storeMemory(
  store: Store,
  input: {
    content: string;
    kind: string;
    importance: number;
    scope: string;
    scope_label: string;
    source: string | null;
  },
): { row: Memory; existing: boolean } {
  const { db, fts } = store;
  const digest = md5(input.content);
  const existing = db
    .prepare("SELECT * FROM memories WHERE scope = ? AND content_md5 = ?")
    .get(input.scope, digest) as Memory | undefined;
  if (existing) {
    return { row: existing, existing: true };
  }
  const strength = clamp(input.importance);
  const insert = db.prepare(
    `INSERT INTO memories
       (scope, scope_label, kind, content, source, importance, strength, content_md5)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const appended = insert.run(
    input.scope,
    input.scope_label,
    input.kind,
    input.content,
    input.source,
    input.importance,
    strength,
    digest,
  );
  const id = Number(appended.lastInsertRowid);
  insertGrams(db, id, gramsOf(input.content));
  if (fts) {
    db.prepare("INSERT INTO memory_fts (rowid, content) VALUES (?, ?)").run(
      id,
      input.content,
    );
  }
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as Memory;
  return { row, existing: false };
}

function renderMemory(m: Memory): string {
  const strength = effectiveStrength(m, isoNow()).toFixed(2);
  return `m${m.id} [${strength}] ${m.scope_label} · ${m.kind}`;
}

function renderHits(hits: Hit[]): string {
  return hits
    .map((h) => {
      const head = renderMemory(h);
      const tag =
        h.superseded_by != null ? ` · superseded by m${h.superseded_by}` : "";
      const body = indent(h.content);
      return `${head}${tag}\n${body}`;
    })
    .join("\n");
}

const render = (hits: Hit[]): string =>
  hits.length ? renderHits(hits) : "(no memories)";

export default function remExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rem",
    label: "Rem",
    description:
      "Memory tool: learn commits facts and constraints idempotently; recall fetches past " +
      "solutions by intent (fuzzy/semantic search, project-scoped first with global fill); " +
      "reflect stores a distilled memory with its raw source; prune consolidates the strength " +
      "arithmetic or removes/reduces memories. Scopes: 'global' for general knowledge, default " +
      "project (cwd). Recall k caps live hits; no query = browse. Ids are minted mN; copy, " +
      "never invent.",
    promptSnippet:
      "Commit facts, recall past solutions, reflect logs, prune memories",
    promptGuidelines: [
      "memories persist across sessions; scope='global' for general knowledge, default is the current project (cwd).",
      "learn is idempotent on content; re-learn to update importance or supersede a stale memory.",
      "recall by intent; k caps live hits (default 10, max 50); no query = browse latest.",
      "reflect stores your distilled memory + raw source; source is provenance, never searched.",
      "prune consolidate decays strength (idempotent); remove/reduce need ids or criteria.",
      "ids are minted mN; copy, never invent.",
    ],
    parameters: Type.Object({
      action: ACTION,
      content: Type.Optional(
        Type.String({ description: "Memory content (learn/reflect)" }),
      ),
      query: Type.Optional(
        Type.String({ description: "Recall intent; omit to browse" }),
      ),
      source: Type.Optional(
        Type.String({ description: "Raw source log for provenance (reflect)" }),
      ),
      kind: Type.Optional(
        Type.String({
          description: "Free-form kind label; reuse consistently",
        }),
      ),
      importance: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 1,
          description: "0..1; strength starts here and decays",
        }),
      ),
      scope: Type.Optional(SCOPE_PARAM),
      k: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: RECALL_K_MAX,
          description: "Live-hit budget (recall)",
        }),
      ),
      verb: Type.Optional(
        StringEnum(["remove", "reduce", "consolidate"] as const),
      ),
      ids: Type.Optional(
        Type.Array(Type.Integer({ description: "Memory ids to prune" })),
      ),
      older_than_days: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Selection criterion for prune",
        }),
      ),
      supersedes: Type.Optional(
        Type.Union([Type.Integer(), Type.Array(Type.Integer())]),
      ),
      include_superseded: Type.Optional(
        Type.Boolean({
          description: "Fill unused budget with superseded hits",
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      const detail =
        typeof args?.action === "string"
          ? theme.fg(
              "text",
              [args.action, args.k ? `k=${args.k}` : undefined]
                .filter(Boolean)
                .join(" "),
            )
          : undefined;
      return header(theme, ctx, "rem", detail);
    },
    renderResult(result, _options, theme, _ctx) {
      if (result.isError) return errorText(theme, result);
      const d =
        (result.details as { hits?: Hit[]; memories?: Memory[] } | undefined) ??
        {};
      if (d.hits) return new Text(indent(render(d.hits)), 0, 0);
      if (d.memories?.length) {
        const rows = d.memories.map(
          (m) => `${renderMemory(m)}\n${indent(m.content)}`,
        );
        return new Text(indent(rows.join("\n")), 0, 0);
      }
      // prune summaries: the reply text is the display
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      return new Text(indent(text), 0, 0);
    },
    async execute(_toolCallId, params: any) {
      return withLog(() =>
        withStore((store) => {
          const { db } = store;
          const action = params.action;
          const cwd = process.cwd();

          if (action === "recall") {
            const k = Math.min(params.k ?? RECALL_K_DEFAULT, RECALL_K_MAX);
            const nowIso = isoNow();
            const includeSuperseded = params.include_superseded === true;
            const opts = {
              query: params.query,
              kind: params.kind,
              k,
              includeSuperseded,
              nowIso,
            };
            let hits: Hit[];
            if (params.scope === "all" || params.scope === SCOPE_GLOBAL) {
              hits = recallScoped(store, {
                ...opts,
                scopes: readScopes(params.scope, cwd),
              });
            } else {
              // hybrid default: project scope first, global fills unused budget
              hits = recallScoped(store, {
                ...opts,
                scopes: readScopes("project", cwd),
              });
              if (hits.length < k) {
                const fill = recallScoped(store, {
                  ...opts,
                  scopes: [SCOPE_GLOBAL],
                  k: k - hits.length,
                });
                hits = hits.concat(fill).slice(0, k);
              }
            }
            if (hits.length) {
              const touch = db.prepare(
                `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?
                 WHERE id IN (${hits.map(() => "?").join(",")})`,
              );
              touch.run(nowIso, ...hits.map((h) => h.id));
            }
            return {
              content: [
                {
                  type: "text",
                  text: `recall: ${hits.length} memories\n${render(hits)}`,
                },
              ],
              details: { action, hits },
            };
          }

          if (action === "learn") {
            const content =
              params.content ?? fail("action 'learn' requires content");
            const scope = writeScope(params.scope, cwd);
            const { row, existing } = storeMemory(store, {
              content,
              kind: params.kind ?? "fact",
              importance: params.importance ?? IMPORTANCE_DEFAULT,
              scope: scope.scope,
              scope_label: scope.label,
              source: null,
            });
            if (params.supersedes != null) {
              applySupersedes(db, row.id, params.supersedes);
            }
            if (existing) {
              let note = `already known m${row.id}`;
              if (params.importance != null) {
                db.prepare(
                  "UPDATE memories SET importance = ? WHERE id = ?",
                ).run(params.importance, row.id);
                note += ` · importance → ${params.importance}`;
              }
              const fresh = db
                .prepare("SELECT * FROM memories WHERE id = ?")
                .get(row.id) as Memory;
              return {
                content: [{ type: "text", text: note }],
                details: { action, memories: [fresh] },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `learned m${row.id} (${row.scope_label} · ${row.kind} · ${row.importance})`,
                },
              ],
              details: { action, memories: [row] },
            };
          }

          if (action === "reflect") {
            const content =
              params.content ?? fail("action 'reflect' requires content");
            const scope = writeScope(params.scope, cwd);
            const { row, existing } = storeMemory(store, {
              content,
              kind: KIND_REFLECTION,
              importance: params.importance ?? REFLECTION_IMPORTANCE,
              scope: scope.scope,
              scope_label: scope.label,
              source: params.source ?? null,
            });
            if (existing) {
              let note = `already known m${row.id}`;
              if (params.importance != null) {
                db.prepare(
                  "UPDATE memories SET importance = ? WHERE id = ?",
                ).run(params.importance, row.id);
                note += ` · importance → ${params.importance}`;
              }
              if (params.source != null && params.source !== row.source) {
                db.prepare("UPDATE memories SET source = ? WHERE id = ?").run(
                  params.source,
                  row.id,
                );
                note += " · source updated";
              }
              const fresh = db
                .prepare("SELECT * FROM memories WHERE id = ?")
                .get(row.id) as Memory;
              return {
                content: [{ type: "text", text: note }],
                details: { action, memories: [fresh] },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `reflected m${row.id} (${row.scope_label} · ${row.kind} · ${row.importance})`,
                },
              ],
              details: { action, memories: [row] },
            };
          }

          if (action === "prune") {
            const verb =
              params.verb ??
              fail("prune requires verb remove|reduce|consolidate");
            const sel = {
              ids: params.ids,
              scope: params.scope,
              kind: params.kind,
              older_than_days: params.older_than_days,
              cwd,
            };
            if (verb === "consolidate") {
              const consolidated = consolidatePass(db, sel);
              return {
                content: [
                  {
                    type: "text",
                    text: `consolidated ${consolidated} memories`,
                  },
                ],
                details: { action, consolidated },
              };
            }
            const ids = selectIds(db, sel);
            if (verb === "remove") {
              const removed = removeMemories(store, ids);
              return {
                content: [{ type: "text", text: `removed ${removed}` }],
                details: { action, removed },
              };
            }
            const importance =
              params.importance ??
              fail("reduce needs an importance to lower to");
            const reduced = reduceImportance(db, ids, importance);
            return {
              content: [
                {
                  type: "text",
                  text: `reduced ${reduced.length} to ${importance}`,
                },
              ],
              details: { action, reduced: reduced.map((r) => r.id) },
            };
          }

          fail(`action '${action}' not implemented`);
        }),
      );
    },
  });

  pi.on("session_compact", (event: any, ctx: any) => {
    const summary = event?.compactionEntry?.summary;
    if (typeof summary !== "string" || !summary.trim()) return;
    return withLog(() => {
      try {
        withStore((store) => {
          const cwd = ctx?.cwd ?? process.cwd();
          const scope = writeScope(undefined, cwd);
          storeMemory(store, {
            content: summary,
            kind: KIND_REFLECTION,
            importance: AUTO_REFLECTION_IMPORTANCE,
            scope: scope.scope,
            scope_label: scope.label,
            source: "session compaction",
          });
        });
      } catch {
        /* never crash a session over a memory store */
      }
    });
  });
}

function applySupersedes(
  db: DatabaseSync,
  byId: number,
  targets: number | number[],
) {
  const raw = Array.isArray(targets) ? targets : [targets];
  const uniq = [...new Set(raw)].filter((id) => id !== byId);
  if (!uniq.length) return;
  const rows = db
    .prepare(
      `SELECT id FROM memories WHERE id IN (${uniq.map(() => "?").join(",")})`,
    )
    .all(...uniq) as { id: number }[];
  const found = new Set(rows.map((r) => r.id));
  for (const id of uniq) {
    if (!found.has(id)) fail(`supersedes target m${id} not found`);
  }
  const update = db.prepare(
    "UPDATE memories SET superseded_by = ? WHERE id = ?",
  );
  for (const id of uniq) update.run(byId, id);
}

function consolidatePass(
  db: DatabaseSync,
  sel: {
    ids: number[] | undefined;
    scope: string | undefined;
    kind: string | undefined;
    older_than_days: number | undefined;
    cwd: string;
  },
): number {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const ids =
    Array.isArray(sel.ids) && sel.ids.length
      ? [...new Set(sel.ids)]
      : undefined;
  if (ids) {
    where.push(`id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  } else if (
    sel.kind != null ||
    sel.older_than_days != null ||
    sel.scope != null
  ) {
    const f = filterClause(sel);
    where.push(...f.clauses);
    args.push(...f.args);
  }
  const rows = db
    .prepare(
      `SELECT id, strength, access_count, importance, last_consolidated_at FROM memories` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : ""),
    )
    .all(...args) as Pick<
    Memory,
    "id" | "strength" | "access_count" | "importance" | "last_consolidated_at"
  >[];
  const update = db.prepare(
    "UPDATE memories SET strength = ?, access_count = 0, last_consolidated_at = ? WHERE id = ?",
  );
  const nowIso = isoNow();
  for (const row of rows) {
    const next = consolidate(
      row.strength,
      daysBetween(row.last_consolidated_at, nowIso),
      row.access_count,
      row.importance,
    );
    update.run(next, nowIso, row.id);
  }
  return rows.length;
}

function filterClause(sel: {
  scope: string | undefined;
  kind: string | undefined;
  older_than_days: number | undefined;
  cwd: string;
}): { clauses: string[]; args: (string | number)[] } {
  const scopes = readScopes(sel.scope, sel.cwd);
  const clauses = [`scope IN (${scopes.map(() => "?").join(",")})`];
  const args: (string | number)[] = [...scopes];
  if (sel.kind != null) {
    clauses.push("kind = ?");
    args.push(sel.kind);
  }
  if (sel.older_than_days != null) {
    clauses.push("created_at < ?");
    args.push(
      new Date(Date.now() - sel.older_than_days * 86400000).toISOString(),
    );
  }
  return { clauses, args };
}

function selectIds(
  db: DatabaseSync,
  sel: {
    ids: number[] | undefined;
    scope: string | undefined;
    kind: string | undefined;
    older_than_days: number | undefined;
    cwd: string;
  },
): number[] {
  if (Array.isArray(sel.ids) && sel.ids.length) return [...new Set(sel.ids)];
  const hasCriteria =
    sel.kind != null || sel.older_than_days != null || sel.scope != null;
  if (!hasCriteria) {
    fail("prune needs ids or criteria (kind/older_than_days/scope)");
  }
  const f = filterClause(sel);
  const rows = db
    .prepare(`SELECT id FROM memories WHERE ${f.clauses.join(" AND ")}`)
    .all(...f.args) as { id: number }[];
  return rows.map((r) => r.id);
}

function removeMemories(store: Store, ids: number[]): number {
  const { db, fts } = store;
  // node:sqlite prepare validates schema eagerly.
  // FTS statement must not even be prepared, or it throws "no such table".
  const delFts = fts
    ? db.prepare("DELETE FROM memory_fts WHERE rowid = ?")
    : null;
  const delGram = db.prepare("DELETE FROM trigrams WHERE memory_id = ?");
  const del = db.prepare("DELETE FROM memories WHERE id = ?");
  let removed = 0;
  for (const id of ids) {
    delFts?.run(id);
    delGram.run(id);
    removed += Number(del.run(id).changes);
  }
  return removed;
}

function reduceImportance(
  db: DatabaseSync,
  ids: number[],
  importance: number,
): Memory[] {
  if (!ids.length) return [];
  const update = db.prepare("UPDATE memories SET importance = ? WHERE id = ?");
  for (const id of ids) update.run(importance, id);
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Memory[];
  return rows;
}
