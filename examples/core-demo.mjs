import { createFaultFetch, defaultFaults } from '../src/index.mjs';
import { startDemoServer } from './demo-server.mjs';
import { createProfileController } from './profile-controller.mjs';

export async function runCoreDemo() {
  const server = await startDemoServer();
  const endpoint = `${server.url}/api/profile`;
  const apps = [];
  try {
    for (const fixed of [false, true]) {
      const results = [];
      const baseline = createProfileController(() => fetch(endpoint), { fixed });
      await baseline.load();
      results.push({ scenario: 'Normal connection', outcome: baseline.getState().phase === 'ready' ? 'pass' : 'fail', injected: 0 });
      for (const fault of defaultFaults) {
        const probe = createFaultFetch(fetch, { ...fault, url: endpoint });
        const controller = createProfileController(() => probe.fetch(endpoint), { fixed });
        await controller.load();
        const afterFault = controller.getState().phase;
        await controller.load();
        const stats = probe.assertApplied();
        results.push({ scenario: fault.name, outcome: controller.getState().phase === 'ready' ? 'pass' : 'fail', afterFault, afterRetry: controller.getState().phase, injected: stats.applied });
      }
      apps.push({ name: fixed ? 'Corrected controller' : 'Broken controller', results });
    }
  } finally { await server.close(); }
  const expectedDemonstrationVerified = apps[0].results[0].outcome === 'pass'
    && apps[0].results.slice(1).every(row => row.outcome === 'fail' && row.afterFault === 'error')
    && apps[1].results.every(row => row.outcome === 'pass');
  return {
    prototype: 'Recovery Probe 0.1', generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform },
    scope: 'Fetch fault engine and shared application controller over local HTTP; no browser engine in this run.',
    apps, expectedDemonstrationVerified,
    browserIntegration: 'Not executed: standalone browser download timed out; the managed browser lacks request interception.',
  };
}
