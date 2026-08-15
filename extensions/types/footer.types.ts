export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate?: number;
};

export type FooterState = {
  modelId: string;
  reasoning: boolean;
  thinkingLevel: string;
  contextUsage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  branch: string | null;
  autoCompact: boolean;
  statuses: string[];
};
