require('dotenv').config();

const fs = require('fs');
const https = require('https');
const express = require('express');
const { authMiddleware } = require('./middleware/auth');
const hoursRoutes = require('./routes/hours');
const aiRoutes = require('./routes/ai');
const callflowRoutes = require('./routes/callflow');
const recordingsRoutes = require('./routes/recordings');
const onboardRoutes = require('./routes/onboard');
const teardownRoutes = require('./routes/teardown');

const app = express();
const PORT = process.env.PORT || 8443;

const SSL_KEY_PATH = process.env.SSL_KEY_PATH
  || '/etc/letsencrypt/live/pbx.ckstudios.work/privkey.pem';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH
  || '/etc/letsencrypt/live/pbx.ckstudios.work/fullchain.pem';

// JSON parsing for all routes except recordings (which receive raw audio)
app.use((req, res, next) => {
  if (req.path.startsWith('/recordings') && req.method === 'PUT') {
    return next();
  }
  express.json({ limit: '1mb' })(req, res, next);
});

// Health — no auth
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

// Protected routes
app.use('/hours', authMiddleware, hoursRoutes);
app.use('/ai', authMiddleware, aiRoutes);
app.use('/callflow', authMiddleware, callflowRoutes);
app.use('/recordings', authMiddleware, recordingsRoutes);
app.use('/onboard', authMiddleware, onboardRoutes);
app.use('/teardown', authMiddleware, teardownRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start HTTPS
const httpsOptions = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH),
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`FreePBX Config Service listening on HTTPS port ${PORT}`);
});
