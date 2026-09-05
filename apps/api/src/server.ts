import { createLogger, createPool, loadConfig } from '@pulse/core';
import { createApp } from './app.ts';
import { StreamHub } from './stream/hub.ts';
import { createChangeListener, type ChangeListener } from './stream/listener.ts';
import { runBackgroundLoops } from '@pulse/worker/loops';

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
    workerInProcess: config.runWorkerInApi,
  });
});

/**
 * Ingestion and detection inside the web process.
 *
 * Free hosting tiers generally bill background workers but not web services, so
 * a $0 deployment has to run both here. Locally the standalone worker is still
 * the better choice -- it restarts independently of the API.
 */
const background = new AbortController();
if (config.runWorkerInApi) {
  void runBackgroundLoops({ config, pool, logger, signal: background.signal }).catch(
    (err: unknown) => {
      // The dashboard must stay up even if ingestion dies.
      logger.error('background loops stopped', { error: (err as Error).message });
    },
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    background.abort();
    hub.close();
    void listener.stop().finally(() => {
      server.close(() => {
        void pool.end().then(() => process.exit(0));
      });
    });
  });
}
