import type { Browser, Page } from 'playwright';
import type { FaultKind } from './fetch-fault.mjs';
export interface DesktopConfig {
  cdp?: string; page?: number; pageUrl: string; endpoint: string;
  readySelector: string; readyText?: string; busySelector?: string;
  recovery?: 'retry' | 'automatic'; retrySelector?: string; timeoutMs?: number; baselineTimeoutMs?: number; recoveryTimeoutMs?: number; times?: number; faults?: FaultKind[];
}
export interface DesktopRow {
  kind: FaultKind; outcome: 'pass' | 'fail' | 'inconclusive' | 'skipped'; code: string;
  applied: number; successfulResponsesAfterFault: number; retryClicked: boolean;
  recoveryMs?: number | null;
  screenshot?: string; evidenceCaptureFailed?: boolean;
}
export interface DesktopReport {
  schemaVersion: number; mode: string; generatedAt: string; endpoint: string;
  recovery: string; timeoutMs: number; results: DesktopRow[]; finalReset: string; ok: boolean; limitation: string;
}
export function pageIdentity(url: string): string;
export function validateDesktopConfig(config: DesktopConfig): DesktopConfig;
export function connectDesktop(cdp?: string): Promise<Browser>;
export function desktopPages(browser: Browser): Page[];
export function selectDesktopPage(browser: Browser, config?: {page?: number; pageUrl?: string}): Page;
export function discoverDesktop(page: Page, options?: {durationMs?: number; maxEndpoints?: number}): Promise<{pageUrl: string; endpoints: {endpoint: string; method: string; observed: number; queryValuesOmitted: boolean}[]; limitation: string}>;
export function checkDesktop(page: Page, config: DesktopConfig, options?: {onFailure?: (page: Page, row: DesktopRow) => Promise<void>}): Promise<DesktopReport>;
