/**
 * Admin API for /admin.html. Authorization: Bearer <ADMIN_TOKEN environment variable, 16+ characters>.
 *   GET  ?action=overview|places|claims|orders|reports|ads|rewards|keys|users[&q=]|voucher&code=
 *   POST {action: 'place' | 'claim' | 'order-paid' | 'order-reject' | 'verify-result' | 'ad-state' | 'report' | 'cleaned'
 *                 | 'reward-save' | 'reward-stock' | 'reward-codes' | 'reward-delete' | 'key-create' | 'key-revoke'
 *                 | 'user-ban' | 'user-adjust' | 'user-rename' | 'voucher-use' | 'owner-remove', ...}
 */
const crypto = require('crypto');
const K = require('./_lib/core');
const R = require('./_lib/reports');
const { COINS, PLANS } = K.CONFIG;

function requireAdmin(req) {
  if (!K.ADMIN_TOKEN || K.ADMIN_TOKEN.length < 16) K.fail(503, 'Set an ADMIN_TOKEN environment variable (16+ characters) in Vercel, then redeploy.', { code: 'no_admin' });
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || '').trim());
  if (!m || !K.safeEqual(K.sha256(m[1]), K.sha256(K.ADMIN_TOKEN))) K.fail(401, 'Wrong admin password.', { code: 'bad_admin' });
}

const PLACE_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 place id, 8 final JSON, 9 submitter uid, 10 description, 11 approve|reject
local raw = redis.call('HGET', 'ss:pend:pl', ARGV[7])
if not raw then return {'missing'} end
redis.call('HDEL', 'ss:pend:pl', ARGV[7])
redis.call('ZREM', 'ss:pend:pl:q', ARGV[7])
local sub = ARGV[9]
if sub ~= '' then
  local left = redis.call('HINCRBY', 'ss:pend:byuser', sub, -1)
  if left <= 0 then redis.call('HDEL', 'ss:pend:byuser', sub) end
end
if ARGV[11] == 'approve' then
  redis.call('HSET', 'ss:places', ARGV[7], ARGV[8])
  if sub ~= '' then
    redis.call('HINCRBY', 'ss:u:' .. sub, 'places', 1)
    award(sub, ${COINS.place}, 'place', ARGV[10])
    contributed(sub)
  end
elseif sub ~= '' then
  redis.call('LPUSH', 'ss:led:' .. sub, entry('place-rejected', 0, ARGV[10]))
  redis.call('LTRIM', 'ss:led:' .. sub, 0, 99)
end
return finish({'ok'})`;

const ADJUST_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 uid, 8 amount, 9 description
if redis.call('EXISTS', 'ss:u:' .. ARGV[7]) == 0 then return {'missing'} end
award(ARGV[7], tonumber(ARGV[8]), 'admin', ARGV[9])
return finish({'ok', redis.call('HGET', 'ss:u:' .. ARGV[7], 'coins')})`;

const area = (p) => [p.city, p.d, p.st].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2).join(', ');

