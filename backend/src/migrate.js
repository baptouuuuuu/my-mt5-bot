import { loadConfig } from './config.js';
import { openDb } from './db.js';

openDb(loadConfig().dbPath);
console.log('Migrations applied');
