/**
 * GET /api/state — everything the map needs on top of the static washroom file, in one cached request:
 *   { enabled, ratings, issues: {id: open reports}, fixed: {id: [time, by]}, featured: [ids], verified: {id: {at, exp}},
 *     places: [approved washrooms added by scouts], owned: [ids with a verified operator] }
 * Without a database it returns {enabled:false} and the app keeps ratings on each device.
 */
const K = require('./_lib/core');
const { foldRatings } = require('./ratings');

async function get(req, res) {
  const [n, sum, w, so, sa, open, fixed, feat, ver, places, own, ema] = await K.redis([
    ['HGETALL', 'ss:n'], ['HGETALL', 'ss:sum'], ['HGETALL', 'ss:water'], ['HGETALL', 'ss:soap'], ['HGETALL', 'ss:safe'],
    ['HGETALL', 'ss:iss:open'], ['HGETALL', 'ss:iss:fixed'], ['HGETALL', 'ss:feat'], ['HGETALL', 'ss:ver'],
    ['HGETALL', 'ss:places'], ['HKEYS', 'ss:own'], ['HGETALL', 'ss:ema'],
  ]);
  // anything stored under an id that a later data rebuild merged into another washroom belongs to that washroom
  const ratings = foldRatings(n, sum, [w, so, sa]);
  const EMA = K.rekey(K.hash(ema, true), Math.min);
  const now = Date.now();
  const issues = {};
  for (const [id, c] of Object.entries(K.rekey(K.hash(open, true), (a, b) => a + b))) if (c > 0) issues[id] = c;
  const fixedOut = {};
  for (const [id, v] of Object.entries(K.rekey(K.hash(fixed), (a, b) => (Number(String(a).split('|')[0]) >= Number(String(b).split('|')[0]) ? a : b)))) {
    const [t, ...by] = String(v).split('|');
    if (now - Number(t) < 30 * 864e5) fixedOut[id] = [Number(t), by.join('|')];
  }
  // a featured listing shows only while it is paid up, has no open hygiene report and isn't rated poorly lately:
  // paying can't push people towards a dirty washroom
  const poor = (id) => EMA[id] != null && EMA[id] < 3 && ((ratings[id] && ratings[id].n) || 0) >= 2;
  const featured = Object.entries(K.rekey(K.hash(feat, true), Math.max)).filter(([id, exp]) => exp > now && !issues[id] && !poor(id)).map(([id]) => id);
  const verified = {};
  for (const [id, v] of Object.entries(K.rekey(K.jsonHash(ver), (a, b) => (a.exp >= b.exp ? a : b)))) if (v && v.exp > now) verified[id] = { at: v.at, exp: v.exp };
  const placeList = Object.values(K.jsonHash(places)).filter((p) => p && p.id).map((p) => {
    const o = {};
    for (const k of ['id', 'n', 's', 'c', 'cg', 'la', 'lo', 'st', 'd', 'city', 'a', 'fee', 'pr', 'g', 'wc', 'bc', 'oh', 'ts', 'at']) if (p[k] != null && p[k] !== '') o[k] = p[k];
    return o;
  });
  return K.send(res, 200, {
    enabled: true,
    ratings,
    rules: K.rules(),
    issues, fixed: fixedOut, featured, verified, places: placeList, owned: [...new Set((own || []).map((x) => K.canon(x)).filter(Boolean))],
  }, 'max-age=20, stale-while-revalidate=120');
}

module.exports = K.handler({ GET: get }, { name: 'state' });
