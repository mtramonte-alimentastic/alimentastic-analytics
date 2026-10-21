# Brand Time

Weekly brand time allocation for every team. Each person logs hours worked per day
and splits them across brands; the tool reports the REPLOID share against an 80%
target and exports to Excel.

Entries are private: a person can only ever read and write their own weeks.
Only admins see the team view, the roster, the brand list and the export — and
that is enforced in the function, not just hidden in the interface.

---

## What's in here

```
public/index.html            the whole front end, one file, no build step
public/reports.html          the admin hours report (shown in the Reports tab), one file
netlify/functions/auth.mjs   signup / login / logout
netlify/functions/api.mjs    all data reads and writes, with the access checks
netlify/functions/identity.mjs  denies signups from addresses not on the allowlist
netlify/functions/seed.mjs   starting brand and task lists
netlify.toml                 build config and the /api + /auth routes
```

Storage is Netlify Blobs. No database to provision.

---

## Deploy (about 15 minutes)

### 1. Put it in Git and connect it

Push this folder to a GitHub repo, then in Netlify: **Add new project → Import an
existing project**, pick the repo, accept the detected settings, deploy.

Drag-and-drop deploy will *not* work — the functions need their dependencies
installed, which only happens on a Git-connected or CLI build. If you prefer the
CLI: `npm install`, then `netlify deploy --prod`.

### 2. Enable Identity

Identity is switched on **per Netlify project**. A new project (for example a copy of this
site under a new URL) starts with it off, and signing up then fails with
"Signup failed (404)" or the message "Netlify Identity is not enabled for this project".
Environment variables do not carry this setting over, so repeat this step on every new site.

**Project configuration → Identity → Enable Identity.**

Then under **Registration**:

- Leave **Registration preferences** on **Open**. The allowlist below is what
  actually keeps people out, and it is more reliable than invite emails.
- Turn **confirmation emails off**: Emails → Confirmation template → Configure →
  allow signups without confirmation. Without this, people sign up and then can't
  log in until they click a link, and the link needs client-side code this build
  deliberately doesn't carry.

### 3. Set the environment variables

**Site configuration → Environment variables:**

| Variable | Value |
|---|---|
| `ALLOWED_EMAILS` | every team address that may create a login, comma-separated — this is also the roster the completion email checks against |
| `ADMIN_EMAILS` | the admins: they see everyone's data, and they may always create a login even if they are not on `ALLOWED_EMAILS`, so an admin who does not log hours never holds a team's week open |
| `RESEND_API_KEY` | from resend.com — see below |
| `NOTIFY_EMAIL` | who receives the completion email — one address or several, comma-separated, e.g. `m.tramonte@alimentastic.com,other@alimentastic.com`. Recipients do not need to be in `ALLOWED_EMAILS` and do not need a login. If unset, it falls back to the first address in `ADMIN_EMAILS`. Until a sending domain is verified in Resend, only the address you signed up to Resend with can receive mail — see step 4 |
| `RESEND_FROM` | optional, see below |

```
ALLOWED_EMAILS = marco@…,luke@…,jessica@…,markus@…,sonja@…,ana@…,madlen@…,melanie@…,patrick@…
ADMIN_EMAILS   = marco@…
RESEND_API_KEY = re_xxxxxxxxxxxxxxxx
NOTIFY_EMAIL   = m.tramonte@alimentastic.com
```

`ALLOWED_EMAILS` fails safe: if it's empty, nobody can sign up, and the
completion check has no roster to compare against so it never fires.

Redeploy after setting them — functions read environment variables at deploy time.

### 4. Sign up for Resend and get an API key

resend.com → sign up with your work email → **API Keys** → create one → paste
it into `RESEND_API_KEY`. No domain or card needed to get started.

One limit worth knowing: until you verify a sending domain, Resend's shared
sandbox address only delivers **to the email you signed up with**. So if
`m.tramonte@alimentastic.com` is also the Resend account email, this works out
of the box. If you'd rather send from your own domain (`brandtime@alimentastic.com`,
say), add and verify it under **Domains** in Resend, then set `RESEND_FROM` to
that address — a few DNS records, a few minutes to propagate.

### 5. First run

Open the site, click **First time here? Create a login**, use your own work
address. Because you're in `ADMIN_EMAILS` you'll see all five tabs, and the brand
list is written on your first visit.

Go to **Brands** before you tell anyone else about it. See the notes below.

---

## Teams

Everyone belongs to one team (Marketing, Sales FMCG, Sales PETFOOD, Operations,
Product Development, Management to start with). The team is how hours are grouped
in reports, how weeks close, and which email a week goes out in.

