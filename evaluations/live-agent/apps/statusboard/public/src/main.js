import * as api from './api.js'
import { createHealth } from './health.js'
import { createNotifications } from './notifications.js'
import { createSync } from './sync.js'

const $ = (selector) => document.querySelector(selector)

const health = createHealth(
  {
    status: $('#health-status'),
    list: $('#services'),
    error: $('#health-error'),
    retry: $('#health-retry'),
  },
  api,
)
const notifications = createNotifications(
  {
    list: $('#notifications'),
    empty: $('#notifications-empty'),
    error: $('#notifications-error'),
    retry: $('#notifications-retry'),
  },
  api,
)
createSync({ button: $('#sync'), status: $('#sync-status') }, api, () =>
  health.load(),
)

api
  .account()
  .then((account) => ($('#account').textContent = account.name))
  .catch(() => {})
health.load()
notifications.load()
