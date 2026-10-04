import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config';
import { connectDatabase } from './config/database';
import routes from './routes';
import { getPrometheusMetrics } from './services/metrics.service';
import { ProxyService } from './services/proxy.service';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: config.cors.origin, credentials: true }));

// Capture raw body buffer for HMAC webhook signature verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(morgan('dev'));

// ─── Direct Proxy Route Mounts (e.g. /p/:projectId/*) ─────────────────────────
app.all('/p/:projectId/*', (req, res) => {
  ProxyService.handleProxyRequest(req, res, req.params.projectId);
});
app.all('/p/:projectId', (req, res) => {
  ProxyService.handleProxyRequest(req, res, req.params.projectId);
});

// ─── Root Prometheus Metrics Endpoint ─────────────────────────────────────────
app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await getPrometheusMetrics();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics);
  } catch (err: any) {
    res.status(500).send(`Error collecting metrics: ${err.message}`);
  }
});

// ─── Root Status Endpoint ───────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'DeployHub API',
    status: 'online',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      metrics: '/metrics',
      auth: '/api/auth/login',
      projects: '/api/projects'
    },
    timestamp: new Date().toISOString()
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function bootstrap() {
  await connectDatabase();

  // Initialize distributed proxy sync
  ProxyService.initSync();

  app.listen(config.port, () => {
    console.log(`\n🚀 DeployHub API running on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   MongoDB: ${config.mongodb.uri}`);
    console.log(`   Redis: ${config.redis.host}:${config.redis.port}`);
    console.log(`   Prometheus Metrics: http://localhost:${config.port}/metrics\n`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