- **At signup** people choose their team from a dropdown. It is stored on the
  server in their Brand Time profile (not in Identity metadata, which users can
  edit themselves).
- **Accounts that pre-date teams** are asked once, at their next login, before they
  can do anything else.
- **People can't change it afterwards.** An admin changes it under
  **Reports -> Settings -> People -> Team**. That also works for people who have not
  signed up yet, so you can place someone before their first login. An admin's
  choice always wins over the person's own.
- **The list of teams** is edited by admins on the **Brands** tab (Teams). Removing
  a team does not move anyone.
- A team is self-declared at signup, and only people on the allowed-email list can
  sign up. If someone picks the wrong team, fix it under People.

---

## Entering time

Hours worked and the time on each brand are entered **to the minute, as h:mm**
(for example `7:30` or `0:45`). These also work: `7.5` or `7,5` (decimal hours),
`8` (hours), `1h30`, `1h 30m`, `45m`. When someone leaves the field it is shown as
h:mm, and an entry that is not a time goes back to the last good value with a hint.
The + and - buttons move hours worked in 15-minute steps, and a new row is
pre-filled with exactly the time still unassigned.

Behind the scenes times are stored as decimal hours (7:20 is 7.333333), but always a
whole number of minutes: the screen does its sums in whole minutes, and the server
rounds whatever it receives to the nearest minute (and to 0-24 h). Existing entries
(for example 1.25 h) simply show as 1:15. The admin gauge and the Teams tab show
h:mm; **Reports and the Excel files use decimal hours** (7:20 appears as 7.33), with
two decimals so no minute is lost.

---

## Closing a week and the completion email

A team's week **closes** the moment every roster address in that team has submitted
it. "Roster" is still `ALLOWED_EMAILS`; each address belongs to the team that person
chose (or that an admin assigned). From then on nobody in the team can change or
reopen that week — saves are refused, the week shows as read-only with a "closed"
banner, and the Submit button disappears. Until the last person in the team submits,
anyone can still reopen and correct their own week. **Other teams are not affected**:
each team closes on its own.

At the moment of closing, the app builds that team's Excel file and emails it to
`NOTIFY_EMAIL`. **One email per team per week, ever.** The close is an atomic
write-only-if-new in Netlify Blobs, so even if the last two people in a team submit
in the same second, exactly one of them closes the week and sends the email. The
store is also read with strong consistency, so a recent change is never read stale.
The subject and attachment name carry the team, e.g. "Brand Time — Operations —
week 2026-W41 complete (7/7)".

An address listed twice in `ALLOWED_EMAILS` counts once. **A team's week cannot close
until every listed person in that team has submitted**, so remove anyone who has left
from `ALLOWED_EMAILS` (and redeploy), or their week will hold their team open.
A listed person who has **no team yet** (never signed up, and not placed by an
admin) does not hold any team open — but they are shown under "No team" in the
Reports review so nobody is missed.

If Resend rejects the send (bad key, sandbox restriction, etc.) the week is
**not** closed: the claim is released, the submission is kept, and the next save
of a submitted week tries again. The error shows up in the function logs
(**Logs -> Functions -> api** in the Netlify dashboard), not to the person
submitting — check there first if an expected email doesn't arrive.

Weeks that were closed or emailed before teams existed count as closed for
everyone.

There is currently **no way to reopen a closed week** — by design, a closed week
is final. If that ever becomes a real need, it should be built as an explicit
admin "reopen" action rather than done by hand in the Blobs browser: removing the
`closed/<week>/<team>` entry alone would not work, because everyone is still marked
submitted and the very next save would close the week again and send another
email.

---

## Reports (admins only)

Admins get a **Reports** tab: the hours report, built on the same data people enter
in Brand Time, so nothing has to be exported and uploaded by hand. It has the same
layout as the standalone "Stundenreport" it was modelled on, in English:

- **Overview** — KPI cards (total, Reploid, diverse brands, General), expandable
  brand bars, hours per calendar week, and a table by department.
- **Investor report** — a ready-to-copy summary text, a Reploid / diverse brands /
  General split, a per-month table, focus areas per brand.
- **By brand** — one brand at a time: text, KPIs, activities, hours by week.
  Employee names are hidden by default, and notes are never shown here.
- **Review** — who has not submitted which week (with one-click "Remind" emails
  that open in Outlook), and findings in the data: BMD differences, brands named in
  notes, 0 h rows, days with hours worked but nothing assigned. Findings can be
  marked "all good".
