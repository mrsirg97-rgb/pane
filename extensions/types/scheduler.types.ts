// Contract for the scheduler extension (docs/SCHEDULER_SPEC.md, SCHEDULER_PLAN.md).
// Scope model: "global" (user-level store) and "cwd" (per job-cwd store, todo's hash).
// Job identity is (scope, id); ids j1, j2, ... are minted per store, never reused.

export type Scope = "global" | "cwd";
export type BusyPolicy = "skip" | "force";
export type JobState = "active" | "paused" | "done" | "removed";
export type RunStatus = "ok" | "fail" | "skip";
export type Op = "create" | "pause" | "resume" | "remove" | "run" | "compact";

export type Job = {
  id: string; // j<n>, minted per scope store, never reused
  name: string; // unique per scope store
  prompt: string;
  cron: string; // 5-field vixie expression, or the literal "once"
  at: string | null; // ISO time, set when cron === "once"
  cwd: string; // where pi runs; independent of scope
  model: string; // pi catalog id (llama-swap alias resolves on the server)
  busy: BusyPolicy;
  state: JobState;
};

export type StoredJob = Job & {
  created_seq: number;
  updated_seq: number;
  lastStatus: RunStatus | null;
  lastTs: string | null;
  lastExit: number | null;
};

export type JobView = Job & {
  scope: Scope;
  nextFire: string | null; // ISO of next fire; null renders "-" (paused/done/never)
  lastStatus: RunStatus | null;
  lastTs: string | null;
  lastExit: number | null;
  running: boolean; // job's flock held right now
  drift: string | null; // human-readable store/crontab mismatch; null when clean
};

export type RunRecord = {
  ts: string;
  id: string;
  scope: Scope;
  status: RunStatus;
  exit: number | null;
  durationMs: number | null;
  log: string | null; // path relative to the scheduler home
  reason: string | null; // skip reason or failure context
};

// ---- cron (5 fields, vixie semantics) ----

export type CronSet = { values: number[]; isStar: boolean };
export type ParsedCron = {
  minute: CronSet;
  hour: CronSet;
  dom: CronSet;
  month: CronSet;
  dow: CronSet; // 0 and 7 both mean Sunday
};

// ---- event args (replay reads exactly these) ----

export type CreateArgs = {
  name: string;
  prompt: string;
  cron: string;
  at: string | null;
  cwd: string;
  model: string;
  busy: BusyPolicy;
};
export type IdArgs = { id: string };
export type RunArgs = {
  id: string;
  status: RunStatus;
  exit: number | null;
  durationMs: number | null;
  log: string | null;
  reason: string | null;
};
export type CompactArgs = { jobs: StoredJob[] }; // full snapshot, tombstones included

// ---- injected seams (production defaults wired once, tests inject fakes) ----

export type CrontabShim = {
  list(): Promise<string>;
  install(text: string): Promise<void>;
};
export type Fetch = (url: string) => Promise<unknown>;
export type SpawnResult = { exit: number; stdout: string; stderr: string };
export type Spawn = (
  argv: string[],
  opts: { cwd: string },
) => Promise<SpawnResult>;

export type SchedulerOpts = {
  home: string; // scheduler home dir (~/.pi/agent/scheduler)
  sessionCwd: string; // creating session's cwd; keys the "cwd" store
  session: string; // session id stamped on mutation events ("anon" if none)
  crontab: CrontabShim;
  now: () => Date;
  runnerPath: string; // deployed runner.sh, goes into cron lines
};

export type RunnerOpts = {
  home: string;
  key: string; // job key from argv: j<n> (global) or cwd-<hash>:j<n>
  crontab: CrontabShim;
  fetch: Fetch;
  spawn: Spawn;
  now: () => Date;
  piBin: string; // resolved by runner.sh from its baseline PATH
  swapUrl: string; // llama-swap base url
};

// ---- core surface (the tool consumes this) ----

export type CreateInput = {
  name: string;
  prompt: string;
  cron: string;
  at?: string; // required when cron === "once"
  cwd?: string;
  model?: string;
  busy?: BusyPolicy;
  scope?: Scope;
};

export type SchedulerCore = {
  create(input: CreateInput): Promise<JobView>;
  list(): Promise<JobView[]>;
  pause(id: string, scope?: Scope): Promise<JobView>;
  resume(id: string, scope?: Scope): Promise<JobView>;
  remove(id: string, scope?: Scope): Promise<JobView>;
  runs(id: string, scope?: Scope, n?: number): Promise<RunRecord[]>;
};

// lock probe seam: true while the job's flock is held (list renders the running glyph)
export type LockProbe = (key: string) => Promise<boolean>;

// Seam for the tool layer (D2 pattern): production defaults are wired once in
// scheduler.ts; tests inject an in-memory crontab and a scratch home.
export type SchedulerToolSeam = {
  home?: string; // scheduler home dir (default ~/.pi/agent/scheduler)
  crontab?: CrontabShim;
  lockProbe?: LockProbe;
  now?: () => Date;
};
