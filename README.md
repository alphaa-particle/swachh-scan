# Swachh Scan — clean public washrooms, near you

Swachh Scan helps people make using public washrooms a habit:

1. **Find** a washroom near you — about 7,500 cleaned, de-duplicated washrooms across India.
2. **Rate** how clean it was — good ratings send more people to the clean ones.
3. **Report** problems — the operator and the municipality see them, fix them, and the fix is logged publicly.

People earn **Swachh Coins** for helping and spend them on rewards. Nearby businesses advertise, and washroom
operators pay for featured listings, verification visits and analytics. That pays for the service.

Plain HTML/CSS/JS with Leaflet, plus 7 small serverless functions. There's no framework, no build step and no npm
packages. It deploys to Vercel as-is.

## What's in it

**Map** (`/`)
- A heatmap when zoomed out and one pin per washroom at street level. Pins are teal circles for public toilets
  and orange squares for toilets inside a mall, restaurant, petrol pump and so on. A gold ring marks a
  Featured listing, and a red dot means a problem has been reported.
- Near me, search (state, district, city, PIN, name, operator, old city names) and quick filters.
  The full filter panel covers cost, hours, access, wheelchair, gender, baby changing, toilet style, facilities,
  ratings and data freshness.
- Sort the list by **Nearest** or **Cleanest**.
- **Washroom page:** open/closed status in India time and the weekly hours. It shows only the facts that are
  actually known for that washroom, plus directions.
  - Badges: *Swachh Verified* (passed an inspection), *Featured*, *N problems reported*, *Cleaned 2 days ago*,
    *Not recently verified* (OpenStreetMap record 5–15 years old), *Added by scouts*.
  - **Rate:** 1–5 stars plus water, soap and safety.
  - **Report a problem:** dirty, no water, blocked, broken lock, unsafe, closed, overcharged… with an optional note.
    The page shows the status of recent reports.
  - **Nearby:** sponsored offers from businesses within their chosen radius, clearly labelled.
  - **Claim it** link for operators, a scan-to-rate QR code, and Share.
- **Add a missing washroom:** pick the spot on the map and fill in a short form. An admin reviews it before it appears.
- Download the current results as CSV.

**Rewards** (`/me.html`): the Swachh Scout profile.
- Coins, tier (Bronze → Silver 500 → Gold 1,500 → Platinum 5,000 coins earned) and a weekly streak.
- 12 badges, recent activity, and the ranks.
- **Rewards catalogue:** partner rewards, plus offers from businesses near you (redeemable only near the shop).
  Redeeming gives a voucher code. Rewards that need delivery, such as a recharge or a T-shirt, ask for a phone
  number or an address. Admins see it in the voucher lookup, and it's deleted once the voucher is marked used.
- **Invite friends** with a referral link.
- **Backup code** to restore the profile on another device.
- There's no sign-up and no password: the profile is created on the device the first time someone earns coins.

| Action | Coins |
|---|---|
| Rate a washroom (once per washroom per 7 days, 10 a day) | +10, +5 more if you're the first to rate it |
| Report a hygiene problem (5 a day) | +5, +20 more when a municipal officer confirms it's fixed (5 a day) |
| Add a missing washroom | +50 when approved |
| Invite a friend (20 a month) | +50 for them on their first contribution, +100 for you once they've contributed on two different days |
| Contribute every week | +25 every 4 weeks in a row |

**Leaderboard** (`/leaderboard.html`)
- Top scouts this week, this month and of all time.
- **Honor Roll:** monthly champions, Platinum and Gold scouts, and the *cleanest washrooms* (4.3★+ from at least 3 people).

**For business** (`/business.html`)
- **Nearby ads:** a sponsored card shown to people looking for washrooms within 0.5–5 km. It can include a coin
  offer (e.g. "Free chai for 50 coins"), which scouts redeem in the app and the shop verifies on this page.
- **Operators** claim their washrooms. Then they can:
  - answer reports and mark them fixed;
  - buy a **Featured listing** — shown only while the washroom has no open report and isn't rated poorly lately,
    so paying can never push people to a dirty washroom;
  - book a **Verification visit**, which earns the inspection badge;
  - buy **Analytics:** daily views, direction requests, calls, QR scans, ratings, reports and district rank.
- **Payments by UPI:** a pay button and QR code, then the business enters the UPI reference (UTR) and an admin
  confirms it. No payment-gateway account is needed.

