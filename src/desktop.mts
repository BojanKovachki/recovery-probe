export {
  type DesktopConfig,
  type ValidDesktopConfig,
  validateDesktopConfig,
} from './workflows/check/http/config.mjs'
export type { DesktopRow } from './workflows/check/http/fault.mjs'
export {
  type DesktopReport,
  checkDesktop,
} from './workflows/check/http/run.mjs'
export { type DesktopDiscovery, discoverDesktop } from './workflows/reads.mjs'
export { pageIdentity } from './core/urls.mjs'
export {
  connectDesktop,
  desktopPages,
  selectDesktopPage,
} from './targets/cdp.mjs'
