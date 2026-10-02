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

## Scheduled fights

**Browse fights** loads the Boxing Data API's seven-day schedule, grouped by event.
Today, This weekend (Friday through Sunday), and Next 7 days filter the shared
list without making more provider requests. Search matches fighters, events,
weight classes and locations. Exact start times are omitted because the provider
returns dates without an explicit timezone; calendar dates are shown as supplied.

Selecting a bout fills the names, supplied weight class, and scheduled rounds.
Unknown rounds and round length must be selected before scoring. Fighter 1/2
ordering is not treated as verified red/blue corner assignment; **Swap corners**
matches the broadcast. The selected provider fight ID is stored separately from
the user's independent scorecard ID. Clear selection returns to manual entry.

Results, official scores, winner flags, statistics and fight status are removed
server-side before the schedule is cached or sent to a browser. The free plan's
listing may not include every undercard; missing bouts remain manually enterable.

Configure `BOXING_RAPIDAPI_KEY` as a Pages secret, not a frontend variable:

```sh
env -u CLOUDFLARE_API_TOKEN npx wrangler pages secret put BOXING_RAPIDAPI_KEY --project-name boxing-round
```

For local development, add the same variable to gitignored `.dev.vars`.
Apply `0002_fight_schedule.sql` locally and remotely before deploying this feature.
The provider rejected a 14-day request on the supplied subscription but accepted
seven days, so the application deliberately requests seven.

A shared D1 cache refreshes on demand at most every six hours. A database lease
prevents simultaneous users from multiplying provider calls. Pagination is capped
at three pages per refresh, with partial coverage shown explicitly. Remaining
provider quota is tracked, and the app additionally caps automatic requests at
80 per calendar month. Failed refreshes are cached temporarily; any saved schedule
is retained and marked stale. **Check schedule** respects the cache and request
budget rather than forcing another provider call.

### Official judges and shared leaderboard

Everyone admitted through Cloudflare Access participates by default. The leaderboard shows email local parts as names, agreement percentages, and ranked fight counts; it does not expose full addresses, account IDs, private notes, active fights, or round-by-round personal cards.

Only completed, full-length decision cards linked to scheduled API fights count. Official results are checked automatically after recording a qualifying result, and for up to three recent qualifying cards on app startup or when opening the leaderboard. Older linked cards can be checked from history. Manual cards, stoppages, incomplete cards, missing official totals, mismatched fighters/round counts and ambiguous results remain unranked. Each user contributes one card per fight: the earliest completed card, with its current saved scores. This is a friendly comparison, not a competition with enforced pre-result submissions or anti-cheating controls.

Agreement compares both personal fighter totals with the arithmetic mean of the official cards. If `error = (abs(red - officialRedMean) + abs(blue - officialBlueMean)) / 2`, agreement is `max(0, 100 * (1 - error / rounds))`. Each eligible fight has equal weight in a user's overall average. A perfect match is 100%; one point of average error in a ten-round fight gives 90%. Fight counts make small samples visible. This measures agreement with final totals, not round-by-round accuracy or whether the official judging was correct.

The provider supplies unlabelled score pairs. We orient the entire set by the published winner and majority decision; dissenting split cards are preserved. Published outcome and judge votes must agree. Draws can only be paired automatically when every supplied card has equal scores. The UI explains this pairing. Fighter IDs, or exact normalized names for older saved cards, then map official scores into the user's chosen corners.

Official scores use a shared D1 cache, request lease, and the same 80-request/month ceiling and upstream quota checks as schedules. Failures and pending results are cached briefly to avoid repeated calls. Successfully paired results are retained, with no automatic refresh, so they remain comparable beyond the free subscription's historical window. The leaderboard reads saved cards and cached results without spending API calls. Deleting a saved card removes its contribution on the next leaderboard read; score edits and imports remain allowed.

Apply `migrations/0003_official_scores.sql` before deploying this feature. It adds only an official-results cache; personal history remains in the existing storage. Results stay excluded from the schedule endpoint and only become visible in a completed card or the leaderboard aggregate.

### Fighter portraits

The red and blue corner panels automatically look up credited Wikimedia Commons photos for manual and scheduled fights. Matching requires a unique human boxer with an exact normalized English name or alias and a Wikidata image. Missing or ambiguous matches, unsupported licenses and broken images display initials. Photos are cropped visually to fit; background removal is not performed. Each photo has expandable source, author, license and cropping credits.

Only verified CC BY, CC BY-SA and CC0 metadata is accepted. Required attribution takes precedence over the artist field. Shared D1 metadata is cached for 30 days for photos, seven days for missing matches and one hour for failures. A lease deduplicates concurrent lookups, with at most 40 new lookups per UTC day. These requests use Wikimedia, not the paid boxing API. The same-origin image route proxies only known Wikimedia assets, bounds their size and caches successful images for 24 hours. It exposes no personal scorecard data.

Apply `migrations/0004_fighter_portraits.sql` before deploying. Keep `/media/portraits/*` in `_routes.json` alongside `/api/*`.
