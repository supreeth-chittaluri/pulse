import { createLogger, createPool, loadConfig } from '@pulse/core';
import { createApp } from './app.ts';

const logger = createLogger('api');
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({ config, pool, logger });

const server = app.listen(config.port, () => {
  logger.info('api listening', { port: config.port, env: config.nodeEnv });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
