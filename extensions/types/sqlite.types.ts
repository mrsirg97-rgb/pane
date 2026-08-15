import type { DatabaseSync } from "node:sqlite";

export type CorruptionPolicy = "delete" | "quarantine";

export type OpenOptions = {
  path: string;
  schema: string;
  policy: CorruptionPolicy;
  configure?: (db: DatabaseSync) => void;
};
