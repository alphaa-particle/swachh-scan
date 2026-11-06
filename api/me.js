/**
 * Swachh Scout profiles — no email or password. The app creates a profile the first time someone earns coins and
 * keeps a private token on the device. The same token is the "backup code" that restores the profile elsewhere.
 *
 *   GET  /api/me                                  (Bearer token) profile, coins, tier, badges data, ranks, activity, vouchers
 *   POST /api/me {action:'create', ref?, name?}   -> {token, profile}
 *   POST /api/me {action:'rename', name}
 *   POST /api/me {action:'redeem', reward}        spend coins on a reward -> voucher code (atomic: coins, stock, limits)
 */
const K = require('./_lib/core');
const { LIMITS } = K.CONFIG;

const REDEEM_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 reward id, 8 cost, 9 mode (pool|gen), 10 voucher code, 11 limit days, 12 description, 13 title, 14 partner, 15 owner uid,
--      16 delivery contact (phone or address, only for rewards that need one)
local auth = checkUser()
if auth == 'banned' then return {'banned'} end
if not auth then return {'auth'} end
local rw = ARGV[7]
if redis.call('HGET', 'ss:rw:on', rw) ~= '1' then return {'inactive'} end
local lk = 'ss:rl:red:' .. CTX.uid .. ':' .. rw
if redis.call('EXISTS', lk) == 1 then return {'limit', redis.call('TTL', lk)} end
local cost = tonumber(ARGV[8])
local coins = tonumber(redis.call('HGET', 'ss:u:' .. CTX.uid, 'coins') or '0')
if coins < cost then return {'poor', coins} end
local vk = 'ss:red:' .. ARGV[10]
if redis.call('EXISTS', vk) == 1 then return {'retry'} end
local pc = ''
if ARGV[9] == 'pool' then
  pc = redis.call('LPOP', 'ss:rw:pool:' .. rw)
  if not pc then return {'out'} end
else
  local s = tonumber(redis.call('GET', 'ss:rw:stock:' .. rw) or '0')
  if s <= 0 then return {'out'} end
  redis.call('DECR', 'ss:rw:stock:' .. rw)
