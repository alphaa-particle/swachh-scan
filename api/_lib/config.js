/**
 * Swachh Scan — business rules in one place. Edit and redeploy to change coin values, tiers or prices.
 * (Files and folders in /api that start with "_" are not turned into serverless functions by Vercel.)
 */
module.exports = {
  // Swachh Coins earned for each action
  COINS: {
    rate: 10,            // rating a washroom (once per washroom per 7 days)
    firstRating: 5,      // extra when you are the first person to rate a washroom
    report: 5,           // reporting a hygiene problem
    reportResolved: 20,  // extra when the problem you reported is fixed by the operator / municipality
    place: 50,           // a missing washroom you added is approved
    referrer: 100,       // a friend you invited contributes on two different days
    referred: 50,        // welcome bonus for the friend on their first contribution
    streak: 25,          // every 4 weeks in a row with at least one contribution
  },
  LIMITS: {
    ratingsRewardedPerDay: 10,
    reportsRewardedPerDay: 5,
    referralsRewardedPerMonth: 20,
    accountsPerNetworkPerDay: 5,
    pendingPlacesPerUser: 5,
    ratingsPerNetworkPerHour: 30,
    ratingsPerWashroomPerNetworkPerDay: 5, // signed-in scouts; anonymous ratings stay at 1
    reportsPerNetworkPerHour: 20,
    eventsPerNetworkPerHour: 600,
  },
  // tiers are based on coins EARNED in total (spending coins never lowers your tier)
  TIERS: [
    { name: 'Bronze', min: 0 },
    { name: 'Silver', min: 500 },
    { name: 'Gold', min: 1500 },
    { name: 'Platinum', min: 5000 },
  ],
  // prices in rupees (shown on /business.html). Payment is by UPI to UPI_ID (env), confirmed by an admin.
  PLANS: {
    featured: { label: 'Featured listing', price: 499, days: 30, what: 'Featured badge, highlighted pin and the top slot in nearby results. Pauses automatically while a hygiene report is open or recent ratings fall below 3★.' },
    analytics: { label: 'Analytics', price: 299, days: 30, what: 'Daily views, direction requests, calls, QR scans, ratings and reports for your washroom, with your rank in the district.' },
    verify: { label: 'Verification visit', price: 1499, days: 180, what: 'An inspector checks cleanliness, water, soap, lighting, locks and access. Passing earns a “Verified by Swachh Scan” badge for 6 months.' },
    ad7: { label: 'Nearby ad · 7 days', price: 299, days: 7, what: 'A sponsored card shown to people looking for washrooms within your chosen radius.' },
    ad30: { label: 'Nearby ad · 30 days', price: 999, days: 30, what: 'A sponsored card shown to people looking for washrooms within your chosen radius.' },
  },
  ISSUES: {
    dirty: 'Dirty', smell: 'Bad smell', no_water: 'No water', no_soap: 'No soap', no_light: 'No light',
    broken: 'Broken door, lock or fittings', clogged: 'Blocked or overflowing', unsafe: 'Felt unsafe',
    closed: 'Closed during opening hours', no_access: 'Not wheelchair accessible', overcharged: 'Charged more than listed',
    missing: 'Not here / wrong location', other: 'Something else',
  },
  AD_CATEGORIES: ['Café', 'Restaurant', 'Pharmacy', 'Store', 'Fuel', 'Hotel', 'Service', 'Other'],
  // shown until an admin adds real partners; "coming soon" because they have no stock
  SAMPLE_REWARDS: [
    { id: 'sample-cafe', icon: '☕', title: '₹50 off at a partner café', partner: 'Partner café', cost: 150, mode: 'gen', limitDays: 7, terms: 'Show the code at the counter.' },
    { id: 'sample-recharge', icon: '📱', title: '₹30 mobile recharge', partner: 'Swachh Scan', cost: 300, mode: 'gen', limitDays: 30, needs: 'phone', terms: 'Credited to the number you give within 3 working days.' },
    { id: 'sample-movie', icon: '🎬', title: '₹100 off movie tickets', partner: 'Partner cinema', cost: 800, mode: 'pool', limitDays: 30, terms: 'Code works once, online booking.' },
    { id: 'sample-tee', icon: '👕', title: 'Swachh Scout T-shirt', partner: 'Swachh Scan', cost: 1500, mode: 'gen', limitDays: 365, needs: 'address', terms: 'Delivered to the address you give within 2 weeks.' },
  ],
};
