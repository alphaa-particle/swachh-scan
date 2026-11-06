/* Rewards page: Swachh Scout profile, coins, tier, badges, rewards catalogue, vouchers, activity, invites, backup. */
(function () {
  'use strict';
  const { esc, ic, nf, api, Account, toast, coinToast, fmtDate, ago, initials, openDialog, lsGet, lsSet } = window.SS;
  const $ = (s, el) => (el || document).querySelector(s);
  const root = $('#root');
  const params = new URLSearchParams(location.search);
  const wantReward = params.get('reward');
  const HERE_MAX_AGE = 864e5; // a saved "offers near me" position is used for a day

  /** The map's "Get offer" link carries the spot the offer was shown for (?reward=…&lat=…&lon=…). */
  function linkHere() {
    const la = Number(params.get('lat')), lo = Number(params.get('lon'));
    if (!params.get('lat') || !params.get('lon') || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return { lat: la, lon: lo, src: 'link' };
  }
  function savedHere() {
    const h = lsGet('ss.offersHere', {});
    if (!h || !Number.isFinite(h.lat) || !Number.isFinite(h.lon) || !(Date.now() - (Number(h.t) || 0) < HERE_MAX_AGE)) return null;
    return { lat: h.lat, lon: h.lon, t: h.t, src: 'device' };
  }

  let ME = null, REWARDS = [], RULES = null, REWARDS_ERR = '', HERE = savedHere() || linkHere(), deepLinked = false;
  const KIND = {
    rate: 'Rated a washroom', first: 'First rating bonus', report: 'Reported a problem', resolved: 'Your report got fixed', place: 'Washroom added',
    'place-pending': 'Washroom suggested', 'place-rejected': 'Washroom not added', referral: 'Invite bonus', streak: 'Streak bonus', redeem: 'Reward redeemed', admin: 'Adjustment',
  };
  const BADGES = [
    { id: 'first', icon: '⭐', name: 'First rating', need: 'Rate 1 washroom', ok: (p) => p.rated >= 1 },
    { id: 'critic', icon: '🧐', name: 'Critic', need: 'Rate 10 washrooms', ok: (p) => p.rated >= 10 },
    { id: 'inspector', icon: '🔍', name: 'Inspector', need: 'Rate 50 washrooms', ok: (p) => p.rated >= 50 },
    { id: 'reporter', icon: '📣', name: 'Reporter', need: 'Report a problem', ok: (p) => p.reports >= 1 },
    { id: 'fixer', icon: '🧹', name: 'Change maker', need: '1 report fixed', ok: (p) => p.resolved >= 1 },
    { id: 'watchdog', icon: '🛡️', name: 'Watchdog', need: '5 reports fixed', ok: (p) => p.resolved >= 5 },
    { id: 'explorer', icon: '🧭', name: 'Explorer', need: 'Add a washroom', ok: (p) => p.places >= 1 },
    { id: 'pathfinder', icon: '🗺️', name: 'Pathfinder', need: 'Add 5 washrooms', ok: (p) => p.places >= 5 },
    { id: 'connector', icon: '🤝', name: 'Connector', need: 'Invite a friend', ok: (p) => p.refs >= 1 },
    { id: 'ambassador', icon: '🎖️', name: 'Ambassador', need: 'Invite 10 friends', ok: (p) => p.refs >= 10 },
    { id: 'habit', icon: '🔥', name: 'Habit', need: '4-week streak', ok: (p) => p.best >= 4 },
    { id: 'swachh-habit', icon: '🏆', name: 'Swachh habit', need: '12-week streak', ok: (p) => p.best >= 12 },
  ];

  function setLoading(on) { $('#loadingLine').hidden = !on; }
  /** Move keyboard focus to an element after a re-render (headings get tabindex=-1 so they can take it). */
  function focusEl(el) {
    if (!el) return;
    if (!el.matches('a[href], button:not([disabled]), input, textarea, select, [tabindex]')) el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }
  /** The control to return to for a reward row: its Redeem button, or the row itself when the button is disabled. */
  function rewardTarget(id) {
    const b = id && $(`[data-act="redeem"][data-id="${CSS.escape(id)}"]`);
    if (b && !b.disabled) return b;
    return (id && $(`[data-reward="${CSS.escape(id)}"]`)) || $('#rewards');
  }
  /** Mark where an open dialog should send focus when it closes (openDialog(…, '[data-ret]')). */
  function markReturn(el) {
    document.querySelectorAll('[data-ret]').forEach((x) => x.removeAttribute('data-ret'));
    if (!el) return;
    if (!el.matches('a[href], button:not([disabled]), input, textarea, select, [tabindex]')) el.tabIndex = -1;
    el.dataset.ret = '';
  }

  // ------------------------------------------------------------------ loading
  async function load(focusSel) {
    setLoading(true);
    const [rw, mr] = await Promise.all([loadRewards(), Account.has() ? api('/api/me') : null]);
    if (rw.enabled === false) { setLoading(false); renderOff(rw.noApi); return; }
    ME = null;
    if (mr) {
      if (mr.ok) { ME = mr.j; Account.cache(ME.profile); }
      else if (mr.status !== 401) {
        setLoading(false);
        root.innerHTML = `<div class="card" style="margin-top:24px"><p role="alert">${esc(mr.j.error || 'Couldn’t load your profile.')}</p><button class="btn" type="button" id="retry">${ic('refresh')} Try again</button></div>`;
        $('#retry').onclick = () => load(focusSel);
        if (focusSel) $('#retry').focus();
        return;
      }
    }
    setLoading(false);
    render();
    if (focusSel) focusEl($(focusSel));
    if (lsGet('ss.newProfile', false) && ME) { lsSet('ss.newProfile', ''); toast('Welcome, Scout! Save your backup code below so you never lose your coins.'); }
  }
  async function loadRewards() {
    let q = HERE ? `&lat=${HERE.lat.toFixed(3)}&lon=${HERE.lon.toFixed(3)}` : '';
    if (wantReward) q += `&reward=${encodeURIComponent(wantReward)}`; // always describe the offer the scout tapped
    const r = await api(`/api/community?action=rewards${q}`, { auth: false });
    if (r.ok) { REWARDS = r.j.rewards || []; RULES = r.j.rules || RULES; REWARDS_ERR = ''; }
    else REWARDS_ERR = r.j.error || 'Couldn’t load the rewards.';
    return r;
  }

  function renderOff(noApi) {
    root.innerHTML = `<section class="page-hero"><h1>Swachh Coins &amp; rewards</h1>
      <p>${noApi ? 'Rewards need the site’s server, which isn’t running on this preview.' : 'Rewards switch on as soon as the site’s database is connected.'} You can still find washrooms and rate them; ratings are saved on this device.</p></section>
      <div class="card"><h2>How it will work</h2><p class="c-sub">Rate washrooms, report problems, add missing ones and invite friends to earn Swachh Coins, then spend them on rewards from partners.</p><a class="btn primary" href="/">${ic('map')} Find a washroom</a></div>`;
  }

  // ------------------------------------------------------------------ main render
  function render() {
    const p = ME && ME.profile;
    let h = '';
    if (!p) h += welcomeHTML();
    else h += profileHTML(p) + coinsHTML(p);
    h += earnHTML();
    h += rewardsHTML(p);
    if (p) h += vouchersHTML() + badgesHTML(p) + activityHTML() + inviteHTML(p) + backupHTML();
    else h += restoreHTML();
    h += moreHTML();
    root.innerHTML = h;
    bind();
    // scroll to the offer the scout came for once (not after every update), as soon as the catalogue has loaded
    if (deepLinked || !(wantReward || location.hash === '#rewards')) return;
    const el = (wantReward && !REWARDS_ERR && ($('#wanted') || document.querySelector(`[data-reward="${CSS.escape(wantReward)}"]`))) || $('#rewards');
    if (el) el.scrollIntoView({ block: el.matches('#rewards, #wanted') ? 'start' : 'center' });
    if (!REWARDS_ERR) deepLinked = true;
  }

  function welcomeHTML() {
    return `<section class="page-hero"><h1 id="pageTitle" tabindex="-1">Become a Swachh Scout</h1>
      <p>Help India find clean washrooms. Every rating and report earns <b>Swachh Coins</b> you can spend on rewards, and helps the municipality clean the washrooms that need it most.</p></section>
      <div class="card grad coins-card" style="margin-top:16px">
        <div class="label">Your Swachh Coins</div><div class="big-num">0</div><span class="coin lg" aria-hidden="true">S</span>
        <p style="margin:10px 0 14px;opacity:.92">No sign-up, no password: your Scout profile is created on this device the first time you earn coins.</p>
        <div class="row"><button class="btn" type="button" data-act="start" style="background:#fff;color:#0b1f1b;border-color:#fff">${ic('sparkle')} Start earning</button><a class="btn" href="/" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.6)">${ic('map')} Rate a washroom</a></div>
      </div>`;
  }

  function profileHTML(p) {
    return `<div class="card profile-card" style="margin-top:20px">
      <span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span>
      <div class="who"><h1 id="pageTitle" tabindex="-1">${esc(p.name)}${p.banned ? '' : ` <button class="icon-btn" type="button" data-act="rename" aria-label="Change your Scout name" style="width:32px;height:32px;vertical-align:middle">${ic('edit', 'sm')}</button>`}</h1>
        <span class="tier ${esc(p.tier.name)}">${{ Bronze: '🥉', Silver: '🥈', Gold: '🥇', Platinum: '💎' }[p.tier.name] || ''} ${esc(p.tier.name)}</span>
        ${p.banned ? '<span class="st bad" style="margin-left:6px">Suspended</span>' : ''}</div>
      <div class="stat"><b>${nf(p.rated)}</b><span>Reviews</span></div>
    </div>
    ${p.banned ? `<div class="notice-box warn" style="margin-top:12px">${ic('alert')}<p><b>This Scout profile is suspended.</b> While it’s suspended you can’t earn or redeem Swachh Coins, and you aren’t shown on the leaderboard. Profiles are suspended when ratings or reports look fake. If you think this is a mistake, contact the Swachh Scan team and give them your invite code <b>${esc(p.ref)}</b> so they can find your profile.</p></div>` : ''}`;
  }

  function coinsHTML(p) {
    const t = p.tier;
    const next = t.next;
    const pctNext = next ? Math.min(100, Math.round(((p.earned - t.min) / (next.min - t.min)) * 100)) : 100;
    const ranks = ME.ranks || {};
    return `<div class="card grad coins-card">
      <div class="label">Your Swachh Coins</div>
      <div class="big-num" aria-label="${nf(p.coins)} Swachh Coins">${nf(p.coins)}</div>
      <span class="coin lg" aria-hidden="true">S</span>
      <div class="progress" role="progressbar" aria-valuemin="${t.min}" aria-valuemax="${next ? next.min : t.min}" aria-valuenow="${p.earned}" aria-label="Progress to ${next ? next.name : 'the top tier'}"><span style="width:${pctNext}%"></span></div>
      <div class="range"><span>${esc(t.name)} (${nf(t.min)})</span><span>${next ? `${esc(next.name)} (${nf(next.min)}) · ${nf(next.min - p.earned)} to go` : 'Top tier reached'}</span></div>
      <div class="statline">
        <div><b>${p.streak ? `🔥 ${p.streak}` : '0'}</b><span>Week streak</span></div>
        <div><b>${ranks.week ? `#${nf(ranks.week.rank)}` : '—'}</b><span>Rank this week</span></div>
        <div><b>${nf(p.reports)}</b><span>Problems reported</span></div>
        <div><b>${nf(p.earned)}</b><span>Coins earned</span></div>
      </div>
    </div>
    ${ME.pendingPlaces ? `<div class="notice-box" style="margin-top:12px">${ic('clock')}<p>${ME.pendingPlaces} washroom${ME.pendingPlaces === 1 ? '' : 's'} you added ${ME.pendingPlaces === 1 ? 'is' : 'are'} waiting for review. You’ll get ${RULES ? RULES.coins.place : 50} coins for each one approved.</p></div>` : ''}`;
  }

  function earnHTML() {
    const c = RULES ? RULES.coins : { rate: 10, firstRating: 5, report: 5, reportResolved: 20, place: 50, referrer: 100, referred: 50, streak: 25 };
    const rows = [
      ['star', `Rate a washroom`, `+${c.rate}`, `+${c.firstRating} more if you’re the first to rate it`],
      ['flag', `Report a hygiene problem`, `+${c.report}`, `+${c.reportResolved} more when the municipality confirms it’s fixed`],
      ['plus', `Add a missing washroom`, `+${c.place}`, 'After our team checks it'],
      ['people', `Invite a friend`, `+${c.referrer}`, `When your friend has contributed on two different days. They get +${c.referred} on their first contribution`],
      ['bolt', `Keep a weekly streak`, `+${c.streak}`, 'Every 4 weeks in a row'],
    ];
    return `<h2 class="eyebrow">${ic('sparkle')} How to earn</h2>
      <div class="rows">${rows.map(([i, t, amt, sub]) => `<div class="rowcard"><span class="o-ico" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand)">${ic(i)}</span><div class="main"><div class="title">${t}</div><div class="sub">${sub}</div></div><span class="cost"><span class="coin" aria-hidden="true">S</span>${amt}</span></div>`).join('')}</div>
      <p class="rate-note">Coins count once per washroom every 7 days, up to ${RULES ? RULES.limits.ratingsRewardedPerDay : 10} ratings and ${RULES ? RULES.limits.reportsRewardedPerDay : 5} reports a day. Fake ratings or reports can get a profile suspended.</p>`;
  }

  /** When the scout can redeem this reward again (a recent redemption with a "once every N days" limit), or 0. */
  function cooldown(r) {
    const until = ME && ME.cooldowns ? Number(ME.cooldowns[r.id]) || 0 : 0;
    return until > Date.now() ? until : 0;
  }
  const hereWhere = () => (HERE && HERE.src === 'link' ? 'the place you were looking at on the map' : 'your location');
  const kmText = (km) => (km < 0.1 ? 'under 100 m' : km < 10 ? `${km} km` : `${nf(Math.round(km))} km`);

  function rewardsHTML(p) {
    const coins = p ? p.coins : 0;
    const want = wantReward ? REWARDS.find((r) => r.id === wantReward) || null : null;
    const wantOut = want && want.local && (want.needsLocation || want.tooFar); // shown on its own, with what's needed
    const global = REWARDS.filter((r) => !r.local);
    const local = REWARDS.filter((r) => r.local && !r.needsLocation && !r.tooFar);
    const hiddenLocal = REWARDS.some((r) => r.needsLocation && r !== want);
    const row = (r) => {
      const soon = r.left <= 0;
      const until = p ? cooldown(r) : 0;
      const where = r.place || r.partner || 'the shop';
      const can = !!p && !p.banned && !soon && !until && !r.needsLocation && !r.tooFar && coins >= r.cost;
      let sub;
      if (soon) sub = r.redeemed ? 'Out of stock — check back soon' : 'Coming soon';
      else if (until) sub = `Redeemed · available again on ${esc(fmtDate(until))}`;
      else if (r.needsLocation) sub = `For people within ${nf(r.radius)} km of ${esc(where)} · ${nf(r.left)} left`;
      else if (r.tooFar) sub = `${kmText(r.km)} away · only within ${nf(r.radius)} km of ${esc(where)}`;
      else {
        sub = `${nf(r.left)} left${r.km != null ? ` · ${kmText(r.km)} away${r.place ? `, ${esc(r.place)}` : ''}` : ''}${r.limitDays ? ` · once every ${r.limitDays === 1 ? 'day' : `${r.limitDays} days`}` : ''}`;
        if (coins < r.cost && !(p && p.banned)) sub = `Unlocks at ${nf(r.cost)} Swachh Coins · ${sub}`;
      }
      let btn = '';
      if (p && !soon) {
        const off = (label) => `<button class="btn sm" type="button" data-act="redeem" data-id="${esc(r.id)}" disabled>${label}</button>`;
        if (p.banned) btn = off('Unavailable');
        else if (until) btn = off('Redeemed');
        else if (r.needsLocation) btn = `<button class="btn sm" type="button" data-act="here">${ic('locate', 'sm')} Use my location</button>`;
        else if (r.tooFar) btn = off('Too far');
        else if (can) btn = `<button class="btn sm primary" type="button" data-act="redeem" data-id="${esc(r.id)}">Redeem</button>`;
        else btn = off(`${nf(r.cost - coins)} more`);
      }
      const mark = r.id === wantReward ? ' style="outline:2px solid var(--brand);outline-offset:2px"' : '';
      return `<div class="rowcard${can ? '' : ' locked'}" data-reward="${esc(r.id)}"${mark}>
        <span class="emoji" aria-hidden="true">${esc(r.icon || '🎁')}</span>
        <div class="main"><div class="title">${esc(r.partner ? `${r.partner} — ${r.title}` : r.title)}</div><div class="sub">${sub}</div></div>
        <div class="end"><span class="cost"><span class="coin" aria-hidden="true">S</span>${nf(r.cost)}</span>${btn}</div>
      </div>`;
    };
    let h = `<h2 class="eyebrow" id="rewards" tabindex="-1">${ic('gift')} Rewards catalogue</h2>`;
    if (REWARDS_ERR) h += `<div class="card" style="margin:0 0 12px"><p role="alert" style="margin:0 0 10px">${esc(REWARDS_ERR)}</p><button class="btn" type="button" data-act="retry-rewards">${ic('refresh')} Try again</button></div>`;
    // the offer a "Get offer" link pointed at
    if (wantReward && !REWARDS_ERR) {
      if (!want) h += `<div class="notice-box warn" id="wanted" style="margin-bottom:12px">${ic('alert')}<p>The offer you opened has ended or isn’t available any more. Here are the other rewards.</p></div>`;
      else if (wantOut) {
        const where = esc(want.place || want.partner || 'the shop');
        const name = `<b>${esc(want.title)}</b>${want.partner ? ` from ${esc(want.partner)}` : ''}`;
        h += want.needsLocation
          ? `<div class="notice-box" id="wanted" style="margin-bottom:8px">${ic('locate')}<p style="flex:1">${name} is for people within ${nf(want.radius)} km of ${where}. Share your location to check you’re close enough, then redeem it here. <button class="link" type="button" data-act="here">Use my location</button></p></div>`
          : `<div class="notice-box warn" id="wanted" style="margin-bottom:8px">${ic('alert')}<p style="flex:1">${name} is only for people within ${nf(want.radius)} km of ${where}, and ${HERE.src === 'link' ? `the place you were looking at on the map is ${kmText(want.km)} away` : `you’re ${kmText(want.km)} away`}. Redeem it when you’re nearby. <button class="link" type="button" data-act="here">${HERE && HERE.src === 'link' ? 'Use my location' : 'Update my location'}</button></p></div>`;
        h += `<div class="rows" style="margin-bottom:12px">${row(want)}</div>`;
      }
    }
    if (local.length) h += `<h3 class="small muted" style="margin:0 0 6px">${HERE && HERE.src === 'link' ? 'Shop offers nearby' : 'Offers near you'}</h3><div class="rows" style="margin-bottom:8px">${local.map(row).join('')}</div>`;
    if (!HERE && hiddenLocal) h += `<div class="notice-box" style="margin-bottom:10px">${ic('locate')}<p style="flex:1">Shops and cafés near you offer rewards too. <button class="link" type="button" data-act="here">Show offers near me</button></p></div>`;
    else if (HERE && !REWARDS_ERR) {
      const near = HERE.src === 'link' ? 'Showing shop offers near the place you were looking at on the map.' : `Showing shop offers near where you were ${esc(ago(HERE.t))}.`;
      h += `<p class="rate-note" style="margin:0 0 10px">${local.length ? near : `No shop offers near ${hereWhere()} right now.`} <button class="link" type="button" data-act="here">${HERE.src === 'link' ? 'Use my location' : 'Update location'}</button></p>`;
    }
    h += global.length ? `<div class="rows">${global.map(row).join('')}</div>` : (REWARDS_ERR ? '' : `<p class="muted">Rewards are coming soon.</p>`);
    if (!p) h += `<p class="rate-note">Start earning to redeem rewards.</p>`;
    return h;
  }

  function vouchersHTML() {
    const v = ME.vouchers || [];
    if (!v.length) return '';
    return `<h2 class="eyebrow" id="vouchers">${ic('ticket')} My vouchers</h2><div class="rows">${v.map((x) => `<div class="rowcard"><div class="main">
        <div class="title">${esc(x.partner ? `${x.partner} — ${x.title}` : x.title)}</div>
        <div class="sub">Redeemed ${esc(fmtDate(x.at))}${x.status === 'used' ? ` · used ${esc(fmtDate(x.usedAt))}` : ''}</div>
        <div class="row" style="margin-top:8px">${x.partnerCode ? `<span class="voucher-code" title="Partner code">${esc(x.partnerCode)}</span>` : ''}<span class="voucher-code" title="Swachh Scan code">${esc(x.code)}</span></div>
      </div><span class="st ${x.status === 'used' ? '' : 'good'}">${x.status === 'used' ? 'Used' : 'Ready to use'}</span></div>`).join('')}</div>`;
  }

  function badgesHTML(p) {
    const got = BADGES.filter((b) => b.ok(p)).length;
    return `<h2 class="eyebrow">${ic('badge')} Badges <span class="spacer"></span><span class="muted small" style="letter-spacing:0;text-transform:none">${got} of ${BADGES.length}</span></h2>
      <div class="badges">${BADGES.map((b) => `<div class="badge-tile${b.ok(p) ? '' : ' off'}"><div class="b-ico" aria-hidden="true">${b.icon}</div><b>${esc(b.name)}</b><small>${b.ok(p) ? 'Earned' : esc(b.need)}</small></div>`).join('')}</div>`;
  }

  function activityHTML() {
    const l = ME.ledger || [];
    return `<h2 class="eyebrow">${ic('clock')} Recent activity</h2>` + (l.length
      ? `<div class="rows activity">${l.slice(0, 20).map((x) => `<div class="rowcard"><div class="main"><div class="title">${esc(x.d || KIND[x.k] || 'Activity')}</div><div class="sub">${esc(KIND[x.k] || '')} · ${esc(ago(x.t))}</div></div>${x.c ? `<span class="amt ${x.c > 0 ? 'plus' : 'minus'}">${x.c > 0 ? '+' : '−'}${nf(Math.abs(x.c))}</span>` : ''}</div>`).join('')}</div>`
      : `<p class="muted">No reviews yet. <a href="/">Start rating to earn coins!</a></p>`);
  }

  const inviteLink = (p) => `${location.origin}/?ref=${encodeURIComponent(p.ref)}`;
  function inviteHTML(p) {
    const link = inviteLink(p);
    const c = RULES ? RULES.coins : { referrer: 100, referred: 50 };
    return `<h2 class="eyebrow">${ic('people')} Invite friends</h2>
      <div class="card soft" style="margin-top:0">
        <p style="margin:0 0 10px">Get <b>+${c.referrer} coins</b> when a friend joins with your link and contributes on two different days (rating a washroom, reporting a problem or adding one). They get <b>+${c.referred}</b> on their first contribution.</p>
        <label class="field" style="margin-bottom:8px"><span>Your invite link</span><input class="input" id="inviteLink" type="text" readonly value="${esc(link)}" spellcheck="false"></label>
        <div class="row"><span class="voucher-code" title="Your invite code">${esc(p.ref)}</span><button class="btn primary" type="button" data-act="share-invite">${ic('share')} Share invite</button><button class="btn" type="button" data-act="copy" data-text="${esc(link)}">${ic('copy')} Copy link</button></div>
        <p class="rate-note">${p.refs ? `${nf(p.refs)} friend${p.refs === 1 ? '' : 's'} joined so far.` : 'No friends joined yet.'} Up to ${RULES ? RULES.limits.referralsRewardedPerMonth : 20} invite bonuses a month.</p>
      </div>`;
  }

  function backupHTML() {
    return `<h2 class="eyebrow">${ic('lock')} Backup &amp; other devices</h2>
      <div class="card" style="margin-top:0">
        <p style="margin:0 0 10px">There’s no password: your profile lives on this device. Save your <b>backup code</b> somewhere safe to keep your coins if you change phones or clear your browser.</p>
        <div class="row"><button class="btn" type="button" data-act="show-code" aria-expanded="false" aria-controls="codeBox">${ic('eye')} Show backup code</button><button class="btn" type="button" data-act="copy-code">${ic('copy')} Copy backup code</button></div>
        <div id="codeBox" hidden style="margin-top:10px"><span class="voucher-code" id="codeText" style="font-size:13px;word-break:break-all;display:inline-block">${esc(Account.token())}</span><p class="rate-note">Anyone with this code can use your coins. Don’t share it.</p></div>
        <details class="more" style="margin-top:14px"><summary>Use a different profile on this device</summary>${restoreForm()}</details>
      </div>`;
  }
  function restoreForm() {
    return `<form class="form" id="restoreForm" onsubmit="return false" style="margin-top:10px">
      <label class="field"><span>Backup code</span><input name="code" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="xxxxxxxxxxxx.xxxxxxxx…" aria-describedby="restoreErr"></label>
      <p class="form-error" id="restoreErr" role="alert" hidden></p>
      <button class="btn" type="submit">${ic('refresh')} Restore profile</button></form>`;
  }
  function restoreHTML() {
    return `<h2 class="eyebrow">${ic('lock')} Already a Scout?</h2><div class="card" style="margin-top:0"><p style="margin:0 0 6px">Restore your coins on this device with the backup code from your other device.</p>${restoreForm()}</div>`;
  }
  function moreHTML() {
    return `<h2 class="eyebrow">${ic('menu')} More</h2><div class="rows">
      <a class="rowcard" href="/leaderboard.html" style="text-decoration:none;color:inherit">${ic('trophy')}<div class="main"><div class="title">Leaderboard &amp; Honor Roll</div><div class="sub">${ME && ME.ranks && ME.ranks.all ? `You’re #${nf(ME.ranks.all.rank)} of all time` : 'See the top Swachh Scouts'}</div></div></a>
      <a class="rowcard" href="/business.html" style="text-decoration:none;color:inherit">${ic('store')}<div class="main"><div class="title">For businesses &amp; operators</div><div class="sub">Advertise nearby, get Featured or Verified</div></div></a>
      <a class="rowcard" href="/civic.html" style="text-decoration:none;color:inherit">${ic('landmark')}<div class="main"><div class="title">Civic dashboard</div><div class="sub">Washrooms that need cleaning, and the ones that got fixed</div></div></a>
    </div>`;
  }

  // ------------------------------------------------------------------ actions
  function bind() {
    root.onclick = async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || a.disabled) return;
      const act = a.dataset.act;
      if (act === 'start') {
        a.disabled = true;
        const r = await Account.ensure();
        if (!r.ok) { toast(r.error || 'Couldn’t create your profile. Try again.'); a.disabled = false; return; }
        lsSet('ss.newProfile', true);
        load('#pageTitle');
      }
      if (act === 'rename') { const f = $('#nameForm'); f.elements.scoutName.value = ME.profile.name; $('#nameErr').hidden = true; openDialog($('#nameDialog'), '[data-act="rename"]'); }
      if (act === 'redeem') openRedeem(REWARDS.find((r) => r.id === a.dataset.id));
      if (act === 'here') locate(a);
      if (act === 'retry-rewards') {
        a.disabled = true;
        await loadRewards();
        render();
        focusEl($('#rewards'));
      }
      if (act === 'copy') copy(a.dataset.text, 'Invite link copied', '#inviteLink', 'The link is selected, so copy it.');
      if (act === 'share-invite') shareInvite();
      if (act === 'show-code') { const b = $('#codeBox'); b.hidden = !b.hidden; a.setAttribute('aria-expanded', String(!b.hidden)); a.innerHTML = `${ic('eye')} ${b.hidden ? 'Show' : 'Hide'} backup code`; }
      if (act === 'copy-code') copy(Account.token(), 'Backup code copied. Keep it somewhere safe.', '#codeText', 'The code is selected, so copy it.');
    };
    const rf = $('#restoreForm');
    if (rf) rf.addEventListener('submit', restore);
  }

  /** Select an input's value or an element's text, so it can be copied by hand. */
  function selectText(el) {
    if (el.select) { el.focus(); el.select(); return; }
    const box = el.closest('[hidden]');
    if (box) box.hidden = false;
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  async function copy(text, msg, selectSel, manualMsg) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      toast(msg);
      return;
    } catch (e) { /* blocked (http, in-app browsers, unfocused page): fall back to selecting the text */ }
    const el = selectSel && $(selectSel);
    if (!el) { toast('Couldn’t copy automatically.'); return; }
    selectText(el);
    if (selectSel === '#codeText') { const b = $('[data-act="show-code"]'); if (b) { b.setAttribute('aria-expanded', 'true'); b.innerHTML = `${ic('eye')} Hide backup code`; } }
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    toast(ok ? msg : `Couldn’t copy automatically. ${manualMsg}`);
  }
  async function shareInvite() {
    const p = ME.profile;
    const url = inviteLink(p);
    const text = `Find clean public washrooms near you on Swachh Scan, rate them and earn rewards. Join with my code ${p.ref}:`;
    if (navigator.share) { try { await navigator.share({ title: 'Swachh Scan', text, url }); } catch (e) { /* cancelled */ } } else copy(`${text} ${url}`, 'Invite copied — paste it to a friend', '#inviteLink', 'The link is selected, so copy it.');
  }
  function locate(btn) {
    if (!navigator.geolocation) { toast('Location isn’t available on this device.'); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const t = Date.now();
      HERE = { lat: pos.coords.latitude, lon: pos.coords.longitude, t, src: 'device' };
      lsSet('ss.offersHere', { lat: HERE.lat, lon: HERE.lon, t });
      await loadRewards();
      render();
      focusEl($('#wanted') || (wantReward && rewardTarget(wantReward)) || $('#rewards'));
      const s = $('#wanted') || $('#rewards'); if (s) s.scrollIntoView({ block: 'start' });
    }, (err) => {
      if (btn.isConnected) btn.disabled = false;
      toast(err && err.code === 1 ? 'Location is blocked for this site. Allow it in your browser settings and try again.' : 'Couldn’t get your location. Try again.');
    }, { timeout: 12000, maximumAge: 300000 });
  }

  async function restore() {
    const f = $('#restoreForm');
    let code = f.code.value.replace(/\s+/g, '');
    // phone keyboards capitalise the first letter: the part before the dot is always lowercase (the rest is case-sensitive)
    if (code.indexOf('.') === 12) code = code.slice(0, 12).toLowerCase() + code.slice(12);
    const err = $('#restoreErr');
    err.hidden = true;
    if (!/^[a-z2-9]{12}\.[A-Za-z0-9_-]{24,64}$/.test(code)) { err.textContent = 'That doesn’t look like a backup code.'; err.hidden = false; f.code.focus(); return; }
    if (Account.has() && !confirm('This replaces the profile on this device. Make sure you saved its backup code first. Continue?')) return;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    const r = await api('/api/me', { token: code });
    btn.disabled = false;
    if (!r.ok) { err.textContent = r.status === 401 ? 'That backup code isn’t valid.' : (r.j.error || 'Couldn’t restore. Try again.'); err.hidden = false; f.code.focus(); return; }
    Account.save(code, r.j.profile);
    toast(`Welcome back, ${r.j.profile.name}!`);
    load('#pageTitle');
  }

  $('#nameForm').addEventListener('submit', async () => {
    const f = $('#nameForm'), err = $('#nameErr');
    err.hidden = true;
    const r = await api('/api/me', { body: { action: 'rename', name: f.elements.scoutName.value.trim() } });
    if (!r.ok) { err.textContent = r.j.error || 'Couldn’t save.'; err.hidden = false; f.elements.scoutName.focus(); return; }
    ME.profile.name = r.j.name;
    Account.cache(ME.profile);
    render(); // before closing, so focus goes back to the new pencil button
    $('#nameDialog').close();
    toast('Name saved');
  });

  // ------------------------------------------------------------------ redeeming
  const PHONE_RE = /^(?:\+91|0091)?0?[1-9]\d{9}$/;
  function openRedeem(r) {
    if (!r || !ME) return;
    const p = ME.profile;
    const needs = r.needs === 'phone' || r.needs === 'address' ? r.needs : '';
    const field = needs === 'phone'
      ? `<label class="field"><span>Your mobile number</span><input id="redeemContact" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" required autofocus placeholder="98765 43210" aria-describedby="redeemContactHint redeemErr"><small class="hint" id="redeemContactHint">We need it to send you this reward. Only the Swachh Scan team sees it, and it’s deleted once the reward is delivered.</small></label>`
      : needs === 'address'
        ? `<label class="field"><span>Delivery address</span><textarea id="redeemContact" autocomplete="street-address" rows="3" minlength="15" maxlength="240" required autofocus placeholder="Name, house, street, area, city, PIN code" aria-describedby="redeemContactHint redeemErr"></textarea><small class="hint" id="redeemContactHint">We need it to deliver this reward. Only the Swachh Scan team sees it, and it’s deleted once the reward is delivered.</small></label>`
        : '';
    const goLabel = `${ic('gift')} Redeem for ${nf(r.cost)} coins`;
    $('#redeemTitle').textContent = 'Redeem reward';
    $('#redeemLive').textContent = '';
    $('#redeemBody').innerHTML = `<div class="rowcard" style="margin-bottom:12px"><span class="emoji" aria-hidden="true">${esc(r.icon || '🎁')}</span><div class="main"><div class="title">${esc(r.title)}</div><div class="sub">${esc(r.partner || '')}</div></div><span class="cost"><span class="coin" aria-hidden="true">S</span>${nf(r.cost)}</span></div>
      ${r.terms ? `<p class="small">${esc(r.terms)}</p>` : ''}
      <p>You have <b>${nf(p.coins)}</b> coins. After redeeming: <b>${nf(p.coins - r.cost)}</b>.</p>
      ${field}
      <p class="form-error" id="redeemErr" role="alert" hidden></p>
      <div class="row"><button class="btn" type="button" data-close${needs ? '' : ' autofocus'}>Cancel</button><button class="btn primary" type="button" id="redeemGo">${goLabel}</button></div>`;
    markReturn(null);
    openDialog($('#redeemDialog'), '[data-ret]');
    if (needs === 'phone') $('#redeemContact').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#redeemGo').click(); } });
    $('#redeemGo').addEventListener('click', async (e) => {
      const b = e.currentTarget, er = $('#redeemErr'), input = $('#redeemContact');
      er.hidden = true;
      const fail = (msg, focus) => { er.textContent = msg; er.hidden = false; if (focus) focus.focus(); };
      let contact;
      if (needs) {
        contact = input.value.trim();
        if (needs === 'phone' && !PHONE_RE.test(contact.replace(/[\s()-]/g, ''))) return fail('Enter a valid Indian mobile number, like 98765 43210.', input);
        if (needs === 'address' && contact.length < 15) return fail('Enter your full delivery address, with the PIN code.', input);
      }
      const body = { action: 'redeem', reward: r.id };
      if (contact) body.contact = contact;
      if (r.local && HERE) { body.lat = HERE.lat; body.lon = HERE.lon; } // a shop's offer is checked against the scout's position
      b.disabled = true; b.textContent = 'Redeeming…';
      if (input) input.readOnly = true;
      const res = await api('/api/me', { body });
      if (!res.ok) {
        if (input) input.readOnly = false;
        const code = res.j.code || '';
        // these won't change by trying again: say why and refresh the catalogue behind the dialog
        if (['limit', 'poor', 'inactive', 'out', 'banned', 'too_far', 'need_location', 'bad_token'].includes(code) || [401, 402, 403, 404, 410, 429].includes(res.status)) {
          b.innerHTML = goLabel;
          fail(res.j.error || 'This reward can’t be redeemed right now.', $('#redeemDialog [data-close]:not(.close)'));
          refreshAfterRedeem(r.id);
          return;
        }
        b.disabled = false;
        if (res.status === 400) { b.innerHTML = goLabel; fail(res.j.error || 'Check the details and try again.', input); return; }
        b.textContent = 'Try again';
        fail(res.j.error || 'Couldn’t redeem. Try again.');
        return;
      }
      const v = res.j.voucher;
      coinToast(res.j.coins);
      $('#redeemTitle').textContent = 'Reward redeemed';
      $('#redeemBody').innerHTML = `<div class="notice-box">${ic('check')}<p><b>Redeemed!</b> ${esc(v.title)}${v.partner ? ` from ${esc(v.partner)}` : ''}.</p></div>
        ${v.partnerCode ? `<p style="margin-top:14px">Your partner code:</p><p><span class="voucher-code">${esc(v.partnerCode)}</span></p>` : ''}
        <p style="margin-top:14px">${v.partnerCode ? 'Swachh Scan reference:' : needs ? 'Your reference code:' : 'Show this code to redeem:'}</p><p><span class="voucher-code">${esc(v.code)}</span></p>
        ${v.terms ? `<p class="small">${esc(v.terms)}</p>` : ''}<p class="rate-note">It’s saved under “My vouchers”.</p>
        <button class="btn primary block" type="button" data-close>Done</button>`;
      // announce the code (the dialog is modal, so the page's toast region may not be read)
      $('#redeemLive').textContent = `Redeemed ${v.title}. ${v.partnerCode ? `Your partner code is ${v.partnerCode}. Swachh Scan reference: ` : 'Your code is '}${v.code.split('').join(' ')}. It’s saved under My vouchers.`;
      $('#redeemBody [data-close]').focus();
      refreshAfterRedeem(r.id);
    });
  }
  /** Reload the profile and catalogue after a redemption attempt, keeping keyboard focus somewhere sensible. */
  async function refreshAfterRedeem(id) {
    const [me] = await Promise.all([api('/api/me'), loadRewards()]);
    if (me.ok) { ME = me.j; Account.cache(ME.profile); }
    render();
    const t = rewardTarget(id);
    if ($('#redeemDialog').open) markReturn(t);
    else if (!document.activeElement || document.activeElement === document.body) focusEl(t);
  }

  load();
})();
