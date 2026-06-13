import { loadConfig } from './config';
import { createServer } from './server';

async function main() {
  const config = loadConfig();
  const app = await createServer(config);

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`control-plane listening on ${address}`);
  } catch (err) {
    console.error('Failed to start control-plane:', err);
    process.exit(1);
  }
}

main();