- **Data** — every entry, searchable.
- **Settings** — how "General" hours are allocated, which brands count as Reploid,
  start week (from when missing submissions are flagged; earlier weeks that have
  data stay selectable and still count), hourly rates, and the people list
  (start / leaving dates).
- **More** menu — Excel exports (report, investor report, one brand, all brands).

Period selector: Week, Month or All. Reports read the live data each time the tab
opens; use **More -> Refresh data** to reload without leaving the page.

What the report counts, and how it differs from Excel uploads:

- **Only submitted weeks count** by default, so the numbers are finished ones. Hours
  in weeks that are not submitted yet are shown as "Not yet counted"; switch on
  "Include weeks not yet submitted" in Settings to count them too.
- **Departments are teams.** "By department", the review grid and the hourly rates
  use each person's team (an admin's choice in Settings -> People wins). People
  with no team yet appear under "No team".
- **Groups are the report's own.** A brand's group in the report (Reploid / Diverse /
  Do not report) is set in Reports -> Settings and is separate from the group on the
  Brands tab. The defaults are those of the original report: REPLOID, Beak Bandits,
  Huhnglaublich and Schnauze & Co. are Reploid, the rest are diverse brands, and
  internal categories plus Alimentastic count as General. **Check this once** in
  Settings (for example ReGreen and Vitus).
- **Automatic assignment is on.** A General row whose note names a brand is counted
  for that brand (e.g. a note "Regreen" on an Alimentastic row), and is listed under
  Review. Switch it off in Settings if you would rather it never moves hours.
- **Tasks, not notes, are the "content"** shown in brand reports and the investor
  report. Notes stay internal (Review and Data tabs only).
- The upload, demo-data and AI-review features of the original are not included, as
  they exist only because that tool reads Excel files.

Technical notes: the report is a separate page (`reports.html`) loaded in a frame, so
its styles cannot clash with the rest of the app. It reads from two admin-only API
operations (`reports`, `reports-save`); non-admins get a 403 even if they open
`/reports.html` directly. Report settings, excused weeks, "all good" marks and people
details are stored in Netlify Blobs under `reports/`. `netlify.toml` allows framing
from the same site only (`X-Frame-Options: SAMEORIGIN`).

---

## Things to check before rollout

**The brand and task lists are shared by every team.** There is one dropdown for
everyone. It currently holds the Marketing brands (12 brands plus a few internal and
external categories) and Marketing's task types, so other teams will not find their
own brands there until an admin adds them on the **Brands** tab. The company
timesheet template ("Markenliste") lists about 45 brands with a group for each;
adding the ones other teams need, and the absence entries (vacation, sick leave,
time off in lieu, public holiday) if you want them, is the next thing to decide
before rolling out beyond Marketing.

**Already deployed and the brand list is wrong?** The Brands tab has a
"Load standard list (13 brands)" button — click it and it replaces
whatever's there with the corrected 13-brand list below in one write, no
need to archive each old entry by hand. Historic weeks that referenced an
archived or removed brand still show it as "(archived)" in their own row,
so nothing already submitted is lost.

**Standard list:** Alimentastic, Beak Bandits, feelfood, GYW, HappyChicken,
Huhnglaublich, Moments, ReGreen, REPLOID, Schnauze & Co., Vifon, Vitus — all
REPLOID — plus White-label client work and New business/pitches (external),
and Team & planning / Admin & reporting / Recruiting & onboarding / Learning
& development (internal).

**Two shares exist, but only admins see either one.** The REPLOID-share
gauge is admin-only now — the person filling in their own hours just sees
the day list, not a percentage. "REPLOID share of hours worked" counts
overhead in the denominator; "excluding overhead" counts only client-facing
time. Decide which one you'll actually manage against.

**BMD stays the record.** This is self-reported allocation. Say so when you
introduce it, and expect daily totals to drift from BMD by a few minutes —
anything over about half an hour a day is worth a question, not an error.

**Austria.** Per-person time data that produces brand-level reporting is
Leistungskontrolle. Private-by-default helps the argument; it does not replace the
Betriebsrat conversation. Have that before rollout, not after.

---

## Known limits

- **Auth doesn't work under `netlify dev`.** Identity endpoints aren't available
  locally. Test on a deploy preview.
- **Password login only.** Google sign-in via Identity needs client-side
  `oauthLogin()` and `handleAuthCallback()`, which would mean adding a bundler.
  Worth doing if people complain about another password; not worth it on day one.
- **Password reset** isn't wired up. For nine people, resetting from
  **Identity → Users** in the Netlify dashboard is faster than building the flow.
- **Export reads every stored week** and filters by date in the browser. Fine at
  ten people for a couple of years; if it ever gets slow, that's the thing to fix.
