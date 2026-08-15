import type { DatabaseSync } from "node:sqlite";

export type Memory = {
  id: number;
  scope: string;
  scope_label: string;
  kind: string;
  content: string;
  source: string | null;
  importance: number;
  strength: number;
  access_count: number;
  superseded_by: number | null;
  created_at: string;
  last_accessed_at: string | null;
  last_consolidated_at: string;
};
export type Hit = Memory & {
  effective_strength: number;
  match: "fts" | "fuzzy" | "both" | "browse";
};

export type Store = { db: DatabaseSync; fts: boolean };
