export type Reply = {
  id: string | null;
  ok: boolean;
  out?: string;
  err?: string;
  result?: string | null;
  error?: string | null;
  note?: string;
};
