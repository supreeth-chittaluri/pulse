import { createLogger, createPool, loadConfig } from '@pulse/core';
import { createApp } from './app.ts';
import { StreamHub } from './stream/hub.ts';
import { createChangeListener, type ChangeListener } from './stream/listener.ts';

const logger = createLogger('api');
const config = loadConfig();
const pool = createPool(config.databaseUrl);

const hub = new StreamHub({ pool, logger });
await hub.initialize();

const listener: ChangeListener = await createChangeListener({
  databaseUrl: config.databaseUrl,
  logger,
  onChange: () => hub.wake(),
});

const app = createApp({ config, pool, logger, hub });

const server = app.listen(config.port, () => {
  logger.info('api listening', {
    port: config.port,
    env: config.nodeEnv,
    streamSource: listener.kind,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    hub.close();
    void listener.stop().finally(() => {
      server.close(() => {
        void pool.end().then(() => process.exit(0));
      });
    });
  });
}
