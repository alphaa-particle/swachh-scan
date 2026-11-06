/**
 * Civic dashboard — helps municipalities clean the washrooms people rate badly or report.
 *   GET  ?action=public                    washrooms that need attention + recently cleaned (public, cached)
 *   GET  ?action=me                        (Bearer officer key) who the key belongs to and its area
 *   GET  ?action=queue                     (officer key) open reports in the officer's area, with notes
 *   POST {action:'update', report, status:'ack'|'resolved'|'rejected', note}   (officer key)
 *   POST {action:'cleaned', id, note}       resolve every open report of a washroom and log the cleaning
 * Officer keys are created by an admin on /admin.html and can be limited to states, districts or cities.
 */
const K = require('./_lib/core');
const R = require('./_lib/reports');

async function officer(req) {
  const m = /^Bearer\s+(ak_[A-Za-z0-9]{32})$/.exec(String(req.headers.authorization || '').trim());
  if (!m) K.fail(401, 'Enter your officer access key.', { code: 'no_key' });
  const [raw] = await K.redis([['HGET', 'ss:ak', K.sha256(m[1])]]);
  if (!raw) K.fail(401, 'This access key is not valid (it may have been revoked).', { code: 'bad_key' });
  const o = JSON.parse(raw);
  o.scope = o.scope || { states: [], districts: [], cities: [] };
  return o;
}
/** Does a washroom (state, district, city) fall in the officer's area? Empty scope = all of India.
 *  Districts and cities are stored as "Name, State" because the same name can exist in two states (e.g. Bilaspur). */
function inScope(scope, p) {
  const s = scope || {};
  const any = (s.states || []).length + (s.districts || []).length + (s.cities || []).length;
  if (!any) return true;
  const low = (x) => String(x || '').trim().toLowerCase();
  const match = (entry, name) => {
    const i = String(entry).lastIndexOf(',');
    if (i < 0) return low(entry) === low(name); // older keys without a state
    return low(entry.slice(0, i)) === low(name) && low(entry.slice(i + 1)) === low(p.st);
  };
  if ((s.states || []).some((x) => low(x) === low(p.st))) return true;
  if ((s.districts || []).some((x) => match(x, p.d))) return true;
  if ((s.cities || []).some((x) => match(x, p.city))) return true;
  return false;
}
const area = (p) => [p.city, p.d, p.st].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2).join(', ');

/** Washrooms that need attention: open reports and/or a poor recent cleanliness score. */
async function attention(scope) {
  const [open, ema, n, sum, places, fixed, ratedAt] = await K.redis([
    ['HGETALL', 'ss:iss:open'], ['HGETALL', 'ss:ema'], ['HGETALL', 'ss:n'], ['HGETALL', 'ss:sum'], ['HGETALL', 'ss:places'], ['HGETALL', 'ss:iss:fixed'], ['HGETALL', 'ss:rated:at'],
  ]);
  const add = (a, b) => a + b;
  const OPEN = K.rekey(K.hash(open, true), add), EMA = K.rekey(K.hash(ema, true), Math.min), N = K.rekey(K.hash(n, true), add), SUM = K.rekey(K.hash(sum, true), add);
  const PL = K.jsonHash(places), FIX = K.rekey(K.hash(fixed)), RATED = K.rekey(K.hash(ratedAt, true), Math.max);
  // a poor recent score stops counting once the washroom was cleaned after its last rating (new ratings decide again)
  const cleanedSince = (id) => FIX[id] && Number(String(FIX[id]).split('|')[0]) > (RATED[id] || 0);
  const ids = new Set([...Object.keys(OPEN).filter((id) => OPEN[id] > 0), ...Object.keys(EMA).filter((id) => N[id] >= 2 && EMA[id] <= 2.75 && !cleanedSince(id))]);
  const list = [];
  for (const raw of ids) {
    const id = K.resolveId(raw) || (PL[raw] ? raw : null);
    if (!id) continue;
    const p = K.staticPlace(id) || (PL[id] && { id, n: PL[id].n, st: PL[id].st, d: PL[id].d, city: PL[id].city, la: PL[id].la, lo: PL[id].lo });
    if (!p || !inScope(scope, p)) continue;
    const recent = N[raw] >= 2 ? EMA[raw] : null;
    const openN = OPEN[raw] || 0;
    // priority: open reports weigh most, then how far the recent score is below 3
    const score = openN * 2 + (recent != null && recent < 3 ? (3 - recent) * 2 : 0);
    const f = FIX[raw] ? String(FIX[raw]).split('|') : null;
    list.push({
      id, n: p.n, area: area(p), st: p.st, d: p.d, city: p.city, la: p.la, lo: p.lo, open: openN,
      recent: recent != null ? Math.round(recent * 10) / 10 : null, avg: N[raw] ? Math.round((SUM[raw] / N[raw]) * 10) / 10 : null, ratings: N[raw] || 0,
      lastCleaned: f ? { at: Number(f[0]), by: f.slice(1).join('|') } : null, score: Math.round(score * 10) / 10,
    });
  }
  list.sort((a, b) => b.score - a.score || b.open - a.open);
  return list;
}

