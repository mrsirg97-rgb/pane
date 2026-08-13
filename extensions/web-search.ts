import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorText, header, preview, shortUrl } from "./_render-kit.mjs";

const SEARXNG = `${process.env.PI_SEARXNG_URL ?? "http://127.0.0.1:8888"}/search`;

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via SearXNG instance. Returns compact JSON: title, url, snippet per result.",
    promptSnippet: "Search the web for up-to-date information",
    promptGuidelines: [
      "current or external info -> web_search; never for code already in the workspace.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(
        Type.Integer({
          description: "Max results (default 5)",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      return header(
        theme,
        ctx,
        "search",
        args?.query ? theme.fg("text", args.query) : undefined,
      );
    },
    renderResult(result, _options, theme, ctx) {
      if (result.isError) return errorText(theme, result);
      const results =
        (
          result.details as
            { results?: { title: string; url: string }[] } | undefined
        )?.results ?? [];
      if (!results.length) return preview(theme, ctx, "", {});
      const styled = results
        .map(
          (r, i) =>
            `${theme.fg("dim", String(i + 1))} ${theme.fg("text", r.title)}\n  ${theme.fg("muted", shortUrl(r.url))}`,
        )
        .join("\n");
      return preview(theme, ctx, styled, { lines: 7, keep: "head" });
    },
    async execute(_toolCallId, params: any) {
      const n = params.maxResults ?? 5;
      const res = await fetch(
        `${SEARXNG}?q=${encodeURIComponent(params.query)}&format=json`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) throw new Error(`SearXNG search failed: HTTP ${res.status}`);
      const data = await res.json();
      const results = (data.results ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.content ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300),
      }));
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? JSON.stringify(results, null, 1)
              : "no results",
          },
        ],
        details: { results },
      };
    },
  });
}
