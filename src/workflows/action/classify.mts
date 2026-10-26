import type { RegionSummary } from '../../core/screen.mjs'
import { MAX_REQUESTS } from './config.mjs'
import type { ActionFinding, ActionRun, ActionRunKind } from './types.mjs'

const changedFrom = (run: ActionRun, ui: RegionSummary) =>
  ui.fingerprint !== run.before.fingerprint

const finding = (
  id: string,
  classification: string,
  kind: ActionFinding['kind'],
  advice: string,
): ActionFinding => ({ id, classification, kind, advice })

const noRequest = (id: string) =>
  finding(
    id,
    'NO_REQUEST',
    'inconclusive',
    'The action did not call the configured channel. Check the channel, the setup steps and whether input validation stopped the request.',
  )

/** Whether the failed run ended where the success run did, or only repeated its messages. */
function lookedLikeSuccess(
  failure: ActionRun,
  success: ActionRun | undefined,
  announcedOnFailure: string[],
) {
  const endedAsSuccess =
    success !== undefined &&
    success.requests > 0 &&
    changedFrom(success, success.final) &&
    failure.final.fingerprint === success.final.fingerprint
  return (
    endedAsSuccess ||
    (failure.announced.length > 0 && !announcedOnFailure.length)
  )
}

const showedError = (failure: ActionRun) =>
  failure.timeline.some(
    ({ ui }) =>
      (ui.error && !failure.before.error) ||
      (ui.retry && !failure.before.retry),
  )

// What the user saw after the failed request, compared with the simulated success.
function classifyFailure(
  failure: ActionRun,
  success: ActionRun | undefined,
): ActionFinding {
  const id = 'failure-feedback'
  if (!failure.requests) return noRequest(id)
  // A message the success run also announced says nothing about the failure.
  const announcedOnFailure = failure.announced.filter(
    (hash) => !success?.announced.includes(hash),
  )
  if (lookedLikeSuccess(failure, success, announcedOnFailure))
    return finding(
      id,
      'FALSE_SUCCESS',
      'suspected-defect',
      'The request failed, but the user was shown what a success shows. Show success only once the request succeeds.',
    )
  if (showedError(failure) || announcedOnFailure.length)
    return finding(
      id,
      'FEEDBACK_SHOWN',
      'observation',
      'An error, or a message other than the success one, was shown after the failed request.',
    )
  if (!changedFrom(failure, failure.final))
    return finding(
      id,
      'SILENT_FAILURE',
      'suspected-defect',
      'The request failed and the screen ended as it was before the action. Show an error the user can act on and keep their input for a retry.',
    )
  return finding(
    id,
    'UNCLEAR_FEEDBACK',
    'decision-needed',
    'The screen changed after the failed request but showed no recognisable error. Review whether the user can tell that it failed.',
  )
}

function classifyDoubleClick(double: ActionRun): ActionFinding {
  const id = 'double-click'
  if (!double.requests) return noRequest(id)
  return double.requests > 1
    ? finding(
        id,
        'DUPLICATE_SUBMIT',
        'suspected-defect',
        `A double-click sent ${double.requests} requests. Disable the action while its request is in flight.`,
      )
    : finding(
        id,
        'SINGLE_SUBMIT',
        'observation',
        'A double-click sent one request.',
      )
}

const kindsOf = (runs: ActionRun[]) => runs.map((r) => r.kind).join(', ')

/** Classifies what the user saw in each run. Exported for tests. */
export function classifyActionRuns(runs: ActionRun[]): ActionFinding[] {
  const run = (kind: ActionRunKind) => runs.find((r) => r.kind === kind)
  const success = run('success')
  const failure = run('failure')
  const double = run('double-click')
  const findings: ActionFinding[] = []
  if (success && !success.requests) findings.push(noRequest('success'))
  if (failure) findings.push(classifyFailure(failure, success))
  const uncaught = runs.filter((r) => r.uncaughtErrors > 0 || r.devErrorOverlay)
  if (uncaught.length)
    findings.push(
      finding(
        'uncaught-error',
        'UNCAUGHT_ERROR',
        'suspected-defect',
        `The ${kindsOf(uncaught)} run raised an uncaught error or rejection. Handle the result where the request is made.`,
      ),
    )
  if (double) findings.push(classifyDoubleClick(double))
  const escaped = runs.filter((r) => r.realRequests > 0)
  if (escaped.length)
    findings.push(
      finding(
        'real-requests',
        'REAL_REQUEST_SENT',
        'inconclusive',
        `More than ${MAX_REQUESTS} requests in the ${kindsOf(escaped)} run; the later ones reached the app's own handler.`,
      ),
    )
  return findings
}
