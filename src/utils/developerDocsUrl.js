/**
 * Where a person who opens the API host in a browser is sent: the developer docs.
 * DEVELOPER_DOCS_URL wins when it is an https URL; otherwise the docs page next to the web app
 * (APP_PUBLIC_URL + /developers/docs.html). Returns null when neither is configured, so the API
 * root keeps answering 404 instead of redirecting somewhere unintended.
 */
function httpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

function developerDocsUrl(env = process.env) {
  const explicit = httpsUrl(env.DEVELOPER_DOCS_URL);
  if (explicit) return explicit.toString();
  const app = httpsUrl(env.APP_PUBLIC_URL);
  if (!app) return null;
  return new URL('/developers/docs.html', app.origin).toString();
}

module.exports = { developerDocsUrl };
