/**
 * One-time Google Calendar OAuth setup helper.
 *
 *   node src/scripts/google-oauth-setup.mjs            → prints the consent URL
 *   node src/scripts/google-oauth-setup.mjs <CODE>     → exchanges code, prints refresh token
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (or env).
 * Steps: run with no args, open the URL in a browser signed in as the clinic
 * account, approve, copy the `code` query param, run again with it, then paste
 * the printed token into .env as GOOGLE_REFRESH_TOKEN.
 */
import 'dotenv/config';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.');
  process.exit(1);
}

const REDIRECT_URI = 'https://developers.google.com/oauthplayground';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const code = process.argv[2];

if (!code) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  console.log('1. Open this URL, sign in as the clinic account, approve:\n');
  console.log(url.toString());
  console.log('\n2. Copy the `code` param from the redirected URL.');
  console.log('3. Run: node src/scripts/google-oauth-setup.mjs <CODE>');
} else {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Exchange failed: ${res.status}`, JSON.stringify(body));
    process.exit(1);
  }
  if (!body.refresh_token) {
    console.error('No refresh_token returned , re-run with prompt=consent (already handled) or remove prior app access at https://myaccount.google.com/permissions and retry.');
    process.exit(1);
  }
  console.log('Add this line to server/.env:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}`);
}
