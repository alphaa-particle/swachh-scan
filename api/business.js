/**
 * Businesses and washroom operators.
 *   Public:  GET ?action=plans · GET ?action=ads&lat&lon · POST {action:'events', e:[[target, type], ...]}
 *   Signed in (Bearer scout token):
 *     GET  ?action=dash                      profile, claims, owned washrooms, orders, campaigns
 *     GET  ?action=analytics&id=<washroom>   (owner with an active Analytics plan) / &ad=<campaign id> (its owner)
 *     POST {action:'profile', name, contact, phone, email, gst?}
 *     POST {action:'claim', id, role, note}
 *     POST {action:'order', kind:'featured'|'analytics'|'verify', target}
 *     POST {action:'campaign', title, text, cat, la, lo, r, place?, url?, phone?, plan:'ad7'|'ad30', offer?:{title, cost, stock}}
 *     POST {action:'payref', order, utr}     · POST {action:'cancel', order}
 *     POST {action:'respond', report, status:'ack'|'resolved', note} · POST {action:'cleaned', id, note}
 *     POST {action:'campaign-state', ad, state:'paused'|'live'} · POST {action:'verify-code', code}
 * Payments: UPI to UPI_ID, then the business enters the UPI reference (UTR); an admin confirms it and the
 * service switches on. No payment gateway account is needed.
 */
const K = require('./_lib/core');
const R = require('./_lib/reports');
const { PLANS, AD_CATEGORIES, LIMITS } = K.CONFIG;

const AID = /^[a-z2-9]{10}$/;

// ------------------------------------------------------------------ public
async function plans(req, res) {
  return K.send(res, 200, { plans: PLANS, upi: !!K.UPI, categories: AD_CATEGORIES }, 'max-age=300');
}

async function ads(req, res) {
  const q = K.query(req);
  const la = Number(q.get('lat')), lo = Number(q.get('lon'));
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !q.get('lat') || !q.get('lon')) K.fail(400, 'Location needed.');
  const [all] = await K.redis([['HGETALL', 'ss:ads']]);
  const now = Date.now();
  const out = [];
  for (const a of Object.values(K.jsonHash(all))) {
    if (!a || a.st !== 'live' || !(a.start <= now && now < a.end)) continue;
    const km = K.distKm({ la, lo }, { la: a.la, lo: a.lo });
    if (km > a.r) continue;
    out.push({ id: a.id, title: a.title, text: a.text, cat: a.cat, biz: a.biz, km: Math.round(km * 100) / 100, la: a.la, lo: a.lo, r: a.r, url: a.url || '', phone: a.phone || '', offer: a.offer && a.rw ? { title: a.offer.title, cost: a.offer.cost, reward: a.rw } : null });
  }
  out.sort((x, y) => x.km - y.km);
  return K.send(res, 200, { ads: out.slice(0, 3) }, 'max-age=60, stale-while-revalidate=300');
}

