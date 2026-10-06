// Netlify function: reads Google Analytics 4 and Search Console on behalf of
// the dashboard, so viewers need no Google login or GA access.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   Either a saved Google sign-in:
//     GA_OAUTH_CLIENT_ID, GA_OAUTH_CLIENT_SECRET, GA_REFRESH_TOKEN
//   or a service account key:
//     GA_CLIENT_EMAIL   the service account's email (client_email in the JSON key)
//     GA_PRIVATE_KEY    the private key (private_key in the JSON key)
//   DASHBOARD_PASSWORD  optional: if set, viewers must enter this password

import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly';
let cached = { token: null, exp: 0 };

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fail = (message, status = 500) => Object.assign(new Error(message), { status });

function credentials() {
  const email = (process.env.GA_CLIENT_EMAIL || '').trim();
  let key = process.env.GA_PRIVATE_KEY || '';
  if (!email || !key) throw fail('The dashboard is not connected to Google Analytics yet. Add GA_OAUTH_CLIENT_ID, GA_OAUTH_CLIENT_SECRET and GA_REFRESH_TOKEN (or GA_CLIENT_EMAIL and GA_PRIVATE_KEY) in Netlify under Site configuration → Environment variables, then redeploy.');
  key = key.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  return { email, key };
}

async function refreshTokenLogin() {
  const client_id = (process.env.GA_OAUTH_CLIENT_ID || '').trim();
  const client_secret = (process.env.GA_OAUTH_CLIENT_SECRET || '').trim();
  const refresh_token = (process.env.GA_REFRESH_TOKEN || '').trim();
  if (!client_id || !client_secret) throw fail('GA_REFRESH_TOKEN is set, but GA_OAUTH_CLIENT_ID or GA_OAUTH_CLIENT_SECRET is missing in Netlify.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id, client_secret, refresh_token })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(`Google rejected the saved sign-in: ${j.error_description || j.error || r.status}. Create a new refresh token and update GA_REFRESH_TOKEN in Netlify.`);
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return cached.token;
}

async function accessToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  // Option A: a saved Google sign-in (refresh token). Option B: a service account key.
  if (process.env.GA_REFRESH_TOKEN) return refreshTokenLogin();
  const { email, key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  let sig;
  try { sig = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key); }
  catch { throw fail('GA_PRIVATE_KEY could not be read. Paste the full private_key value from the JSON key file, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines.'); }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(sig)}` })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(`Google rejected the service account sign-in: ${j.error_description || j.error || r.status}. Check GA_CLIENT_EMAIL and GA_PRIVATE_KEY.`);
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return cached.token;
}

async function google(url, body) {
  const token = await accessToken();
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) cached = { token: null, exp: 0 };
    // Never pass Google's 401 through: the page reads 401 as "wrong password".
    throw fail(j.error?.message || `Google returned an error (${r.status}).`, r.status === 401 ? 502 : r.status);
  }
  return j;
}

function authorised(req) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return true;
  const given = req.headers.get('x-dashboard-key') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  if (!authorised(req)) return json(401, { error: 'Password required.' });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  try {
    if (action === 'properties') {
      const out = [];
      let page = '';
      do {
        const j = await google('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
        (j.accountSummaries || []).forEach(a => (a.propertySummaries || []).forEach(p =>
          out.push({ id: p.property.split('/')[1], name: p.displayName, account: a.displayName })));
        page = j.nextPageToken || '';
      } while (page);
      return json(200, { properties: out });
    }
    if (action === 'report' && req.method === 'POST') {
      const property = url.searchParams.get('property') || '';
      if (!/^\d+$/.test(property)) return json(400, { error: 'Invalid property.' });
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.requests) || body.requests.length < 1 || body.requests.length > 5) return json(400, { error: 'Invalid report request.' });
      return json(200, await google(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:batchRunReports`, { requests: body.requests }));
    }
    if (action === 'gsc_sites') {
      return json(200, await google('https://www.googleapis.com/webmasters/v3/sites'));
    }
    if (action === 'gsc_batch' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const site = body && typeof body.site === 'string' ? body.site : '';
      if (!/^(sc-domain:|https?:\/\/)/.test(site)) return json(400, { error: 'Invalid Search Console site.' });
      if (!Array.isArray(body.queries) || body.queries.length < 1 || body.queries.length > 8) return json(400, { error: 'Invalid Search Console request.' });
      const allowed = ['startDate', 'endDate', 'dimensions', 'type', 'rowLimit', 'startRow', 'dataState', 'aggregationType', 'dimensionFilterGroups'];
      const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
      const results = await Promise.all(body.queries.map(q =>
        google(url, Object.fromEntries(Object.entries(q || {}).filter(([k]) => allowed.includes(k))))));
      return json(200, { results });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
