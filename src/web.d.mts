import type { Browser, BrowserContext, Page } from 'playwright';
import type { DesktopConfig, DesktopReport, DesktopRow } from './desktop.mjs';
export interface WebConfig extends Omit<DesktopConfig, 'cdp'> {
  storageState?: string;
  headless?: boolean;
  startupTimeoutMs?: number;
}
export function openWeb(config: Pick<WebConfig, 'pageUrl' | 'storageState' | 'headless' | 'startupTimeoutMs'>): Promise<{ browser: Browser; context: BrowserContext; page: Page }>;
export function checkWeb(config: WebConfig, options?: {onFailure?: (page: Page, row: DesktopRow) => Promise<void>}): Promise<DesktopReport>;
export function discoverWeb(config: Pick<WebConfig, 'pageUrl' | 'storageState' | 'headless' | 'startupTimeoutMs'>, options?: { durationMs?: number; maxEndpoints?: number }): ReturnType<typeof import('./desktop.mjs').discoverDesktop>;
