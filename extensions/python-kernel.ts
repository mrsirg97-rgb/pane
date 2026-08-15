import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorText, header, preview } from "./_render-kit.mjs";
import type { Reply } from "./types/python-kernel.types.ts";

const VENV_DIR = join(homedir(), ".pi/agent/kernel-venv");
export const KERNEL_PYTHON = join(VENV_DIR, "bin/python");

export function resolveKernelHost(): string {
  const local = join(homedir(), ".pi/agent/kernel/kernel_host.py");
  if (existsSync(local)) return local;
  try {
    return fileURLToPath(new URL("../kernel/kernel_host.py", import.meta.url));
  } catch {
    return local;
  }
}
export const KERNEL_HOST = resolveKernelHost();

function runStep(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 300_000 }, (err, _stdout, stderr) =>
      err
        ? reject(
            new Error(
              `${command} ${args[0] ?? ""}: ${String(stderr || err.message).slice(-500)}`,
            ),
          )
        : resolve(),
    );
  });
}

let bootstrap: Promise<void> | null = null;
export function ensureKernel(): Promise<void> {
  if (existsSync(KERNEL_PYTHON)) return Promise.resolve();
  bootstrap ??= (async () => {
    await runStep("python3", ["-m", "venv", VENV_DIR]);
    await runStep(join(VENV_DIR, "bin/pip"), [
      "install",
      "--quiet",
      "ipython",
      "numpy",
      "pandas",
    ]);
  })().catch((err) => {
    bootstrap = null;
    throw new Error(
      `kernel bootstrap failed (needs python3 + network): ${err.message}`,
    );
  });
  return bootstrap;
}
const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_TAIL = 4096;

export class Kernel {
  constructor(private opts: { python?: string; host?: string } = {}) {}

  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private stderrTail = "";
  private pending = new Map<string, (r: Reply) => void>();
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastDeath: { desc: string; stderr: string } | null = null;

  private failAll(message: string) {
    for (const [, resolve] of this.pending) {
      resolve({ id: null, ok: false, error: message });
    }
    this.pending.clear();
  }

  private takeDeathNote(): string | null {
    const d = this.lastDeath;
    if (!d) return null;
    this.lastDeath = null;
    const stderr = d.stderr ? `\n[stderr]\n${d.stderr}` : "";
    return (
      `note: fresh kernel; previous kernel exited (${d.desc}); ` +
      `all previous variables are gone${stderr}`
    );
  }

  private start() {
    this.buf = "";
    this.stderrTail = "";
    const proc = spawn(
      this.opts.python ?? KERNEL_PYTHON,
      [this.opts.host ?? KERNEL_HOST],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const reply = JSON.parse(line) as Reply;
          const resolve = reply.id ? this.pending.get(reply.id) : undefined;
          if (reply.id) this.pending.delete(reply.id);
          resolve?.(reply);
        } catch {
          /* a non-protocol line means the host printed junk; ignore it */
        }
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    const isCurrent = () => this.proc === proc;
    proc.on("error", (err) => {
      if (!isCurrent()) return;
      this.failAll(`kernel failed to start: ${err.message}`);
      this.proc = null;
    });
    proc.on("exit", (code, signal) => {
      if (!isCurrent()) return;
      const tail = this.stderrTail.trim();
      const desc = signal ? `signal ${signal}` : `code ${code}`;
      this.lastDeath = { desc, stderr: tail };
      this.failAll(
        `kernel exited (${desc})` + (tail ? `\n[stderr]\n${tail}` : ""),
      );
      this.proc = null;
    });
    proc.stdin.on("error", () => {});
    this.proc = proc;
  }

  private teardown(message: string) {
    const proc = this.proc;
    this.proc = null;
    this.failAll(message);
    proc?.kill("SIGKILL");
  }

  restart() {
    this.teardown("kernel was restarted; all variables are gone");
  }

  shutdown() {
    this.teardown("kernel shut down");
  }