**Civic dashboard** (`/civic.html`)
- **Needs attention:** a public list and map of washrooms with open reports or poor recent ratings, most urgent first.
- **Recently cleaned:** the public log of fixes.
- **Officer action queue:** municipal officers sign in with an access key limited to their state, district or
  city (a district or city that exists in two states is saved with its state). They see report notes, then
  acknowledge, resolve or reject reports, or mark a washroom cleaned. The scout who reported it gets the bonus.
  Operators can close reports on their own washrooms too, but only an officer's or admin's confirmation pays the
  bonus, so nobody can farm coins by reporting and closing their own washroom.
- **Coverage & data:** the statistics, cleaning report, sources and downloads.

**Admin** (`/admin.html`, password = `ADMIN_TOKEN`)
- Approve new washrooms and operator claims.
- Confirm UPI payments, which switches services on, and review ad content.
- Record inspection results.
- Pause or end ads, handle reports, manage rewards (stock or partner code lists), and create or revoke officer keys.
- Search, ban, rename or adjust scouts, and look up vouchers.
- Remove an operator from a washroom.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, go to **Add New → Project → Import** the repository.
   Set Framework preset to **Other**, and leave the build command empty (`vercel.json` already serves `public/`).
3. In the project, open **Storage** and add **Upstash for Redis** (the free plan is fine to start), then **Connect**
   it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