const EV_TYPES = { v: 1, d: 1, c: 1, s: 1, q: 1 };
async function events(req, res, body) {
  if (!Array.isArray(body.e) || !body.e.length) return K.send(res, 200, { ok: true, counted: 0 });
  const ev = body.e.slice(0, 40);
  const valid = [];
  for (const x of ev) {
    if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string') continue;
    const [t, k] = x;
    if (t.startsWith('ad:')) { if (AID.test(t.slice(3)) && (k === 'i' || k === 'k')) valid.push(`${t}:${k}`); continue; }
    const id = K.COMMUNITY_ID.test(t) ? t : K.resolveId(t);
    if (id && EV_TYPES[k]) valid.push(`${id}:${k}`);
  }
  // community washrooms and ads must exist (static ids were checked above against the data index)
  const comm = [...new Set(valid.filter((f) => f.startsWith('SS-')).map((f) => f.split(':')[0]))];
  const adIds = [...new Set(valid.filter((f) => f.startsWith('ad:')).map((f) => f.split(':')[1]))];
  if (comm.length || adIds.length) {
    const [pl, ad] = await K.redis([comm.length ? ['HMGET', 'ss:places', ...comm] : ['ECHO', ''], adIds.length ? ['HMGET', 'ss:ads', ...adIds] : ['ECHO', '']]);
    const okC = new Set(comm.filter((c, i) => pl && pl[i])), okA = new Set(adIds.filter((c, i) => ad && ad[i]));
    for (let i = valid.length - 1; i >= 0; i--) {
      const f = valid[i];
      if ((f.startsWith('SS-') && !okC.has(f.split(':')[0])) || (f.startsWith('ad:') && !okA.has(f.split(':')[1]))) valid.splice(i, 1);
    }
    if (!valid.length) return K.send(res, 200, { ok: true, counted: 0 });
  }
  const used = await K.bump(`ss:rl:ev:${K.netKey(req)}`, 3600, valid.length);
  if (used > LIMITS.eventsPerNetworkPerHour) return K.send(res, 200, { ok: true, counted: 0 });
  const day = `ss:ev:${K.dayKey()}`;
  await K.redis([...valid.map((f) => ['HINCRBY', day, f, 1]), ['EXPIRE', day, 34560000]]);
  return K.send(res, 200, { ok: true, counted: valid.length });
}

// ------------------------------------------------------------------ signed-in helpers
async function bizProfile(uid) {
  const [flat] = await K.redis([['HGETALL', `ss:biz:${uid}`]]);
  const b = K.hash(flat);
  return b.name ? b : null;
}
async function requireBiz(user) {
  const b = await bizProfile(user.uid);
  if (!b) K.fail(400, 'Add your business details first.', { code: 'no_profile' });
  return b;
}
async function owns(uid, id) {
  const cid = K.canon(id);
  if (!cid) return false;
  const [o] = await K.redis([['HMGET', 'ss:own', ...K.idsFor(cid)]]);
  return (o || []).includes(uid);
}
async function getOrder(oid) {
  if (!/^[a-z2-9]{10}$/.test(String(oid))) return null;
  const [flat] = await K.redis([['HGETALL', `ss:ord:${oid}`]]);
  const o = K.hash(flat);
  return o.uid ? Object.assign(o, { id: oid, amount: Number(o.amount) || 0, at: Number(o.at) || 0, days: Number(o.days) || 0 }) : null;
}
async function newOrder(user, biz, kind, target, tname) {
  const plan = PLANS[kind];
  if (!plan) K.fail(400, 'Unknown service.');
  const oid = K.rid(10);
  const now = Date.now();
  const o = { uid: user.uid, kind, label: plan.label, target, tname: tname || '', days: String(plan.days), amount: String(plan.price), st: 'awaiting_payment', at: String(now), biz: biz.name };
  await K.redis([['HSET', `ss:ord:${oid}`, ...Object.entries(o).flat()], ['ZADD', `ss:ord:u:${user.uid}`, now, oid], ['ZADD', 'ss:ord:q', now, oid]]);
  return Object.assign(o, { id: oid, amount: plan.price, at: now });
}

