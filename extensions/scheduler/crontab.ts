import { execFile, spawn } from "node:child_process";
import type { CrontabShim } from "../types/scheduler.types.ts";

// Crontab surgery. One tagged line per job:
//   <cron> <runnerPath> <key>  # pane-scheduler:<key>
// paused = the same line prefixed with "# ". Only lines carrying the trailing
// tag are ever rewritten; every other byte passes through untouched.

const TAG_RE = /^(?<lead>\S.*?)\s+#\s*pane-scheduler:(?<key>\S+)$/;

export function lineFor(key: string, cron: string, runnerPath: string): string {
  return `${cron} ${runnerPath} ${key}  # pane-scheduler:${key}`;
}

/** Exactly one trailing newline for non-empty text; empty stays empty. */
export function normalize(text: string): string {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

export type TaggedLine = { key: string; cron: string; paused: boolean };

/** All tagged lines, in file order. Lookalikes (prose, mid-line, standalone
 * comment tags) never match: the tag must trail a non-empty line. */
export function scan(text: string): TaggedLine[] {
  const out: TaggedLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = TAG_RE.exec(line);
    if (!m) continue;
    const key = m.groups?.key ?? "";
    const body = line.startsWith("# ") ? line.slice(2) : line;
    out.push({
      key,
      cron: body.split(/\s+/).slice(0, 5).join(" "),
      paused: line.startsWith("# "),
    });
  }
  return out;
}

function withLines(text: string): string[] {
  const norm = normalize(text);
  return norm === "" ? [] : norm.slice(0, -1).split("\n");
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function findIndex(lines: string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const m = TAG_RE.exec(lines[i].trimEnd());
    if (m && m.groups?.key === key) return i;
  }
  return -1;
}

/** Append (new key) or replace in place (existing key, becomes active). */
export function upsertLine(
  text: string,
  key: string,
  cron: string,
  runnerPath: string,
): { text: string; added: boolean } {
  const lines = withLines(text);
  const line = lineFor(key, cron, runnerPath);
  const idx = findIndex(lines, key);
  if (idx === -1) {
    lines.push(line);
    return { text: joinLines(lines), added: true };
  }
  lines[idx] = line;
  return { text: joinLines(lines), added: false };
}

/** Comment the line out (pause) or strip exactly the "# " prefix (resume).
 * Idempotent; a missing key changes nothing and reports found=false. */
export function setPaused(
  text: string,
  key: string,
  paused: boolean,
): { text: string; found: boolean } {
  const lines = withLines(text);
  const idx = findIndex(lines, key);
  if (idx === -1) return { text: joinLines(lines), found: false };
  const active = lines[idx].startsWith("# ") ? lines[idx].slice(2) : lines[idx];
  const next = paused ? `# ${active}` : active;
  if (next !== lines[idx]) lines[idx] = next;
  return { text: joinLines(lines), found: true };
}

/** Delete the line (active or paused); no trace remains. */
export function removeLine(
  text: string,
  key: string,
): { text: string; found: boolean } {
  const lines = withLines(text);
  const idx = findIndex(lines, key);
  if (idx === -1) return { text: joinLines(lines), found: false };
  lines.splice(idx, 1);
  return { text: joinLines(lines), found: true };
}

// ---- production shim: `crontab -l` / `crontab -` round-trip ----

export function realCrontabShim(bin = "crontab"): CrontabShim {
  return {
    list: () =>
      new Promise<string>((resolve, reject) => {
        execFile(bin, ["-l"], (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if (err.code === "ENOENT")
            return reject(new Error("crontab: binary not found"));
          const e = String(stderr ?? "").trim();
          if (err.code === 1 && /no crontab for/i.test(e)) return resolve("");
          // Fail closed: an empty result may only come from the spool's own
          // "no crontab for <user>". Any other failure (PAM, permissions,
          // spool unreadable) must reject - installing from a false empty
          // would silently wipe every foreign line in the user's crontab.
          return reject(
            new Error(
              `crontab list failed (exit ${err.code}): ${e || err.message}`,
            ),
          );
        });
      }),
    install: (text) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(bin, ["-"], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d));
        child.on("error", () => reject(new Error("crontab: binary not found")));
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `crontab install failed (exit ${code}): ${stderr.trim() || "no stderr"}`,
                ),
              ),
        );
        child.stdin.end(text);
      }),
  };
}
