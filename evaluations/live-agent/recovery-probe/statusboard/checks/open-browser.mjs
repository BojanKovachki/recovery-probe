// Opens Chromium with a debugging port on the running app, which the observe checks attach to.
// Start the app first (npm start), then run: node checks/open-browser.mjs
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
console.log(
  `Chromium on http://127.0.0.1:9222 has ${app} open. Leave it running; Ctrl+C closes it.`,
)
process.on('SIGINT', () => browser.close().then(() => process.exit(0)))
await new Promise(() => {})
