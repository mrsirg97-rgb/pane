import { openDb, withStore } from "../sqlite.ts";
import type {
  BusyPolicy,
  CreateArgs,
  CreateInput,
  JobView,
  LockProbe,
  RunRecord,
  Scope,
  SchedulerCore,
  SchedulerOpts,
  StoredJob,
} from "../types/scheduler.types.ts";
import { nextFire, validateCron } from "./cron.ts";
import {
  removeLine,
  scan,
  setPaused,
  upsertLine,
  type TaggedLine,
} from "./crontab.ts";
import {
  SCHEMA,
  appendEvent,
  applyEvent,
  compactIfNeeded,
  cwdHash,
  keyOf,
  mintId,
  persistJobs,
  replayJobs,
  storePathFor,
} from "./store.ts";

export const DEFAULT_MODEL = "qwen3.8-workers";
const DEFAULT_N = 5;

function fail(message: string): never {
  throw new Error(`scheduler: ${message}`);
}

type StoreRef = { scope: Scope; storeCwd: string | undefined };

function refFor(
  scope: Scope,
  cwd: string | undefined,
  sessionCwd: string,
): StoreRef {
  return {
    scope,
    storeCwd: scope === "global" ? undefined : (cwd ?? sessionCwd),
  };
}

function pathFor(home: string, ref: StoreRef): string {
  return storePathFor(home, ref.scope, ref.storeCwd);
}

function keyFor(ref: StoreRef, id: string): string {
  return keyOf({
    scope: ref.scope,
    hash: ref.scope === "cwd" ? cwdHash(ref.storeCwd ?? "") : undefined,
    id,
  });
}

function readMap(home: string, ref: StoreRef): Map<string, StoredJob> {
  const db = openDb({
    path: pathFor(home, ref),
    schema: SCHEMA,
    policy: "delete",
  });
  try {
    return replayJobs(db);
  } finally {
    db.close();
  }
}

function onceToCron(atIso: string): string {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime()))
    fail(`'at' must be a valid ISO time, got '${atIso}'`);
  // cron fires in local time; the runner's minute-granularity is the contract
  return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
}

