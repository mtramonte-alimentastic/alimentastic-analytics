import { login, signup, logout, getUser, verifyRequestOrigin } from '@netlify/identity';
import { getStore } from '@netlify/blobs';
import { DEFAULT_TEAMS } from './seed.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

async function teamList() {
  try {
    const cfg = await getStore({ name: 'brandtime', consistency: 'strong' }).get('config', { type: 'json' });
    if (cfg && Array.isArray(cfg.teams) && cfg.teams.length) return cfg.teams;
  } catch { /* fall through to the defaults */ }
  return DEFAULT_TEAMS;
}

export default async (req) => {
  const op = new URL(req.url).searchParams.get('op');

  // Read-only checks, no CSRF guard needed.
  if (op === 'me') {
    const u = await getUser();
    return json({ user: u ? { id: u.id, email: u.email } : null });
  }
  // The signup form needs the team list before anyone is signed in. Team names are not sensitive.
  if (op === 'teams') {
    return json({ teams: await teamList() });
  }

  try {
    // Mandatory before login/signup/logout: without it an attacker can log a
    // victim's browser into the attacker's account.
    verifyRequestOrigin(req);
  } catch {
    return json({ error: 'Request blocked (origin mismatch).' }, 403);
  }

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  try {
    if (op === 'login') {
      if (!email || !password) return json({ error: 'Email and password required.' }, 400);
      await login(email, password);
      return json({ ok: true });
    }
    if (op === 'signup') {
      if (!email || !password) return json({ error: 'Email and password required.' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
      const teams = await teamList();
      const team = String(body.team || '');
      if (!teams.includes(team)) return json({ error: 'Please choose your team.' }, 400);
      const created = await signup(email, password, {});
      // The team is kept in Brand Time's own profile record, not in Identity metadata (users can edit
      // their own metadata). If this write fails the person is simply asked for their team at first login.
      try {
        if (created && created.id) {
          const store = getStore({ name: 'brandtime', consistency: 'strong' });
          await store.setJSON(`profile/${created.id}`, { email, team, dailyDefault: 8, seenAt: new Date().toISOString() });
        }
      } catch (e) { console.error('brand-time: could not store team at signup:', e && e.message); }
      return json({ ok: true });
    }
    if (op === 'logout') {
      await logout();
      return json({ ok: true });
    }
    return json({ error: 'Unknown operation.' }, 400);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // A bare 404 from Identity itself means Identity is not switched on for this Netlify project
    // (its settings belong to each project and do not copy over with the environment variables).
    if (e && e.status === 404) {
      console.error('brand-time: Identity answered 404 - is Identity enabled for this project?');
      return json({ error: 'Sign-in is not set up on this site yet: Netlify Identity is not enabled for this project. An admin needs to enable it in the Netlify dashboard (Identity), allow signups without email confirmation, and redeploy.' }, 503);
    }
    // Identity denies non-allowlisted signups via the userValidate handler.
    if (/401|unauthor|denied|deny/i.test(msg)) {
      return json({ error: 'That address is not on the team list, or the password is wrong.' }, 401);
    }
    if (/invalid|credential|password|not\s*found/i.test(msg)) {
      return json({ error: 'That email and password do not match.' }, 401);
    }
    if (/registered|exists|duplicate/i.test(msg)) {
      return json({ error: 'That address already has a login — sign in instead.' }, 409);
    }
    return json({ error: msg }, 400);
  }
};
