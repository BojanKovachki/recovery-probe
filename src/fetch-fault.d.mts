export type FaultKind = 'http-error' | 'connection-failure' | 'invalid-json';
export interface FetchFaultOptions {
  url: string;
  kind: FaultKind;
  status?: number;
  count?: number;
  method?: string;
}
export interface FetchFaultStats {
  kind: FaultKind;
  requested: number;
  applied: number;
  matchingRequests: number;
}
export function createFaultFetch(baseFetch: typeof fetch, options: FetchFaultOptions): {
  fetch: typeof fetch;
  summary(): FetchFaultStats;
  assertApplied(): FetchFaultStats;
};
