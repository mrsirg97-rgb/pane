#!/usr/bin/env node
// pane-scheduler runner: the fire engine cron invokes via runner.sh.
// Standalone on purpose: it runs under bare node in a cold cron shell, so it
// inlines the small slice of store/crontab logic it needs instead of importing
// the extension's TypeScript. Deployed as-is to ~/.pi/agent/scheduler/runner.mjs.
//
// Fire: look up the job by key, check GPU busy state (fail closed), run the
// prompt with pi, tee output to a pruned log, record a run event, self-heal
// once/zombie drift. Every outcome is recorded; only unexpected errors exit
// non-zero (cron mails stderr).

import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  op TEXT NOT NULL CHECK (op IN ('create','pause','resume','remove','run','compact')),
  args TEXT NOT NULL,
  session TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  at TEXT,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  busy TEXT NOT NULL CHECK (busy IN ('skip','force')),
  state TEXT NOT NULL CHECK (state IN ('active','paused','done','removed')),
  last_status TEXT CHECK (last_status IN ('ok','fail','skip')),
  last_ts TEXT,
  last_exit INTEGER,
  created_seq INTEGER NOT NULL REFERENCES events(seq),
  updated_seq INTEGER NOT NULL REFERENCES events(seq)
);
`;

const TAG_RE = /^(?<lead>\S.*?)\s+#\s*pane-scheduler:(?<key>\S+)$/;

export function parseKey(key) {
  const cwd = /^cwd-([0-9a-f]{12}):(j\d+)$/.exec(key);
  if (cwd) return { scope: "cwd", hash: cwd[1], id: cwd[2] };
  const global = /^(j\d+)$/.exec(key);
  if (global) return { scope: "global", hash: null, id: global[1] };
  throw new Error(`runner: bad key '${key}'`);
}

export function storePathFor(home, key) {
  const { hash } = parseKey(key);
  return join(home, hash ? `${hash}.sqlite` : "global.sqlite");
}

export function openStore(home, key) {
  const db = new DatabaseSync(storePathFor(home, key));
  db.exec(SCHEMA);
  return db;
}

// ---- crontab line surgery (mirrors extensions/scheduler/crontab.ts) ----

function normalize(text) {
  const t = String(text).replace(/\n+$/, "");
  return t === "" ? "" : `${t}\n`;
}

function findTagIndex(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const m = TAG_RE.exec(lines[i].trimEnd());
    if (m && m.groups.key === key) return i;
  }
  return -1;
}

function hasLine(text, key) {
  const norm = normalize(text);
  if (norm === "") return false;
  return findTagIndex(norm.slice(0, -1).split("\n"), key) !== -1;
}

function removeLine(text, key) {
  const norm = normalize(text);
  const lines = norm === "" ? [] : norm.slice(0, -1).split("\n");
  const idx = findTagIndex(lines, key);
  if (idx === -1) return { text: norm, found: false };
  lines.splice(idx, 1);
  return {
    text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    found: true,
  };
}

// ---- run record ----

function recordRun(db, id, status, extra, nowIso) {
  const args = {
    id,
    status,
    exit: extra.exit ?? null,
    durationMs: extra.durationMs ?? null,
    log: extra.log ?? null,
    reason: extra.reason ?? null,
  };
  db.exec("BEGIN IMMEDIATE");
  const r = db
    .prepare(
      "INSERT INTO events (ts, op, args, session) VALUES (?, 'run', ?, NULL)",
    )
    .run(nowIso, JSON.stringify(args));
  const seq = Number(r.lastInsertRowid);
  db.prepare(
    "UPDATE jobs SET last_status = ?, last_ts = ?, last_exit = ?, updated_seq = ? WHERE id = ?",
  ).run(status, nowIso, args.exit, seq, id);
  db.exec("COMMIT");
  return { args, seq };
}

function pruneLogs(dir, keep = 20) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep)))
    rmSync(join(dir, f));
}

// ---- busy check: llama-swap is the GPU truth ----

export async function busyState(fetch, swapUrl, jobModel) {
  let models;
  let running;
  try {
    models = await fetch(`${swapUrl}/v1/models`);
    running = await fetch(`${swapUrl}/running`);
  } catch (e) {
    return { kind: "error", reason: `busy check failed: ${e.message}` };
  }
  // normalize names: the store keeps pi catalog ids (qwen3.8-workers) while
  // /running reports canonical llama-swap names (qwen3.8-27b-workers)
  const canon = new Map();
  for (const m of models?.data ?? []) {
    const aliases = m?.meta?.llamaswap?.aliases ?? [];
    for (const n of [m.id, ...aliases]) canon.set(n, m.id);
  }
  const norm = (n) => canon.get(n) ?? n;
  const own = norm(jobModel);
  const resident = new Set((running?.running ?? []).map((r) => norm(r.model)));
  if (resident.has(own)) return { kind: "run", reason: null };
  if (resident.size === 0) return { kind: "run", reason: null };
  return { kind: "busy", names: [...resident].join(", ") };
}

// ---- fire ----

export const REPORT_BACK =
  "\n\nReport back: when you finish, persist durable findings with the rem tool (project scope: this job's cwd) and end your reply with a short summary of what you found and did.";

export async function fire(key, opts) {
  const { home, crontab, fetch, spawn, now, piBin, swapUrl } = opts;
  const parsed = parseKey(key);
  const { id } = parsed;
  const scopeDir = parsed.hash ? `cwd-${parsed.hash}` : "global";

  const text = await crontab.list();
  if (!hasLine(text, key)) {
    // cron fires from the line, so this is drift; record loudly, touch nothing
    const db = openStore(home, key);
    try {
      const { args } = recordRun(
        db,
        id,
        "skip",
        { reason: "no crontab line (drift)" },
        now().toISOString(),
      );
      return { status: "skip", reason: args.reason };
    } finally {
      db.close();
    }
  }

  const db = openStore(home, key);
  try {
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) {
      const reason = "no job row (zombie line)";
      recordRun(db, id, "skip", { reason }, now().toISOString());
      await crontab.install(removeLine(text, key).text);
      return { status: "skip", reason };
    }
    if (row.state === "done" || row.state === "removed") {
      const reason =
        row.state === "done"
          ? "job already done (crash between run and line delete)"
          : "job removed (stale line)";
      recordRun(db, id, "skip", { reason }, now().toISOString());
      await crontab.install(removeLine(text, key).text);
      return { status: "skip", reason };
    }
    if (row.state === "paused") {
      const reason = "store says paused (line drifted active)";
      recordRun(db, id, "skip", { reason }, now().toISOString());
      return { status: "skip", reason };
    }

    const st = await busyState(fetch, swapUrl, row.model);
    if (st.kind === "error") {
      recordRun(db, id, "skip", { reason: st.reason }, now().toISOString());
      return { status: "skip", reason: st.reason };
    }
    if (st.kind === "busy" && row.busy !== "force") {
      const reason = `busy: ${st.names} resident (policy skip)`;
      recordRun(db, id, "skip", { reason }, now().toISOString());
      return { status: "skip", reason };
    }

    const t0 = Date.now();
    const res = await spawn(
      [
        piBin,
        "-p",
        row.prompt + REPORT_BACK,
        "--model",
        row.model,
        "--no-session",
      ],
      { cwd: row.cwd },
    );
    const durationMs = Date.now() - t0;

    const dir = join(home, "runs", scopeDir, id);
    mkdirSync(dir, { recursive: true });
    const logName = `${now().toISOString().replace(/[:.]/g, "-")}.log`;
    const logRel = join("runs", scopeDir, id, logName);
    writeFileSync(
      join(dir, logName),
      `# pane-scheduler run\nkey=${key}\nstarted=${now().toISOString()}\nexit=${res.exit}\nduration_ms=${durationMs}\n\n== stdout ==\n${res.stdout}\n\n== stderr ==\n${res.stderr}\n`,
    );
    pruneLogs(dir, 20);

    const status = res.exit === 0 ? "ok" : "fail";
    const rec = recordRun(
      db,
      id,
      status,
      { exit: res.exit, durationMs, log: logRel },
      now().toISOString(),
    );

    if (row.at !== null) {
      // once job: mark done (store first), then consume the line. A crash in
      // between leaves a live line on a done row; the next fire heals it.
      db.prepare(
        "UPDATE jobs SET state = 'done', updated_seq = ? WHERE id = ?",
      ).run(rec.seq, id);
      await crontab.install(removeLine(text, key).text);
    }
    return { status, reason: null };
  } finally {
    db.close();
  }
}

