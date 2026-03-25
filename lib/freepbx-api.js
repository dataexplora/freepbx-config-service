const TOKEN_URL = 'http://localhost/admin/api/api/token';
const API_BASE = 'http://localhost/admin/api/api/rest';
const SCOPES = 'rest:timeconditions:read rest:timeconditions:write rest:daynight:read rest:daynight:write';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get OAuth2 token (cached, auto-refresh)
 */
async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.FREEPBX_CLIENT_ID;
  const clientSecret = process.env.FREEPBX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FREEPBX_CLIENT_ID or FREEPBX_CLIENT_SECRET not set');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: SCOPES,
  });

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth2 token failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);

  console.log('[FREEPBX-API] Token refreshed, expires in', data.expires_in, 's');
  return cachedToken;
}

/**
 * Authenticated request to FreePBX REST API
 */
async function apiRequest(method, path, body = null) {
  const token = await getToken();
  const url = `${API_BASE}${path}`;

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  let res = await fetch(url, opts);

  // Retry once on 401 (token may have expired early)
  if (res.status === 401) {
    cachedToken = null;
    const newToken = await getToken();
    opts.headers['Authorization'] = `Bearer ${newToken}`;
    res = await fetch(url, opts);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FreePBX API ${method} ${path}: ${res.status} ${text}`);
  }

  return res.json().catch(() => null);
}

const STATE_LABELS = {
  'auto': 'Automatic (Follow Schedule)',
  'true': 'Force Open (AI Active)',
  'true_sticky': 'Force Open Persistent (AI Active)',
  'false': 'Force Closed (AI Off)',
  'false_sticky': 'Force Closed Persistent (AI Off)',
};

const VALID_STATES = Object.keys(STATE_LABELS);

async function getTimecondition(id) {
  return apiRequest('GET', `/timeconditions/${id}`);
}

async function listTimeconditions() {
  return apiRequest('GET', '/timeconditions/');
}

async function setTimeconditionState(id, state) {
  return apiRequest('PUT', `/timeconditions/${id}`, { state });
}

// --- Call Flow Control (DAYNIGHT) ---

async function getCallflow(ext) {
  return apiRequest('GET', `/daynight/${ext}`);
}

async function listCallflows() {
  return apiRequest('GET', '/daynight/');
}

async function setCallflowState(ext, state) {
  return apiRequest('PUT', `/daynight/${ext}`, { state });
}

module.exports = {
  getTimecondition,
  listTimeconditions,
  setTimeconditionState,
  getCallflow,
  listCallflows,
  setCallflowState,
  STATE_LABELS,
  VALID_STATES,
};
