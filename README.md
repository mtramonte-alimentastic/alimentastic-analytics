# Alimentastic Marketing Dashboard

- `index.html` – the dashboard
- `netlify/functions/ga.mjs` – fetches Google Analytics data with a service account
- `netlify.toml` – tells Netlify where the function lives

Netlify environment variables: either `GA_OAUTH_CLIENT_ID`, `GA_OAUTH_CLIENT_SECRET`, `GA_REFRESH_TOKEN`, or `GA_CLIENT_EMAIL`, `GA_PRIVATE_KEY`. Social tab: `SOCIAL_SHEET_ID` (Google Sheet link or ID), optional `SOCIAL_SHEET_TAB` and `SOCIAL_FOLLOWERS_TAB`. Optional: `DASHBOARD_PASSWORD`.

Newsletter tab: `KLAVIYO_ACCOUNTS` – one line per brand, `Brand name: pk_...` (Klaviyo private read-only key).