// ------------------------------------------------------------------ reads
async function overview() {
  const [pl, cl, oq, rep, users, bizs, ads, keys, places] = await K.redis([
    ['ZCARD', 'ss:pend:pl:q'], ['ZCARD', 'ss:claims:q'], ['ZRANGE', 'ss:ord:q', 0, -1], ['ZCARD', 'ss:rep:open'], ['ZCARD', 'ss:users'], ['ZCARD', 'ss:bizs'],
    ['HVALS', 'ss:ads'], ['HLEN', 'ss:ak'], ['HLEN', 'ss:places'],
  ]);
  const st = oq && oq.length ? await K.redis(oq.map((o) => ['HGET', `ss:ord:${o}`, 'st'])) : [];
  const count = (s) => st.filter((x) => x === s).length;
  const now = Date.now();
  const adList = (ads || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  return {
    pendingPlaces: Number(pl) || 0, pendingClaims: Number(cl) || 0, paymentsToConfirm: count('payment_submitted'), awaitingPayment: count('awaiting_payment'),
    inspections: count('inspection'), openReports: Number(rep) || 0, users: Number(users) || 0, businesses: Number(bizs) || 0,
    liveAds: adList.filter((a) => a.st === 'live' && a.start <= now && now < a.end).length, officerKeys: Number(keys) || 0, communityPlaces: Number(places) || 0,
    config: { upi: !!K.UPI, plans: PLANS },
  };
}

async function places() {
  const [ids] = await K.redis([['ZRANGE', 'ss:pend:pl:q', 0, 199]]);
  const raws = ids && ids.length ? await K.redis([['HMGET', 'ss:pend:pl', ...ids]]).then((x) => x[0]) : [];
  const list = (raws || []).map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
  const who = await K.names([...new Set(list.map((p) => p.uid).filter(Boolean))]);
  return list.map((p) => {
    const near = p.near ? K.staticPlace(p.near[0]) : null;
    return Object.assign({}, p, { scout: p.uid ? (who[p.uid] || {}).name : '', nearest: near ? { id: near.id, n: near.n, m: p.near[1], s: near.s } : null });
  });
}

async function claims() {
  const [ids] = await K.redis([['ZRANGE', 'ss:claims:q', 0, 199]]);
  const hs = ids && ids.length ? await K.redis(ids.map((c) => ['HGETALL', `ss:claim:${c}`])) : [];
  const list = (ids || []).map((c, i) => Object.assign({ id: c }, K.hash(hs[i])));
  const biz = list.length ? await K.redis(list.map((c) => ['HGETALL', `ss:biz:${c.uid}`])) : [];
  return Promise.all(list.map(async (c, i) => { const p = await K.findPlace(c.w); return Object.assign(c, { at: Number(c.at) || 0, business: K.hash(biz[i]), area: p ? area(p) : '' }); }));
}

async function orders(q) {
  const all = q.get('status') === 'all';
  const [ids] = await K.redis([['ZRANGE', 'ss:ord:q', 0, -1]]);
  let list = ids || [];
  if (all) {
    // recent orders across businesses
    const [bizs] = await K.redis([['ZREVRANGE', 'ss:bizs', 0, 99]]);
    const per = bizs && bizs.length ? await K.redis(bizs.map((u) => ['ZREVRANGE', `ss:ord:u:${u}`, 0, 19])) : [];
    list = [...new Set([...list, ...per.flat()])];
  }
  const hs = list.length ? await K.redis(list.map((o) => ['HGETALL', `ss:ord:${o}`])) : [];
  const out = list.map((o, i) => Object.assign({ id: o }, K.hash(hs[i]))).filter((o) => o.uid);
  const bz = out.length ? await K.redis(out.map((o) => ['HGETALL', `ss:biz:${o.uid}`])) : [];
  const [ads] = await K.redis([['HGETALL', 'ss:ads']]);
  const AD = K.jsonHash(ads);
  return out.map((o, i) => Object.assign(o, { amount: Number(o.amount) || 0, at: Number(o.at) || 0, business: K.hash(bz[i]), campaign: o.kind && o.kind.startsWith('ad') ? AD[o.target] || null : undefined }))
    .sort((a, b) => (a.st === 'payment_submitted' ? -1 : 0) - (b.st === 'payment_submitted' ? -1 : 0) || b.at - a.at);
}

async function reports() {
  const [ids] = await K.redis([['ZREVRANGE', 'ss:rep:open', 0, 499]]);
  return R.readReports(ids || []);
}

async function adsList() {
  const [all] = await K.redis([['HGETALL', 'ss:ads']]);
  return Object.values(K.jsonHash(all)).filter(Boolean).sort((a, b) => b.at - a.at);
}

/** The sample rewards are normally created the first time someone opens the catalogue; make sure admins see them too. */
async function ensureSampleRewards() {
  const [seeded] = await K.redis([['SET', 'ss:rw:seeded', '1', 'NX']]);
  if (!seeded) return;
  const cmds = [];
  K.CONFIG.SAMPLE_REWARDS.forEach((r, i) => {
    cmds.push(['HSET', 'ss:rw', r.id, JSON.stringify(Object.assign({ sample: true, order: i }, r))], ['HSET', 'ss:rw:on', r.id, '1']);
  });
  await K.redis(cmds);
}

async function rewardsList() {
  await ensureSampleRewards();
  const [all, on, used] = await K.redis([['HGETALL', 'ss:rw'], ['HGETALL', 'ss:rw:on'], ['HGETALL', 'ss:rw:used']]);
  const RW = Object.values(K.jsonHash(all)).filter(Boolean);
  const stock = RW.length ? await K.redis(RW.flatMap((r) => [['GET', `ss:rw:stock:${r.id}`], ['LLEN', `ss:rw:pool:${r.id}`]])) : [];
  const ON = K.hash(on), USED = K.hash(used, true);
  return RW.map((r, i) => Object.assign({}, r, { active: ON[r.id] === '1', stock: Number(stock[2 * i]) || 0, pool: Number(stock[2 * i + 1]) || 0, redeemed: USED[r.id] || 0 }))
    .sort((a, b) => (a.aid ? 1 : 0) - (b.aid ? 1 : 0) || (a.order || 0) - (b.order || 0));
}

async function keys() {
  const [all] = await K.redis([['HGETALL', 'ss:ak']]);
  return Object.entries(K.jsonHash(all)).map(([h, v]) => Object.assign({ hash: h, hint: h.slice(0, 8) }, v)).sort((a, b) => b.at - a.at);
}

async function users(q) {
  const term = (q.get('q') || '').trim();
  let uids = [];
  let direct = false;
  if (/^[A-Za-z2-9]{6}$/.test(term)) { const [u] = await K.redis([['GET', `ss:ref:${term.toUpperCase()}`]]); if (u) { uids.push(u); direct = true; } }
  if (/^[a-z2-9]{12}$/.test(term)) { uids.push(term); direct = true; }
  if (!uids.length) {
    const [recent, top] = await K.redis([['ZREVRANGE', 'ss:users', 0, 299], ['ZREVRANGE', 'ss:lb:all', 0, 49]]);
    uids = [...new Set([...(top || []), ...(recent || [])])];
  }
  const hs = uids.length ? await K.redis(uids.map((u) => ['HGETALL', `ss:u:${u}`])) : [];
  let list = uids.map((u, i) => { const h = K.hash(hs[i]); return h.th ? { uid: u, name: h.name, coins: Number(h.coins) || 0, earned: Number(h.earned) || 0, rated: Number(h.rated) || 0, reports: Number(h.reports) || 0, places: Number(h.places) || 0, refs: Number(h.refs) || 0, ref: h.ref, created: Number(h.c) || 0, banned: h.banned === '1' } : null; }).filter(Boolean);
  if (term && !direct) list = list.filter((u) => (u.name || '').toLowerCase().includes(term.toLowerCase()));
  return list.slice(0, 100);
}

async function voucher(q) {
  const c = String(q.get('code') || '').toUpperCase().replace(/\s/g, '');
  const [flat] = await K.redis([['HGETALL', `ss:red:${c}`]]);
  const v = K.hash(flat);
  if (!v.rw) K.fail(404, 'No voucher with this code.');
  const who = await K.names([v.uid]);
  return Object.assign({ code: c, scout: (who[v.uid] || {}).name }, v, { ts: Number(v.ts) || 0, usedAt: Number(v.usedAt) || 0 });
}

async function get(req, res) {
  requireAdmin(req);
  const q = K.query(req);
  const action = q.get('action');
  const fn = { overview, places, claims, orders: () => orders(q), reports, ads: adsList, rewards: rewardsList, keys, users: () => users(q), voucher: () => voucher(q) }[action];
  if (!fn) K.fail(400, 'Unknown action.');
  return K.send(res, 200, { [action]: await fn() });
}

// ------------------------------------------------------------------ writes
async function placeDecision(b) {
  const id = String(b.id || '');
  const [raw] = await K.redis([['HGET', 'ss:pend:pl', id]]);
  if (!raw) K.fail(404, 'Already handled.');
  const p = JSON.parse(raw);
  const decision = K.oneOf(b.decision, ['approve', 'reject'], 'Decision');
  const e = b.edits || {};
  if (e.n) p.n = K.text(e.n, 80, { label: 'Name', min: 3 });
  if (e.city !== undefined) p.city = K.text(e.city, 60, { label: 'City' });
  if (e.d !== undefined) p.d = K.text(e.d, 60, { label: 'District' });
  if (e.st) p.st = K.text(e.st, 60, { label: 'State' });
  const final = { id: p.id, n: p.n, s: p.s, c: p.c, cg: p.s ? 'Public toilets' : 'Added by scouts', la: p.la, lo: p.lo, st: p.st, d: p.d, city: p.city, a: p.a, fee: p.fee, pr: p.pr, g: p.g, wc: p.wc, bc: p.bc, oh: p.oh, at: Date.now(), by: p.uid };
  const reason = K.text(b.note, 160, { label: 'Note' });
  const desc = decision === 'approve' ? K.jstr(`Your washroom “${p.n}” was added to the map`) : K.jstr(`“${p.n}” wasn’t added${reason ? `: ${reason}` : ''}`);
  const [out] = await K.redis([['EVAL', PLACE_SCRIPT, '0', ...K.coinArgs(null), id, JSON.stringify(final), p.uid || '', desc, decision]]);
  if (K.splitCoins(out)[0][0] !== 'ok') K.fail(404, 'Already handled.');
  return { ok: true };
}

async function claimDecision(b) {
  const id = String(b.id || '');
  const [flat] = await K.redis([['HGETALL', `ss:claim:${id}`]]);
  const c = K.hash(flat);
  if (!c.w || c.st !== 'pending') K.fail(404, 'Already handled.');
  const decision = K.oneOf(b.decision, ['approve', 'reject'], 'Decision');
  const note = K.text(b.note, 160, { label: 'Note' });
  const cmds = [['HSET', `ss:claim:${id}`, 'st', decision === 'approve' ? 'approved' : 'rejected', 'adminNote', note, 'upd', String(Date.now())], ['ZREM', 'ss:claims:q', id]];
  if (decision === 'approve') {
    const w = K.canon(c.w) || c.w;
    const [owners] = await K.redis([['HMGET', 'ss:own', ...K.idsFor(w)]]);
    const other = (owners || []).find((o) => o && o !== c.uid);
    if (other) K.fail(409, 'Another operator already manages this washroom. Remove them first (Claims → Remove an operator).');
    cmds.push(['HSET', 'ss:own', w, c.uid], ['SADD', `ss:own:u:${c.uid}`, w]);
  }
  await K.redis(cmds);
  return { ok: true };
}

async function orderPaid(b) {
  const id = String(b.id || '');
  const [flat] = await K.redis([['HGETALL', `ss:ord:${id}`]]);
  const o = K.hash(flat);
  if (!o.uid) K.fail(404, 'Order not found.');
  if (!['awaiting_payment', 'payment_submitted'].includes(o.st)) K.fail(409, 'This order is not waiting for payment.');
  const now = Date.now();
  const days = Number(o.days) || 30;
  const cmds = [['HSET', `ss:ord:${id}`, 'paidAt', String(now)]];
  if (o.kind === 'featured' || o.kind === 'analytics') {
    const key = o.kind === 'featured' ? 'ss:feat' : 'ss:ana';
    const [cur] = await K.redis([['HGET', key, o.target]]);
    const until = Math.max(Number(cur) || 0, now) + days * 864e5;
    cmds.push(['HSET', key, o.target, String(until)], ['HSET', `ss:ord:${id}`, 'st', 'active', 'until', String(until)], ['ZREM', 'ss:ord:q', id]);
  } else if (o.kind === 'verify') {
    cmds.push(['HSET', `ss:ord:${id}`, 'st', 'inspection']);
  } else if (o.kind === 'ad7' || o.kind === 'ad30') {
    const [raw] = await K.redis([['HGET', 'ss:ads', o.target]]);
    if (!raw) K.fail(404, 'Campaign not found.');
    const a = JSON.parse(raw);
    a.st = 'live'; a.start = now; a.end = now + days * 864e5;
    if (a.offer) {
      a.rw = `ad-${a.id}`;
      const r = { id: a.rw, icon: '🏷️', title: a.offer.title, partner: a.biz, cost: a.offer.cost, mode: 'gen', limitDays: 7, terms: `Show this code at ${a.biz}${a.place ? `, ${a.place}` : ''}.`, la: a.la, lo: a.lo, r: a.r, place: a.place || '', ends: a.end, owner: a.uid, aid: a.id, order: 0 };
      cmds.push(['HSET', 'ss:rw', r.id, JSON.stringify(r)], ['HSET', 'ss:rw:on', r.id, '1'], ['SET', `ss:rw:stock:${r.id}`, String(a.offer.stock)]);
    }
    cmds.push(['HSET', 'ss:ads', a.id, JSON.stringify(a)], ['HSET', `ss:ord:${id}`, 'st', 'active', 'until', String(a.end)], ['ZREM', 'ss:ord:q', id]);
  }
  await K.redis(cmds);
  return { ok: true };
}

/** Take a washroom away from its operator (wrong claim, contract ended). */
async function ownerRemove(b) {
  const w = K.canon(String(b.id || ''));
  if (!w) K.fail(400, 'Unknown washroom id.');
  const ids = K.idsFor(w);
  const [owners] = await K.redis([['HMGET', 'ss:own', ...ids]]);
  const uids = [...new Set((owners || []).filter(Boolean))];
  if (!uids.length) K.fail(404, 'Nobody manages this washroom.');
  await K.redis([['HDEL', 'ss:own', ...ids], ...uids.map((u) => ['SREM', `ss:own:u:${u}`, ...ids])]);
  return { ok: true, removed: uids.length };
}

async function orderReject(b) {
  const id = String(b.id || '');
  const [flat] = await K.redis([['HGETALL', `ss:ord:${id}`]]);
  const o = K.hash(flat);
  if (!o.uid) K.fail(404, 'Order not found.');
  // only orders that haven't switched anything on yet; active services are ended from their own controls
  if (!['awaiting_payment', 'payment_submitted', 'inspection'].includes(o.st)) K.fail(409, `This order is ${String(o.st || '').replace(/_/g, ' ')}; only unpaid, unconfirmed or not-yet-inspected orders can be rejected.`);
  const note = K.text(b.note, 200, { required: true, label: 'Reason' });
  const cmds = [['HSET', `ss:ord:${id}`, 'st', 'rejected', 'note', note], ['ZREM', 'ss:ord:q', id]];
  if (o.kind && o.kind.startsWith('ad')) {
    const [raw] = await K.redis([['HGET', 'ss:ads', o.target]]);
    if (raw) { const a = JSON.parse(raw); a.st = 'rejected'; a.note = note; cmds.push(['HSET', 'ss:ads', a.id, JSON.stringify(a)]); if (a.rw) cmds.push(['HSET', 'ss:rw:on', a.rw, '0']); }
  }
  await K.redis(cmds);
  return { ok: true };
}

const CHECKS = ['clean', 'water', 'soap', 'light', 'locks', 'dustbin', 'access', 'signage'];
async function verifyResult(b) {
  const id = String(b.id || '');
  const [flat] = await K.redis([['HGETALL', `ss:ord:${id}`]]);
  const o = K.hash(flat);
  if (o.kind !== 'verify' || o.st !== 'inspection') K.fail(409, 'This order is not waiting for an inspection.');
  const checks = {};
  for (const c of CHECKS) checks[c] = !!(b.checks && b.checks[c]);
  const pass = b.pass === true;
  const note = K.text(b.note, 300, { label: 'Inspector notes', multiline: true });
  const now = Date.now();
  const cmds = [['HSET', `ss:ord:${id}`, 'st', 'completed', 'result', pass ? 'passed' : 'not passed', 'note', note], ['ZREM', 'ss:ord:q', id]];
  if (pass) cmds.push(['HSET', 'ss:ver', o.target, JSON.stringify({ at: now, exp: now + (Number(o.days) || 180) * 864e5, checks, note, by: 'Swachh Scan inspector' })]);
  await K.redis(cmds);
  return { ok: true };
}

async function adState(b) {
  const [raw] = await K.redis([['HGET', 'ss:ads', String(b.id || '')]]);
  if (!raw) K.fail(404, 'Campaign not found.');
  const a = JSON.parse(raw);
  a.st = K.oneOf(b.state, ['live', 'paused', 'ended', 'rejected'], 'State');
  if (a.st === 'live' && !a.start) K.fail(409, 'Confirm the payment first; that starts the campaign.');
  if (a.st === 'ended') a.end = Math.min(a.end || Date.now(), Date.now());
  a.pausedBy = a.st === 'paused' ? 'admin' : undefined; // the advertiser can't resume an admin pause
  const cmds = [['HSET', 'ss:ads', a.id, JSON.stringify(a)]];
  if (a.rw) {
    const [adminOff] = await K.redis([['HGET', 'ss:rw:adminoff', a.rw]]);
    cmds.push(['HSET', 'ss:rw:on', a.rw, a.st === 'live' && !adminOff ? '1' : '0']);
  }
  await K.redis(cmds);
  return { ok: true };
}

async function rewardSave(b) {
  const r = b.reward || {};
  const id = r.id ? String(r.id) : `rw-${K.rid(6)}`;
  if (!/^[a-z0-9-]{3,40}$/.test(id)) K.fail(400, 'Invalid reward id.');
  const [raw] = await K.redis([['HGET', 'ss:rw', id]]);
  const old = raw ? JSON.parse(raw) : {};
  if (old.aid) {
    // business offers are managed with their campaign; only switching them on/off is allowed here,
    // and an admin "off" sticks even if the advertiser pauses and resumes the campaign
    await K.redis([['HSET', 'ss:rw:on', id, r.active ? '1' : '0'], r.active ? ['HDEL', 'ss:rw:adminoff', id] : ['HSET', 'ss:rw:adminoff', id, '1']]);
    return { ok: true, id };
  }
  const out = {
    id, icon: K.text(r.icon, 8, { label: 'Icon' }) || '🎁',
    title: K.text(r.title, 80, { required: true, label: 'Title', min: 3 }),
    partner: K.text(r.partner, 60, { label: 'Partner' }),
    cost: Math.round(K.num(r.cost, 10, 100000, 'Coins')),
    mode: K.oneOf(r.mode, ['gen', 'pool'], 'Code type'),
    limitDays: Math.round(K.num(r.limitDays == null ? 7 : r.limitDays, 0, 365, 'Limit')),
    terms: K.text(r.terms, 200, { label: 'Terms', multiline: true }),
    needs: r.needs ? K.oneOf(r.needs, ['phone', 'address'], 'Ask scouts for') : undefined,
    order: Math.round(K.num(r.order == null ? 0 : r.order, -1000, 1000, 'Order')),
  };
  await K.redis([['HSET', 'ss:rw', id, JSON.stringify(out)], ['HSET', 'ss:rw:on', id, r.active === false ? '0' : '1']]);
  return { ok: true, id };
}

async function rewardStock(b) {
  const id = String(b.id || '');
  const n = Math.round(K.num(b.add, -100000, 100000, 'Stock'));
  const [v] = await K.redis([['INCRBY', `ss:rw:stock:${id}`, n]]);
  if (v < 0) await K.redis([['SET', `ss:rw:stock:${id}`, '0']]);
  return { ok: true, stock: Math.max(0, v) };
}

async function rewardCodes(b) {
  const id = String(b.id || '');
  if (!Array.isArray(b.codes) || !b.codes.length || b.codes.length > 1000) K.fail(400, 'Paste 1 to 1000 codes, one per line.');
  const codes = [...new Set(b.codes.map((c) => K.text(c, 40, { label: 'Code' })).filter(Boolean))];
  const [len] = await K.redis([['RPUSH', `ss:rw:pool:${id}`, ...codes]]);
  return { ok: true, pool: len, added: codes.length };
}

async function rewardDelete(b) {
  const id = String(b.id || '');
  await K.redis([['HDEL', 'ss:rw', id], ['HDEL', 'ss:rw:on', id]]);
  return { ok: true };
}

/** Areas are checked against the washroom data. Districts and cities are saved as "Name, State" because the same
 *  name exists in more than one state (e.g. Bilaspur in Chhattisgarh and Himachal Pradesh). */
function qualifyAreas(entries, kind) {
  const D = K.data();
  const low = (x) => String(x || '').trim().toLowerCase();
  const known = new Map(); // name -> Set(states)
  for (const r of Object.values(D.items)) {
    const name = kind === 'district' ? D.districts[r[2]] : r[3];
    if (!name) continue;
    const k = low(name);
    if (!known.has(k)) known.set(k, { name, states: new Set() });
    known.get(k).states.add(D.states[r[1]]);
  }
  return entries.map((e) => {
    const m = /^(.*?)\s*[,(]\s*([^,()]+?)\s*\)?$/.exec(e);
    const name = m ? m[1] : e, st = m ? m[2] : '';
    const hit = known.get(low(name));
    if (!hit) K.fail(400, `${kind === 'district' ? 'District' : 'City'} “${name}” isn’t in the washroom data. Check the spelling.`);
    if (st) {
      const s2 = [...hit.states].find((x) => low(x) === low(st));
      if (!s2) K.fail(400, `“${hit.name}” is in ${[...hit.states].join(' and ')}, not ${st}.`);
      return `${hit.name}, ${s2}`;
    }
    if (hit.states.size > 1) K.fail(400, `“${hit.name}” exists in ${[...hit.states].join(' and ')}. Write it as “${hit.name}, ${[...hit.states][0]}”.`);
    return `${hit.name}, ${[...hit.states][0]}`;
  });
}
function qualifyStates(entries) {
  const states = K.data().states;
  return entries.map((e) => {
    const s2 = states.find((x) => x.toLowerCase() === e.trim().toLowerCase());
    if (!s2) K.fail(400, `State / UT “${e}” isn’t in the washroom data. Use the full name, e.g. Maharashtra.`);
    return s2;
  });
}

async function keyCreate(b) {
  // states/districts/cities: arrays, or text with one entry per line (commas separate a name from its state)
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n|;/)).map((x) => K.text(x, 80, { label: 'Area' })).filter(Boolean).slice(0, 50);
  const o = {
    name: K.text(b.name, 80, { required: true, label: 'Name', min: 3 }), dept: K.text(b.dept, 80, { label: 'Department' }),
    scope: { states: qualifyStates(list(b.states)), districts: qualifyAreas(list(b.districts), 'district'), cities: qualifyAreas(list(b.cities), 'city') }, at: Date.now(),
  };
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(32);
  let key = 'ak_';
  for (let i = 0; i < 32; i++) key += alpha[bytes[i] % alpha.length];
  await K.redis([['HSET', 'ss:ak', K.sha256(key), JSON.stringify(o)]]);
  return { ok: true, key, officer: o };
}