// ------------------------------------------------------------------ dashboard
async function dash(req, res) {
  const me = await K.getUser(req, { required: true });
  const now = Date.now();
  const [bflat, claimIds, ownIds, orderIds] = await K.redis([
    ['HGETALL', `ss:biz:${me.uid}`], ['ZREVRANGE', `ss:claims:u:${me.uid}`, 0, 49], ['SMEMBERS', `ss:own:u:${me.uid}`], ['ZREVRANGE', `ss:ord:u:${me.uid}`, 0, 99],
  ]);
  const biz = K.hash(bflat);
  const cmds = [
    ...(claimIds || []).map((c) => ['HGETALL', `ss:claim:${c}`]),
    ...(orderIds || []).map((o) => ['HGETALL', `ss:ord:${o}`]),
  ];
  const owned = [...new Set((ownIds || []).map((x) => K.canon(x)).filter(Boolean))];
  const ownCmds = owned.flatMap((id) => {
    const ks = K.idsFor(id);
    return [['HGET', 'ss:n', id], ['HGET', 'ss:sum', id], ['HGET', 'ss:ema', id], ['HMGET', 'ss:feat', ...ks], ['HMGET', 'ss:ver', ...ks], ['HMGET', 'ss:ana', ...ks], ['ZREVRANGE', `ss:rep:w:${id}`, 0, 19]];
  });
  const [all] = await K.redis([['HGETALL', 'ss:ads']]);
  const flat = cmds.length || ownCmds.length ? await K.redis([...cmds, ...ownCmds]) : [];
  const claims = (claimIds || []).map((c, i) => { const h = K.hash(flat[i]); return { id: c, washroom: h.w, name: h.n, role: h.role, status: h.st, at: Number(h.at) || 0, note: h.adminNote || '' }; });
  const off = (claimIds || []).length;
  const orders = (orderIds || []).map((o, i) => { const h = K.hash(flat[off + i]); return { id: o, kind: h.kind, label: h.label, target: h.target, targetName: h.tname, amount: Number(h.amount) || 0, status: h.st, utr: h.utr || '', at: Number(h.at) || 0, paidAt: Number(h.paidAt) || 0, until: Number(h.until) || 0, days: Number(h.days) || 0, note: h.note || '', result: h.result || '' }; });
  const base = off + (orderIds || []).length;
  const washrooms = [];
  for (let i = 0; i < owned.length; i++) {
    const [n, sum, ema, featL, verL, anaL, reps] = flat.slice(base + i * 7, base + i * 7 + 7);
    const feat = Math.max(0, ...(featL || []).map(Number).filter(Boolean));
    const ana = Math.max(0, ...(anaL || []).map(Number).filter(Boolean));
    const place = await K.findPlace(owned[i]);
    const openIds = await R.openReportIds(owned[i]);
    const reports = (await R.readReports([...new Set([...openIds, ...(reps || [])])])).sort((a, b) => b.at - a.at);
    let v = null;
    for (const x of verL || []) { try { const o = x ? JSON.parse(x) : null; if (o && (!v || o.exp > v.exp)) v = o; } catch (e) { /* skip */ } }
    washrooms.push({
      id: owned[i], name: place ? place.n : owned[i], area: place ? [place.city, place.d, place.st].filter(Boolean).filter((x, j, a) => a.indexOf(x) === j).slice(0, 2).join(', ') : '',
      rating: Number(n) ? { n: Number(n), avg: Math.round((Number(sum) / Number(n)) * 10) / 10, recent: Number(ema) || null } : null,
      featuredUntil: Number(feat) > now ? Number(feat) : 0, verified: v && v.exp > now ? v : null, lastVerification: v,
      analyticsUntil: Number(ana) > now ? Number(ana) : 0,
      reports: reports.filter((r) => r.status === 'open' || r.status === 'ack' || now - r.at < 30 * 864e5),
    });
  }
  const campaigns = Object.values(K.jsonHash(all)).filter((a) => a && a.uid === me.uid).sort((a, b) => b.at - a.at)
    .map((a) => Object.assign({}, a, { live: a.st === 'live' && a.start <= now && now < a.end }));
  return K.send(res, 200, {
    profile: biz.name ? biz : null, claims, washrooms, orders, campaigns, plans: PLANS, categories: AD_CATEGORIES,
    upi: K.UPI ? { id: K.UPI.id, name: K.UPI.name } : null,
  });
}

