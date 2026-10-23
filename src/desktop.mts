export {
  type DesktopConfig,
  type ValidDesktopConfig,
  type DesktopRow,
  type DesktopReport,
  validateDesktopConfig,
  checkDesktop,
} from './workflows/check/http.mjs'
export { type DesktopDiscovery, discoverDesktop } from './workflows/reads.mjs'
export { pageIdentity } from './core/urls.mjs'
export {
  connectDesktop,
  desktopPages,
  selectDesktopPage,
} from './targets/cdp.mjs'
