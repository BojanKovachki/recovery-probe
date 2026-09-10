import type { Browser, Page } from 'playwright';

export type FaultKind = 'http-error' | 'connection-failure' | 'invalid-json';
export interface FaultOptions {
  match: string | RegExp;
  kind: FaultKind;
  status?: number;
  count?: number;
  method?: string;
}
export interface FaultStats { kind: FaultKind; requested: number; applied: number; injectionErrors: number }
export class ProbeError extends Error { code: string; stats: FaultStats }
export const defaultFaults: readonly Readonly<{name: string; kind: FaultKind; status?: number}>[];
export function withFault(page: Page, options: FaultOptions, exercise: () => Promise<void>): Promise<FaultStats>;
export interface RecoveryConfig {
  name?: string;
  url: string;
  requestPattern: string;
  readySelector: string;
  retrySelector: string;
  timeoutMs?: number;
}
export interface ProbeRow { scenario: string; outcome: 'pass' | 'fail' | 'inconclusive' | 'skipped'; code: string; applied: number }
export function probeRecovery(browser: Browser, config: RecoveryConfig): Promise<{name: string; ok: boolean; results: ProbeRow[]}>;

export interface FetchFaultOptions {
  url: string;
  kind: FaultKind;
  status?: number;
  count?: number;
  method?: string;
}
export interface FetchFaultStats { kind: FaultKind; requested: number; applied: number; matchingRequests: number }
export function createFaultFetch(baseFetch: typeof fetch, options: FetchFaultOptions): {
  fetch: typeof fetch;
  summary(): FetchFaultStats;
  assertApplied(): FetchFaultStats;
};
