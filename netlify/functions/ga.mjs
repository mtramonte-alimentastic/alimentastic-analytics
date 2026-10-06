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

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/spreadsheets.readonly';
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

// ---------- Social sheet parsing (Windsor export) ----------
const COLS = {
  date: ['date'],
  datasource: ['datasource', 'data source', 'source'],
  account: ['account_name', 'account name'],
  ig_followers: ['followers_count', 'profile followers'],
  reach: ['reach'],
  views: ['views'],
  interactions: ['total_interactions', 'total interactions'],
  li_impr: ['account_analytics_impression_count', 'total impression count'],
  li_uimpr: ['account_analytics_unique_impressions_count', 'total unique impression count'],
  li_eng: ['account_analytics_total_engagements', 'total engagements'],
  li_followers: ['organization_follower_count', 'organization follower count'],
  li_gain_org: ['followers_gain_organic', "organic growth of the organization's followers per day"],
  li_gain_paid: ['followers_gain_paid', "paid growth of the organization's followers per day"]
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  const n = Number(s.replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
};
function toIsoDate(v) {
  if (typeof v === 'number' && v > 20000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function parseSocial(values) {
  if (!values.length) return { rows: [], firstDate: null, lastDate: null };
  const head = values[0].map(norm);
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex(h => names.includes(h));
  if (idx.datasource < 0) idx.datasource = head.findIndex(h => h === 'source');
  const get = (row, k) => idx[k] >= 0 ? row[idx[k]] : null;
  const rows = [];
  for (const row of values.slice(1)) {
    const date = toIsoDate(get(row, 'date'));
    const account = String(get(row, 'account') ?? '').trim();
    if (!date || !account) continue;
    let src = norm(get(row, 'datasource'));
    if (!src) src = num(get(row, 'li_impr')) != null || num(get(row, 'li_followers')) != null ? 'linkedin' : 'instagram';
    const platform = src.includes('linkedin') ? 'linkedin' : src.includes('instagram') ? 'instagram' : src.includes('facebook') ? 'facebook' : src;
    if (platform === 'linkedin') {
      const go = num(get(row, 'li_gain_org')), gp = num(get(row, 'li_gain_paid'));
      rows.push({ date, platform, account,
        reach: num(get(row, 'li_uimpr')), impressions: num(get(row, 'li_impr')), engagements: num(get(row, 'li_eng')),
        followers: num(get(row, 'li_followers')), newFollowers: go == null && gp == null ? null : (go || 0) + (gp || 0) });
    } else {
      rows.push({ date, platform, account,
        reach: num(get(row, 'reach')), impressions: num(get(row, 'views')), engagements: num(get(row, 'interactions')),
        followers: num(get(row, 'ig_followers')), newFollowers: null });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, firstDate: rows[0]?.date || null, lastDate: rows[rows.length - 1]?.date || null };
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
    if (action === 'social') {
      let id = (process.env.SOCIAL_SHEET_ID || '').trim();
      const m = id.match(/\/d\/([a-zA-Z0-9_-]+)/); if (m) id = m[1];
      if (!id) throw fail('The social data sheet is not connected yet. Add SOCIAL_SHEET_ID (the Google Sheet link or ID) in Netlify under Site configuration → Environment variables, then redeploy.');
      const tab = (process.env.SOCIAL_SHEET_TAB || '').trim();
      const fTab = (process.env.SOCIAL_FOLLOWERS_TAB || '').trim();
      const rng = (name) => name ? `'${name.replace(/'/g, "''")}'!A1:Z` : 'A1:Z';
      const ranges = [rng(tab)].concat(fTab ? [rng(fTab)] : []);
      const qs = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
      let j;
      try {
        j = await google(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
      } catch (e) {
        if (fTab && /Unable to parse range/i.test(e.message)) throw fail(`The sheet has no tab called "${fTab}". Check SOCIAL_FOLLOWERS_TAB in Netlify (it must match the tab name exactly).`, 400);
        if (/Unable to parse range/i.test(e.message)) throw fail(`The sheet has no tab called "${tab}". Check SOCIAL_SHEET_TAB in Netlify (it must match the tab name exactly).`, 400);
        throw e;
      }
      const [main, fol] = (j.valueRanges || []).map(v => v.values || []);
      const out = parseSocial(main || []);
      if (fol && fol.length) {
        // Follower snapshots: only rows with a follower count, added without touching reach/impressions.
        parseSocial(fol).rows.filter(r => r.followers != null)
          .forEach(r => out.rows.push({ ...r, reach: null, impressions: null, engagements: null, newFollowers: null, snapshot: true }));
        out.rows.sort((a, b) => a.date.localeCompare(b.date));
      }
      return json(200, out);
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
