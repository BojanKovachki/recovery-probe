import type { Browser, Page } from 'playwright';
import type { FaultKind } from './fetch-fault.mjs';
export { createFaultFetch } from './fetch-fault.mjs';
export type { FaultKind, FetchFaultOptions, FetchFaultStats } from './fetch-fault.mjs';

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
