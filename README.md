# Alimentastic Marketing Dashboard

- `index.html` – the dashboard
- `netlify/functions/ga.mjs` – fetches Google Analytics data with a service account
- `netlify.toml` – tells Netlify where the function lives

Netlify environment variables: either `GA_OAUTH_CLIENT_ID`, `GA_OAUTH_CLIENT_SECRET`, `GA_REFRESH_TOKEN`, or `GA_CLIENT_EMAIL`, `GA_PRIVATE_KEY`. Social tab: `SOCIAL_SHEET_ID` (Google Sheet link or ID), optional `SOCIAL_SHEET_TAB`, `SOCIAL_FOLLOWERS_TAB` and `SOCIAL_POSTS_TAB`. Optional: `DASHBOARD_PASSWORD`.

Newsletter tab: `KLAVIYO_ACCOUNTS` – one line per brand, `Brand name: pk_...` (Klaviyo private read-only key).
Shop tab: `SHOPIFY_STORES` – stores separated by `;`, each `Brand: store.myshopify.com | CLIENT_ID | CLIENT_SECRET` (Dev Dashboard app with read_reports).
Paid media tab: Google Ads from the Windsor export tab (`ADS_SHEET_TAB`, same sheet as SOCIAL_SHEET_ID or `ADS_SHEET_ID`). Without ADS_SHEET_TAB it uses the Google Ads API (needs the adwords scope and Explorer access).
Meta Ads: Windsor export tab `META_SHEET_TAB` (same sheet), shown in Paid media with a Platform filter.
