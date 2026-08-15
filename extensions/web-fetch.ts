import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  errorText,
  header,
  indent,
  preview,
  shortUrl,
} from "./_render-kit.mjs";
import type { Deps, Fetched, LookupFn } from "./types/web-fetch.types.ts";

const PROXY_URL = process.env.PI_WEB_FETCH_PROXY ?? "http://127.0.0.1:8889";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HOPS = 5;
const TRAFILATURA = "trafilatura";
const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|[\w.-]+\+(json|xml))(\s*;|$))/i;

export function ipIsPrivate(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const v4 = normalized.startsWith("::ffff:")
    ? normalized.slice(7)
    : normalized;
  if (v4.includes(".")) {
    const octets = v4.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((o) => !Number.isInteger(o) || o > 255)
    )
      return true;
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && octets[2] === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized)
  );
}

async function guardedUrl(
  raw: string,
  base: string | null,
  lookup: LookupFn,
): Promise<URL> {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `only http(s) is fetchable, got ${url.protocol.slice(0, -1)}`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host).catch(() => []);
  if (!addresses.length) throw new Error(`cannot resolve host: ${host}`);
  for (const { address } of addresses) {
    if (ipIsPrivate(address)) {
      throw new Error(
        `refused: ${host} resolves to private address ${address}`,
      );
    }
  }
  return url;
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - bytes;
    chunks.push(value.byteLength > room ? value.slice(0, room) : value);
    bytes += value.byteLength;
    if (bytes >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated };
}

let proxiedFetch: typeof fetch | undefined;
async function defaultFetch(): Promise<typeof fetch> {
  if (!PROXY_URL) return fetch;
  if (!proxiedFetch) {
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(PROXY_URL);
    proxiedFetch = ((input: any, init: any) =>
      undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
  }
  return proxiedFetch;
}

export async function fetchGuarded(
  rawUrl: string,
  deps: Deps = {},
): Promise<Fetched> {
  const {
    fetchImpl = await defaultFetch(),
    lookup = defaultLookup,
    maxBytes = MAX_BYTES,
  } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let url = await guardedUrl(rawUrl, null, lookup);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await fetchImpl(url.href, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": "pi-web-fetch/1.0",
          accept:
            "text/html,application/xhtml+xml,application/json,text/*;q=0.9,*/*;q=0.5",
        },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        url = await guardedUrl(location, url.href, lookup);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.href}`);
      const contentType = res.headers.get("content-type") ?? "text/plain";
      if (!TEXTUAL.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(
          `unsupported content type ${contentType.split(";")[0]}; only textual responses are fetchable`,
        );
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new Error(
          `response too large: ${declared} bytes declared, cap is ${maxBytes}`,
        );
      }
      const { body, truncated } = await readCapped(res, maxBytes);
      return {
        finalUrl: url.href,
        status: res.status,
        contentType,
        body,
        bodyTruncated: truncated,
      };
    }
    throw new Error(
      `too many redirects (>${MAX_HOPS}) starting from ${rawUrl}`,
    );
  } catch (err) {
    if (signal.aborted)
      throw new Error(`timed out after ${timeoutMs}ms fetching ${url.href}`);
    if (
      !deps.fetchImpl &&
      PROXY_URL &&
      (err as any)?.cause?.code === "ECONNREFUSED"
    ) {
      throw new Error(
        `egress proxy ${PROXY_URL} is unreachable. Start it: cd ~/docker/web-tools && docker compose up -d`,
      );
    }
    throw err;
  }
}

const defaultLookup: LookupFn = (host) =>
  dnsLookup(host, { all: true, verbatim: true });

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (ENTITIES[lower]) return ENTITIES[lower];
    if (lower.startsWith("#x"))
      return String.fromCodePoint(parseInt(lower.slice(2), 16)) || whole;
    if (lower.startsWith("#"))
      return String.fromCodePoint(parseInt(lower.slice(1), 10)) || whole;
    return whole;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>|<br\s*\/?>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function runTrafilatura(binary: string, html: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = execFile(
      binary,
      [],
      { timeout: 20_000, maxBuffer: 2 * MAX_BYTES },
      (err, stdout) => resolve(err ? "" : stdout.trim()),
    );
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(html);
  });
}

export async function extractReadable(
  html: string,
  opts: { trafilatura?: string | null } = {},
): Promise<string> {
  const binary =
    opts.trafilatura === undefined ? TRAFILATURA : opts.trafilatura;
  if (binary) {
    const extracted = await runTrafilatura(binary, html);
    if (extracted) return extracted;
  }
  return htmlToText(html);
}

export function capChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n[TRUNCATED: showing ${maxChars} of ${text.length} chars. Refetch with a larger maxChars or a more specific URL.]`
  );
}

