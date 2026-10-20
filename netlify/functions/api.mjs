import { getUser } from '@netlify/identity';
import { getStore } from '@netlify/blobs';
import { SEED_CONFIG, DEFAULT_TEAMS } from './seed.mjs';
import { buildWeekWorkbook, sendWeekEmail } from './_notify.mjs';

const STORE = 'brandtime';
const WEEK_RE = /^\d{4}-W\d{2}$/;
const REPORT_KEYS = ['settings', 'excuses', 'acks', 'people'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}
function isAdmin(u) {
  if (!u) return false;
  const roles = u.roles || (u.app_metadata && u.app_metadata.roles) || [];
  if (Array.isArray(roles) && roles.includes('admin')) return true;
  return adminEmails().includes(String(u.email || '').toLowerCase());
}

/* Strip anything we didn't put there, and cap the shape so one bad client
   can't write an unbounded blob. */
function cleanDoc(raw) {
  const out = { days: {}, submitted: !!(raw && raw.submitted), submittedAt: null, dailyDefault: 8 };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.submittedAt === 'string') out.submittedAt = raw.submittedAt.slice(0, 40);
  const dd = Number(raw.dailyDefault);
  if (Number.isFinite(dd) && dd >= 0 && dd <= 24) out.dailyDefault = dd;

  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  Object.keys(days).slice(0, 10).forEach((k) => {
    if (!DATE_RE.test(k)) return;
    const d = days[k] || {};
    const worked = Number(d.worked);
    const rows = Array.isArray(d.rows) ? d.rows.slice(0, 40) : [];
    out.days[k] = {
      worked: Number.isFinite(worked) && worked >= 0 && worked <= 24 ? worked : null,
      rows: rows.map((r) => {
        const h = Number(r && r.h);
        return {
          b: String((r && r.b) || '').slice(0, 60),
          t: String((r && r.t) || '').slice(0, 60),
          h: Number.isFinite(h) && h >= 0 && h <= 24 ? h : 0,
          n: String((r && r.n) || '').slice(0, 300)
        };
      })
    };
  });
  return out;
}

