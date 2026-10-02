# Boxing Round

Boxing scorecards with Cloudflare Access email-code login, per-user D1 history,
and local device saves. The app remains on https://boxing-round.pages.dev/.

## Development

Requires Node 22+ and Wrangler authentication with Pages and D1 permissions.

```sh
npm ci
npm run build
npx wrangler d1 migrations apply boxing-round --local
```

For local sign-in, put `DEV_USER_EMAIL=developer@example.com` in a gitignored
`.dev.vars` file, then run `npm run dev`. The development identity is accepted
only for localhost URLs. Never add it to production variables.

```sh
npm test
npx playwright install chromium
```

With the local server running on port 8788, run `npm run test:browser`. The
browser tests reset the local developer account; never point them at production.

## Deployment

`wrangler.jsonc` contains the D1 binding and public Access configuration. If
`CLOUDFLARE_API_TOKEN` contains an Access-only token, unset it for Wrangler
commands so Wrangler uses its existing Pages/D1 OAuth login:

```sh
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 migrations apply boxing-round --remote
env -u CLOUDFLARE_API_TOKEN npm run deploy
```

Only `dist/` is uploaded as static assets. Pages Functions are bundled separately;
credentials, test files, migrations and local databases are not published.
Unsigned requests to the API are rejected even through unprotected preview URLs.
To invite someone, add their email to the Boxing Round — Players Access policy.

## Import and recovery

After signing in, choose **Import old browser data** on the setup screen or in
History. It explicitly assigns that browser's original history and in-progress
fight to the signed-in account. The original `boxing-scorecard.v1` data remains
unchanged as a backup. JSON history and single-bout exports can also be imported;
existing IDs are skipped rather than overwritten. JSON exports include the active
fight as well as history.

Each user has an internal database ID linked to verified email and Access subject.
API requests check both the verified token and the account opened by the browser,
preventing another tab's account switch from putting saves in the wrong history.

The complete account state is saved atomically with an optimistic revision check.
Concurrent edits prompt for a choice rather than silently overwriting cards.
The device version is backed up locally when resolving a conflict; export it first
to keep a portable copy. Device caches and backups use per-user keys.

Scoring continues offline in an already-open tab. Pending edits are saved locally
and retried on reconnect or through the sync status button. Opening a new tab or
reloading requires an online identity check; this release does not cache the app
for fully offline startup. Session expiry requires signing in again before sync.

The old 50-fight cap is removed; History shows 20 cards per page. Account snapshots
are limited to 1.5 MB to stay within D1's row limits. A limit or storage error is
shown explicitly and never silently drops history. Keep periodic JSON exports as
an independent backup; D1 also provides Time Travel recovery.