async function userBan(b) {
  const uid = String(b.uid || '');
  if (!/^[a-z2-9]{12}$/.test(uid)) K.fail(400, 'Invalid user.');
  // scores stay in the leaderboards (pages skip suspended scouts), so un-suspending restores them exactly
  const [ex] = await K.redis([['EXISTS', `ss:u:${uid}`]]);
  if (!ex) K.fail(404, 'User not found.');
  await K.redis([b.banned ? ['HSET', `ss:u:${uid}`, 'banned', '1'] : ['HDEL', `ss:u:${uid}`, 'banned']]);
  return { ok: true };
}

async function userAdjust(b) {
  const uid = String(b.uid || '');
  const amount = Math.round(K.num(b.amount, -100000, 100000, 'Amount'));
  const reason = K.text(b.reason, 120, { required: true, label: 'Reason' });
  const [out] = await K.redis([['EVAL', ADJUST_SCRIPT, '0', ...K.coinArgs(null), uid, String(amount), K.jstr(reason)]]);
  const [main] = K.splitCoins(out);
  if (main[0] !== 'ok') K.fail(404, 'User not found.');
  return { ok: true, coins: Number(main[1]) || 0 };
}

async function userRename(b) {
  const uid = String(b.uid || '');
  const name = K.displayName(b.name);
  const [ex] = await K.redis([['EXISTS', `ss:u:${uid}`]]);
  if (!ex) K.fail(404, 'User not found.');
  await K.redis([['HSET', `ss:u:${uid}`, 'name', name]]);
  return { ok: true };
}