function cleanConfig(raw) {
  const brands = Array.isArray(raw && raw.brands) ? raw.brands.slice(0, 150) : [];
  const tasks = Array.isArray(raw && raw.tasks) ? raw.tasks.slice(0, 40) : [];
  return {
    brands: brands.map((b) => ({
      id: String((b && b.id) || '').slice(0, 60),
      name: String((b && b.name) || '').slice(0, 80),
      group: ['reploid', 'external', 'internal'].includes(b && b.group) ? b.group : 'internal',
      archived: !!(b && b.archived)
    })).filter((b) => b.id && b.name),
    tasks: tasks.map((t) => String(t || '').slice(0, 60)).filter(Boolean),
    teams: Array.isArray(raw && raw.teams)
      ? [...new Set(raw.teams.map((t) => String(t || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 40)
      : undefined,
    updatedAt: new Date().toISOString()
  };
}

async function readProfiles(store) {
  const { blobs } = await store.list({ prefix: 'profile/' });
  const rows = await Promise.all(blobs.map(async (b) => {
    const p = await store.get(b.key, { type: 'json' }).catch(() => null);
    return { userId: b.key.slice('profile/'.length), email: (p && p.email) || '', team: (p && p.team) || '' };
  }));
  return rows;
}

/* ---------- teams ----------
   A person's team is chosen at signup (or at first login for accounts that pre-date teams) and kept in
   their profile. An admin can override it per person under Reports -> Settings -> People; the override
   wins. Identity metadata is deliberately not used: users can edit their own. */
const teamListOf = (cfg) => (cfg && Array.isArray(cfg.teams) && cfg.teams.length ? cfg.teams : DEFAULT_TEAMS);
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
async function readOverrides(store) {
  return (await store.get('reports/people', { type: 'json' }).catch(() => null)) || {};
}
function effectiveTeam(profile, overrides, email) {
  const o = overrides && overrides[String(email || '').toLowerCase()];
  return String((o && o.team) || (profile && profile.team) || '').trim();
}

/* The roster is ALLOWED_EMAILS, not "everyone who has ever logged in" — an
   old profile from someone who left doesn't block the notification, and
   someone added mid-week is expected before it fires. */
function rosterEmails() {
  // Set() so an address accidentally listed twice isn't counted (or exported) twice.
  return [...new Set(String(process.env.ALLOWED_EMAILS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))];
}

/* Who receives the completion email. Independent of ALLOWED_EMAILS: a
   recipient does not need a login. NOTIFY_EMAIL may hold several
   comma-separated addresses; falls back to the first admin. */
function notifyRecipients() {
  const raw = process.env.NOTIFY_EMAIL || adminEmails()[0] || '';
  return [...new Set(String(raw).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))];
}

/* A team's week is closed once every roster address in that team has submitted it. From that moment
   nobody in the team can change it, and exactly one report email for the team goes out.
   `closed/<week>` and `notified/<week>` are markers from earlier versions (before teams existed):
   such weeks count as closed for everyone. */
async function isClosed(store, week, team) {
  const keys = [`closed/${week}`, `notified/${week}`];
  if (team) keys.push(`closed/${week}/${slug(team)}`);
  const found = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
  return found.some(Boolean);
}

/* Returns true if this team's week is closed after the call. The close itself is an atomic
   write-only-if-new, so when two final submissions land together exactly one of them wins the
   claim and sends the email. People on the roster who have no team yet cannot hold a team open. */
async function maybeCloseWeek(store, week, team) {
  if (!team) return false;
  const [people, overrides] = await Promise.all([readProfiles(store), readOverrides(store)]);
  const byEmail = {};
  people.forEach((p) => { if (p.email) byEmail[p.email.toLowerCase()] = p; });
  const members = rosterEmails().filter((e) => effectiveTeam(byEmail[e], overrides, e) === team);
  if (!members.length) return false;

  const rows = [];
  let submittedCount = 0;
  for (const email of members) {
    const p = byEmail[email];
    const doc = p ? await store.get(`week/${p.userId}/${week}`, { type: 'json' }).catch(() => null) : null;
    if (doc && doc.submitted) submittedCount += 1;
    if (p) rows.push({ userId: p.userId, email: p.email, doc });
  }
  if (submittedCount < members.length) return false; // still waiting on someone in this team

  const recipients = notifyRecipients();
  const key = `closed/${week}/${slug(team)}`;
  const claim = await store.setJSON(key, { closedAt: new Date().toISOString(), team, to: recipients }, { onlyIfNew: true });
  if (!claim.modified) return true; // another request closed it and sends the email

  if (recipients.length) {
    try {
      const cfg = (await store.get('config', { type: 'json' }).catch(() => null)) || { brands: [], tasks: [] };
      const buffer = await buildWeekWorkbook(cfg, week, rows, team);
      await sendWeekEmail({ to: recipients, week, buffer, complete: submittedCount, total: members.length, team });
    } catch (e) {
      // Nothing was sent, so release the claim: the week stays open and the
      // next save of a submitted week tries again.
      await store.delete(key).catch(() => {});
      throw e;
    }
  }
  return true;
}

export default async (req) => {
  const user = await getUser();
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const url = new URL(req.url);
  const op = url.searchParams.get('op');
  const store = getStore({ name: STORE, consistency: 'strong' });
  const uid = user.id;
  const admin = isAdmin(user);

  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }

  try {
    /* ---------- everyone ---------- */
    if (op === 'bootstrap') {
      let [config, profile, overrides] = await Promise.all([
        store.get('config', { type: 'json' }).catch(() => null),
        store.get(`profile/${uid}`, { type: 'json' }).catch(() => null),
        readOverrides(store)
      ]);
      // First admin to open a fresh deploy gets the starting brand list.
      if (!config && admin) {
        config = cleanConfig({ ...SEED_CONFIG, teams: DEFAULT_TEAMS });
        await store.setJSON('config', config);
      }
      // Record the login so the person shows up in the roster before their first save.
      // Merge, so nothing else on the profile (such as the team) is lost.
      if (!profile || profile.email !== user.email) {
        profile = { ...(profile || {}), email: user.email || '', dailyDefault: (profile && profile.dailyDefault) || 8, seenAt: new Date().toISOString() };
        await store.setJSON(`profile/${uid}`, profile);
      }
      const team = effectiveTeam(profile, overrides, user.email);
      return json({
        user: { id: uid, email: user.email, admin, team },
        config: config || { brands: [], tasks: [] },
        profile: profile || { dailyDefault: 8 },
        teams: teamListOf(config),
        needsTeam: !team
      });
    }

    if (op === 'profile' && req.method === 'POST') {
      // Chosen once, at first login for accounts that pre-date teams. After that only an admin changes it.
      const [config, profile, overrides] = await Promise.all([
        store.get('config', { type: 'json' }).catch(() => null),
        store.get(`profile/${uid}`, { type: 'json' }).catch(() => null),
        readOverrides(store)
      ]);
      const team = String(body.team || '');
      if (!teamListOf(config).includes(team)) return json({ error: 'Please choose your team.' }, 400);
      const current = effectiveTeam(profile, overrides, user.email);
      if (current) return json({ ok: true, team: current });
      await store.setJSON(`profile/${uid}`, { ...(profile || {}), email: user.email || '', team, seenAt: new Date().toISOString() });
      return json({ ok: true, team });
    }

    if (op === 'week') {
      const [myProfile, myOverrides] = await Promise.all([
        store.get(`profile/${uid}`, { type: 'json' }).catch(() => null),
        readOverrides(store)
      ]);
      const team = effectiveTeam(myProfile, myOverrides, user.email);
      if (req.method === 'POST') {
        const week = String(body.week || '');
        if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
        if (!team) return json({ error: 'Choose your team first.', needsTeam: true }, 400);
        if (await isClosed(store, week, team)) {
          return json({ error: 'This week is closed — everyone in your team has submitted.', closed: true }, 409);
        }
        const cleaned = cleanDoc(body.doc);
        await store.setJSON(`week/${uid}/${week}`, {
          ...cleaned, userId: uid, week, updatedAt: new Date().toISOString()
        });
        let closed = false;
        if (cleaned.submitted) {
          try {
            closed = await maybeCloseWeek(store, week, team);
          } catch (e) {
            console.error('brand-time close/notify failed:', e && e.message);
          }
        }
        return json({ ok: true, closed });
      }
      const week = String(url.searchParams.get('week') || '');
      if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
      const [doc, closed] = await Promise.all([
        store.get(`week/${uid}/${week}`, { type: 'json' }).catch(() => null),
        isClosed(store, week, team)
      ]);
      return json({ doc: doc || null, closed });
    }

    /* ---------- admin only, from here down ---------- */
    if (!admin) return json({ error: 'Not allowed.' }, 403);

    if (op === 'config' && req.method === 'POST') {
      const next = cleanConfig(body);
      if (!Array.isArray(body.teams)) {
        const prev = await store.get('config', { type: 'json' }).catch(() => null);
        if (prev && prev.teams) next.teams = prev.teams;
      }
      await store.setJSON('config', next);
      return json({ ok: true });
    }

    /* ---------- reports (admin only) ---------- */
    if (op === 'reports') {
      const people = await readProfiles(store);
      const byId = {};
      people.forEach((p) => { byId[p.userId] = p; });
      const { blobs } = await store.list({ prefix: 'week/' });
      const [config, ...saved] = await Promise.all([
        store.get('config', { type: 'json' }).catch(() => null),
        ...REPORT_KEYS.map((k) => store.get(`reports/${k}`, { type: 'json' }).catch(() => null))
      ]);
      const weeks = (await Promise.all(blobs.map(async (b) => {
        const parts = b.key.split('/');                       // week/<uid>/<weekId>
        if (parts.length !== 3) return null;
        const doc = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (!doc) return null;
        return { userId: parts[1], week: parts[2], email: (byId[parts[1]] || {}).email || '', doc };
      }))).filter(Boolean);
      const state = {};
      REPORT_KEYS.forEach((k, i) => { state[k] = saved[i] || {}; });
      return json({
        config: config || { brands: [], tasks: [] },
        roster: rosterEmails(),
        teams: teamListOf(config),
        profiles: people.map((p) => ({ email: p.email, team: p.team })),
        weeks,
        state,
        me: { email: user.email }
      });
    }

    if (op === 'reports-save' && req.method === 'POST') {
      const key = String(body.key || '');
      if (!REPORT_KEYS.includes(key)) return json({ error: 'Unknown report setting.' }, 400);
      const value = body.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'Bad value.' }, 400);
      if (JSON.stringify(value).length > 200000) return json({ error: 'Too large.' }, 413);
      await store.setJSON(`reports/${key}`, value);
      return json({ ok: true });
    }

    if (op === 'team') {
      const week = String(url.searchParams.get('week') || '');
      if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
      const [people, overrides] = await Promise.all([readProfiles(store), readOverrides(store)]);
      const rows = await Promise.all(people.map(async (p) => {
        const doc = await store.get(`week/${p.userId}/${week}`, { type: 'json' }).catch(() => null);
        return { userId: p.userId, email: p.email, team: effectiveTeam(p, overrides, p.email), doc };
      }));
      return json({ rows });
    }

    if (op === 'export') {
      const from = String(url.searchParams.get('from') || '');
      const to = String(url.searchParams.get('to') || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return json({ error: 'Bad dates.' }, 400);
      const [people, overrides] = await Promise.all([readProfiles(store), readOverrides(store)]);
      const byId = {};
      people.forEach((p) => { byId[p.userId] = p; });
      const { blobs } = await store.list({ prefix: 'week/' });
      const rows = await Promise.all(blobs.map(async (b) => {
        const parts = b.key.split('/');           // week/<uid>/<weekId>
        const userId = parts[1], week = parts[2];
        const doc = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (!doc) return null;
        const p = byId[userId] || { email: '', team: '' };
        return { userId, week, email: p.email, team: effectiveTeam(p, overrides, p.email), doc };
      }));
      return json({ rows: rows.filter(Boolean) });
    }

    return json({ error: 'Unknown operation.' }, 400);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};