// ---- lock skip (runner.sh flock path) ----

export async function lockSkipRecord(key, opts) {
  const { home, now } = opts;
  const { id } = parseKey(key);
  const db = openStore(home, key);
  try {
    const { args } = recordRun(
      db,
      id,
      "skip",
      { reason: "lock held (previous run still active)" },
      now().toISOString(),
    );
    return { status: "skip", reason: args.reason };
  } finally {
    db.close();
  }
}

// ---- production wiring (cron) ----

function realCrontabShim(bin) {
  return {
    list: () =>
      new Promise((resolveP, reject) => {
        execFile(bin, ["-l"], (err, stdout, stderr) => {
          if (!err) return resolveP(stdout);
          if (err.code === "ENOENT")
            return reject(new Error("crontab: binary not found"));
          const e = String(stderr ?? "").trim();
          if (err.code === 1 && /no crontab for/i.test(e)) return resolveP("");
          // fail closed: a false empty would make the next install wipe every
          // foreign line in the user's crontab
          return reject(
            new Error(
              `crontab list failed (exit ${err.code}): ${e || err.message}`,
            ),
          );
        });
      }),
    install: (text) =>
      new Promise((resolveP, reject) => {
        execFile(bin, ["-"], { input: text }, (err) => {
          if (!err) return resolveP();
          reject(
            new Error(
              `crontab install failed (exit ${err.code}): ${String(err.stderr || err.message).trim()}`,
            ),
          );
        });
      }),
  };
}

