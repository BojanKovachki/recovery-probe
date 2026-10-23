import { runDoctor } from '../tools/doctor.mjs'
import { parseOptions, text } from './args.mjs'

const HELP = `recovery-probe doctor [--cdp URL] [--inspector URL] [--json]

Checks what Recovery Probe needs and says how to fix what's missing:
Node.js, Playwright and Chromium, an app on the debugging port (--cdp, default
http://127.0.0.1:9222) and the IPC hook (--inspector, default http://127.0.0.1:9229).
Exits 0 when nothing blocks a check, 2 otherwise.`

export async function doctorMain(args: string[]) {
  if (args.includes('--help')) {
    console.log(HELP)
    return
  }
  const { values } = parseOptions(args, {
    json: { type: 'boolean' },
    cdp: { type: 'string' },
    inspector: { type: 'string' },
  })
  const json = values.json === true
  const options = {
    cdp: text(values, 'cdp'),
    inspector: text(values, 'inspector'),
  }
  const report = await runDoctor(options)
  process.exitCode = report.ok ? 0 : 2
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`Recovery Probe ${report.version}\n`)
  for (const check of report.checks) {
    console.log(`${check.status.padEnd(8)} ${check.name}: ${check.detail}`)
    if (check.fix)
      console.log(
        check.fix
          .split('\n')
          .map(
            (line, index) => `${' '.repeat(9)}${index ? '' : 'Fix: '}${line}`,
          )
          .join('\n'),
      )
  }
  if (report.ipc)
    console.log(
      `\nChannels the hook can fail: ${report.ipc.registered.join(', ') || 'none'}`,
    )
}