async function voucherUse(b) {
  const c = String(b.code || '').toUpperCase().replace(/\s/g, '');
  const [st] = await K.redis([['HGET', `ss:red:${c}`, 'st']]);
  if (!st) K.fail(404, 'No voucher with this code.');
  if (st === 'used') K.fail(409, 'Already used.');
  const [first] = await K.redis([['HSETNX', `ss:red:${c}`, 'usedAt', String(Date.now())], ['HSET', `ss:red:${c}`, 'st', 'used']]);
  if (!first) K.fail(409, 'Already used.');
  await K.redis([['HDEL', `ss:red:${c}`, 'contact']]); // delivered: the phone number / address isn't kept
  return { ok: true };
}

async function post(req, res) {
  requireAdmin(req);
  const b = await K.postBody(req, 65536);
  const fn = {
    place: placeDecision, claim: claimDecision, 'order-paid': orderPaid, 'order-reject': orderReject, 'verify-result': verifyResult, 'ad-state': adState,
    report: async (x) => { const r = await R.updateReport(String(x.id || ''), K.oneOf(x.status, ['ack', 'resolved', 'rejected'], 'Status'), K.text(x.by, 60, { label: 'Name' }) || 'Swachh Scan team', K.text(x.note, 200, { label: 'Note', multiline: true }), true); if (!r.ok) K.fail(409, 'This report is already closed.'); return { ok: true }; },
    cleaned: async (x) => { const p = await K.findPlace(x.id); if (!p) K.fail(404, 'Unknown washroom.'); return Object.assign({ ok: true }, await R.markCleaned(p.id, K.text(x.by, 60, { label: 'Name' }) || 'Swachh Scan team', K.text(x.note, 200, { label: 'Note', multiline: true }), true)); },
    'reward-save': rewardSave, 'reward-stock': rewardStock, 'reward-codes': rewardCodes, 'reward-delete': rewardDelete,
    'key-create': keyCreate, 'owner-remove': ownerRemove, 'key-revoke': async (x) => { await K.redis([['HDEL', 'ss:ak', String(x.hash || '')]]); return { ok: true }; },
    'user-ban': userBan, 'user-adjust': userAdjust, 'user-rename': userRename, 'voucher-use': voucherUse,
  }[b.action];
  if (!fn) K.fail(400, 'Unknown action.');
  return K.send(res, 200, await fn(b));
}

module.exports = K.handler({ GET: get, POST: post }, { name: 'admin' });
