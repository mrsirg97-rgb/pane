import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CorruptionPolicy = "delete" | "quarantine";

export type OpenOptions = {
  path: string;
  schema: string;
  policy: CorruptionPolicy;
  configure?: (db: DatabaseSync) => void;
};

function rawOpen(o: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(o.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  o.configure?.(db);
  db.exec(o.schema);
  return db;
}

function disposeCorrupt(p: string, policy: CorruptionPolicy) {
  if (policy === "delete") {
    rmSync(p, { force: true });
    rmSync(`${p}-wal`, { force: true });
    rmSync(`${p}-shm`, { force: true });
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const sidecar of [p, `${p}-wal`, `${p}-shm`]) {
    try {
      renameSync(sidecar, `${sidecar}.corrupt-${stamp}`);
    } catch {
      /* absent sidecar files are fine; the main file always moves */
    }
  }
}

export function openDb(o: OpenOptions): DatabaseSync {
  const dir = dirname(o.path);
  mkdirSync(dir, { recursive: true });
  try {
    const db = rawOpen(o);
    const check = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (check && check.integrity_check === "ok") return db;
    db.close();
  } catch {
    // corrupt or unreadable: fall through to dispose + recreate
  }
  disposeCorrupt(o.path, o.policy);
  return rawOpen(o);
}

export function withStore<T, H = DatabaseSync>(
  o: OpenOptions,
  handle: (db: DatabaseSync) => H,
  fn: (h: H) => T,
): T {
  const db = openDb(o);
  const h = handle(db);
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = fn(h);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already committed or never begun */
    }
    throw err;
  } finally {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* read-only or closed */
    }
    db.close();
  }
}

let busy: Promise<void> = Promise.resolve();
export async function withLog<T>(fn: () => T): Promise<T> {
  const prev = busy;
  let release!: () => void;
  busy = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return fn();
  } finally {
    release();
  }
}