export function buildExecute(deps: Deps = {}) {
  return async function execute(_toolCallId: string, params: any) {
    try {
      const fetched = await fetchGuarded(params.url, {
        ...deps,
        timeoutMs: params.timeoutMs ?? deps.timeoutMs,
      });
      const isHtml = /html|xml/i.test(fetched.contentType);
      const readable = isHtml
        ? await extractReadable(fetched.body, deps)
        : fetched.body.trim();
      const marker = fetched.bodyTruncated
        ? "\n\n[TRUNCATED: download hit the byte cap; content is partial.]"
        : "";
      const text =
        capChars(readable, params.maxChars ?? MAX_CHARS) + marker ||
        "(no content extracted)";
      return {
        content: [{ type: "text", text }],
        details: {
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          contentType: fetched.contentType,
          chars: readable.length,
          truncated:
            fetched.bodyTruncated ||
            readable.length > (params.maxChars ?? MAX_CHARS),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `web_fetch: ${message}` }],
        isError: true,
      };
    }
  };
}

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a public http(s) URL and return its readable text (article extraction for HTML, " +
      "raw body for JSON/plain). Redirects are followed and re-checked; private/internal " +
      "addresses are refused. Output is capped; a loud [TRUNCATED] marker states the full size.",
    promptSnippet: "Fetch a URL and return its readable text content",
    promptGuidelines: [
      "search finds, fetch reads; snippets are not the page.",
      "web pages and textual APIs only; local files -> read, local services -> bash.",
      "[TRUNCATED] -> refetch with larger maxChars only if the missing part matters.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL to fetch" }),
      maxChars: Type.Optional(
        Type.Integer({
          description: `Max chars returned (default ${MAX_CHARS})`,
          minimum: 100,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          description: `Total timeout in ms (default ${DEFAULT_TIMEOUT_MS})`,
          minimum: 1000,
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      return header(
        theme,
        ctx,
        "fetch",
        args?.url ? theme.fg("text", shortUrl(args.url)) : undefined,
      );
    },
    renderResult(result, _options, theme, ctx) {
      if (result.isError) return errorText(theme, result);
      const d = (result.details ?? {}) as {
        status?: number;
        contentType?: string;
        chars?: number;
        truncated?: boolean;
      };
      const meta = [
        d.status && String(d.status),
        d.contentType?.split(";")[0],
        d.chars !== undefined &&
          `${d.chars > 1024 ? `${(d.chars / 1024).toFixed(1)}k` : d.chars} chars`,
      ]
        .filter(Boolean)
        .join(" · ");
      const metaLine = new Text(
        indent(
          theme.fg("muted", meta) +
            (d.truncated ? theme.fg("warning", " · truncated") : ""),
        ),
        0,
        0,
      );
      const raw = (result.content ?? [])
        .map((c: any) => (c.type === "text" ? c.text : ""))
        .join("");
      const body = preview(theme, ctx, theme.fg("toolOutput", raw), {
        lines: 6,
        keep: "head",
      });
      return {
        render: (width: number) => [
          ...metaLine.render(width),
          ...body.render(width),
        ],
        invalidate: () => body.invalidate?.(),
      };
    },
    execute: buildExecute(),
  });
}