async function analytics(req, res) {
  const me = await K.getUser(req, { required: true });
  const q = K.query(req);
  const days = K.lastDays(30);
  const now = Date.now();
  if (q.get('ad')) {
    const aid = q.get('ad');
    const [raw] = await K.redis([['HGET', 'ss:ads', aid]]);
    const a = raw ? JSON.parse(raw) : null;
    if (!a || a.uid !== me.uid) K.fail(404, 'Campaign not found.');
    const out = await K.redis([...days.map((d) => ['HMGET', `ss:ev:${d}`, `ad:${aid}:i`, `ad:${aid}:k`]), ['HGET', 'ss:rw:used', a.rw || '-'], ['LRANGE', `ss:red:rw:${a.rw || '-'}`, 0, 49]]);
    const series = days.map((d, i) => ({ day: d, impressions: Number(out[i][0]) || 0, clicks: Number(out[i][1]) || 0 }));
    const codes = out[days.length + 1] || [];
    const vs = codes.length ? await K.redis(codes.map((c) => ['HMGET', `ss:red:${c}`, 'st', 'ts', 'usedAt'])) : [];
    return K.send(res, 200, { kind: 'ad', id: aid, series, redeemed: Number(out[days.length]) || 0, vouchers: codes.map((c, i) => ({ code: c, status: vs[i][0], at: Number(vs[i][1]) || 0, usedAt: Number(vs[i][2]) || 0 })) });
  }
  const id = q.get('id') || '';
  if (!(await owns(me.uid, id))) K.fail(404, 'You don’t manage this washroom.');
  const [ana] = await K.redis([['HGET', 'ss:ana', id]]);
  if (!(Number(ana) > now)) K.fail(402, 'Analytics needs an active plan for this washroom.', { code: 'no_plan' });
  const F = ['v', 'd', 'c', 's', 'q', 'rn', 'rs', 'rp'];
  const out = await K.redis([...days.map((d) => ['HMGET', `ss:ev:${d}`, ...F.map((f) => `${id}:${f}`)]), ['HGETALL', 'ss:n'], ['HGETALL', 'ss:sum']]);
  const series = days.map((d, i) => { const o = { day: d }; F.forEach((f, j) => { o[f] = Number(out[i][j]) || 0; }); return o; });
  // rank among rated washrooms in the same district
  const place = await K.findPlace(id);
  const N = K.hash(out[days.length], true), SUM = K.hash(out[days.length + 1], true);
  let rank = null;
  if (place && N[id]) {
    const peers = Object.keys(N).map((k) => K.staticPlace(K.resolveId(k) || '') ? [k, K.staticPlace(K.resolveId(k))] : null).filter((x) => x && x[1].d === place.d && x[1].st === place.st);
    const scored = peers.map(([k]) => [k, SUM[k] / N[k]]).sort((a, b) => b[1] - a[1]);
    const pos = scored.findIndex(([k]) => k === id);
    if (pos >= 0) rank = { rank: pos + 1, of: scored.length, area: place.d || place.st };
  }
  return K.send(res, 200, { kind: 'washroom', id, series, rank, until: Number(ana) });
}

// ------------------------------------------------------------------ writes
async function profile(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const b = {
    name: K.text(body.name, 80, { required: true, label: 'Business name', min: 2 }),
    contact: K.text(body.contact, 60, { required: true, label: 'Contact person', min: 2 }),
    phone: K.phone(body.phone, true),
    email: K.email(body.email, true),
    gst: K.text(body.gst, 15, { label: 'GSTIN' }).toUpperCase(),
  };
  if (b.gst && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(b.gst)) K.fail(400, 'Enter a valid 15-character GSTIN, or leave it empty.');
  const [existing] = await K.redis([['HGET', `ss:biz:${me.uid}`, 'at']]);
  await K.redis([['HSET', `ss:biz:${me.uid}`, ...Object.entries(b).flat(), 'at', existing || String(Date.now())], ['ZADD', 'ss:bizs', Date.now(), me.uid]]);
  return K.send(res, 200, { ok: true, profile: b });
}

