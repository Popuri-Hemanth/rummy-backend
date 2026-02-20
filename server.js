/**
 * Production-ready Express + Socket.IO server.
 * Railway + Upstash Redis. Env: PORT, REDIS_URL, NODE_ENV, CORS_ORIGIN.
 */

require('./config/env');
const config = require('./config/env');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { createAdapter } = require('@socket.io/redis-adapter');
const redis = require('./services/redis');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, methods: ['GET', 'POST'], credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(compression());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { ok: false, reason: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
  })
);
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    redis: redis.getRedisStatus(),
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ ok: false, reason: 'userId required' });
    }
    const stats = await redis.getStats(userId);
    res.json({ ok: true, stats });
  } catch (error) {
    console.error('GET /api/stats error:', error);
    res.status(500).json({ ok: false, reason: error.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const leaderboard = await redis.getLeaderboard(limit);
    res.json(leaderboard);
  } catch (error) {
    console.error('GET /api/leaderboard error:', error);
    res.status(500).json({ ok: false, reason: error.message });
  }
});

const { pubClient, subClient } = redis.getClients();
io.adapter(createAdapter(pubClient, subClient));

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

require('./socket')(io, redis);

app.use((err, req, res, next) => {
  console.error('[express] Unhandled error:', err.stack);
  res.status(500).json({ ok: false, reason: 'Internal server error' });
});

process.on('unhandledRejection', (reason, p) => {
  console.error('[critical] Unhandled rejection at Promise', p, 'reason:', reason);
  if (reason && typeof reason === 'object' && reason.stack) {
    console.error(reason.stack);
  }
});

const PORT = config.PORT;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Running on port ${PORT} (NODE_ENV=${config.NODE_ENV})`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down gracefully`);
  server.close(() => {
    redis.disconnect().then(() => {
      console.log('[server] Exit');
      process.exit(0);
    }).catch((err) => {
      console.error('[server] Redis disconnect error:', err);
      process.exit(1);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
