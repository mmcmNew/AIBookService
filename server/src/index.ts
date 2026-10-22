import dotenv from 'dotenv';
dotenv.config();

const { createApp } = await import('./app.js');
const { config } = await import('./config.js');
const { createGracefulShutdown } = await import('./shutdown.js');
const { collectConfigWarnings } = await import('./startupChecks.js');

const port = process.env.PORT || 4000;
const { app, db } = createApp();

const warnings = collectConfigWarnings(process.env);
for (const warn of warnings) {
  console.warn(`[config warning] ${warn}`);
}

const server = app.listen(port, () => {
  console.log(`AIBookReader Cloud Server запущен на порту ${port}`);
  console.log(`YooKassa: ${config.yookassaConfigured() ? 'боевой режим' : 'DEV-симуляция'}`);
});

const shutdown = createGracefulShutdown(server, db);

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  void shutdown('uncaughtException', 1);
});

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));

