export const formatJob = (job) =>
  `<li data-job="${job.id}" title="${job.name}">${job.name} <span class="state">${job.state}</span></li>`