function realSpawn(piBin) {
  const timeoutMs = Number(process.env.PANE_RUN_TIMEOUT_MS ?? 1000 * 60 * 30);
  return (argv, { cwd }) =>
    new Promise((resolveP) => {
      execFile(
        argv[0],
        argv.slice(1),
        { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const exit = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          const note = err?.killed
            ? `\n[runner: killed after ${timeoutMs}ms timeout]\n`
            : "";
          resolveP({
            exit,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") + note,
          });
        },
      );
    });
}

async function main() {
  const argv = process.argv.slice(2);
  const lockSkip = argv.includes("--lock-skip");
  const key = argv[0];
  if (!key || !/^(?:cwd-[0-9a-f]{12}:)?j\d+$/.test(key)) {
    console.error("runner.mjs: usage: runner.mjs <key> [--lock-skip]");
    process.exit(2);
  }
  const home =
    process.env.PANE_SCHEDULER_HOME ??
    join(homedir(), ".pi", "agent", "scheduler");
  const opts = {
    home,
    key,
    crontab: realCrontabShim(process.env.PANE_CRONTAB_BIN ?? "crontab"),
    fetch: (url) => globalThis.fetch(url),
    spawn: realSpawn(process.env.PANE_PI_BIN ?? "pi"),
    now: () => new Date(),
    piBin: process.env.PANE_PI_BIN ?? "pi",
    swapUrl: process.env.PANE_SWAP_URL ?? "http://127.0.0.1:8090",
  };
  try {
    if (lockSkip) await lockSkipRecord(key, opts);
    else await fire(key, opts);
    process.exit(0);
  } catch (e) {
    console.error(`runner: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
