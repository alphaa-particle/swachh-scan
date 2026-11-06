/**
 * POST /api/ratings — rate a washroom's cleanliness (1–5 stars + water / soap / safety), and earn Swachh Coins.
 *   body {id, stars, water?, soap?, safe?}   (true | false | null for the three aspects)
 *   Authorization: Bearer <scout token>  (optional; without it the rating counts but earns no coins)
 * GET /api/ratings — every washroom's rating summary (kept for older pages; the app uses /api/state).
 *
 * Limits: anonymous — one rating per washroom per network per day; signed-in scouts — one per washroom per day
 * each, at most 5 per washroom per network per day; 30 ratings per network per hour. Coins: once per washroom
 * per 7 days, at most 10 rewarded ratings a day. All checks, counters and coins run in ONE Redis Lua script,
 * so they are atomic: parallel requests can't slip past a limit and a failure can't leave half a rating.
 */
const K = require('./_lib/core');
const { COINS, LIMITS } = K.CONFIG;
const ASPECTS = ['water', 'soap', 'safe'];

const RATE_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 hourly cap, 8 id, 9 stars, 10 water, 11 soap, 12 safe, 13 network key, 14 day, 15 community id flag, 16 description
local id = ARGV[8]
local stars = tonumber(ARGV[9])
if ARGV[15] == '1' and redis.call('HEXISTS', 'ss:places', id) == 0 then return {'unknown'} end
local auth = checkUser()
if auth == 'banned' then return {'banned'} end
local hk = 'ss:rl:h:' .. ARGV[13]
if tonumber(redis.call('GET', hk) or '0') >= tonumber(ARGV[7]) then return {'limited'} end
local nk = 'ss:rl:d:' .. ARGV[13] .. ':' .. id
local ncap = 1
local uk = nil
if auth then ncap = ${LIMITS.ratingsPerWashroomPerNetworkPerDay}; uk = 'ss:rl:du:' .. CTX.uid .. ':' .. id end
if tonumber(redis.call('GET', nk) or '0') >= ncap then return {'already'} end
if uk and redis.call('EXISTS', uk) == 1 then return {'already'} end
if uk then redis.call('SET', uk, '1', 'EX', 86400) end
if redis.call('INCR', nk) == 1 then redis.call('EXPIRE', nk, 86400) end
if redis.call('INCR', hk) == 1 then redis.call('EXPIRE', hk, 3600) end
local n = redis.call('HINCRBY', 'ss:n', id, 1)
local out = {'ok', n, redis.call('HINCRBY', 'ss:sum', id, stars)}
local names = {'ss:water', 'ss:soap', 'ss:safe'}
for i = 1, 3 do
  if ARGV[9 + i] ~= '' then redis.call('HINCRBY', names[i], id .. ':' .. ARGV[9 + i], 1) end
  local p = redis.call('HMGET', names[i], id .. ':y', id .. ':n')
  table.insert(out, p[1] or '0')
  table.insert(out, p[2] or '0')
end
-- recent cleanliness (weights the latest ratings most): the civic dashboard uses it to spot washrooms that need cleaning
local e = redis.call('HGET', 'ss:ema', id)
local ne = stars
if e then ne = tonumber(e) * 0.6 + stars * 0.4 end
redis.call('HSET', 'ss:ema', id, string.format('%.2f', ne))
-- who rated (distinct scouts / networks, for the Honor Roll) and when (a cleaning is "confirmed" by newer ratings)
if auth then redis.call('SADD', 'ss:rv:' .. id, CTX.uid) else redis.call('SADD', 'ss:rv:' .. id, 'n:' .. ARGV[13]) end
redis.call('HSET', 'ss:rated:at', id, CTX.now)
local ev = 'ss:ev:' .. ARGV[14]
redis.call('HINCRBY', ev, id .. ':rn', 1)
redis.call('HINCRBY', ev, id .. ':rs', stars)
redis.call('EXPIRE', ev, 34560000)
if auth then
  redis.call('HINCRBY', 'ss:u:' .. CTX.uid, 'rated', 1)
  if redis.call('SET', 'ss:cr:' .. CTX.uid .. ':' .. id, '1', 'EX', 604800, 'NX') then
    local ck = 'ss:cap:' .. CTX.uid .. ':' .. ARGV[14] .. ':rate'
    local cn = redis.call('INCR', ck)
    if cn == 1 then redis.call('EXPIRE', ck, 172800) end
    if cn <= ${LIMITS.ratingsRewardedPerDay} then
      award(CTX.uid, ${COINS.rate}, 'rate', ARGV[16])
      if n == 1 then award(CTX.uid, ${COINS.firstRating}, 'first', '"First to rate this washroom"') end
    end
  end
  contributed(CTX.uid)
