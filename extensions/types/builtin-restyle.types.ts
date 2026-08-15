export type LiveSpec = { text: string; base: number | null };
export type Restyle = {
  def: any;
  detail: (args: any, theme: any, cwd: string) => string | undefined;
  view: { lines: number; keep: "head" | "tail" };
  timed?: boolean;
  body?: (args: any, result: any, theme: any) => string | undefined;
  sub?: (args: any, theme: any, cwd: string) => string | undefined;
  live?: (args: any, state: any, cwd: string) => LiveSpec | undefined;
};