export function createSchedulerCore(
  opts: SchedulerOpts,
  lockProbe?: LockProbe,
): SchedulerCore {
  const view = (
    job: StoredJob,
    ref: StoreRef,
    line: TaggedLine | undefined,
    running: boolean,
  ): JobView => {
    let drift: string | null = null;
    if (job.state !== "removed") {
      if (line === undefined) {
        drift = "no crontab line";
      } else {
        const notes: string[] = [];
        if (job.state === "paused" && !line.paused)
          notes.push("line is active");
        if (job.state !== "paused" && line.paused) notes.push("line is paused");
        if (line.cron !== job.cron)
          notes.push(`cron differs (crontab: ${line.cron})`);
        if (notes.length) drift = notes.join("; ");
      }
    }
    let nextFireIso: string | null = null;
    if (job.state === "active") {
      if (job.cron === "once" && job.at) {
        const at = new Date(job.at);
        if (!Number.isNaN(at.getTime()) && at > opts.now())
          nextFireIso = at.toISOString();
      } else if (job.cron !== "once") {
        nextFireIso =
          nextFire(validateCron(job.cron), opts.now())?.toISOString() ?? null;
      }
    }
    return {
      ...job,
      scope: ref.scope,
      nextFire: nextFireIso,
      running,
      drift,
    };
  };

  const crontabText = async (): Promise<string> => {
    try {
      return await opts.crontab.list();
    } catch (e) {
      fail(`crontab: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const install = async (text: string): Promise<void> => {
    try {
      await opts.crontab.install(text);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  /** Resolve an id to exactly one (scope, job). Unknown or ambiguous ids
   * refuse loudly. Tombstones resolve too (runs works after remove). */
  const resolve = (
    id: string,
    scope?: Scope,
  ): { ref: StoreRef; job: StoredJob } => {
    const refs: StoreRef[] = scope
      ? [refFor(scope, undefined, opts.sessionCwd)]
      : [
          refFor("global", undefined, opts.sessionCwd),
          refFor("cwd", undefined, opts.sessionCwd),
        ];
    const hits = refs
      .map((ref) => ({ ref, job: readMap(opts.home, ref).get(id) }))
      .filter((h) => h.job !== undefined);
    if (hits.length === 0)
      fail(scope ? `no job '${id}' in scope '${scope}'` : `no job '${id}'`);
    if (hits.length > 1)
      fail(
        `'${id}' is ambiguous: it exists in both scopes; pass scope ('global' or 'cwd')`,
      );
    return hits[0];
  };

  const stateAction = async (
    id: string,
    scope: Scope | undefined,
    action: "pause" | "resume" | "remove",
  ): Promise<JobView> => {
    const { ref, job } = resolve(id, scope);
    if (action === "pause") {
      if (job.state === "paused") fail(`'${id}' is already paused`);
      if (job.state === "done") fail(`'${id}' is done; nothing to pause`);
    } else if (action === "resume") {
      if (job.state !== "paused") fail(`'${id}' is not paused`);
    } else if (job.state === "removed") {
      fail(`'${id}' is already removed`);
    }

    const key = keyFor(ref, id);
    // crontab first: a failed crontab write never leaves a store mutation.
    const text = await crontabText();
    const next =
      action === "pause"
        ? setPaused(text, key, true)
        : action === "resume"
          ? setPaused(text, key, false)
          : removeLine(text, key);
    if (!next.found && action !== "remove") {
      // drift (line missing): the store state still changes; list flags it
      await install(next.text);
    } else {
      await install(next.text);
    }

    return withStore(
      { path: pathFor(opts.home, ref), schema: SCHEMA, policy: "delete" },
      (db) => db,
      (db) => {
        const map = replayJobs(db);
        if (compactIfNeeded(db, map, opts.session)) persistJobs(db, map);
        const seq = appendEvent(db, action, { id }, opts.session);
        applyEvent(map, seq, new Date().toISOString(), action, { id });
        persistJobs(db, map);
        const row = map.get(id)!;
        const line =
          action === "remove"
            ? undefined
            : { key, cron: row.cron, paused: action === "pause" };
        return view(row, ref, line, false);
      },
    );
  };

  return {
    async create(input: CreateInput): Promise<JobView> {
      const name = String(input.name ?? "").trim();
      if (!name) fail("create requires a non-empty name");
      const prompt = String(input.prompt ?? "");
      if (!prompt) fail("create requires a non-empty prompt");
      const scope: Scope = input.scope === "global" ? "global" : "cwd";
      const ref = refFor(scope, input.cwd, opts.sessionCwd);
      const model = String(input.model ?? DEFAULT_MODEL);
      const busy: BusyPolicy = input.busy === "force" ? "force" : "skip";

      let cron = String(input.cron ?? "").trim();
      let at: string | null = null;
      if (cron === "once") {
        if (!input.at) fail("cron 'once' requires 'at' (ISO time)");
        at =
          new Date(String(input.at)).toISOString() ??
          (undefined as unknown as string);
        if (Number.isNaN(new Date(at).getTime()))
          fail(`'at' must be a valid ISO time, got '${input.at}'`);
        cron = onceToCron(at);
      } else {
        validateCron(cron); // throws `cron: ...` before anything is written
      }

      // read phase: duplicate-name check (per scope store, tombstones count)
      // and a candidate id for the crontab key
      const readRefMap = readMap(opts.home, ref);
      for (const t of readRefMap.values())
        if (t.name === name)
          fail(
            `a job named '${name}' already exists in scope '${scope}' (state: ${t.state}); remove it first`,
          );
      const candidateId = mintId(readRefMap);
      const key = keyFor(ref, candidateId);

      // crontab first (plan B): the visible failure mode is a line with no row
      const text = await crontabText();
      await install(upsertLine(text, key, cron, opts.runnerPath).text);

      const args: CreateArgs = {
        name,
        prompt,
        cron,
        at,
        cwd: ref.storeCwd ?? "",
        model,
        busy,
      };
      return withStore(
        { path: pathFor(opts.home, ref), schema: SCHEMA, policy: "delete" },
        (db) => db,
        (db) => {
          const map = replayJobs(db);
          if (compactIfNeeded(db, map, opts.session)) persistJobs(db, map);
          const seq = appendEvent(db, "create", args, opts.session);
          applyEvent(map, seq, new Date().toISOString(), "create", args);
          persistJobs(db, map);
          const row = [...map.values()].find((t) => t.name === name);
          if (!row)
            fail(
              `concurrent create raced on name '${name}'; the crontab line is orphaned, remove it`,
            );
          const drift =
            row.id !== candidateId
              ? `crontab line carries key for ${candidateId}, store row is ${row.id} (concurrent create); remove and re-create`
              : null;
          const v = view(
            row,
            ref,
            { key, cron: row.cron, paused: false },
            false,
          );
          return drift ? { ...v, drift } : v;
        },
      );
    },

    async list(): Promise<JobView[]> {
      let lines: Map<string, TaggedLine> | null;
      try {
        lines = new Map(
          scan(await opts.crontab.list()).map((l) => [l.key, l] as const),
        );
      } catch {
        lines = null; // crontab unreadable: every job drifts
      }
      const refs: StoreRef[] = [
        refFor("global", undefined, opts.sessionCwd),
        refFor("cwd", undefined, opts.sessionCwd),
      ];
      const out: JobView[] = [];
      for (const ref of refs) {
        const map = readMap(opts.home, ref);
        for (const job of map.values()) {
          if (job.state === "removed") continue;
          const key = keyFor(ref, job.id);
          const running = lockProbe ? await lockProbe(key) : false;
          const line = lines?.get(key);
          const v = view(job, ref, line, running);
          if (lines === null && v.drift === null)
            out.push({ ...v, drift: "crontab unreadable" });
          else out.push(v);
        }
      }
      return out;
    },

    pause: (id, scope) => stateAction(id, scope, "pause"),
    resume: (id, scope) => stateAction(id, scope, "resume"),
    remove: (id, scope) => stateAction(id, scope, "remove"),

    async runs(id: string, scope?: Scope, n?: number): Promise<RunRecord[]> {
      const limit = n ?? DEFAULT_N;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        fail(`runs count must be an integer 1-100, got ${n}`);
      const { ref, job } = resolve(id, scope);
      const db = openDb({
        path: pathFor(opts.home, ref),
        schema: SCHEMA,
        policy: "delete",
      });
      try {
        const rows = db
          .prepare(
            "SELECT ts, args FROM events WHERE op = 'run' AND json_extract(args, '$.id') = ? ORDER BY seq DESC LIMIT ?",
          )
          .all(id, limit) as { ts: string; args: string }[];
        return rows.reverse().map((r) => {
          const a = JSON.parse(r.args) as Record<string, unknown>;
          return {
            ts: r.ts,
            id: String(a.id ?? id),
            scope: ref.scope,
            status: (["ok", "fail", "skip"] as const).includes(
              a.status as never,
            )
              ? (a.status as RunRecord["status"])
              : "skip",
            exit: typeof a.exit === "number" ? a.exit : null,
            durationMs: typeof a.durationMs === "number" ? a.durationMs : null,
            log: typeof a.log === "string" ? a.log : null,
            reason: typeof a.reason === "string" ? a.reason : null,
          };
        });
      } finally {
        db.close();
      }
    },
  };
}
