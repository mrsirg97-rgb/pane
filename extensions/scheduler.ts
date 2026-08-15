import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorText, header, indent } from "./_render-kit.mjs";
import { withLog } from "./sqlite.ts";
import { realCrontabShim } from "./scheduler/crontab.ts";
import { DEFAULT_MODEL, createSchedulerCore } from "./scheduler/core.ts";
import type {
  JobView,
  RunRecord,
  Scope,
  SchedulerOpts,
  SchedulerToolSeam,
} from "./types/scheduler.types.ts";

// The tool layer: a thin seam over scheduler/core.ts. Production wiring
// (real crontab, real lock probe, homedir home) happens once here; tests
// inject through the seam (D2 pattern).

const ACTION = StringEnum([
  "create",
  "list",
  "pause",
  "resume",
  "remove",
  "runs",
] as const);

function currentSession(ctx?: {
  sessionManager?: { getSessionId?: () => string };
}): string {
  const id = ctx?.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length ? id : "anon";
}

// ---- deploy: runner.sh + runner.mjs live in the scheduler home, deployed
// from the repo files, overwritten when they change, never blocking load ----

const SRC_SH = fileURLToPath(new URL("./scheduler/runner.sh", import.meta.url));
const SRC_MJS = fileURLToPath(
  new URL("./scheduler/runner.mjs", import.meta.url),
);

function deployRunner(home: string): void {
  mkdirSync(home, { recursive: true });
  const jobs: [string, string, boolean][] = [
    [SRC_SH, "runner.sh", true],
    [SRC_MJS, "runner.mjs", false],
  ];
  for (const [src, name, exec] of jobs) {
    const dest = join(home, name);
    const from = readFileSync(src);
    const to = existsSync(dest) ? readFileSync(dest) : null;
    if (!to || !to.equals(from)) {
      writeFileSync(dest, from);
      if (exec) chmodSync(dest, 0o755);
    }
  }
}

// ---- production lock probe: is the key's flock held? ----

function realLockProbe(home: string): (key: string) => Promise<boolean> {
  return (key) =>
    new Promise<boolean>((resolve) => {
      const lock = join(home, "locks", `${key.replace(/:/g, "_")}.lock`);
      execFile("flock", ["-n", "-E", "73", lock, "-c", "true"], (err) => {
        if (!err) return resolve(false); // acquired and released: not held
        if ((err as { code?: number | string }).code === 73)
          return resolve(true);
        resolve(false); // no flock binary etc.: not held
      });
    });
}

// ---- text rendering ----

function nextText(job: JobView): string | null {
  if (job.state !== "active") return null;
  if (job.cron === "once") return job.at ? `at ${job.at}` : "at passed";
  return job.nextFire ? `next ${job.nextFire}` : "never";
}

function lastText(job: JobView): string | null {
  if (!job.lastStatus) return null;
  const bits = [job.lastStatus];
  if (job.lastExit !== null && job.lastExit !== undefined)
    bits.push(`exit ${job.lastExit}`);
  if (job.lastTs) bits.push(job.lastTs);
  return bits.join(" ");
}

function jobLines(
  job: JobView,
  theme?: { fg: (token: string, text: string) => string },
): string[] {
  const fg = (token: string, text: string) =>
    theme ? theme.fg(token, text) : text;
  const STATE: Record<string, string> = {
    active: "success",
    paused: "warning",
    done: "dim",
    removed: "dim",
  };
  const head = [job.id, job.name, fg(STATE[job.state] ?? "text", job.state)]
    .join(" ")
    .concat(
      [nextText(job), lastText(job)]
        .filter(Boolean)
        .map((s) => ` · ${s}`)
        .join(""),
    );
  const lines = [
    head,
    fg(
      "dim",
      `scope ${job.scope} · cron ${job.cron}${job.at ? ` · at ${job.at}` : ""} · ${job.model}` +
        (job.busy === "force" ? " · busy force" : "") +
        ` · ${job.cwd}`,
    ),
  ];
  if (job.drift) lines.push(fg("warning", `drift: ${job.drift}`));
  if (job.running) lines.push(fg("accent", "running (lock held)"));
  return lines;
}

