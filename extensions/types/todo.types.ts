export type Status = "pending" | "in_progress" | "done" | "failed";
export type Task = {
  id: string;
  text: string;
  status: Status;
  dependsOn: string | null;
};
export type TaskView = Task & {
  blockedBy: string | null;
  owner: string | null;
};
export type StoredTask = Task & {
  pos: number;
  created_seq: number;
  updated_seq: number;
  owner: string | null;
};

export type Op =
  "create" | "start" | "complete" | "fail" | "retry" | "move" | "compact";

export type PlannedRow = {
  text: string;
  id: string;
  pos: number;
  dependsOn: string | null | undefined; // undefined: keep an existing link
};
export type Plan = { rows: PlannedRow[]; problems: string[] };
