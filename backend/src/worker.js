import { bootstrap } from './bootstrap.js';

const { engine, logger } = bootstrap();
logger.info('Worker started');
engine.start();
