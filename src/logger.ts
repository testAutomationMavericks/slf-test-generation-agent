/**
 * src/logger.ts — Simple structured logger
 */

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL as keyof typeof LEVELS] ?? 1;
}

function timestamp(): string {
  return new Date().toISOString().split('T')[1].split('.')[0];
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog('debug')) console.debug(`[${timestamp()}] DEBUG ${msg}`, ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog('info')) console.log(`[${timestamp()}] INFO  ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog('warn')) console.warn(`[${timestamp()}] WARN  ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog('error')) console.error(`[${timestamp()}] ERROR ${msg}`, ...args);
  },
};
