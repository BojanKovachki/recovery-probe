export const formatJob = (job) =>
  `<li data-job="${job.id}">${job.name} <span class="state">${job.state}</span></li>`
