/* Leaderboard (week / month / all time) and the Honor Roll. */
(function () {
  'use strict';
  const { esc, ic, nf, api, Account, initials } = window.SS;
  const $ = (s) => document.querySelector(s);
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const TIER_ICON = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Platinum: '💎' };
  let me = null; // {uid, name, tier, banned, ranks}
  let selected = 'week'; // the tab on screen: a slower answer for another tab must not replace it
  const cache = {};

  function monthName(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  /** The message for a failed load: no server here, no database yet, or a temporary problem (with a retry). */
  function failHTML(r, what, retryAct) {
    if (r.noApi) return `<p>The ${what} needs the site’s server, which isn’t running here. Meanwhile you can <a href="/">find and rate washrooms</a>.</p>`;
    if (r.enabled === false) return `<p>The ${what} switches on when the site’s database is connected. Meanwhile you can <a href="/">find and rate washrooms</a>.</p>`;
    return `<p role="alert" style="margin:0 0 10px">${esc(r.j.error || `Couldn’t load the ${what}.`)}</p><button class="btn" type="button" data-act="${retryAct}">${ic('refresh')} Try again</button>`;
  }

  async function loadMe() {
    if (!Account.has()) return;
    const r = await api('/api/me');
    if (r.ok) { const p = r.j.profile; me = { uid: p.uid, name: p.name, tier: p.tier.name, banned: !!p.banned, ranks: r.j.ranks || {} }; Account.cache(p); }
  }

  async function board(period, focusAfter) {
    const el = $('#board');
    el.setAttribute('aria-labelledby', `tab-${period}`);
    if (!cache[period]) {
      el.innerHTML = '<div class="loading-line">Loading…</div>';
      const r = await api(`/api/community?action=leaderboard&period=${period}`, { auth: false });
      if (r.ok) cache[period] = r.j;
      if (period !== selected) return; // the scout has switched tabs meanwhile
      if (!r.ok) {
        el.innerHTML = `<div class="card">${failHTML(r, 'leaderboard', 'retry-board')}</div>`;
        return;
      }
    }
    const d = cache[period];
    const top = d.top || [];
    const label = { week: 'this week', month: 'this month', all: 'of all time' }[period];
    if (!top.length) {
      el.innerHTML = `<div class="card soft"><h2 style="margin:0 0 6px">No Scouts on the board ${label} yet</h2><p class="c-sub">${me && me.banned ? 'This profile is suspended, so it isn’t shown on the leaderboard.' : 'Rate a washroom or report a problem to be the first.'}</p><a class="btn primary" href="/">${ic('map')} Find a washroom</a></div>`;
      return;
    }
    const mine = me && me.ranks ? me.ranks[period] : null;
    const youTag = '<span class="st info">You</span>';
    let h = '';
    const pod = top.slice(0, 3);
    if (pod.length === 3) {
      const order = [pod[1], pod[0], pod[2]];
      h += `<div class="podium" aria-label="Top three">${order.map((p) => `<div class="p${p.rank === 1 ? ' first' : ''}"><div class="medal" aria-hidden="true">${MEDAL[p.rank]}</div><b>${esc(p.name)}</b><small>${nf(p.coins)} coins</small></div>`).join('')}</div>`;
    }
    h += `<ol class="lb" style="list-style:none;padding:0;margin:0" aria-label="Leaderboard ${label}">`;
    for (const p of top) {
      const isMe = me && p.uid === me.uid;
      h += `<li class="lb-row${p.rank <= 3 ? ` top${p.rank}` : ''}${isMe ? ' me' : ''}"${isMe ? ' aria-current="true"' : ''}><span class="rank">${MEDAL[p.rank] || p.rank}</span>
        <span class="nm"><span class="avatar sm" aria-hidden="true">${esc(initials(p.name))}</span><span title="${esc(p.name)}">${esc(p.name)}</span>${isMe ? youTag : ''}<span class="tier ${esc(p.tier)}" style="height:22px;font-size:11px">${TIER_ICON[p.tier] || ''} ${esc(p.tier)}</span></span>
        <b style="font-variant-numeric:tabular-nums">${nf(p.coins)}</b></li>`;
    }
    h += '</ol>';
    const onBoard = me && top.some((p) => p.uid === me.uid);
    if (me && me.banned) {
      h += `<p class="rate-note">This profile is suspended, so it isn’t shown on the leaderboard.</p>`;
    } else if (me && mine && !onBoard) {
      h += `<div class="lb" style="margin-top:8px"><div class="lb-row me"><span class="rank">${nf(mine.rank)}</span><span class="nm"><span class="avatar sm" aria-hidden="true">${esc(initials(me.name))}</span><span title="${esc(me.name)}">${esc(me.name)}</span>${youTag}${me.tier ? `<span class="tier ${esc(me.tier)}" style="height:22px;font-size:11px">${TIER_ICON[me.tier] || ''} ${esc(me.tier)}</span>` : ''}</span><b style="font-variant-numeric:tabular-nums">${nf(mine.coins)}</b></div></div>`;
    } else if (!onBoard) {
      h += `<p class="rate-note">${Account.has() ? `Earn coins${period === 'all' ? '' : ` ${label}`} to appear on this board.` : '<a href="/me.html">Become a Swachh Scout</a> to get on the board.'}</p>`;
    }
    h += `<p class="rate-note">${nf(d.total)} Scout${d.total === 1 ? '' : 's'} earned coins ${label}.${period === 'week' ? ' Weeks start on Monday (India time).' : ''}</p>`;
    el.innerHTML = h;
    if (focusAfter) el.focus();
  }

  async function honor(focusAfter) {
    const el = $('#honorRoll');
    const r = await api('/api/community?action=honor', { auth: false });
    if (!r.ok) { el.innerHTML = `<div class="card">${failHTML(r, 'Honor Roll', 'retry-honor')}</div>`; return; }
    const { champions = [], platinum = [], gold = [], cleanest = [] } = r.j;
    // thresholds come from the server's tiers (config.js), so the copy always matches what is awarded
    const tierMin = (name, fallback) => { const t = (r.j.tiers || []).find((x) => x && x.name === name); return t && Number.isFinite(t.min) ? t.min : fallback; };
    let h = '<div class="honor">';
    h += `<section class="card"><h3>👑 Monthly champions</h3>${champions.length ? champions.map((m) => `<p class="small muted" style="margin:8px 0 2px">${esc(monthName(m.month))}</p><ol>${m.top.map((p, i) => `<li>${MEDAL[i + 1]} ${esc(p.name)} <span class="muted">· ${nf(p.coins)}</span></li>`).join('')}</ol>`).join('') : '<p class="c-sub">The first champions are crowned when this month ends.</p>'}</section>`;
    const tierList = (list, min) => (list.length
      ? `<p class="c-sub" style="margin:0 0 6px">${nf(min)}+ coins earned</p><ol>${list.map((p) => `<li>${esc(p.name)} <span class="muted">· ${nf(p.earned)}</span></li>`).join('')}</ol>`
      : `<p class="c-sub">Earn ${nf(min)} coins to join.</p>`);
    h += `<section class="card"><h3>💎 Platinum Scouts</h3>${tierList(platinum, tierMin('Platinum', 5000))}
      <h3 style="margin-top:14px">🥇 Gold Scouts</h3>${tierList(gold, tierMin('Gold', 1500))}</section>`;
    h += `<section class="card"><h3>✨ Cleanest washrooms</h3><p class="c-sub" style="margin:0 0 8px">Rated 4.3★ or more on average by at least 3 different raters. Thank the people who keep them clean.</p>${cleanest.length ? `<ol>${cleanest.map((w) => `<li><a href="/?id=${encodeURIComponent(w.id)}">${esc(w.n)}</a> <span class="muted">· ${esc(w.place)} · ${Number(w.avg).toFixed(1)}★ (${nf(w.count)} rating${w.count === 1 ? '' : 's'})${w.verified ? ' · Verified' : ''}</span></li>`).join('')}</ol>` : '<p class="c-sub">None yet — rate the clean ones you visit!</p>'}</section>`;
    h += '</div>';
    el.innerHTML = h;
    if (focusAfter) $('#honor').focus();
  }

  const tabs = [...document.querySelectorAll('#periodTabs [role="tab"]')];
  function choose(t, focus) {
    tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
    if (focus) t.focus();
    selected = t.dataset.period;
    board(selected);
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => choose(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); choose(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); choose(tabs[e.key === 'Home' ? 0 : tabs.length - 1], true); }
    });
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'retry-board') { b.disabled = true; board(selected, true); }
    if (b.dataset.act === 'retry-honor') { b.disabled = true; honor(true); }
  });

  loadMe().then(() => board(selected));
  honor();
})();