4. In **Settings → Environment Variables**, add:

   | Variable | Needed for | Example |
   |---|---|---|
   | `ADMIN_TOKEN` | the admin page (16+ random characters) | `openssl rand -base64 24` |
   | `UPI_ID` | business payments (optional; without it businesses are told you'll send an invoice) | `yourshop@okhdfcbank` |
   | `UPI_NAME` | name shown in the UPI app (optional) | `Swachh Scan` |

5. **Deploy** (or Redeploy if it was already deployed).

That's all. Without step 3 the site still works as a map with ratings saved on each device. Coins, reports, ads
and the dashboards switch on as soon as the database is connected.

From the command line instead: `npx vercel`, then `npx vercel --prod`.

**First steps after deploying:**
1. Open `/admin.html` and sign in with your `ADMIN_TOKEN`.
2. Go to **Rewards**: add stock (we generate codes) or paste partner codes for the rewards you can honour. Sample
   rewards show as "Coming soon" until they have stock, so nobody can redeem something you can't deliver.
3. Go to **Officer keys** and create one for each municipality you work with. Send them the key and the
   `/civic.html` link.

## How it works (and how it's kept honest)

- **Storage:** everything lives in one Upstash Redis database, accessed over its REST API with `fetch`.
  The washroom list itself is a static file (`public/data/washrooms.json`).
- **Atomic writes:** every action that moves coins is one Redis Lua script. That covers rating, reporting,
  redeeming, approving a washroom, resolving a report and admin adjustments. Limits, counters, coins, streaks and
  referral bonuses therefore change together or not at all. Parallel requests can't double-spend, and a reward
  with one item left goes to exactly one person.
- **Abuse limits:**
  - Ratings: 30 per network per hour, and one per washroom per day per scout (anonymous: per network).
  - Coins: once per washroom per 7 days, with daily caps on rewarded ratings and reports.
  - Profiles: 5 new ones per network per day.
  - Invites: the bonus waits for the friend's second contribution day, with a monthly cap.
  - Report-fixed bonus: paid only when a municipal officer or admin confirms the fix, 5 a day.
  - Honor Roll: "cleanest" needs at least 3 different raters.
  - Admins can suspend a profile, which hides it from the leaderboards.
- **Privacy:**
  - IP addresses are never stored; only a keyed hash, changed every day, is used for rate limits.
  - Scouts give no email or phone. Their token is stored hashed.
  - Public pages never show who reported what, or the report notes. Only the operator and the officers see notes.
  - Businesses give a contact name, phone and email for invoicing.
- **Security:**
  - Every write must be JSON from the site's own pages.
  - The admin password and officer keys are compared as hashes.
  - Officer keys are stored hashed and can be revoked.
- **Rules and prices** are in `api/_lib/config.js`: coin values, tiers, limits, plan prices, report categories
  and sample rewards. Every page reads them from the API, so edit that file and redeploy.

## Run locally

```bash
python3 -m http.server 8000 --directory public
```

Open http://localhost:8000. This serves the map with ratings saved on the device; there's no `/api` here.
To run everything, link the project and its environment variables with `npx vercel link` and
`npx vercel env pull`, then run:

```bash
npx vercel dev
```

## How the data is cleaned

`scripts/build_data.py` runs every record through this pipeline. The civic dashboard's "Coverage & data" tab
shows what each step changed.

1. **Text normalisation:** Unicode NFC; invisible and bidi characters removed; whitespace and capitalisation tidied.
2. **Canonicalisation:** fuzzy matching (RapidFuzz) unifies generic names.
   - "SBM", "Swacch Bharat Mission" and "Public Washroom SBM" all become *Swachh Bharat toilet*, and 12 spellings of
     Sulabh become *Sulabh Shauchalaya*.
   - "Pay & use" names imply a fee, and "Ladies toilet" implies women's.
   - The same approach merges operator spellings (e.g. BBMP in Kannada and in English) and updates city names
     (Bangalore → Bengaluru, Gurgaon → Gurugram).
3. **Validation:**
   - Phone numbers are checked with Google's libphonenumber.
   - PIN codes are checked against the state's India Post zone.
   - Websites must be valid URLs, and implausible prices (over ₹100) are removed.
   - Opening hours are parsed into a weekly schedule.
4. **Location check:** each point is tested against Natural Earth land and neighbouring-country polygons (shapely).
   A point is dropped only if it is more than 2 km inside another country or more than 10 km out at sea.
   Island washrooms in Andaman & Nicobar and Lakshadweep are part of India and are kept.
5. **Freshness:** records last edited more than 15 years before the data download are removed. Records 5–15 years
   old keep only their location and are marked "not recently verified".
6. **De-duplication:** the same toilet block is often mapped several times, for example once for men and once for
   women. Compatible records within 20 m of a seed record are merged with a haversine BallTree (scikit-learn).
   Compatible means the same type, matching names and no differing numbers. Their details are combined, and the
   old IDs still resolve.

## Update the data

Replace `SwachhScan_India_Washrooms.xlsx` with a newer export (same sheets and columns), then:

```bash
python3 -m pip install -r scripts/requirements.txt
```

```bash
python3 scripts/build_data.py
```

This regenerates:
- `public/data/washrooms.json` and `public/data/meta.json`;
- the cleaned Excel download, `public/data/swachh-scan-cleaned.xlsx`;
- `api/_data.json`, the compact index the API uses for valid IDs, merged IDs, names and areas.

The build is deterministic, and IDs stay stable across rebuilds, so ratings, reports, claims and printed QR codes
keep working. Commit and push, and Vercel redeploys.

## Project layout

```
public/                      everything the website serves
  index.html  js/app.js      map, list, filters, washroom page, rating, reports, add washroom, ads
  me.html     js/me.js       Swachh Scout profile, coins, badges, rewards, vouchers, invites, backup
  leaderboard.html  js/leaderboard.js   leaderboards and Honor Roll
  business.html     js/business.js      ads, claims, featured / verification / analytics, UPI payments
  civic.html  js/civic.js js/insights.js   needs attention, cleaning log, officer queue, coverage
  admin.html  js/admin.js    admin console
  js/common.js               shared: API client, scout profile, coin toasts, events, header/tab bar, theme
  css/style.css, img/icons.svg, favicon.svg, manifest.webmanifest, data/
api/                         Vercel serverless functions (7, under the Hobby limit of 12)
  state.js                   everything the map needs in one cached request
  ratings.js  me.js  community.js  business.js  civic.js  admin.js
  _lib/core.js               Redis client, auth, validation, Lua coin helpers   (_ = not a route)
  _lib/config.js             coin values, tiers, limits, prices
  _lib/reports.js            resolving reports + reporter bonus
  _data.json                 generated washroom index
scripts/                     data pipeline (build_data.py, cleaning.py, hours.py, ref/)
vercel.json
```

## Before a public launch

- **Vercel plan:** Vercel's Hobby plan is for non-commercial use. Once you sell ads or listings, move to Pro.
- **Database size:** the Upstash free plan is fine for a pilot. Each map load is one cached request, and usage
  events are batched. Upgrade when traffic grows.
- **Rewards you can honour:** only stock rewards you have a partner (or budget) for. The sample rewards stay
  "Coming soon" until you add stock.
- **Payments:** UPI with manual confirmation is simple and has no fees. At scale, a gateway (Razorpay, Cashfree)
  can mark orders paid automatically; only the `order-paid` step in `api/admin.js` changes.
- **Terms & privacy:** publish terms for rewards and ads, and a privacy notice (DPDP Act 2023). Cover what
  businesses share and the anonymous device profile.
- **Map tiles:** OpenStreetMap's tile server is for light use. For real traffic, use a tile provider with an API
  key, or a basemap that follows Survey of India boundaries (Mappls / Bhuvan). Every map on the site uses `TILES`
  at the top of `public/js/common.js`, so it's one change.
- **Licence:** washroom data is © OpenStreetMap contributors under the ODbL. Keep the credit, and publish derived
  data under the ODbL, as the downloads already do.
- **QR stickers and invite links** use the address the page was opened on. Generate them from your final domain.
