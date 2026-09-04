type Level = 'debug' | 'info' | 'warn' | 'error';

/** Structured single-line logs -- greppable locally, parseable once deployed. */
function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, scope, message, ...fields };
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(JSON.stringify(line));
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit('debug', scope, m, f),
    info: (m: string, f?: Record<string, unknown>) => emit('info', scope, m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit('warn', scope, m, f),
    error: (m: string, f?: Record<string, unknown>) => emit('error', scope, m, f),
  };
}

export type Logger = ReturnType<typeof createLogger>;
