function authMiddleware(req, res, next) {
  const token = process.env.CONFIG_SERVICE_TOKEN;

  if (!token) {
    console.error('[AUTH] CONFIG_SERVICE_TOKEN not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (provided !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { authMiddleware };
