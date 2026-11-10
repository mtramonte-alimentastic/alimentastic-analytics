# Alimentastic Marketing Dashboard — project guide for Claude Code

Owner: Marco Tramonte (Alimentastic GmbH, Salzburg — a house of brands within REPLOID Group AG).
Live site: https://alimentastic-analytics.netlify.app (Netlify project `alimentastic-analytics`, deploys automatically from this GitHub repo's `main` branch).
Company language is English: all UI text, notes and docs in English.

## How Marco wants to work
- He is not a developer. Explain steps in plain language, one click at a time, and never assume terminal knowledge.
- Web apps are single self-contained HTML files (no React/Vite/build step). Keep it that way.
- Every change: bump `DASHBOARD_VERSION` in `index.html` (format `YYYY-MM-DD.N`) so the live version can be checked at the bottom of the page.
- Commit and push to `main` when a change is done and tested; Netlify deploys automatically. Afterwards tell Marco to reload with Ctrl+F5 and check the version label.
- Never put secrets (API keys, tokens, client secrets) in the repo, in commits or in chat. They live only in Netlify environment variables.
- Test before pushing: `node --check` on the extracted script, and ideally a headless browser run with mocked `/.netlify/functions/ga` responses (Playwright works well).

## Files
- `index.html` — the whole dashboard (UI, CSS, all tab logic, the assistant). Fonts (DIN Next LT Pro, Alimentastic CD) and the logo are embedded as base64. Chart.js 4.4.1 is loaded from cdnjs.
- `netlify/functions/ga.mjs` — the single data service. Every request is `/.netlify/functions/ga?action=…`. It must stay the ONLY file in `netlify/functions` (a foreign `_notify.mjs` from another app once broke all deploys).
- `package.json` — only dependency: `@netlify/blobs` pinned to 11.1.3 (for permanent post thumbnails). Don't add packages unless needed; pin exact versions at least two weeks old.
- `netlify.toml` — publish `.`, functions dir `netlify/functions`.
- `README.md` — short env var list.

## Tabs (in order)
Overview · Web analytics · Search Console · Social · Newsletter · Shop · Paid media, plus the "Ask the dashboard" assistant (bottom-right button).
Shared controls: date range (7/28/90 days, 12 months, custom) and comparison (previous period / last year / none). Periods end yesterday (Search Console: 3 days ago).
All tables sort by clicking a header; bar lists have a sortable header row; sorting persists across reloads of data.

## Data sources and `ga.mjs` actions
| Source | How | Actions |
|---|---|---|
| GA4 | Google Analytics Data/Admin API with a saved Google sign-in (OAuth refresh token) | `properties`, `report` |
| Search Console | Search Console API, same sign-in | `gsc_sites`, `gsc_batch` |
| Social (Instagram, Facebook pages, LinkedIn organic) | Windsor.ai daily exports → Google Sheet (`dashboard_social`) → Sheets API | `social` (also returns posts), `thumb` |
| Newsletter | Klaviyo API, one private read-only key per brand | `klaviyo_accounts`, `klaviyo_daily`, `klaviyo_campaigns`, `klaviyo_lists` |
| Shop | Shopify ShopifyQL via GraphQL Admin API 2026-10, Dev Dashboard app per store, client-credentials login | `shopify_stores`, `shopify_sales` |
| Paid media | Google Ads + Meta Ads via Windsor exports → Google Sheet tabs `ads` and `meta` | `pm_accounts`, `pm_data` (old aliases `ads_accounts`, `ads_data`) |
| Assistant | Anthropic Messages API (`claude-sonnet-5-5` by default, `ANTHROPIC_MODEL` overrides) | `chat` |

Google Ads API mode also exists in code (used only if `ADS_SHEET_TAB` and `META_SHEET_TAB` are both unset); it needs the `adwords` scope and Explorer access — currently not used.