function renderJob(
  job: JobView,
  theme?: { fg: (token: string, text: string) => string },
): string {
  return jobLines(job, theme).join("\n");
}

function renderJobs(
  jobs: JobView[],
  theme?: { fg: (token: string, text: string) => string },
): string {
  const fg = (token: string, text: string) =>
    theme ? theme.fg(token, text) : text;
  const sections: string[] = [];
  for (const scope of ["global", "cwd"] as Scope[]) {
    const list = jobs.filter((j) => j.scope === scope);
    sections.push(
      list.length
        ? `${fg("accent", `${scope}:`)}\n${list.map((j) => renderJob(j, theme)).join("\n")}`
        : `${fg("accent", `${scope}:`)} ${fg("dim", "no jobs")}`,
    );
  }
  return sections.join("\n");
}

function renderRuns(
  id: string,
  runs: RunRecord[],
  theme?: { fg: (token: string, text: string) => string },
): string {
  const fg = (token: string, text: string) =>
    theme ? theme.fg(token, text) : text;
  const head = `${id} · ${runs.length} run${runs.length === 1 ? "" : "s"} (oldest first):`;
  const lines = runs.map((r) => {
    const status =
      r.status === "ok"
        ? fg("success", "ok")
        : r.status === "fail"
          ? fg("error", "fail")
          : fg("dim", "skip");
    const detail =
      r.status === "skip"
        ? (r.reason ?? "")
        : [
            r.exit !== null && r.exit !== undefined ? `exit ${r.exit}` : null,
            r.durationMs !== null && r.durationMs !== undefined
              ? `${r.durationMs}ms`
              : null,
            r.log,
          ]
            .filter(Boolean)
            .join(" ");
    return `${r.ts}  ${status}  ${detail}`;
  });
  return [head, ...lines].join("\n");
}