async function claim(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const biz = await requireBiz(me);
  const place = await K.findPlace(body.id);
  if (!place) K.fail(400, 'Unknown washroom.');
  const role = K.oneOf(body.role, ['Operator / contractor', 'Owner', 'Municipal staff', 'Facility manager'], 'Your role');
  const note = K.text(body.note, 400, { required: true, label: 'How we can confirm it', multiline: true, min: 10 });
  const [owner, mine] = await K.redis([['HGET', 'ss:own', place.id], ['ZRANGE', `ss:claims:u:${me.uid}`, 0, -1]]);
  if (owner === me.uid) K.fail(409, 'You already manage this washroom.');
  if (owner) K.fail(409, 'Another operator already manages this washroom. Contact us if that is wrong.');
  if ((mine || []).length >= 50) K.fail(429, 'Too many claims. Contact us to manage more washrooms.');
  const pend = mine && mine.length ? await K.redis(mine.map((c) => ['HMGET', `ss:claim:${c}`, 'w', 'st'])) : [];
  if (pend.some(([w, st]) => w === place.id && st === 'pending')) K.fail(409, 'Your claim for this washroom is already waiting for review.');
  const cid = K.rid(10);
  const now = Date.now();
  await K.redis([
    ['HSET', `ss:claim:${cid}`, 'w', place.id, 'n', place.n, 'uid', me.uid, 'biz', biz.name, 'role', role, 'note', note, 'st', 'pending', 'at', String(now)],
    ['ZADD', 'ss:claims:q', now, cid], ['ZADD', `ss:claims:u:${me.uid}`, now, cid],
  ]);
  return K.send(res, 200, { ok: true, id: cid });
}

async function order(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const biz = await requireBiz(me);
  const kind = K.oneOf(body.kind, ['featured', 'analytics', 'verify'], 'Service');
  const id = String(body.target || '');
  if (!(await owns(me.uid, id))) K.fail(403, 'Claim this washroom first. Services are for washrooms you manage.');
  const place = await K.findPlace(id);
  const cid = K.canon(id);
  // don't pile up unpaid orders for the same thing (the lock makes parallel requests wait their turn)
  const lockKey = `ss:lock:ord:${me.uid}:${kind}:${cid}`;
  const [lock] = await K.redis([['SET', lockKey, '1', 'EX', 15, 'NX']]);
  if (!lock) K.fail(409, 'This order is already being created.');
  try {
    const ids = await K.redis([['ZREVRANGE', `ss:ord:u:${me.uid}`, 0, 49]]).then((x) => x[0] || []);
    const hs = ids.length ? await K.redis(ids.map((o) => ['HMGET', `ss:ord:${o}`, 'kind', 'target', 'st'])) : [];
    const dupe = ids.find((o, i) => hs[i][0] === kind && hs[i][1] === cid && ['awaiting_payment', 'payment_submitted', 'inspection'].includes(hs[i][2]));
    if (dupe) K.fail(409, 'You already have an open order for this. Finish or cancel it first.', { order: dupe });
    const o = await newOrder(me, biz, kind, cid, place ? place.n : cid);
    return K.send(res, 200, { ok: true, order: o });
  } finally {
    await K.redis([['DEL', lockKey]]).catch(() => {});
  }
}

