import { bootstrap } from './bootstrap.js';
import { createApp } from './app.js';

const ctx = bootstrap();
const app = createApp(ctx);
app.listen(ctx.config.port, () => {
  ctx.logger.info(`API listening on :${ctx.config.port}`, { embedWorker: ctx.config.embedWorker });
  if (ctx.config.embedWorker) ctx.engine.start();
});