end
award(CTX.uid, -cost, 'redeem', ARGV[12])
redis.call('HSET', vk, 'rw', rw, 'uid', CTX.uid, 'ts', CTX.now, 'st', 'issued', 'title', ARGV[13], 'partner', ARGV[14], 'pc', pc, 'owner', ARGV[15], 'cost', cost, 'contact', ARGV[16])
redis.call('LPUSH', 'ss:vou:' .. CTX.uid, ARGV[10])
redis.call('LTRIM', 'ss:vou:' .. CTX.uid, 0, 49)
redis.call('LPUSH', 'ss:red:rw:' .. rw, ARGV[10])
redis.call('LTRIM', 'ss:red:rw:' .. rw, 0, 1999)
redis.call('HINCRBY', 'ss:rw:used', rw, 1)
if tonumber(ARGV[11]) > 0 then redis.call('SET', lk, '1', 'EX', tonumber(ARGV[11]) * 86400) end
return finish({'ok', pc})`;

function publicProfile(uid, u) {
  const earned = Number(u.earned) || 0;
  return {
    uid, name: u.name || 'Scout', coins: Number(u.coins) || 0, earned, tier: K.tierOf(earned),
    rated: Number(u.rated) || 0, reports: Number(u.reports) || 0, resolved: Number(u.resolved) || 0,
    places: Number(u.places) || 0, refs: Number(u.refs) || 0, streak: currentStreak(u), best: Number(u.best) || 0,
    ref: u.ref, created: Number(u.c) || 0, banned: u.banned === '1', invited: !!u.by,
  };
}
/** A streak is still alive this week or if the last contribution was last week. */
function currentStreak(u) {
  const now = Date.now();
  if (u.wk === K.weekKey(now) || u.wk === K.weekKey(now - 7 * 864e5)) return Number(u.streak) || 0;
  return 0;
}

async function create(req, res, body) {
  const name = body.name ? K.displayName(body.name) : `Scout ${K.code(4)}`; // validate before counting the attempt
  const made = await K.bump(`ss:rl:acct:${K.netKey(req)}`, 86400);
  if (made > LIMITS.accountsPerNetworkPerDay) K.fail(429, 'Too many new profiles from your network today. Try again tomorrow.', { code: 'rate_limited' });
  let by = '';
  if (typeof body.ref === 'string' && /^[A-Z2-9]{6}$/.test(body.ref.toUpperCase())) {
    const [r] = await K.redis([['GET', `ss:ref:${body.ref.toUpperCase()}`]]);
    if (r) by = r;
  }
  const uid = K.rid(12);
  const secret = require('crypto').randomBytes(24).toString('base64url');
  let ref = '';
  for (let i = 0; i < 6 && !ref; i++) {
    const c = K.code(6);
    const [ok] = await K.redis([['SET', `ss:ref:${c}`, uid, 'NX']]);
    if (ok) ref = c;
  }
  if (!ref) K.fail(503, 'Please try again.');
  const u = { name, th: K.sha256(secret), c: String(Date.now()), coins: '0', earned: '0', ref, by };
  await K.redis([['HSET', `ss:u:${uid}`, ...Object.entries(u).flat()], ['ZADD', 'ss:users', Date.now(), uid]]);
  return K.send(res, 200, { token: `${uid}.${secret}`, profile: publicProfile(uid, u) });
}

async function getMe(req, res) {
  const me = await K.getUser(req, { required: true });
  const now = Date.now();
  const wk = K.weekKey(now), mo = K.monthKey(now);
  const [led, vou, rw, rm, ra, sw, sm, sa, pend, rwIds] = await K.redis([
    ['LRANGE', `ss:led:${me.uid}`, 0, 49], ['LRANGE', `ss:vou:${me.uid}`, 0, 49],
    ['ZREVRANK', `ss:lb:w:${wk}`, me.uid], ['ZREVRANK', `ss:lb:m:${mo}`, me.uid], ['ZREVRANK', 'ss:lb:all', me.uid],
    ['ZSCORE', `ss:lb:w:${wk}`, me.uid], ['ZSCORE', `ss:lb:m:${mo}`, me.uid], ['ZSCORE', 'ss:lb:all', me.uid],
    ['HGET', 'ss:pend:byuser', me.uid], ['HKEYS', 'ss:rw'],
  ]);
  // rewards redeemed recently can't be redeemed again until their limit ends
  const ids = rwIds || [];
  const ttls = ids.length ? await K.redis(ids.map((r) => ['PTTL', `ss:rl:red:${me.uid}:${r}`])) : [];
  const cooldowns = {};
  ids.forEach((r, i) => { if (Number(ttls[i]) > 0) cooldowns[r] = now + Number(ttls[i]); });
  const ledger = (led || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  let vouchers = [];
  if (vou && vou.length) {
    const vs = await K.redis(vou.map((c) => ['HGETALL', `ss:red:${c}`]));
    vouchers = vou.map((c, i) => { const v = K.hash(vs[i]); return { code: c, partnerCode: v.pc || '', title: v.title, partner: v.partner, at: Number(v.ts) || 0, status: v.st || 'issued', usedAt: Number(v.usedAt) || 0 }; });
  }
  const rank = (r, s) => (r == null || !Number(s) ? null : { rank: Number(r) + 1, coins: Number(s) });
  return K.send(res, 200, {
    profile: publicProfile(me.uid, me.u), ledger, vouchers,
    ranks: me.u.banned === '1' ? {} : { week: rank(rw, sw), month: rank(rm, sm), all: rank(ra, sa) },
    pendingPlaces: Number(pend) || 0, cooldowns,
  });
}

async function rename(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const name = K.displayName(body.name);
  await K.redis([['HSET', `ss:u:${me.uid}`, 'name', name]]);
  return K.send(res, 200, { ok: true, name });
}

async function redeem(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const rwId = K.text(body.reward, 40, { required: true, label: 'Reward' });
  const [raw] = await K.redis([['HGET', 'ss:rw', rwId]]);
  if (!raw) K.fail(404, 'That reward is no longer available.');
  const r = JSON.parse(raw);
  if (r.ends && r.ends < Date.now()) K.fail(410, 'That offer has ended.');
  // a shop's offer is for people near the shop
  if (r.la != null && r.lo != null) {
    const la = Number(body.lat), lo = Number(body.lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || body.lat === null || body.lon === null) K.fail(400, 'Share your location to redeem this nearby offer.', { code: 'need_location' });
    if (K.distKm({ la, lo }, { la: r.la, lo: r.lo }) > (r.r || 2) + 0.5) K.fail(403, `This offer is only for people near ${r.place || r.partner || 'the shop'}.`, { code: 'too_far' });
  }
  let contact = '';
  if (r.needs === 'phone') contact = K.phone(body.contact, true);
  else if (r.needs === 'address') contact = K.text(body.contact, 240, { required: true, label: 'Delivery address', multiline: true, min: 15 });
  const voucher = `SS-${K.code(4)}-${K.code(4)}`;
  const desc = K.jstr(`Redeemed: ${r.title}`);
  const [out] = await K.redis([[
    'EVAL', REDEEM_SCRIPT, '0', ...K.coinArgs(me),
    rwId, String(r.cost), r.mode === 'pool' ? 'pool' : 'gen', voucher, String(r.limitDays || 0), desc, r.title, r.partner || '', r.owner || '', contact,
  ]]);
  const [main, coins] = K.splitCoins(out);
  const why = {
    inactive: [410, 'That reward is not available right now.'],
    out: [410, 'Sorry, this reward just ran out. Check back soon.'],
    poor: [402, `You need ${r.cost} Swachh Coins for this reward.`],
    limit: [429, `You already redeemed this reward recently. You can redeem it again on ${new Date(Date.now() + Math.max(0, Number(main[1]) || 0) * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('-')}.`],
    retry: [503, 'Please try again.'],
    auth: [401, 'Sign in first.'],
    banned: [403, 'This profile has been suspended.'],
  }[main[0]];
  if (why) K.fail(why[0], why[1], { code: main[0] });
  return K.send(res, 200, { ok: true, voucher: { code: voucher, partnerCode: main[1] || '', title: r.title, partner: r.partner, terms: r.terms || '', at: Date.now(), status: 'issued' }, coins });
}

async function post(req, res) {
  const body = await K.postBody(req, 2048);
  if (body.action === 'create') return create(req, res, body);
  if (body.action === 'rename') return rename(req, res, body);
  if (body.action === 'redeem') return redeem(req, res, body);
  K.fail(400, 'Unknown action.');
}

module.exports = K.handler({ GET: getMe, POST: post }, { name: 'me' });
module.exports.publicProfile = publicProfile;
