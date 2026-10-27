// What the fixture apps put on the page's window, for tests that read it back.
interface Window {
  /** The Electron fixture's preload, which a check must leave in place. */
  recoveryProbeFixture: { kind: string }
  /** Set on the main process only; a test checks the page can't see it. */
  __recoveryProbeIpc?: unknown
  /** Random per page load, so a test can tell a reload happened. */
  fixtureNonce: number
  /** Set by a fixture button when a click reaches the page. */
  clicked?: boolean
  /** The slow-reads fixture's request bridge, and its own postMessage to compare with. */
  fixtureBridge: { postMessage: unknown }
  originalPost: unknown
}