export default function schedulerExtension(
  pi: ExtensionAPI,
  seam: SchedulerToolSeam = {},
): void {
  const home = seam.home ?? join(homedir(), ".pi", "agent", "scheduler");

  pi.registerTool({
    name: "scheduler",
    label: "Scheduler",
    description:
      `Background jobs on the user's crontab, bound to the worker GPU. create schedules a headless pi ` +
      `worker session (5-field vixie cron 'M H D Mo DOW', or cron:'once' + at:<ISO> for one-shot; the line ` +
      `self-deletes after one fire, no retry). Jobs run under flock via runner.sh, skip when another model ` +
      `holds the GPU (busy:'skip' default; 'force' evicts), and log to the scheduler home (runs/). ` +
      `list shows jobs in both scopes with drift between store and crontab. pause/resume/remove manage jobs; ` +
      `runs gives the audit trail (n last, default 5). Two stores: scope 'global' (this user) and 'cwd' ` +
      `(this working directory); ids jN are minted per scope, never reused - copy them from list, never invent. ` +
      `Default model: ${DEFAULT_MODEL}.`,
    promptSnippet:
      "Schedule recurring or one-shot background jobs on the worker GPU",
    promptGuidelines: [
      "recurring/one-shot background work -> scheduler create; the job runs a headless pi session on the worker model.",
      "default scope is cwd; scope:'global' for machine-wide jobs. ids jN are per scope: copy from list, never invent.",
      "busy:'skip' (default) skips a fire while another model holds the GPU; 'force' evicts it - only when the user wants the GPU now.",
      "cron is 5-field 'M H D Mo DOW'; 'once' + at:<ISO> fires at that minute and self-deletes; a failed once job is done-with-fail, re-create to retry.",
      "list flags drift (store vs crontab): a drifting job is not trustworthy until the drift note is gone.",
    ],
    parameters: Type.Object({
      action: ACTION,
      name: Type.Optional(
        Type.String({
          description: "Unique job name per scope. Required for create.",
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "The prompt a worker pi session runs. Required for create.",
        }),
      ),
      cron: Type.Optional(
        Type.String({
          description:
            "5-field vixie cron 'M H D Mo DOW' or 'once'. Required for create.",
        }),
      ),
      at: Type.Optional(
        Type.String({ description: "ISO time; required when cron is 'once'." }),
      ),
      scope: Type.Optional(StringEnum(["global", "cwd"] as const)),
      model: Type.Optional(
        Type.String({ description: `pi model id (default ${DEFAULT_MODEL}).` }),
      ),
      busy: Type.Optional(StringEnum(["skip", "force"] as const)),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory the job runs in (default: this session's cwd).",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Job id jN (as shown by list). Required for pause/resume/remove/runs.",
        }),
      ),
      n: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "How many runs to show for action='runs' (default 5).",
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      const detail = args?.action
        ? theme.fg(
            "text",
            [args.action, args.id ?? args.name].filter(Boolean).join(" "),
          )
        : undefined;
      return header(theme, ctx, "scheduler", detail);
    },
    renderResult(result, _options, theme, _ctx) {
      if (result.isError) return errorText(theme, result);
      const d = result.details as
        | { job?: JobView; jobs?: JobView[]; runs?: RunRecord[]; id?: string }
        | undefined;
      if (d?.jobs) return new Text(indent(renderJobs(d.jobs, theme)), 0, 0);
      if (d?.runs)
        return new Text(indent(renderRuns(d.id ?? "", d.runs, theme)), 0, 0);
      if (d?.job) return new Text(indent(renderJob(d.job, theme)), 0, 0);
      const text = (result.content ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      return new Text(indent(text), 0, 0);
    },
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      return withLog(async () => {
        deployRunner(home);
        const opts: SchedulerOpts = {
          home,
          sessionCwd: process.cwd(),
          session: currentSession(ctx),
          crontab: seam.crontab ?? realCrontabShim(),
          now: seam.now ?? (() => new Date()),
          runnerPath: join(home, "runner.sh"),
        };
        const core = createSchedulerCore(
          opts,
          seam.lockProbe ?? realLockProbe(home),
        );
        const p = params ?? {};
        const scope: Scope | undefined =
          p.scope === undefined
            ? undefined
            : p.scope === "global" || p.scope === "cwd"
              ? p.scope
              : (() => {
                  throw new Error(
                    `scheduler: scope must be 'global' or 'cwd', got '${p.scope}'`,
                  );
                })();

        switch (p.action) {
          case "create": {
            const name = String(p.name ?? "").trim();
            if (!name) throw new Error("scheduler: create requires 'name'");
            const prompt = String(p.prompt ?? "");
            if (!prompt) throw new Error("scheduler: create requires 'prompt'");
            const cron = String(p.cron ?? "");
            if (!cron)
              throw new Error(
                "scheduler: create requires 'cron' (5-field or 'once' + 'at')",
              );
            const job = await core.create({
              name,
              prompt,
              cron,
              at: p.at != null ? String(p.at) : undefined,
              scope,
              model: p.model != null ? String(p.model) : undefined,
              busy: p.busy === "force" ? "force" : "skip",
              cwd: p.cwd != null ? String(p.cwd) : undefined,
            });
            const text = `created ${job.id} '${job.name}' (${job.scope})\n${renderJob(job)}`;
            return { content: [{ type: "text", text }], details: { job } };
          }
          case "list": {
            const jobs = await core.list();
            return {
              content: [{ type: "text", text: renderJobs(jobs) }],
              details: { jobs },
            };
          }
          case "pause":
          case "resume":
          case "remove": {
            const id = String(p.id ?? "");
            if (!id)
              throw new Error(`scheduler: ${p.action} requires 'id' (jN)`);
            const job = await core[p.action](id, scope);
            const text = `${job.id} ${job.name} -> ${job.state}\n${renderJob(job)}`;
            return { content: [{ type: "text", text }], details: { job } };
          }
          case "runs": {
            const id = String(p.id ?? "");
            if (!id) throw new Error("scheduler: runs requires 'id' (jN)");
            const runs = await core.runs(id, scope, p.n);
            const text = renderRuns(id, runs);
            return { content: [{ type: "text", text }], details: { runs, id } };
          }
          default:
            throw new Error(`scheduler: unknown action '${p.action}'`);
        }
      });
    },
  });
}
