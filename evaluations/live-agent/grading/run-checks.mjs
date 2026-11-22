// Runs a task's behavior checks against an app directory. Every check gets a fresh server,
// so the data starts from the seed, and a fresh browser context.
import { chromium } from 'playwright'
import { serve } from './serve.mjs'

const CHECK_MS = 45000

async function runCheck(browser, directory, check) {
  const context = await browser.newContext()
  const page = await context.newPage()
  let server
  let timer
  try {
    server = await serve(directory)
    await Promise.race([
      check(page, server.origin),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no result within ${CHECK_MS} ms`)),
          CHECK_MS,
        )
      }),
    ])
    return { pass: true }
  } catch (error) {
    return { pass: false, detail: String(error.message).split('\n')[0] }
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => {})
    await server?.stop()
  }
}

/**
 * Every check of the task's app against `directory`: the task's required checks, and every
 * other check of the app as a regression check.
 */
export async function runChecks(directory, rule) {
  const { checks } = await import(`./checks/${rule.app}.mjs`)
  for (const name of rule.required)
    if (!checks[name]) throw new Error(`No check named ${name} for ${rule.app}`)
  const browser = await chromium.launch()
  const required = {}
  const regression = {}
  try {
    for (const [name, check] of Object.entries(checks)) {
      const result = await runCheck(browser, directory, check)
      ;(rule.required.includes(name) ? required : regression)[name] = result
    }
  } finally {
    await browser.close()
  }
  return { required, regression }
}
