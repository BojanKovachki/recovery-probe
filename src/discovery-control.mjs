// A stable intermediate screen is not a healthy control once a baseline exists.
export function matchesHealthyControl(ui, expectedFingerprint) {
  return expectedFingerprint === undefined || ui.fingerprint === expectedFingerprint;
}

// Keep completed runs visible when a later control aborts an experiment.
// Partial evidence must not inherit a confirmed defect/healthy verdict.
export function retainPartialFindings(report, plannedRuns) {
  const groups = new Map();
  for (const run of report.results) {
    const id = `${run.fault}-${run.times}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  for (const [id, runs] of groups) {
    if (report.findings.some(finding => finding.id === id)) continue;
    const interpretations = runs.map(run => run.interpretation ?? run.assessment);
    const consistent = interpretations.every(value => value.classification === interpretations[0].classification);
    report.findings.push({ id, fault: runs[0].fault, times: runs[0].times,
      classification: 'INCOMPLETE_EXPERIMENT', kind: 'inconclusive', confidence: 'low',
      confirmations: runs.length, completedRuns: runs.length, plannedRuns,
      partial: true, repeatConfirmed: false,
      observedInterpretation: consistent ? interpretations[0] : { classification: 'UNSTABLE', kind: 'inconclusive' },
      stoppedReason: report.error ?? 'Experiment interrupted',
      advice: 'Completed runs are partial evidence. Resolve the stopped control before claiming repeat confirmation.',
    });
  }
}
