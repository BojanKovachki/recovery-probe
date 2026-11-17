// Opens Chromium with a debugging port on the running app, which the observe checks attach to,
// and opens the page again whenever a file under public/ changes, so that it runs the current
// code. Start the app first (npm start), then run: node checks/open-browser.mjs
import { watch } from 'node:fs'
import { chromium } from 'playwright'

const app = process.env.APP_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({
  args: [
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
  ],
})
const page = await browser.newPage()
await page.goto(app)

let pending
watch('public', { recursive: true }, () => {
  clearTimeout(pending)
  pending = setTimeout(() => {
    page.goto(app).then(
      () => console.log('public/ changed: opened the page again.'),
      () => {},
    )
  }, 300)
})

console.log(
  `Chromium on http://127.0.0.1:9222 has ${app} open and opens it again when public/ changes, so there is no need to restart it. This helper's process id is ${process.pid}; Ctrl+C closes it and Chromium.`,
)
process.on('SIGINT', () => browser.close().then(() => process.exit(0)))
await new Promise(() => {})