## Netlify environment variables (names only — values are in Netlify)
- Google: `GA_OAUTH_CLIENT_ID`, `GA_OAUTH_CLIENT_SECRET`, `GA_REFRESH_TOKEN` (scopes: analytics.readonly, webmasters.readonly, spreadsheets.readonly). Created via OAuth Playground with own credentials; the Google Cloud OAuth app is External + In production (unverified), so refresh tokens don't expire after 7 days.
- Social sheet: `SOCIAL_SHEET_ID`, `SOCIAL_SHEET_TAB` (=social), `SOCIAL_FOLLOWERS_TAB` (=followers), `SOCIAL_POSTS_TAB` (=posts), `SOCIAL_FB_POSTS_TAB` (=fb_posts).
- Paid media: `ADS_SHEET_TAB` (=ads), `META_SHEET_TAB` (=meta); same spreadsheet as `SOCIAL_SHEET_ID` unless `ADS_SHEET_ID` is set.
- Klaviyo: `KLAVIYO_ACCOUNTS` — `Brand: pk_…` pairs; any separator works (Netlify collapses line breaks).
- Shopify: `SHOPIFY_STORES` — `Brand: store.myshopify.com | CLIENT_ID | CLIENT_SECRET`, stores separated by `;`. Currently Schnauze & Co., Feelfood, Beak Bandits.
- Assistant: `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`).
- Optional: `DASHBOARD_PASSWORD` (page asks for it; sent as `x-dashboard-key`; the `thumb` action is exempt because <img> tags can't send headers).
Variables only apply after a new deploy.

## Windsor.ai exports (Google Sheet `dashboard_social`, all daily)
| Task | Tab | Notes |
|---|---|---|
| dashboard_social | social | Instagram account reach/views/interactions, Facebook page reach/impressions/engagements/follows, LinkedIn page stats. last_30d + 1-year backfill. Match `date,datasource,account_name`. |
| dashboard_followers | followers | Instagram `followers_count` only for today (`date_preset=last_1dT`). Columns to Match empty (appends history). |
| dashboard_posts | posts | Instagram media + LinkedIn shares incl. `media_url`, `media_thumbnail_url`. Columns to Match `date,media_id,share_id`. |
| dashboard_fb_posts | fb_posts | Facebook page posts (post_id, message, permalink, created time, impressions, post_total_media_view_unique as reach, engagements, full_picture — set via the Connector URL, the editor hides some fields). Match `date,post_id`. |
| dashboard_ads | ads | Google Ads: date, account, campaign, device, spend, impressions, clicks, conversions, conversion_value. Match `date,campaign_id,device`. |
| dashboard_meta | meta | Meta Ads: link_clicks, website purchases (Pixel) + value, publisher_platform. Match `date,campaign_id,publisher_platform`. |

Rules learned the hard way:
- New accounts must be added inside `select_accounts=` (comma-separated, no spaces) — never after `&_field_headers=names`, which must stay the URL's last parameter. A mistake there got `dashboard_social` deactivated.
- Destination tasks allow max 30 days per run; history comes from the backfill (history icon). Only one backfill per task at a time.
- Instagram `follower_count_1d` only covers 30 days; LinkedIn ranges max 14 months.
- Max 3 "Columns to Match".
- The Windsor API key is inside the task URLs (it has been exposed in chat; regenerating it means updating all five task URLs).

Connected accounts (Windsor): Instagram — biogena.moments, schnauze.und.co, getyourwellbeing, feel_food_com, alimentastic_houseofbrands, beakbandits, huhnglaublich.gut, vitus.vitality. LinkedIn — Alimentastic House of Brands, VITUS GmbH. Facebook pages — getyourwellbeing, Alimentastic Food Innovation, BIOGENA moments, Feel-food.com, Schnauze & Co. (Zeitgeist Coffee deliberately excluded). Google Ads — REPLOID Group Ag, getyourwellbeing by Biogena, Beak Bandits. Meta Ads — feelfood, Functional coffee (Moments), Schnauze & Co, Alimentastic GmbH, Get_your_wellbeeing, Moments by Biogena.

## Brand mapping
Two lists in `index.html`:
- `BRANDS` (Social tab): handle → display name.
- `OV_BRANDS` (Overview + assistant): per brand, its group (Alimentastic / REPLOID) and the matching names/IDs per source (`ga`, `gsc` match by substring; `social`, `klaviyo`, `shop` exact, case-insensitive; `gads` account IDs; `meta` IDs prefixed `meta_`). Unmatched data shows as "Unassigned". `OV_EXCLUDE_GA` drops the "Webstream" GA4 property.
Groups: Alimentastic — feelfood, Moments (incl. Functional coffee), getyourwellbeing (marketing funded by BIOGENA), Alimentastic corporate. REPLOID — Beak Bandits, Schnauze & Co., Huhnglaublich, Vitus, plus "REPLOID (portfolio)" for the multi-area REPLOID Group Google Ads account.

## Gotchas (already solved — don't reintroduce)
- Ad blockers hide elements whose ids/classes contain "ads": Paid media uses `pm…` ids and `pm_…` actions.
- Netlify CDN caching (`Netlify-CDN-Cache-Control`, 1 h) must vary by query: `Netlify-Vary: query=action|brand|start|end|id|login,header=x-dashboard-key`. Without it every request got the same cached answer.
- Klaviyo: strict rate limits — aggregates in batches of 3/s, campaign reports ~1/s, reports split into ≤1-year chunks; accounts without a "Placed Order" metric (getyourwellbeing has no shop) get campaign stats from email events instead; revenue = orders attributed via `$attributed_flow` / `$attributed_message`.
- Shopify: run ShopifyQL queries one per request with retry/backoff (rate limits). App needs `read_reports` + protected customer data, and must be installed on the store.
- Netlify functions have a short timeout, so the assistant's tool loop runs in the browser: each round is one `chat` call; tools execute client-side with the dashboard's cached fetchers.
- Instagram image URLs expire after weeks: thumbnails are saved to Netlify Blobs store `post-thumbs` on first sight and served via `action=thumb`.
- Open/click rates in Newsletter come from campaign results (unique per delivered), not daily event sums (which exceeded 100%).
- Google Ads conversions in the REPLOID account are inflated (~€1 per "conversion") — a tracking setup issue in Google Ads, not a dashboard bug. Blended ROAS (Shopify sales ÷ ad spend) is the trusted efficiency metric.
- Errors are shown on screen (`showCrash`) with the version label.

## Open items / next steps
1. Amazon Seller Central → Shop tab via Windsor (plan now has free data-source slots).
2. More Shopify stores as access arrives; GA4 properties for feelfood and getyourwellbeing; Search Console verification for alimentastic.com (DNS TXT record via IT).
3. Recommendation engine on top of the assistant's data tools (e.g. weekly automatic review with ranked recommendations per brand).
4. Optional: regenerate the Windsor API key and update the five task URLs.
