import { spawn } from 'node:child_process';

const port = 32000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    DISABLE_BACKGROUND_JOBS: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', chunk => output.push(chunk.toString()));
server.stderr.on('data', chunk => output.push(chunk.toString()));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`El servidor terminó antes de responder:\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {
      // El proceso todavía está iniciando.
    }
    await sleep(100);
  }
  throw new Error(`El servidor no respondió en 10 segundos:\n${output.join('')}`);
}

try {
  const healthResponse = await waitForServer();
  const health = await healthResponse.json();
  if (health.status !== 'ok' || typeof health.argentina_hour !== 'number') {
    throw new Error(`Respuesta inválida de /health: ${JSON.stringify(health)}`);
  }

  const uiResponse = await fetch(`${baseUrl}/ui/`);
  const ui = await uiResponse.text();
  if (!uiResponse.ok || !ui.includes('Voice Bot')) {
    throw new Error(`El dashboard no respondió correctamente (HTTP ${uiResponse.status})`);
  }

  const callsResponse = await fetch(`${baseUrl}/calls`);
  const calls = await callsResponse.json();
  if (!callsResponse.ok || !Array.isArray(calls.calls)) {
    throw new Error(`Respuesta inválida de /calls: ${JSON.stringify(calls)}`);
  }

  console.log(`Smoke test OK: /health, /ui/ y /calls en ${baseUrl}`);
} finally {
  if (server.exitCode === null) server.kill();
}