end
table.insert(out, auth and '1' or '0')
return finish(out)`;

function summary(n, sum, flat) {
  const s = { n: Number(n) || 0, sum: Number(sum) || 0 };
  ASPECTS.forEach((a, i) => { s[a] = [Number(flat[2 * i]) || 0, Number(flat[2 * i + 1]) || 0]; });
  return s;
}

/** Rating of one washroom, including anything stored under ids that were later merged into it. */
async function currentSummary(id) {
  const D = K.data();
  const ids = [id, ...Object.keys(D.alias).filter((a) => D.alias[a] === id)];
  const cmds = [];
  for (const k of ids) cmds.push(['HGET', 'ss:n', k], ['HGET', 'ss:sum', k], ...ASPECTS.map((a) => ['HMGET', `ss:${a}`, `${k}:y`, `${k}:n`]));
  const out = await K.redis(cmds);
  const s = { n: 0, sum: 0, water: [0, 0], soap: [0, 0], safe: [0, 0] };
  for (let i = 0; i < ids.length; i++) {
    const o = out.slice(i * 5, i * 5 + 5);
    s.n += Number(o[0]) || 0; s.sum += Number(o[1]) || 0;
    ASPECTS.forEach((a, j) => { s[a][0] += Number(o[2 + j][0]) || 0; s[a][1] += Number(o[2 + j][1]) || 0; });
  }
  return s;
}

/** All ratings, folded onto current ids. Shared with /api/state. */
async function allRatings() {
  const [n, sum, ...asp] = await K.redis([['HGETALL', 'ss:n'], ['HGETALL', 'ss:sum'], ...ASPECTS.map((a) => ['HGETALL', `ss:${a}`])]);
  return foldRatings(n, sum, asp);
}
function foldRatings(n, sum, asp) {
  const N = K.hash(n, true), SUM = K.hash(sum, true), A = asp.map((x) => K.hash(x, true));
  const ratings = {};
  for (const stored of Object.keys(N)) {
    const id = K.resolveId(stored) || (K.COMMUNITY_ID.test(stored) ? stored : null);
    if (!id || !N[stored]) continue;
    const r = ratings[id] || (ratings[id] = { n: 0, sum: 0, water: [0, 0], soap: [0, 0], safe: [0, 0] });
    r.n += N[stored];
    r.sum += SUM[stored] || 0;
    ASPECTS.forEach((a, i) => { r[a][0] += A[i][`${stored}:y`] || 0; r[a][1] += A[i][`${stored}:n`] || 0; });
  }
  return ratings;
}

async function post(req, res) {
  const body = await K.postBody(req, 2048);
  const community = typeof body.id === 'string' && K.COMMUNITY_ID.test(body.id);
  const id = community ? body.id : K.resolveId(body.id);
  const stars = body.stars;
  if (!id) K.fail(400, 'Unknown washroom.');
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) K.fail(400, 'Choose 1 to 5 stars.');
  const tok = K.userToken(req);
  const user = tok ? { uid: tok.uid, th: tok.th } : null;
  const place = community ? null : K.staticPlace(id);
  const desc = K.jstr(`Rated ${place ? place.n : 'a washroom'}${place && (place.city || place.d) ? `, ${place.city || place.d}` : ''} ${stars}★`);
  const aspect = (v) => (v === true ? 'y' : v === false ? 'n' : '');
  let out;
  try {
    [out] = await K.redis([[
      'EVAL', RATE_SCRIPT, '0', ...K.coinArgs(user),
      String(LIMITS.ratingsPerNetworkPerHour), id, String(stars), aspect(body.water), aspect(body.soap), aspect(body.safe),
      K.netKey(req), K.dayKey(), community ? '1' : '0', desc,
    ]]);
  } catch (err) {
    if (err instanceof K.MaybeSaved) {
      // the script may have run; never retry automatically (that could count the rating twice)
      return K.send(res, 503, { code: 'maybe_saved', error: 'Your rating may already have been saved. Check again in a minute before rating again.' });
    }
    throw err;
  }
  const [main, coins] = K.splitCoins(out);
  if (main[0] === 'unknown') K.fail(400, 'Unknown washroom.');
  if (main[0] === 'banned') K.fail(403, 'This profile has been suspended.', { code: 'banned' });
  if (main[0] === 'limited') return K.send(res, 429, { code: 'rate_limited', error: 'Too many ratings from your network. Please try again later.' });
  if (main[0] === 'already') {
    return K.send(res, 429, { code: 'already_rated', error: user ? 'You already rated this washroom today. Come back tomorrow!' : 'Thanks — this washroom was already rated from your network today.', rating: await currentSummary(id) });
  }
  const s = summary(main[1], main[2], main.slice(3, 9));
  if (!community && Object.values(K.data().alias).includes(id)) Object.assign(s, await currentSummary(id));
  const authed = main[9] === '1';
  return K.send(res, 200, { ok: true, id, rating: s, coins: authed ? coins : null, auth: user ? authed : undefined });
}

async function get(req, res) {
  return K.send(res, 200, { enabled: true, ratings: await allRatings() }, 'max-age=30, stale-while-revalidate=300');
}

module.exports = K.handler({ GET: get, POST: post }, { name: 'ratings', maybeSaved: 'Your rating may already have been saved. Check again in a minute before rating again.' });
module.exports.allRatings = allRatings;
module.exports.foldRatings = foldRatings;
