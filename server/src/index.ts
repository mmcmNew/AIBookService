import dotenv from 'dotenv';
dotenv.config();

const { createApp } = await import('./app.js');
const { config } = await import('./config.js');

const port = process.env.PORT || 4000;
const { app, db } = createApp();

if (!config.yookassaConfigured() && config.isProduction()) {
  console.warn('YooKassa не настроена: в production создание платежей отключено.');
}

const server = app.listen(port, () => {
  console.log(`AIBookReader Cloud Server запущен на порту ${port}`);
  console.log(`YooKassa: ${config.yookassaConfigured() ? 'боевой режим' : 'DEV-симуляция'}`);
});

async function shutdown() {
  server.close();
  await db.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
