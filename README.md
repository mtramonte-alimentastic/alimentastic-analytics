# Alimentastic Marketing Dashboard

- `index.html` – the dashboard
- `netlify/functions/ga.mjs` – fetches Google Analytics data with a service account
- `netlify.toml` – tells Netlify where the function lives

Netlify environment variables: `GA_CLIENT_EMAIL`, `GA_PRIVATE_KEY`, optional `DASHBOARD_PASSWORD`.
