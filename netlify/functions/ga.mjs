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


// ---------- Klaviyo (one private read-only key per brand) ----------
// KLAVIYO_ACCOUNTS: one brand per line (or separated by ;) as  Brand name: pk_xxxxxxxx
const KLAVIYO_REVISION = '2024-10-15';
function klaviyoAccounts() {
  // Accepts "Brand: pk_..." pairs separated by line breaks, semicolons, commas or just spaces.
  const raw = process.env.KLAVIYO_ACCOUNTS || '';
  const out = [];
  const re = /([^:;=,\n]+?)\s*[:=]\s*(pk_[A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(raw))) out.push({ brand: m[1].replace(/^[\s,;]+/, '').trim(), key: m[2] });
  return out.filter(a => a.brand && a.key);
}
function klaviyoAccount(brand) {
  const accts = klaviyoAccounts();
  if (!accts.length) throw fail('Klaviyo is not connected yet. Add KLAVIYO_ACCOUNTS in Netlify (one line per brand, like "feelfood: pk_..."), then redeploy.');
  const a = accts.find(x => x.brand === brand);
  if (!a) throw fail(`No Klaviyo key found for "${brand}".`, 400);
  return a;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function klaviyo(acct, path, body, tries = 3) {
  const url = path.startsWith('http') ? path : `https://a.klaviyo.com/api/${path}`;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Klaviyo-API-Key ${acct.key}`, revision: KLAVIYO_REVISION, accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 429 && attempt < tries) { await sleep(Math.min(5000, Number(r.headers.get('retry-after') || 1) * 1000 + 250)); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.errors?.[0]?.detail || j.errors?.[0]?.title || `Klaviyo returned an error (${r.status}).`;
      if (r.status === 401 || r.status === 403) throw fail(`Klaviyo (${acct.brand}) refused the API key: ${msg} Check that it is a private key with read access.`, 502);
      if (r.status === 429) throw fail(`Klaviyo (${acct.brand}) is limiting requests right now. Wait a minute and click Refresh.`, 503);
      throw fail(`Klaviyo (${acct.brand}): ${msg}`, r.status >= 500 ? 502 : 400);
    }
    return j;
  }
}
async function klaviyoAll(acct, path, maxPages = 5) {
  const out = []; let next = path, n = 0;
  while (next && n++ < maxPages) { const j = await klaviyo(acct, next); out.push(...(j.data || [])); next = j.links?.next || null; }
  return out;
}
const METRIC_NAMES = {
  received: ['received email'], opened: ['opened email'], clicked: ['clicked email'],
  subscribed: ['subscribed to email marketing', 'subscribed to list'],
  unsubscribed: ['unsubscribed from email marketing', 'unsubscribed', 'unsubscribed from list'],
  order: ['placed order']
};
async function klaviyoMetricIds(acct) {
  const all = await klaviyoAll(acct, 'metrics/?fields[metric]=name,integration', 10);
  const ids = { _label: {} };
  for (const [k, names] of Object.entries(METRIC_NAMES)) {
    for (const n of names) {
      const hits = all.filter(m => (m.attributes?.name || '').toLowerCase() === n);
      const integ = (m) => (m.attributes?.integration?.name || '').toLowerCase();
      const SHOPS = ['shopify', 'woocommerce', 'shopware', 'magento', 'bigcommerce', 'prestashop', 'wix', 'squarespace'];
      const pick = k === 'order'
        ? (hits.find(m => SHOPS.some(s => integ(m).includes(s))) || hits.find(m => integ(m) && integ(m) !== 'api') || hits[0])
        : (hits.find(m => integ(m) === 'klaviyo') || hits[0]);
      if (pick) { ids[k] = pick.id; ids._label[pick.id] = `${pick.attributes?.name} (${pick.attributes?.integration?.name || 'no integration'})`; break; }
    }
  }
  return ids;
}
function aggBody(metricId, measurement, start, endExcl, by) {
  return { data: { type: 'metric-aggregate', attributes: {
    metric_id: metricId, measurements: [measurement], interval: 'day', page_size: 500, timezone: 'Europe/Vienna',
    filter: [`greater-or-equal(datetime,${start}T00:00:00)`, `less-than(datetime,${endExcl}T00:00:00)`],
    ...(by ? { by } : {}) } } };
}
// Klaviyo reports cover at most about a year, so longer ranges are split into pieces.
function yearChunks(start, end) {
  const out = []; let s = start;
  while (s <= end) {
    const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 364);
    const e = d.toISOString().slice(0, 10) < end ? d.toISOString().slice(0, 10) : end;
    out.push([s, e]); s = dayAfter(e);
  }
  return out;
}
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
const dayAfter = (s) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

async function klaviyoDaily(acct, start, end) {
  const parts = yearChunks(start, end);
  if (parts.length > 1) {
    const merged = { metrics: [], revenueAttributed: false };
    for (const [s, e] of parts) {
      const d = await klaviyoDailyChunk(acct, s, e);
      merged.metrics = d.metrics;
      for (const k of ['received', 'opened', 'clicked', 'subscribed', 'unsubscribed', 'revenue', 'revenueFlows', 'revenueCampaigns']) {
        if (d[k]) merged[k] = { ...(merged[k] || {}), ...d[k] };
        else if (k === 'revenue' && d.revenueError) merged.revenueError = d.revenueError;
      }
      merged.revenueAttributed = merged.revenueAttributed || d.revenueAttributed;
      await sleep(1100);
    }
    return merged;
  }
  return klaviyoDailyChunk(acct, start, end);
}

async function klaviyoDailyChunk(acct, start, end) {
  const ids = await klaviyoMetricIds(acct);
  const endEx = dayAfter(end);
  const series = (j, measurement, pickDim) => {
    const a = j.data?.attributes || {};
    const dates = (a.dates || []).map(d => String(d).slice(0, 10));
    const rows = a.data || [];
    const vals = dates.map(() => 0);
    rows.forEach(row => {
      if (pickDim && !pickDim(row.dimensions || [])) return;
      (row.measurements?.[measurement] || []).forEach((v, i) => { vals[i] += Number(v) || 0; });
    });
    return Object.fromEntries(dates.map((d, i) => [d, vals[i]]));
  };
  const jobs = [
    ['received', 'count'], ['opened', 'unique'], ['clicked', 'unique'], ['subscribed', 'count'], ['unsubscribed', 'count']
  ].filter(([k]) => ids[k]);
  const out = { metrics: Object.keys(ids) };
  // Klaviyo allows ~3 aggregate requests per second, so run them in small batches.
  for (let i = 0; i < jobs.length; i += 3) {
    const batch = jobs.slice(i, i + 3);
    const res = await Promise.all(batch.map(([k, m]) => klaviyo(acct, 'metric-aggregates/', aggBody(ids[k], m, start, endEx))));
    batch.forEach(([k, m], n) => { out[k] = series(res[n], m); });
    if (i + 3 < jobs.length) await sleep(1100);
  }
  out.revenueAttributed = false;
  if (ids.order) {
    await sleep(400);
    // Orders Klaviyo attributes to a flow or a campaign message (the same attribution Klaviyo's own dashboard uses).
    const has = (v) => v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'none' && String(v).toLowerCase() !== '(not set)';
    try {
      const j = await klaviyo(acct, 'metric-aggregates/', aggBody(ids.order, 'sum_value', start, endEx, ['$attributed_flow', '$attributed_message']));
      out.revenueFlows = series(j, 'sum_value', dims => has(dims[0]));
      out.revenueCampaigns = series(j, 'sum_value', dims => !has(dims[0]) && has(dims[1]));
      out.revenue = Object.fromEntries(Object.keys(out.revenueFlows).map(d => [d, (out.revenueFlows[d] || 0) + (out.revenueCampaigns[d] || 0)]));
      out.revenueAttributed = true;
    } catch (e) {
      try {   // fallback for accounts that only expose the channel
        await sleep(400);
        const j = await klaviyo(acct, 'metric-aggregates/', aggBody(ids.order, 'sum_value', start, endEx, ['$attributed_channel']));
        out.revenue = series(j, 'sum_value', dims => (dims[0] || '').toLowerCase() === 'email');
        out.revenueAttributed = true;
      } catch (e2) { out.revenue = null; out.revenueError = e.message; }
    }
  }
  return out;
}

async function klaviyoCampaignMeta(acct) {
  const meta = new Map(), msgToCampaign = new Map();
  let next = `campaigns/?filter=${encodeURIComponent("equals(messages.channel,'email')")}&fields[campaign]=name,send_time,scheduled_at&include=campaign-messages&sort=-scheduled_at`, n = 0;
  while (next && n++ < 6) {
    const j = await klaviyo(acct, next);
    (j.data || []).forEach(c => {
      meta.set(c.id, c.attributes || {});
      msgToCampaign.set(c.id, c.id);
      (c.relationships?.['campaign-messages']?.data || []).forEach(m => msgToCampaign.set(m.id, c.id));
    });
    next = j.links?.next || null;
  }
  return { meta, msgToCampaign };
}

// Campaign stats from email events, for accounts where Klaviyo's campaign report isn't available (no shop metric).
async function klaviyoCampaignsFromEvents(acct, ids, start, end) {
  const { meta, msgToCampaign } = await klaviyoCampaignMeta(acct);
  const stats = new Map();
  const jobs = [['received', 'count', 'delivered'], ['opened', 'unique', 'opens'], ['clicked', 'unique', 'clicks'], ['unsubscribed', 'count', 'unsubscribes']].filter(([k]) => ids[k]);
  let calls = 0;
  for (const [s, e] of yearChunks(start, end)) {
    for (const [k, m, field] of jobs) {
      if (calls && calls % 3 === 0) await sleep(1100);
      calls++;
      const body = aggBody(ids[k], m, s, dayAfter(e), ['$message']);
      body.data.attributes.interval = 'month';
      const j = await klaviyo(acct, 'metric-aggregates/', body);
      (j.data?.attributes?.data || []).forEach(row => {
        const cid = msgToCampaign.get(row.dimensions?.[0]); if (!cid) return;   // skips flow emails
        const total = (row.measurements?.[m] || []).reduce((a, v) => a + (Number(v) || 0), 0);
        const cur = stats.get(cid) || { recipients: 0, delivered: 0, opens: 0, clicks: 0, unsubscribes: 0, revenue: 0 };
        cur[field] += total; if (field === 'delivered') cur.recipients += total;
        stats.set(cid, cur);
      });
    }
  }
  return { hasRevenue: false, source: 'events', campaigns: [...stats.entries()].map(([id, s]) => ({
    id, name: meta.get(id)?.name || id, sent: (meta.get(id)?.send_time || meta.get(id)?.scheduled_at || '').slice(0, 10), ...s })) };
}

async function klaviyoCampaigns(acct, start, end) {
  const ids = await klaviyoMetricIds(acct);
  if (!ids.order) return klaviyoCampaignsFromEvents(acct, ids, start, end);
  const convId = ids.order;
  const results = [];
  const parts = yearChunks(start, end);
  let conv = convId, revenueOk = !!ids.order;
  for (const [i, [s, e]] of parts.entries()) {
    if (i) await sleep(1100);   // campaign reports are limited to about one per second
    const ask = (metricId) => klaviyo(acct, 'campaign-values-reports/', { data: { type: 'campaign-values-report', attributes: {
      statistics: ['recipients', 'delivered', 'opens_unique', 'open_rate', 'clicks_unique', 'click_rate', 'unsubscribes', 'conversion_value'],
      timeframe: { start: `${s}T00:00:00+00:00`, end: `${dayAfter(e)}T00:00:00+00:00` },
      conversion_metric_id: metricId,
      filter: 'equals(send_channel,"email")'
    } } });
    let report;
    try { report = await ask(conv); }
    catch (err) {
      // This account's order metric can't be used for campaign reports: count campaign stats from email events instead.
      if (/conversion metric/i.test(err.message)) return klaviyoCampaignsFromEvents(acct, ids, start, end);
      throw err;
    }
    results.push(...(report.data?.attributes?.results || []));
  }
  const byCampaign = new Map();
  results.forEach(r => {
    const id = r.groupings?.campaign_id; if (!id) return;
    const s = r.statistics || {}, cur = byCampaign.get(id) || { recipients: 0, delivered: 0, opens: 0, clicks: 0, unsubscribes: 0, revenue: 0 };
    cur.recipients += s.recipients || 0; cur.delivered += s.delivered || 0; cur.opens += s.opens_unique || 0;
    cur.clicks += s.clicks_unique || 0; cur.unsubscribes += s.unsubscribes || 0; cur.revenue += revenueOk ? (s.conversion_value || 0) : 0;
    byCampaign.set(id, cur);
  });
  const meta = byCampaign.size ? (await klaviyoCampaignMeta(acct)).meta : new Map();
  return { hasRevenue: revenueOk, campaigns: [...byCampaign.entries()].map(([id, s]) => ({
    id, name: meta.get(id)?.name || id, sent: (meta.get(id)?.send_time || meta.get(id)?.scheduled_at || '').slice(0, 10), ...s })) };
}

async function klaviyoLists(acct) {
  const lists = await klaviyoAll(acct, 'lists/?fields[list]=name', 3);
  const rank = (n) => /newsletter|master|main|subscri/i.test(n) ? 0 : 1;
  const picks = lists.map(l => ({ id: l.id, name: l.attributes?.name || l.id }))
    .sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 4);
  const out = [];
  for (const l of picks) {   // this endpoint allows about 1 request per second
    const j = await klaviyo(acct, `lists/${l.id}/?additional-fields[list]=profile_count&fields[list]=name,profile_count`);
    out.push({ name: l.name, profiles: j.data?.attributes?.profile_count ?? null });
    if (out.length < picks.length) await sleep(1050);
  }
  return { lists: out.sort((a, b) => (b.profiles || 0) - (a.profiles || 0)), totalLists: lists.length };
}

const cdnJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600, stale-while-revalidate=86400',
  // Cache each distinct request separately (action, brand and dates), per password.
  'Netlify-Vary': 'query=action|brand|start|end,header=x-dashboard-key'
} });

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
    if (action === 'klaviyo_accounts') {
      return json(200, { brands: klaviyoAccounts().map(a => a.brand) });
    }
    if (action === 'klaviyo_daily' || action === 'klaviyo_campaigns' || action === 'klaviyo_lists') {
      const acct = klaviyoAccount(url.searchParams.get('brand') || '');
      if (action === 'klaviyo_lists') return cdnJson(await klaviyoLists(acct));
      const start = isoDay(url.searchParams.get('start')), end = isoDay(url.searchParams.get('end'));
      if (!start || !end || start > end) return json(400, { error: 'Invalid date range.' });
      return cdnJson(action === 'klaviyo_daily' ? await klaviyoDaily(acct, start, end) : await klaviyoCampaigns(acct, start, end));
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