async function publicView(req, res) {
  const [list, log, totals] = await Promise.all([
    attention(null),
    K.redis([['LRANGE', 'ss:clean:log', 0, 29]]).then((x) => (x[0] || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)),
    K.redis([['ZCARD', 'ss:rep:open'], ['ZCARD', 'ss:rep:all'], ['LLEN', 'ss:clean:log']]),
  ]);
  const cleaned = log.map((c) => { const p = K.staticPlace(c.id); return { id: c.id, n: p ? p.n : 'Washroom', area: p ? area(p) : '', at: c.t, by: c.by, resolved: c.resolved }; });
  return K.send(res, 200, {
    attention: list.slice(0, 300), cleaned,
    totals: { openReports: Number(totals[0]) || 0, recentReports: Number(totals[1]) || 0, cleanings: Number(totals[2]) || 0, needAttention: list.length },
  }, 'max-age=60, stale-while-revalidate=300');
}

async function me(req, res) {
  const o = await officer(req);
  return K.send(res, 200, { name: o.name, dept: o.dept || '', scope: o.scope });
}

async function queue(req, res) {
  const o = await officer(req);
  const [ids] = await K.redis([['ZREVRANGE', 'ss:rep:open', 0, 1499]]);
  const reports = (await R.readReports(ids || [])).filter((r) => inScope(o.scope, r));
  const byW = new Map();
  for (const r of reports) {
    let g = byW.get(r.w);
    if (!g) {
      const p = await K.findPlace(r.w);
      g = { id: r.w, n: r.n || (p && p.n) || r.w, area: p ? area(p) : area(r), la: p && p.la, lo: p && p.lo, reports: [] };
      byW.set(r.w, g);
    }
    g.reports.push(r);
  }
  const groups = [...byW.values()].sort((a, b) => b.reports.length - a.reports.length || a.reports[a.reports.length - 1].at - b.reports[b.reports.length - 1].at);
  const att = await attention(o.scope);
  const lowRated = att.filter((x) => !x.open).slice(0, 100);
  return K.send(res, 200, { officer: { name: o.name, dept: o.dept || '', scope: o.scope }, groups, lowRated });
}

async function update(req, res, body) {
  const o = await officer(req);
  const [rep] = await R.readReports([String(body.report || '')].filter((x) => /^[a-z2-9]{10}$/.test(x)));
  if (!rep || !inScope(o.scope, rep)) K.fail(404, 'Report not found in your area.');
  const status = K.oneOf(body.status, ['ack', 'resolved', 'rejected'], 'Status');
  const note = K.text(body.note, 200, { label: 'Note', multiline: true });
  const r = await R.updateReport(rep.id, status, o.name, note, true);
  if (!r.ok) K.fail(409, 'This report is already closed.');
  return K.send(res, 200, { ok: true });
}

async function cleaned(req, res, body) {
  const o = await officer(req);
  const p = await K.findPlace(body.id);
  if (!p || !inScope(o.scope, p)) K.fail(404, 'Washroom not found in your area.');
  const note = K.text(body.note, 200, { label: 'Note', multiline: true });
  const r = await R.markCleaned(p.id, o.name, note, true);
  return K.send(res, 200, { ok: true, resolved: r.resolved });
}

async function get(req, res) {
  const action = K.query(req).get('action');
  if (action === 'public') return publicView(req, res);
  if (action === 'me') return me(req, res);
  if (action === 'queue') return queue(req, res);
  K.fail(400, 'Unknown action.');
}
async function post(req, res) {
  const body = await K.postBody(req, 2048);
  if (body.action === 'update') return update(req, res, body);
  if (body.action === 'cleaned') return cleaned(req, res, body);
  K.fail(400, 'Unknown action.');
}

module.exports = K.handler({ GET: get, POST: post }, { name: 'civic' });
module.exports.attention = attention;
module.exports.inScope = inScope;
