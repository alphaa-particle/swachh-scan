/**
 * Closing the loop on hygiene reports — shared by the civic dashboard (municipal officers), operators (business
 * page) and admins. When a municipal officer or an admin confirms a fix, the scout who sent the report gets a
 * bonus, once per report and at most 5 a day. Operators can close reports on their own washrooms too, but that
 * pays no bonus: otherwise an operator could report and close their own washroom (or use friends) to farm coins.
 */
const K = require('./core');
const { COINS } = K.CONFIG;
const BONUSES_PER_DAY = 5;

const UPDATE_SCRIPT = K.LUA_PRELUDE + `
-- ARGV 7 report id, 8 new status (ack|resolved|rejected), 9 actor label, 10 response note, 11 description for the reporter,
--      12 '1' if the actor is a municipal officer / admin (pays the reporter bonus), 13 day key
local rk = 'ss:rep:' .. ARGV[7]
local cur = redis.call('HMGET', rk, 'st', 'w', 'uid', 'paid')
if not cur[1] then return {'missing'} end
if cur[1] == 'resolved' or cur[1] == 'rejected' then return {'closed', cur[1]} end
local new = ARGV[8]
redis.call('HSET', rk, 'st', new, 'upd', CTX.now, 'by', ARGV[9], 'resp', ARGV[10])
if new == 'ack' then return finish({'ok', cur[2]}) end
redis.call('ZREM', 'ss:rep:open', ARGV[7])
redis.call('SREM', 'ss:rep:wo:' .. cur[2], ARGV[7])
local left = redis.call('HINCRBY', 'ss:iss:open', cur[2], -1)
if left <= 0 then redis.call('HDEL', 'ss:iss:open', cur[2]) end
redis.call('EXPIRE', rk, 34560000)
if new == 'resolved' then
  redis.call('HSET', 'ss:iss:fixed', cur[2], CTX.now .. '|' .. ARGV[9])
  if cur[3] and cur[3] ~= '' then redis.call('HINCRBY', 'ss:u:' .. cur[3], 'resolved', 1) end
  if ARGV[12] == '1' and cur[3] and cur[3] ~= '' and cur[4] ~= '1' then
    redis.call('HSET', rk, 'paid', '1')
    local ck = 'ss:cap:' .. cur[3] .. ':' .. ARGV[13] .. ':res'
    local cn = redis.call('INCR', ck)
    if cn == 1 then redis.call('EXPIRE', ck, 172800) end
    if cn <= ${BONUSES_PER_DAY} then award(cur[3], ${COINS.reportResolved}, 'resolved', ARGV[11]) end
  end
end
return finish({'ok', cur[2]})`;

/** Read reports by id -> [{id, w, issues, note, ts, st, ...}] */
async function readReports(ids) {
  if (!ids.length) return [];
  const out = await K.redis(ids.map((r) => ['HGETALL', `ss:rep:${r}`]));
  return ids.map((r, i) => {
    const h = K.hash(out[i]);
    if (!h.w) return null;
    return {
      id: r, w: h.w, n: h.n || '', st: h.sta || '', d: h.d || '', city: h.city || '', issues: (h.iss || '').split(',').filter(Boolean),
      note: h.note || '', at: Number(h.ts) || 0, status: h.st || 'open', updated: Number(h.upd) || 0, by: h.by || '', response: h.resp || '', scout: !!h.uid,
    };
  }).filter(Boolean);
}

/** Add a fix to the public cleaning log (one entry per washroom and actor within 30 minutes). */
async function logCleaning(washroomId, actor, note, resolved) {
  const now = Date.now();
  const [last] = await K.redis([['LINDEX', 'ss:clean:log', 0]]);
  let prev = null;
  try { prev = last ? JSON.parse(last) : null; } catch (e) { prev = null; }
  const entry = JSON.stringify({ t: now, id: washroomId, by: actor, note: note || '', resolved: (prev && prev.id === washroomId && prev.by === actor && now - prev.t < 30 * 60e3 ? prev.resolved || 0 : 0) + resolved });
  if (prev && prev.id === washroomId && prev.by === actor && now - prev.t < 30 * 60e3) await K.redis([['LSET', 'ss:clean:log', 0, entry]]);
  else await K.redis([['LPUSH', 'ss:clean:log', entry], ['LTRIM', 'ss:clean:log', 0, 499]]);
}

/** Change one report's status. official = municipal officer or admin (only they trigger the reporter bonus). */
async function updateReport(reportId, status, actor, note, official, log) {
  if (!/^[a-z2-9]{10}$/.test(String(reportId))) return { ok: false, reason: 'missing' };
  const [h] = await K.redis([['HMGET', `ss:rep:${reportId}`, 'n', 'iss']]);
  const name = (h && h[0]) || 'a washroom';
  const [out] = await K.redis([[
    'EVAL', UPDATE_SCRIPT, '0', ...K.coinArgs(null),
    reportId, status, actor, note || '', K.jstr(`Your report about ${name} was confirmed fixed by ${actor}`), official ? '1' : '0', K.dayKey(),
  ]]);
  const [main] = K.splitCoins(out);
  if (main[0] !== 'ok') return { ok: false, reason: main[0], status: main[1] };
  if (status === 'resolved' && log !== false) await logCleaning(main[1], actor, note, 1);
  return { ok: true, washroom: main[1] };
}

/** Every open report id of a washroom (including ids it had before a merge). */
async function openReportIds(washroomId) {
  const ids = K.idsFor(washroomId);
  const out = await K.redis(ids.map((i) => ['SMEMBERS', `ss:rep:wo:${i}`]));
  return [...new Set(out.flat().filter(Boolean))];
}

/** "Cleaned": resolve every open report of a washroom and log it publicly. */
async function markCleaned(washroomId, actor, note, official) {
  const open = await openReportIds(washroomId);
  let resolved = 0;
  for (const r of open) { const x = await updateReport(r, 'resolved', actor, note, official, false); if (x.ok) resolved++; }
  await K.redis([['HSET', 'ss:iss:fixed', washroomId, `${Date.now()}|${actor}`]]);
  await logCleaning(washroomId, actor, note, resolved);
  return { resolved };
}

module.exports = { readReports, updateReport, markCleaned, openReportIds };
