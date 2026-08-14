import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FAIL_LIMIT = Number(process.env.PI_TOOL_FAIL_LIMIT ?? 3);

export default function retryGuardExtension(pi: ExtensionAPI) {
  const failures = new Map<string, number>();

  pi.on("turn_start", () => failures.clear());

  pi.on("tool_result", (event) => {
    if (!event.toolName) return;
    if (!event.isError) {
      failures.delete(event.toolName);
      return;
    }
    const n = (failures.get(event.toolName) ?? 0) + 1;
    failures.set(event.toolName, n);
    if (n < FAIL_LIMIT) return;

    const original = Array.isArray(event.content) ? event.content : [];
    return {
      content: [
        ...original,
        {
          type: "text" as const,
          text:
            `[retry-guard] ${event.toolName} failed ${n}× in a row this turn. The error is above; ` +
            `read it and change the call, or stop calling this tool. Do not retry blindly.`,
        },
      ],
      details: {
        ...event.details,
        retryGuard: { tool: event.toolName, failures: n },
      },
    };
  });
}