async function campaign(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const biz = await requireBiz(me);
  const plan = K.oneOf(body.plan, ['ad7', 'ad30'], 'Duration');
  const a = {
    id: K.rid(10), uid: me.uid, biz: biz.name,
    title: K.text(body.title, 60, { required: true, label: 'Headline', min: 4 }),
    text: K.text(body.text, 140, { required: true, label: 'Message', min: 4 }),
    cat: K.oneOf(body.cat, AD_CATEGORIES, 'Category'),
    la: K.num(body.la, 6, 37.5, 'Location'), lo: K.num(body.lo, 68, 97.6, 'Location'),
    r: K.oneOf(body.r, [0.5, 1, 2, 5], 'Radius'),
    place: K.text(body.place, 80, { label: 'Area' }),
    url: K.url(body.url), phone: body.phone ? K.phone(body.phone) : '',
    plan, days: PLANS[plan].days, st: 'awaiting_payment', at: Date.now(), offer: null,
  };
  if (body.offer && body.offer.title) {
    a.offer = {
      title: K.text(body.offer.title, 60, { required: true, label: 'Offer', min: 4 }),
      cost: K.oneOf(body.offer.cost, [50, 100, 150, 200, 300, 500], 'Coins needed'),
      stock: Math.round(K.num(body.offer.stock, 1, 1000, 'Number of offers')),
    };
  }
  const [lock, mine] = await K.redis([['SET', `ss:lock:camp:${me.uid}`, '1', 'EX', 10, 'NX'], ['HGETALL', 'ss:ads']]);
  if (!lock) K.fail(409, 'A campaign is already being created. Try again in a few seconds.');
  try {
    if (Object.values(K.jsonHash(mine)).filter((x) => x && x.uid === me.uid && x.st === 'awaiting_payment').length >= 3) K.fail(429, 'You have 3 unpaid campaigns. Pay or cancel one first.');
    const o = await newOrder(me, biz, plan, a.id, a.title);
    a.order = o.id;
    await K.redis([['HSET', 'ss:ads', a.id, JSON.stringify(a)]]);
    return K.send(res, 200, { ok: true, campaign: a, order: o });
  } finally {
    await K.redis([['DEL', `ss:lock:camp:${me.uid}`]]).catch(() => {});
  }
}

