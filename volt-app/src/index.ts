import { createServer } from './server';
import { config } from './config';
import { pool } from './db';
import { startScheduler } from './services/orchestrator';

const app = createServer();

const server = app.listen(config.port, () => {
  console.log(`Volt control plane listening on :${config.port} (${config.env})`);
});

// orchestrator background scheduler (event provisioning, recording roll, retention sweep)
const stopScheduler = startScheduler();

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  stopScheduler();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
