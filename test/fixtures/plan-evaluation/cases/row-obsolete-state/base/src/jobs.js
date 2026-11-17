import { formatJob } from './format.js'

export function createJobList(document) {
  let jobs = []
  const render = () => {
    document.querySelector('#jobs').innerHTML = jobs.map(formatJob).join('')
  }
  const read = async (path) => {
    const response = await fetch(path)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  return {
    async load() {
      jobs = await read('/api/jobs')
      render()
    },
    async checkStatus() {
      const current = await read('/api/jobs/status')
      jobs = jobs.map((job) => ({
        ...current.find((update) => update.id === job.id),
        ...job,
      }))
      render()
    },
  }
}
