/**
 * Environment config: dotenv for local dev, process.env for production.
 * Exits process if REDIS_URL is missing.
 */

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const required = ['REDIS_URL'];
const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');
if (missing.length > 0) {
  console.error('[config] Missing required ENV:', missing.join(', '));
  process.exit(1);
}

const PORT = parseInt(process.env.PORT, 10) || 3001;
const REDIS_URL = process.env.REDIS_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

module.exports = {
  PORT,
  REDIS_URL,
  NODE_ENV,
  CORS_ORIGIN,
};
