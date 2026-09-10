import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

function app(fixed) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Recovery Probe fixture</title>
<main><h1>Sample profile</h1><p id="status" role="status"></p><p id="profile" hidden></p><button id="retry" hidden>Retry</button></main>
<script type="module">
import { createProfileController } from '/profile-controller.mjs';
const status = document.querySelector('#status');
const profile = document.querySelector('#profile');
const retry = document.querySelector('#retry');
const controller = createProfileController(() => fetch('/api/profile'), {
  fixed: ${fixed},
  onChange(state) {
    status.textContent = state.phase;
    retry.hidden = state.phase !== 'error';
    profile.hidden = state.phase !== 'ready';
    profile.textContent = state.name ?? '';
  },
});
retry.addEventListener('click', () => controller.load());
controller.load();
</script></html>`;
}

export async function startDemoServer() {
  const controllerSource = await readFile(new URL('./profile-controller.mjs', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/api/profile') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ name: 'Synthetic Example', method: request.method }));
    } else if (path === '/profile-controller.mjs') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(controllerSource);
    } else if (path === '/broken' || path === '/fixed') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(app(path === '/fixed'));
    } else {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
