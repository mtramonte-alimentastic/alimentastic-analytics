/* Netlify Identity event handler.
   Invoked by the platform, never called directly.

   Registration is left Open in the dashboard, and this handler is what keeps
   the app closed. Two lists decide who may create a login:

     ALLOWED_EMAILS  the people who log hours. This is also the roster a team's
                     week waits for before it closes.
     ADMIN_EMAILS    the admins. They may always create a login, even when they
                     are not on ALLOWED_EMAILS, so an admin who does not log
                     hours never holds a team's week open.

   Both are comma-separated lists in Site configuration > Environment variables.
   If both are empty everyone is denied, which fails safe rather than open. */

const list = (name) => String(process.env[name] || '')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

export default {
  userValidate(event) {
    const permitted = new Set([...list('ALLOWED_EMAILS'), ...list('ADMIN_EMAILS')]);
    const email = String((event.user && event.user.email) || '').toLowerCase();
    if (!permitted.size || !permitted.has(email)) return event.deny();
  }
};
