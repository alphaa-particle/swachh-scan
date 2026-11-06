/**
 * Community features.
 *   POST {action:'report', id, issues:[...], note?}   report a hygiene problem (coins for scouts)
 *   POST {action:'place', n, s, c, la, lo, fee?, g?, wc?, bc?, oh?, note?}   suggest a missing washroom (scouts; reviewed by an admin)
 *   GET ?action=leaderboard&period=week|month|all
 *   GET ?action=honor                                monthly champions, Platinum scouts, cleanest washrooms
 *   GET ?action=rewards[&lat=&lon=]                  reward catalogue (+ offers from businesses near you)
 *   GET ?action=issues&id=                           recent reports for one washroom (no personal notes)
 */
const K = require('./_lib/core');
const { COINS, LIMITS, ISSUES, SAMPLE_REWARDS } = K.CONFIG;

const REPORT_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 washroom id, 8 network key, 9 day, 10 report id, 11 issues, 12 note, 13 name, 14 state, 15 district, 16 city, 17 description
local id = ARGV[7]
local auth = checkUser()
if auth == 'banned' then return {'banned'} end
local hk = 'ss:rl:rh:' .. ARGV[8]
if tonumber(redis.call('GET', hk) or '0') >= ${LIMITS.reportsPerNetworkPerHour} then return {'limited'} end
local dk = 'ss:rl:rn:' .. ARGV[8] .. ':' .. id
if auth then dk = 'ss:rl:ru:' .. CTX.uid .. ':' .. id end
if not redis.call('SET', dk, '1', 'EX', 43200, 'NX') then return {'already'} end
if redis.call('INCR', hk) == 1 then redis.call('EXPIRE', hk, 3600) end
local rk = 'ss:rep:' .. ARGV[10]
local uid = ''
if auth then uid = CTX.uid end
redis.call('HSET', rk, 'w', id, 'iss', ARGV[11], 'note', ARGV[12], 'uid', uid, 'ts', CTX.now, 'st', 'open', 'n', ARGV[13], 'sta', ARGV[14], 'd', ARGV[15], 'city', ARGV[16])
redis.call('ZADD', 'ss:rep:open', CTX.now, ARGV[10])
redis.call('ZADD', 'ss:rep:all', CTX.now, ARGV[10])
redis.call('ZREMRANGEBYRANK', 'ss:rep:all', 0, -5001)
redis.call('ZADD', 'ss:rep:w:' .. id, CTX.now, ARGV[10])
redis.call('SADD', 'ss:rep:wo:' .. id, ARGV[10])
redis.call('ZREMRANGEBYRANK', 'ss:rep:w:' .. id, 0, -51)
redis.call('HINCRBY', 'ss:iss:open', id, 1)
local ev = 'ss:ev:' .. ARGV[9]
redis.call('HINCRBY', ev, id .. ':rp', 1)
redis.call('EXPIRE', ev, 34560000)
if auth then
  redis.call('HINCRBY', 'ss:u:' .. CTX.uid, 'reports', 1)
  local ck = 'ss:cap:' .. CTX.uid .. ':' .. ARGV[9] .. ':rep'
  local cn = redis.call('INCR', ck)
  if cn == 1 then redis.call('EXPIRE', ck, 172800) end
  if cn <= ${LIMITS.reportsRewardedPerDay} then award(CTX.uid, ${COINS.report}, 'report', ARGV[17]) end
  contributed(CTX.uid)
