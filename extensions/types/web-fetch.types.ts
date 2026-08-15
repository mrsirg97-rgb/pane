export type LookupFn = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
export type Deps = {
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  trafilatura?: string | null;
  maxBytes?: number;
  timeoutMs?: number;
};
export type Fetched = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bodyTruncated: boolean;
};