  async send(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Reply> {
    const turn = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await turn;
    try {
      return await this.dispatch(payload, timeoutMs);
    } finally {
      release();
    }
  }

  private async dispatch(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Reply> {
    let note: string | null = null;
    if (!this.proc) {
      note = this.takeDeathNote();
      try {
        await ensureKernel();
      } catch (err) {
        return {
          id: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          note: note ?? undefined,
        };
      }
      this.start();
    }
    const id = String(++this.seq);
    const wait = new Promise<Reply>((resolve) => this.pending.set(id, resolve));
    try {
      this.proc!.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
    } catch (err) {
      this.pending.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      return { id, ok: false, error: `kernel is not writable: ${message}` };
    }

    let timer: NodeJS.Timeout;
    const timeout = new Promise<Reply>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          id,
          ok: false,
          error:
            `timed out after ${Math.round(timeoutMs / 1000)}s; kernel will be restarted ` +
            `on the next call; all variables are gone. Re-run setup, or pass a larger timeoutMs.`,
        });
        this.restart();
      }, timeoutMs);
    });
    const reply = await Promise.race([wait, timeout]);
    clearTimeout(timer!);
    return note ? { ...reply, note } : reply;
  }
}

function render(r: Reply): string {
  const parts: string[] = [];
  if (r.note?.trim()) parts.push(r.note.trimEnd());
  if (r.out?.trim()) parts.push(r.out.trimEnd());
  if (r.err?.trim()) parts.push(`[stderr]\n${r.err.trimEnd()}`);
  if (r.error) parts.push(`[error]\n${r.error}`);
  if (r.result && !r.out?.includes(r.result)) parts.push(r.result);
  return parts.join("\n") || (r.ok ? "(no output)" : "(failed, no output)");
}

export default function pythonKernelExtension(pi: ExtensionAPI) {
  const kernel = new Kernel();
  pi.on("session_shutdown", () => kernel.shutdown());
  pi.registerTool({
    name: "python",
    label: "Python",
    description:
      "Run Python in a persistent IPython session. Variables, imports and definitions " +
      "persist across calls, so build state up incrementally. numpy and pandas are " +
      "available; IPython magics (%timeit, %run) work. action='vars' lists the current " +
      "namespace, action='reset' clears it.",
    promptSnippet:
      "Run Python in a persistent session; state persists across calls",
    promptGuidelines: [
      "arithmetic, data shaping, parsing, bulk text -> compute in python, don't estimate.",
      "state persists; compute once, query it in later calls.",
    ],
    parameters: Type.Object({
      code: Type.Optional(
        Type.String({ description: "Python source to execute" }),
      ),
      action: Type.Optional(
        Type.Union([Type.Literal("vars"), Type.Literal("reset")], {
          description:
            "'vars' summarises the namespace, 'reset' clears it. Omit to run code.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          description: "Timeout in ms (default 120000)",
          minimum: 1000,
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      const codeLines = (args?.code ?? "")
        .split("\n")
        .filter((l: string) => l.trim());
      const detail = args?.action
        ? theme.fg("text", args.action)
        : codeLines.length
          ? theme.fg(
              "muted",
              `${codeLines.length} ${codeLines.length === 1 ? "line" : "lines"}`,
            )
          : undefined;
      const head = header(theme, ctx, "python", detail);
      if (!codeLines.length) return head;
      const code = codeLines
        .map((l: string) => theme.fg("mdCode", l))
        .join("\n");
      const body = preview(theme, ctx, code, { lines: 4, keep: "head" });
      return {
        render: (width: number) => [
          ...head.render(width),
          ...body.render(width),
        ],
        invalidate: () => body.invalidate?.(),
      };
    },
    renderResult(result, _options, theme, ctx) {
      if (
        result.isError &&
        !result.content?.some((c: any) => c.type === "text" && c.text.trim())
      ) {
        return errorText(theme, result);
      }
      const raw = (result.content ?? [])
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      const styled = raw
        .split("\n")
        .map((line: string) =>
          line === "[stderr]" || line === "[error]"
            ? theme.fg(line === "[error]" ? "error" : "warning", line)
            : theme.fg("toolOutput", line),
        )
        .join("\n");
      return preview(theme, ctx, styled, { lines: 8, keep: "tail" });
    },
    async execute(_toolCallId, params: any) {
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const payload = params.action
        ? { cmd: params.action }
        : { code: params.code ?? "" };
      if (!params.action && !params.code?.trim()) {
        return {
          content: [{ type: "text", text: "no code supplied" }],
          isError: true,
        };
      }
      const reply = await kernel.send(payload, timeoutMs);
      const text = render(reply);
      return {
        content: [{ type: "text", text }],
        isError: !reply.ok,
        details: { ok: reply.ok, error: reply.error ?? null },
      };
    },
  });
}