end
local authed = '0'
if auth then authed = '1' end
return finish({'ok', authed})`;

async function report(req, res, body) {
  const place = await K.findPlace(body.id);
  if (!place) K.fail(400, 'Unknown washroom.');
  if (!Array.isArray(body.issues) || !body.issues.length || body.issues.length > 8) K.fail(400, 'Choose what was wrong.');
  const issues = [...new Set(body.issues)].map((x) => K.oneOf(x, Object.keys(ISSUES), 'Problem'));
  const note = K.text(body.note, 280, { label: 'Note', multiline: true });
  if (issues.includes('other') && !note) K.fail(400, 'Tell us what was wrong.');
  const tok = K.userToken(req);
  const user = tok ? { uid: tok.uid, th: tok.th } : null;
  const rid = K.rid(10);
  const [out] = await K.redis([[
    'EVAL', REPORT_SCRIPT, '0', ...K.coinArgs(user),
    place.id, K.netKey(req), K.dayKey(), rid, issues.join(','), note, place.n, place.st, place.d, place.city,
    K.jstr(`Reported: ${issues.map((i) => ISSUES[i]).join(', ')} at ${place.n}`),
  ]]);
  const [main, coins] = K.splitCoins(out);
  if (main[0] === 'banned') K.fail(403, 'This profile has been suspended.', { code: 'banned' });
  if (main[0] === 'limited') K.fail(429, 'Too many reports from your network. Please try again later.', { code: 'rate_limited' });
  if (main[0] === 'already') K.fail(429, 'You already reported this washroom in the last 12 hours. Thank you!', { code: 'already_reported' });
  const authed = main[1] === '1';
  return K.send(res, 200, { ok: true, id: rid, coins: authed ? coins : null, auth: user ? authed : undefined });
}

const FEE = ['free', 'paid'];
const G = ['separate', 'men', 'women', 'unisex'];
const WC = ['yes', 'limited', 'no'];
const CATS = ['Public toilet', 'Petrol pump', 'Restaurant / café', 'Mall / shop', 'Railway / bus station', 'Metro station', 'Hospital / clinic', 'Place of worship', 'Park', 'Tourist place', 'Office / government', 'Other'];

async function place(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const n = K.text(body.n, 80, { required: true, label: 'Name', min: 3 });
  const s = body.s === true || body.s === 1 ? 1 : 0;
  const c = s ? 'Public toilet' : K.oneOf(body.c, CATS.slice(1), 'Type of place');
  const la = K.num(body.la, 6, 37.5, 'Location');
  const lo = K.num(body.lo, 68, 97.6, 'Location');
  const p = {
    n, s, c, la: Math.round(la * 1e6) / 1e6, lo: Math.round(lo * 1e6) / 1e6,
    fee: body.fee ? K.oneOf(body.fee, FEE, 'Cost') : '',
    pr: K.text(body.pr, 20, { label: 'Price' }),
    g: body.g ? K.oneOf(body.g, G, 'Men / women') : '',
    wc: body.wc ? K.oneOf(body.wc, WC, 'Wheelchair') : '',
    bc: body.bc ? K.oneOf(body.bc, ['yes', 'no'], 'Baby changing') : '',
    oh: K.text(body.oh, 80, { label: 'Opening hours' }),
    a: K.text(body.a, 140, { label: 'Address' }),
    note: K.text(body.note, 280, { label: 'Note', multiline: true }),
  };
  const near = K.nearestStatic(p.la, p.lo);
  if (!near || near.km > 60) K.fail(400, 'That point is too far from any place we cover. Check the location.');
  // likely the same washroom: ask the scout to rate the existing one instead
  if (near.km < 0.025 && near.place.s === s && body.confirm !== true) {
    K.fail(409, `“${near.place.n}” is already on the map ${Math.round(near.km * 1000)} m from here. Is it the same washroom?`, { code: 'duplicate', existing: near.place.id });
  }
  // reserve a pending slot first (atomic), give it back if over the cap
  const [pending] = await K.redis([['HINCRBY', 'ss:pend:byuser', me.uid, 1]]);
  if (pending > LIMITS.pendingPlacesPerUser) {
    await K.redis([['HINCRBY', 'ss:pend:byuser', me.uid, -1]]);
    K.fail(429, 'You have several washrooms waiting for review. Please wait until they are checked.');
  }
  const id = `SS-${K.rid(8)}`;
  Object.assign(p, { id, st: near.place.st, d: near.km < 15 ? near.place.d : '', city: near.km < 8 ? near.place.city : '', uid: me.uid, at: Date.now(), near: [near.place.id, Math.round(near.km * 1000)] });
  await K.redis([
    ['HSET', 'ss:pend:pl', id, JSON.stringify(p)],
    ['ZADD', 'ss:pend:pl:q', Date.now(), id],
    ['LPUSH', `ss:led:${me.uid}`, JSON.stringify({ t: Date.now(), k: 'place-pending', c: 0, d: `Suggested ${n} — waiting for review (+${COINS.place} when approved)` })],
    ['LTRIM', `ss:led:${me.uid}`, 0, 99],
  ]);
  return K.send(res, 200, { ok: true, id, pending: true, coinsOnApproval: COINS.place });
}

// ------------------------------------------------------------------ reads
async function leaderboard(req, res) {
  const period = K.query(req).get('period') || 'week';
  const key = { week: `ss:lb:w:${K.weekKey()}`, month: `ss:lb:m:${K.monthKey()}`, all: 'ss:lb:all' }[period];
  if (!key) K.fail(400, 'Unknown period.');
  const [flat, total] = await K.redis([['ZREVRANGE', key, 0, 99, 'WITHSCORES'], ['ZCARD', key]]);
  const rows = K.zpairs(flat).filter(([, s]) => s > 0);
  const who = await K.names(rows.map((r) => r[0]));
  let rank = 0;
  const top = [];
  for (const [uid, coins] of rows) {
    if (who[uid].banned) continue;
    rank++;
    top.push({ rank, uid, name: who[uid].name, coins, tier: K.tierOf(who[uid].earned).name });
    if (top.length >= 50) break;
  }
  return K.send(res, 200, { period, key: key.replace('ss:lb:', ''), total: Number(total) || 0, top }, 'max-age=30, stale-while-revalidate=120');
}

async function honor(req, res) {
  const months = [];
  const d = new Date(Date.now() + 5.5 * 3600e3); // months in India time, like the leaderboards
  for (let i = 1; i <= 12; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15));
    months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const out = await K.redis([
    ...months.map((m) => ['ZREVRANGE', `ss:lb:m:${m}`, 0, 4, 'WITHSCORES']),
    ['ZREVRANGEBYSCORE', 'ss:lb:all', '+inf', K.CONFIG.TIERS[3].min, 'WITHSCORES', 'LIMIT', 0, 60],
    ['ZREVRANGEBYSCORE', 'ss:lb:all', K.CONFIG.TIERS[3].min - 1, K.CONFIG.TIERS[2].min, 'WITHSCORES', 'LIMIT', 0, 60],
    ['HGETALL', 'ss:n'], ['HGETALL', 'ss:sum'], ['HGETALL', 'ss:ver'], ['HGETALL', 'ss:places'],
  ]);
  const monthRows = months.map((m, i) => ({ month: m, rows: K.zpairs(out[i]) }));
  const plat = K.zpairs(out[12]), gold = K.zpairs(out[13]);
  const uids = [...new Set([...monthRows.flatMap((m) => m.rows.map((r) => r[0])), ...plat.map((r) => r[0]), ...gold.map((r) => r[0])])];
  const who = await K.names(uids);
  const champions = monthRows.map((m) => ({ month: m.month, top: m.rows.filter(([u, s]) => s > 0 && !who[u].banned).slice(0, 3).map(([u, s]) => ({ name: who[u].name, coins: s })) })).filter((m) => m.top.length);
  const people = (rows) => rows.filter(([u]) => !who[u].banned).slice(0, 50).map(([u, s]) => ({ name: who[u].name, earned: s }));
  // cleanest washrooms: at least 3 ratings, average 4.3+
  const N = K.hash(out[14], true), SUM = K.hash(out[15], true), VER = K.jsonHash(out[16]), PL = K.jsonHash(out[17]);
  const agg = {};
  for (const stored of Object.keys(N)) {
    const id = K.resolveId(stored) || (PL[stored] ? stored : null);
    if (!id) continue;
    const a = agg[id] || (agg[id] = { n: 0, sum: 0 });
    a.n += N[stored]; a.sum += SUM[stored] || 0;
  }
  // at least 3 different raters (scouts or networks), not just 3 ratings from one person
  const cand = Object.entries(agg).filter(([, a]) => a.n >= 3 && a.sum / a.n >= 4.3);
  const raters = cand.length ? await K.redis(cand.map(([id]) => ['SUNION', ...K.idsFor(id).map((x) => `ss:rv:${x}`)])) : [];
  const cleanest = cand.filter((c, i) => new Set(raters[i] || []).size >= 3)
    .map(([id, a]) => { const p = K.staticPlace(id) || (PL[id] && { id, n: PL[id].n, city: PL[id].city, d: PL[id].d, st: PL[id].st }); return { id, n: p.n, place: [p.city, p.d, p.st].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 2).join(', '), avg: Math.round((a.sum / a.n) * 10) / 10, count: a.n, verified: !!(VER[id] && VER[id].exp > Date.now()) }; })
    .sort((x, y) => y.avg - x.avg || y.count - x.count).slice(0, 30);
  return K.send(res, 200, { champions, platinum: people(plat), gold: people(gold), cleanest, tiers: K.CONFIG.TIERS }, 'max-age=120, stale-while-revalidate=600');
}

/** Sample rewards appear (as "coming soon", no stock) until an admin adds real ones. */
async function ensureSampleRewards() {
  const [seeded] = await K.redis([['SET', 'ss:rw:seeded', '1', 'NX']]);
  if (!seeded) return;
  const cmds = [];
  SAMPLE_REWARDS.forEach((r, i) => {
    cmds.push(['HSET', 'ss:rw', r.id, JSON.stringify(Object.assign({ sample: true, order: i }, r))], ['HSET', 'ss:rw:on', r.id, '1']);
  });
  await K.redis(cmds);
}

async function rewards(req, res) {
  await ensureSampleRewards();
  const q = K.query(req);
  const la = Number(q.get('lat')), lo = Number(q.get('lon'));
  const here = Number.isFinite(la) && Number.isFinite(lo) && q.get('lat') && q.get('lon') ? { la, lo } : null;
  const wanted = q.get('reward') || ''; // a "Get offer" link: always describe that offer, even when it's out of range
  const [all, on, used] = await K.redis([['HGETALL', 'ss:rw'], ['HGETALL', 'ss:rw:on'], ['HGETALL', 'ss:rw:used']]);
  const RW = K.jsonHash(all), ON = K.hash(on), USED = K.hash(used, true);
  const now = Date.now();
  const list = Object.values(RW).filter((r) => r && ON[r.id] === '1' && !(r.ends && r.ends < now));
  const stock = list.length ? await K.redis(list.map((r) => (r.mode === 'pool' ? ['LLEN', `ss:rw:pool:${r.id}`] : ['GET', `ss:rw:stock:${r.id}`]))) : [];
  const out = [];
  list.forEach((r, i) => {
    const o = { id: r.id, icon: r.icon || '🎁', title: r.title, partner: r.partner || '', cost: r.cost, terms: r.terms || '', left: Number(stock[i]) || 0, redeemed: USED[r.id] || 0, order: r.order || 0, limitDays: r.limitDays || 0, needs: r.needs || undefined };
    if (r.la != null && r.lo != null) {
      // a nearby business offer: only for people within its radius (redeeming checks the location again)
      Object.assign(o, { local: true, place: r.place || '', radius: r.r || 2, ends: r.ends });
      if (!here) o.needsLocation = true;
      else {
        const km = K.distKm(here, { la: r.la, lo: r.lo });
        o.km = Math.round(km * 10) / 10;
        if (km > (r.r || 2) + 0.5) { if (r.id !== wanted) return; o.tooFar = true; }
      }
    }
    out.push(o);
  });
  out.sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1) || (b.left > 0) - (a.left > 0) || a.order - b.order || a.cost - b.cost);
  return K.send(res, 200, { rewards: out, rules: K.rules() }, here ? 'max-age=60' : 'max-age=30, stale-while-revalidate=120');
}

async function issues(req, res) {
  const id = K.query(req).get('id') || '';
  const place = await K.findPlace(id);
  if (!place) K.fail(404, 'Unknown washroom.');
  const [ids, fixed] = await K.redis([['ZREVRANGE', `ss:rep:w:${place.id}`, 0, 9], ['HGET', 'ss:iss:fixed', place.id]]);
  const reps = ids && ids.length ? await K.redis(ids.map((r) => ['HMGET', `ss:rep:${r}`, 'iss', 'ts', 'st', 'upd', 'by', 'resp'])) : [];
  const list = reps.map(([iss, ts, st, upd, by, resp]) => ({ issues: (iss || '').split(',').filter(Boolean), at: Number(ts) || 0, status: st || 'open', updated: Number(upd) || 0, by: st === 'open' ? '' : by || '', response: st === 'resolved' || st === 'ack' ? resp || '' : '' }))
    .filter((r) => r.at && Date.now() - r.at < 90 * 864e5);
  let lastFixed = null;
  if (fixed) { const [t, ...by] = String(fixed).split('|'); lastFixed = { at: Number(t), by: by.join('|') }; }
  return K.send(res, 200, { id: place.id, reports: list, lastFixed }, 'max-age=15, stale-while-revalidate=60');
}

async function get(req, res) {
  const action = K.query(req).get('action');
  if (action === 'leaderboard') return leaderboard(req, res);
  if (action === 'honor') return honor(req, res);
  if (action === 'rewards') return rewards(req, res);
  if (action === 'issues') return issues(req, res);
  K.fail(400, 'Unknown action.');
}

async function post(req, res) {
  const body = await K.postBody(req, 4096);
  if (body.action === 'report') return report(req, res, body);
  if (body.action === 'place') return place(req, res, body);
  K.fail(400, 'Unknown action.');
}

module.exports = K.handler({ GET: get, POST: post }, { name: 'community' });
module.exports.CATS = CATS;
