import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FAIL_LIMIT = Number(process.env.PI_TOOL_FAIL_LIMIT ?? 3);

export default function retryGuardExtension(pi: ExtensionAPI) {
  // Per-instance, not module-scope: one process can host several sessions, and a
  // shared map would let one session's turn_start clear another's counters.
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

    // A returned `content` REPLACES the original (agent-session.js: `hookResult?.content
    // ?? result.content`), so append to it. Substituting a truncated copy would strip the
    // very error the model needs to fix the call, and pi truncates tool output already.
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
      details: { ...event.details, retryGuard: { tool: event.toolName, failures: n } },
    };
  });
}