async function payref(req, res, body) {
  const me = await K.getUser(req, { required: true });
  const o = await getOrder(body.order);
  if (!o || o.uid !== me.uid) K.fail(404, 'Order not found.');
  if (o.st !== 'awaiting_payment' && o.st !== 'payment_submitted') K.fail(409, 'This order doesn’t need a payment reference.');
  const utr = K.text(body.utr, 30, { required: true, label: 'UPI reference' }).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{10,22}$/.test(utr)) K.fail(400, 'Enter the 12-digit UPI reference (UTR) from your payment app.');
  const [claimed, holder] = await K.redis([['SET', `ss:utr:${utr}`, o.id, 'NX'], ['GET', `ss:utr:${utr}`]]);
  if (!claimed && holder !== o.id) K.fail(409, 'This UPI reference was already used for another order. Each payment can pay for one order only.');
  if (o.utr && o.utr !== utr) await K.redis([['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", '1', `ss:utr:${o.utr}`, o.id]]);
  await K.redis([['HSET', `ss:ord:${o.id}`, 'st', 'payment_submitted', 'utr', utr, 'paidClaimAt', String(Date.now())], ['ZADD', 'ss:ord:q', Date.now(), o.id]]);
  return K.send(res, 200, { ok: true });
}

async function cancel(req, res, body) {
  const me = await K.getUser(req, { required: true });
  const o = await getOrder(body.order);
  if (!o || o.uid !== me.uid) K.fail(404, 'Order not found.');
  if (o.st !== 'awaiting_payment') K.fail(409, 'Only unpaid orders can be cancelled. Contact us about a refund.');
  const cmds = [['HSET', `ss:ord:${o.id}`, 'st', 'cancelled'], ['ZREM', 'ss:ord:q', o.id]];
  if (o.kind === 'ad7' || o.kind === 'ad30') {
    const [raw] = await K.redis([['HGET', 'ss:ads', o.target]]);
    if (raw) { const a = JSON.parse(raw); a.st = 'cancelled'; cmds.push(['HSET', 'ss:ads', a.id, JSON.stringify(a)]); }
  }
  await K.redis(cmds);
  return K.send(res, 200, { ok: true });
}

async function respond(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const biz = await requireBiz(me);
  const [rep] = await R.readReports([String(body.report || '')].filter((x) => /^[a-z2-9]{10}$/.test(x)));
  if (!rep || !(await owns(me.uid, rep.w))) K.fail(404, 'Report not found.');
  const status = K.oneOf(body.status, ['ack', 'resolved'], 'Status');
  const note = K.text(body.note, 200, { label: 'Note', multiline: true });
  const r = await R.updateReport(rep.id, status, `${biz.name} (operator)`, note);
  if (!r.ok) K.fail(409, 'This report is already closed.');
  return K.send(res, 200, { ok: true });
}

async function cleaned(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const biz = await requireBiz(me);
  const id = String(body.id || '');
  if (!(await owns(me.uid, id))) K.fail(404, 'You don’t manage this washroom.');
  const note = K.text(body.note, 200, { label: 'Note', multiline: true });
  const r = await R.markCleaned(id, `${biz.name} (operator)`, note);
  return K.send(res, 200, { ok: true, resolved: r.resolved });
}

async function campaignState(req, res, body) {
  const me = await K.getUser(req, { required: true, notBanned: true });
  const [raw] = await K.redis([['HGET', 'ss:ads', String(body.ad || '')]]);
  const a = raw ? JSON.parse(raw) : null;
  if (!a || a.uid !== me.uid) K.fail(404, 'Campaign not found.');
  const want = K.oneOf(body.state, ['paused', 'live'], 'State');
  if (!['live', 'paused'].includes(a.st) || Date.now() >= a.end) K.fail(409, 'Only running campaigns can be paused or resumed.');
  if (want === 'live' && a.pausedBy === 'admin') K.fail(409, 'The Swachh Scan team paused this campaign. Contact us to resume it.');
  a.st = want;
  a.pausedBy = want === 'paused' ? 'owner' : undefined;
  const cmds = [['HSET', 'ss:ads', a.id, JSON.stringify(a)]];
  if (a.rw) {
    const [adminOff] = await K.redis([['HGET', 'ss:rw:adminoff', a.rw]]);
    cmds.push(['HSET', 'ss:rw:on', a.rw, want === 'live' && !adminOff ? '1' : '0']);
  }
  await K.redis(cmds);
  return K.send(res, 200, { ok: true, campaign: a });
}

async function verifyCode(req, res, body) {
  const me = await K.getUser(req, { required: true });
  const codeStr = K.text(body.code, 20, { required: true, label: 'Code' }).toUpperCase().replace(/\s/g, '');
  if (!/^SS-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codeStr)) K.fail(400, 'Codes look like SS-ABCD-2345.');
  const [flat] = await K.redis([['HGETALL', `ss:red:${codeStr}`]]);
  const v = K.hash(flat);
  if (!v.rw || v.owner !== me.uid) K.fail(404, 'No offer of yours has this code.');
  if (v.st === 'used') return K.send(res, body.use === true ? 409 : 200, { ok: false, code: 'used', status: 'used', title: v.title, usedAt: Number(v.usedAt) || 0, error: 'This code was already used. Don’t accept it again.' });
  if (body.use === true) {
    const [first] = await K.redis([['HSETNX', `ss:red:${codeStr}`, 'usedAt', String(Date.now())], ['HSET', `ss:red:${codeStr}`, 'st', 'used']]);
    if (!first) return K.send(res, 409, { ok: false, code: 'used', status: 'used', title: v.title, error: 'This code was already used. Don’t accept it again.' });
  }
  return K.send(res, 200, { ok: true, status: body.use === true ? 'used' : 'issued', title: v.title, at: Number(v.ts) || 0 });
}

async function get(req, res) {
  const action = K.query(req).get('action');
  if (action === 'plans') return plans(req, res);
  if (action === 'ads') return ads(req, res);
  if (action === 'dash') return dash(req, res);
  if (action === 'analytics') return analytics(req, res);
  K.fail(400, 'Unknown action.');
}

async function post(req, res) {
  const body = await K.postBody(req, 4096);
  const fn = {
    events, profile, claim, order, campaign, payref, cancel, respond, cleaned, 'campaign-state': campaignState, 'verify-code': verifyCode,
  }[body.action];
  if (!fn) K.fail(400, 'Unknown action.');
  return fn(req, res, body);
}

module.exports = K.handler({ GET: get, POST: post }, { name: 'business' });
