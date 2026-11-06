/* Swachh Scan — admin console. Talks to /api/admin with the ADMIN_TOKEN password (kept in this tab's sessionStorage only). */
(function () {
  'use strict';
  if (!window.SS) return;
  const { esc, ic, nf, api, toast, fmtDate, fmtDateTime, ago, openDialog } = window.SS;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  // ------------------------------------------------------------------ labels (mirror api/_lib/config.js and api/admin.js)
  const ISSUES = {
    dirty: 'Dirty', smell: 'Bad smell', no_water: 'No water', no_soap: 'No soap', no_light: 'No light',
    broken: 'Broken door, lock or fittings', clogged: 'Blocked or overflowing', unsafe: 'Felt unsafe',
    closed: 'Closed during opening hours', no_access: 'Not wheelchair accessible', overcharged: 'Charged more than listed',
    missing: 'Not here / wrong location', other: 'Something else',
  };
  const CHECKS = [
    ['clean', 'Clean floor, seats and walls'], ['water', 'Running water'], ['soap', 'Soap at the basin'], ['light', 'Working lights'],
    ['locks', 'Doors lock properly'], ['dustbin', 'Dustbin available'], ['access', 'Step-free / wheelchair access'], ['signage', 'Signs, hours and helpline shown'],
  ];
  const ORDER_ST = {
    awaiting_payment: ['Awaiting payment', 'warn'], payment_submitted: ['Payment to confirm', 'info'], active: ['Active', 'good'],
    inspection: ['Inspection due', 'info'], completed: ['Completed', 'good'], rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', ''],
  };
  const AD_ST = {
    awaiting_payment: ['Awaiting payment', 'warn'], live: ['Live', 'good'], paused: ['Paused', 'warn'], ended: ['Ended', ''],
    rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', ''],
  };
  const NEEDS = { '': 'Nothing', phone: 'Phone number', address: 'Delivery address' };
  const G = { separate: 'Separate men & women', men: 'Men only', women: 'Women only', unisex: 'Unisex' };
  const WC = { yes: 'Wheelchair accessible', limited: 'Limited wheelchair access', no: 'Not wheelchair accessible' };
  const pill = (map, s) => { const [l, t] = map[s] || [s || 'Unknown', '']; return `<span class="st ${t}">${esc(l)}</span>`; };
  const rupees = (n) => `₹${nf(n || 0)}`;
  const washLink = (id, name) => (id ? `<a href="/?id=${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(name || id)}</a>` : esc(name || ''));
  const gmaps = (la, lo) => `https://www.google.com/maps/search/?api=1&query=${la},${lo}`;
  const areaOf = (r) => [r.city, r.d, r.st].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2).join(', ');

  // ------------------------------------------------------------------ state
  const KEY = 'ss.admin';
  let PW = '';
  try { PW = sessionStorage.getItem(KEY) || ''; } catch (e) { PW = ''; }
  const A = { tab: 'overview', ov: null, showAll: false, data: {}, newKey: null, editReward: null, userQ: '', voucher: null, actor: '' };
  try { A.actor = sessionStorage.getItem('ss.admin.actor') || ''; } catch (e) { /* ignore */ }

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'orders', label: 'Orders & payments', count: (o) => o.paymentsToConfirm },
    { id: 'places', label: 'New washrooms', count: (o) => o.pendingPlaces },
    { id: 'claims', label: 'Claims', count: (o) => o.pendingClaims },
    { id: 'inspections', label: 'Inspections', count: (o) => o.inspections },
    { id: 'reports', label: 'Reports', count: (o) => o.openReports },
    { id: 'ads', label: 'Ads' },
    { id: 'rewards', label: 'Rewards' },
    { id: 'keys', label: 'Officer keys' },
    { id: 'scouts', label: 'Scouts' },
    { id: 'voucher', label: 'Voucher lookup' },
  ];

  // ------------------------------------------------------------------ API
  const get = (action, extra) => api(`/api/admin?action=${action}${extra || ''}`, { token: PW });
  /** POST an admin action. Disables the button while saving; toasts the result; returns the reply or null.
   *  from: the control the admin used (defaults to btn); keyboard focus goes back to the same control in the redrawn
   *  panel, or to the panel heading when the item is gone (approved, rejected…). */
  async function post(body, btn, okMsg, from) {
    const label = btn ? btn.innerHTML : '';
    const back = focusTargets(from || btn);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const r = await api('/api/admin', { token: PW, body });
    if (!r.ok) {
      if (r.status === 401) { signOut('Your admin session ended. Sign in again.'); return null; }
      toast(r.j.error || 'That didn’t work. Please try again.');
      if (btn && document.contains(btn)) { btn.disabled = false; btn.innerHTML = label; btn.focus(); }
      return null;
    }
    if (okMsg) toast(okMsg);
    await refreshCounts();
    await loadTab(A.tab, false);
    restoreFocus(back);
    return r.j;
  }
  /** Selectors for "the same control" after a redraw: the same action on the same item, any action on it, then nothing. */
  function focusTargets(el) {
    if (!el || !el.closest) return [];
    const holder = el.closest('[data-id], [data-uid], [data-hash]');
    if (!holder) return el.id ? [`#${CSS.escape(el.id)}`] : [];
    const attr = ['data-id', 'data-uid', 'data-hash'].find((a) => holder.hasAttribute(a));
    const base = `[${attr}="${CSS.escape(holder.getAttribute(attr))}"]`;
    return [el.dataset && el.dataset.act ? `${base} [data-act="${CSS.escape(el.dataset.act)}"]` : '', `${base} [data-act]`, `${base} input, ${base} button`].filter(Boolean);
  }
  /** Put focus somewhere sensible if the redraw removed the focused control. */
  function restoreFocus(sels) {
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a) && a.offsetParent !== null) return;
    for (const s of sels || []) { const el = s && panel.querySelector(s); if (el && !el.disabled) { el.focus(); return; } }
    const h = panel.querySelector('h2.panel-title');
    if (h) h.focus();
  }

  // ------------------------------------------------------------------ sign in / out
  function showSignin(msg, helpHTML) {
    $('#signin').hidden = false;
    $('#console').hidden = true;
    $('#signOut').hidden = true;
    const err = $('#signinError');
    err.hidden = !msg;
    err.textContent = msg || '';
    $('#signinHelp').innerHTML = helpHTML || '';
  }
  function signOut(msg) {
    PW = '';
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    A.ov = null; A.data = {}; A.newKey = null;
    showSignin(msg || '');
    $('#pw').value = '';
    $('#pw').focus();
  }
  $('#signOut').addEventListener('click', () => signOut());

  async function trySignin(pw, fromForm) {
    const btn = $('#signinBtn');
    btn.disabled = true;
    const r = await api('/api/admin?action=overview', { token: pw });
    btn.disabled = false;
    if (r.ok) {
      PW = pw;
      try { sessionStorage.setItem(KEY, pw); } catch (e) { /* ignore */ }
      A.ov = r.j.overview;
      $('#signin').hidden = true;
      $('#console').hidden = false;
      $('#signOut').hidden = false;
      renderTabs();
      await loadTab(A.tab, fromForm);
      return;
    }
    const forget = () => { PW = ''; try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } };
    if (r.status === 401) {
      forget();
      showSignin(fromForm ? 'That password is not right.' : '');
      if (fromForm) $('#pw').focus();
    } else if (r.status === 503 && r.j.code === 'no_admin') {
      forget();
      showSignin('', `<div class="notice-box warn">${ic('alert')}<div><p><strong>Admin isn’t set up yet.</strong></p><p>In Vercel → Project → Settings → Environment Variables, add <code>ADMIN_TOKEN</code> with a long random password (at least 16 characters), then redeploy. Sign in here with that password.</p></div></div>`);
    } else if (r.enabled === false && r.noApi) {
      showSignin('', `<div class="notice-box warn">${ic('alert')}<div><p><strong>The site’s server functions aren’t running here.</strong></p><p>This host serves only the static pages (for example a local preview), so there is no <code>/api</code> to sign in to. Open the admin on your Vercel deployment, or run the project with <code>vercel dev</code>.</p></div></div>`);
    } else if (r.enabled === false) {
      showSignin('', `<div class="notice-box warn">${ic('alert')}<div><p><strong>No database is connected yet.</strong></p><p>In your Vercel project open <strong>Storage</strong> (or Integrations → Marketplace), add <strong>Upstash for Redis</strong> and connect it to this project. Vercel adds <code>KV_REST_API_URL</code> and <code>KV_REST_API_TOKEN</code> for you. Then redeploy.</p></div></div>`);
    } else {
      // a temporary problem (timeout, 5xx, offline): keep the saved session and offer a retry with the same password
      showSignin(r.j.error || 'Couldn’t reach the server. Try again.', `<div class="row" style="margin-top:12px"><button class="btn" type="button" id="signinRetry">${ic('refresh', 'sm')} Try again</button>${!fromForm && PW ? '<span class="small muted">You’re still signed in in this tab.</span>' : ''}</div>`);
      const again = $('#signinRetry');
      again.addEventListener('click', async () => { again.disabled = true; again.textContent = 'Trying again…'; await trySignin(pw, fromForm); if (!$('#console').hidden) restoreFocus([]); else { const nb = $('#signinRetry'); if (nb) nb.focus(); } });
    }
  }
  $('#signinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = $('#pw').value.trim();
    if (!pw) { showSignin('Enter the admin password.'); $('#pw').focus(); return; }
    trySignin(pw, true);
  });

  // ------------------------------------------------------------------ tabs
  /** Build the tab buttons once, then update them in place so keyboard focus is never lost. */
  function renderTabs() {
    const o = A.ov || {};
    const box = $('#tabs');
    if (!box.children.length) {
      box.innerHTML = TABS.map((t) => `<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel" data-tab="${t.id}"><span class="t-label">${esc(t.label)}</span><span class="n" hidden></span></button>`).join('');
    }
    for (const t of TABS) {
      const b = $(`#tab-${t.id}`);
      const sel = t.id === A.tab;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      const n = t.count ? t.count(o) : 0;
      const badge = b.querySelector('.n');
      badge.hidden = !n;
      badge.textContent = n ? nf(n) : '';
      if (n) badge.setAttribute('aria-label', `${n} waiting`); else badge.removeAttribute('aria-label');
    }
    $('#panel').setAttribute('aria-labelledby', `tab-${A.tab}`);
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab, true);
  });
  $('#tabs').addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === A.tab);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = TABS.length - 1;
    if (j == null) return;
    e.preventDefault();
    switchTab(TABS[j].id, false);
    const t = $(`#tab-${TABS[j].id}`);
    if (t) { t.focus(); t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  });
  async function switchTab(id, focusPanel) {
    A.tab = id;
    renderTabs();
    await loadTab(id, focusPanel);
  }
  async function refreshCounts() {
    const r = await get('overview');
    if (r.ok) { A.ov = r.j.overview; renderTabs(); }
  }

  const LOADERS = {
    overview: async () => { const r = await get('overview'); if (r.ok) A.ov = r.j.overview; return r; },
    orders: () => get('orders', A.showAll ? '&status=all' : ''),
    places: () => get('places'),
    claims: () => get('claims'),
    inspections: () => get('orders'),
    reports: () => get('reports'),
    ads: () => get('ads'),
    rewards: () => get('rewards'),
    keys: () => get('keys'),
    scouts: () => get('users', A.userQ ? `&q=${encodeURIComponent(A.userQ)}` : ''),
    voucher: async () => ({ ok: true, j: {} }),
  };
  let loadSeq = 0;
  async function loadTab(id, focusPanel) {
    const seq = ++loadSeq;
    const panel = $('#panel');
    const keepScroll = window.scrollY;
    if (!panel.innerHTML || focusPanel) panel.innerHTML = `<div class="loading-line">Loading…</div>`;
    const r = await LOADERS[id]();
    if (seq !== loadSeq) return; // a newer tab load won
    if (!r.ok) {
      if (r.status === 401) { signOut('Your admin session ended. Sign in again.'); return; }
      panel.innerHTML = `<div class="notice-box warn" role="alert">${ic('alert')}<div><p>${esc(r.j.error || 'Couldn’t load this section.')}</p><p style="margin-top:8px"><button class="btn sm" type="button" data-act="tab-retry">${ic('refresh', 'sm')} Try again</button></p></div></div>`;
      if (focusPanel) { const t = panel.querySelector('[data-act="tab-retry"]'); if (t) t.focus(); }
      return;
    }
    A.data[id] = r.j;
    panel.innerHTML = RENDER[id](r.j);
    if (id === 'overview') renderTabs();
    if (focusPanel) { const h = panel.querySelector('h2'); (h || panel).focus({ preventScroll: false }); }
    else window.scrollTo(0, keepScroll);
  }
  const title = (t, sub) => `<h2 class="panel-title" tabindex="-1">${esc(t)}</h2>${sub ? `<p class="panel-sub">${sub}</p>` : ''}`;
  const empty = (t) => `<div class="empty card">${ic('check')}<p>${esc(t)}</p></div>`;

  // ------------------------------------------------------------------ renderers
  const RENDER = {};

  RENDER.overview = () => {
    const o = A.ov || {};
    const k = (label, val, tab, hot, sub) => `<button type="button" class="kpi kpi-go${hot && val ? ' hot' : ''}" data-go="${tab}"><div class="k-label">${esc(label)}</div><div class="k-val">${nf(val || 0)}</div>${sub ? `<div class="k-sub">${esc(sub)}</div>` : ''}</button>`;
    const plans = (o.config && o.config.plans) || {};
    return `${title('Overview', 'What needs your attention, at a glance. Select a tile to open that section.')}
      <div class="kpis">
        ${k('Payments to confirm', o.paymentsToConfirm, 'orders', true, `${nf(o.awaitingPayment || 0)} awaiting payment`)}
        ${k('New washrooms to review', o.pendingPlaces, 'places', true)}
        ${k('Operator claims', o.pendingClaims, 'claims', true)}
        ${k('Inspections due', o.inspections, 'inspections', true)}
        ${k('Open hygiene reports', o.openReports, 'reports', true)}
        ${k('Scouts', o.users, 'scouts')}
        ${k('Businesses', o.businesses, 'orders')}
        ${k('Live ads', o.liveAds, 'ads')}
        ${k('Officer keys', o.officerKeys, 'keys')}
        ${k('Washrooms added by scouts', o.communityPlaces, 'places')}
      </div>
      <h3 class="eyebrow">${ic('rupee')} Payments</h3>
      ${o.config && o.config.upi
        ? `<div class="notice-box">${ic('check')}<p>UPI payments are switched on. Businesses see a UPI QR code and enter their UPI reference (UTR); you confirm it in <strong>Orders &amp; payments</strong> after checking your bank app.</p></div>`
        : `<div class="notice-box warn">${ic('alert')}<p>UPI isn’t configured, so businesses are told you’ll contact them with payment details. Add <code>UPI_ID</code> (e.g. yourname@okhdfcbank) and optionally <code>UPI_NAME</code> in Vercel’s environment variables and redeploy to show a UPI QR code.</p></div>`}
      <div class="card"><h2>Price list</h2><p class="c-sub">Set in <code>api/_lib/config.js</code>. Change it there and redeploy.</p>
        <div class="tbl-wrap"><table class="data"><thead><tr><th scope="col">Service</th><th scope="col" class="num">Price</th><th scope="col" class="num">Days</th><th scope="col">What it includes</th></tr></thead><tbody>
        ${Object.values(plans).map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${rupees(p.price)}</td><td class="num">${nf(p.days)}</td><td>${esc(p.what)}</td></tr>`).join('')}
        </tbody></table></div></div>`;
  };

  RENDER.places = (j) => {
    const list = j.places || [];
    return `${title('New washrooms', 'Washrooms suggested by scouts. Approving puts them on the map and gives the scout their coins. Check the nearest existing washroom to avoid duplicates.')}
      ${list.length ? `<div class="adm-list">${list.map((p) => {
        const tags = [p.s ? 'Public toilet' : p.c, p.fee === 'free' ? 'Free' : p.fee === 'paid' ? `Paid${p.pr ? ' · ' + p.pr : ''}` : '', G[p.g], WC[p.wc], p.bc === 'yes' ? 'Baby changing' : p.bc === 'no' ? 'No baby changing' : '', p.oh ? `Hours: ${p.oh}` : ''].filter(Boolean);
        const near = p.nearest;
        return `<article class="adm-item" data-id="${esc(p.id)}">
          <div class="it-head"><div><div class="it-title">${esc(p.n)}</div><div class="it-sub">Suggested by ${esc(p.scout || 'a scout')} · ${esc(ago(p.at))} · ${esc([p.city, p.d, p.st].filter(Boolean).join(', '))}</div></div>
            <a class="btn sm" href="${gmaps(p.la, p.lo)}" target="_blank" rel="noopener">${ic('map', 'sm')} See on Google Maps</a></div>
          <div class="adm-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          ${p.a ? `<div class="small"><span class="muted">Address:</span> ${esc(p.a)}</div>` : ''}
          ${p.note ? `<p class="adm-quote">${esc(p.note)}</p>` : ''}
          ${near ? `<div class="small${near.m < 60 ? ' form-error' : ''}">${ic('pin', 'sm')} Nearest washroom on the map: ${washLink(near.id, near.n)} · ${nf(near.m)} m away${near.m < 60 ? ' — check it isn’t the same one' : ''}</div>` : ''}
          <div class="adm-fields">
            <label class="field"><span>Name</span><input name="n" value="${esc(p.n)}" maxlength="80"></label>
            <label class="field"><span>City / town</span><input name="city" value="${esc(p.city || '')}" maxlength="60"></label>
            <label class="field"><span>District</span><input name="d" value="${esc(p.d || '')}" maxlength="60"></label>
          </div>
          <label class="field"><span>Note to the scout (optional, shown if rejected)</span><input name="note" maxlength="160" placeholder="e.g. Already on the map as Ganesh Market toilet"></label>
          <div class="adm-actions"><button class="btn good" type="button" data-act="place-approve">${ic('check')} Approve</button><button class="btn danger" type="button" data-act="place-reject">${ic('x')} Reject</button></div>
        </article>`;
      }).join('')}</div>` : empty('No washrooms waiting for review.')}`;
  };

  RENDER.claims = (j) => {
    const list = j.claims || [];
    return `${title('Operator claims', 'Businesses asking to manage a washroom. Approve only when the proof checks out (contract, municipal letter, phone call). Approved operators can answer reports and buy services.')}
      ${list.length ? `<div class="adm-list">${list.map((c) => {
        const b = c.business || {};
        return `<article class="adm-item" data-id="${esc(c.id)}">
          <div class="it-head"><div><div class="it-title">${washLink(c.w, c.n)}</div><div class="it-sub">${esc(c.area || '')}${c.area ? ' · ' : ''}claimed ${esc(ago(c.at))}</div></div><span class="st info">${esc(c.role || '')}</span></div>
          <dl class="adm-kv"><dt>Business</dt><dd>${esc(b.name || c.biz || '')}</dd>
            ${b.contact ? `<dt>Contact</dt><dd>${esc(b.contact)}</dd>` : ''}
            ${b.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>` : ''}
            ${b.email ? `<dt>Email</dt><dd><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>` : ''}
            ${b.gst ? `<dt>GSTIN</dt><dd>${esc(b.gst)}</dd>` : ''}</dl>
          ${c.note ? `<p class="adm-quote">${esc(c.note)}</p>` : ''}
          <label class="field"><span>Note to the business (optional)</span><input name="note" maxlength="160"></label>
          <div class="adm-actions"><button class="btn good" type="button" data-act="claim-approve">${ic('check')} Approve</button><button class="btn danger" type="button" data-act="claim-reject">${ic('x')} Reject</button></div>
        </article>`;
      }).join('')}</div>` : empty('No claims waiting for review.')}
      <section class="card" style="margin-top:18px">
        <h3 style="margin:0 0 4px">Remove an operator</h3>
        <p class="c-sub" style="margin:0 0 10px">Use this when a claim was wrong or a contract ended. The business loses access to that washroom’s reports and services; paid services stay on the washroom until they expire.</p>
        <form class="row" id="ownerForm" onsubmit="return false" style="align-items:flex-end">
          <label class="field" style="flex:1;min-width:220px;margin:0"><span>Washroom ID</span><input name="wid" placeholder="OSM-N123… or SS-…" autocomplete="off" spellcheck="false" required></label>
          <button class="btn danger" type="submit">${ic('x')} Remove operator</button>
        </form>
        <p class="form-error" id="ownerErr" role="alert" hidden></p>
      </section>`;
  };

  function campaignHTML(a) {
    if (!a) return '';
    return `<div class="card soft" style="margin:0;padding:12px 14px">
      <div class="small muted">Ad content to review</div>
      <div style="font-weight:700;margin-top:2px">${esc(a.title)}</div>
      <div class="small">${esc(a.text)}</div>
      <dl class="adm-kv small" style="margin-top:8px"><dt>Category</dt><dd>${esc(a.cat)}</dd><dt>Shown within</dt><dd>${esc(a.r)} km of <a href="${gmaps(a.la, a.lo)}" target="_blank" rel="noopener">${esc(a.place || `${a.la}, ${a.lo}`)}</a></dd>
        ${a.url ? `<dt>Link</dt><dd><a href="${esc(a.url)}" target="_blank" rel="noopener nofollow">${esc(a.url)}</a></dd>` : ''}
        ${a.phone ? `<dt>Phone</dt><dd>${esc(a.phone)}</dd>` : ''}
        ${a.offer ? `<dt>Coin offer</dt><dd>${esc(a.offer.title)} · ${nf(a.offer.cost)} coins · ${nf(a.offer.stock)} available</dd>` : ''}</dl>
    </div>`;
  }

  RENDER.orders = (j) => {
    const list = (j.orders || []).filter((o) => A.showAll || o.st !== 'inspection');
    return `${title('Orders & payments', 'Check each UPI reference (UTR) against your bank or UPI app before confirming. Confirming switches the service on straight away; for ads, confirming also approves the ad content shown below.')}
      <div class="adm-toolbar"><label class="adm-check"><input type="checkbox" id="showAll"${A.showAll ? ' checked' : ''}> Show all recent orders (not only open ones)</label></div>
      ${list.length ? `<div class="adm-list">${list.map((o) => {
        const b = o.business || {};
        const open = o.st === 'awaiting_payment' || o.st === 'payment_submitted';
        const isWash = o.kind === 'featured' || o.kind === 'analytics' || o.kind === 'verify';
        return `<article class="adm-item" data-id="${esc(o.id)}">
          <div class="it-head"><div><div class="it-title">${esc(o.label || o.kind)} · ${rupees(o.amount)}</div>
            <div class="it-sub">${isWash ? washLink(o.target, o.tname) : esc(o.tname || '')} · ordered ${esc(ago(o.at))} · #${esc(o.id)}</div></div>${pill(ORDER_ST, o.st)}</div>
          <dl class="adm-kv"><dt>Business</dt><dd>${esc(b.name || o.biz || '')}${b.contact ? ` · ${esc(b.contact)}` : ''}</dd>
            ${b.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>` : ''}
            ${b.email ? `<dt>Email</dt><dd><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>` : ''}
            ${o.utr ? `<dt>UPI reference</dt><dd><strong>${esc(o.utr)}</strong></dd>` : ''}
            ${o.paidAt ? `<dt>Confirmed</dt><dd>${esc(fmtDateTime(Number(o.paidAt)))}</dd>` : ''}
            ${o.until ? `<dt>Runs until</dt><dd>${esc(fmtDate(Number(o.until)))}</dd>` : ''}
            ${o.result ? `<dt>Inspection</dt><dd>${esc(o.result)}</dd>` : ''}
            ${o.note ? `<dt>Note</dt><dd>${esc(o.note)}</dd>` : ''}</dl>
          ${o.campaign ? campaignHTML(o.campaign) : ''}
          ${open ? `${o.st === 'awaiting_payment' ? `<p class="small muted" style="margin:0">No UPI reference yet — confirm only if you received the money another way.</p>` : ''}
            <label class="field"><span>Reason (needed to reject)</span><input name="reason" maxlength="200" placeholder="e.g. No payment found for this UTR"></label>
            <div class="adm-actions"><button class="btn good" type="button" data-act="order-paid">${ic('check')} Confirm payment</button><button class="btn danger" type="button" data-act="order-reject">${ic('x')} Reject</button></div>`
          : o.st === 'inspection' ? `<div class="adm-actions"><button class="btn" type="button" data-go="inspections">Record the inspection</button></div>` : ''}
        </article>`;
      }).join('')}</div>` : empty(A.showAll ? 'No orders yet.' : 'No open orders. Nothing to confirm.')}`;
  };

  RENDER.inspections = (j) => {
    const list = (j.orders || []).filter((o) => o.st === 'inspection');
    return `${title('Inspections', 'Paid verification visits. Record what the inspector found. Passing gives the washroom a “Verified by Swachh Scan” badge for 6 months.')}
      ${list.length ? `<div class="adm-list">${list.map((o) => {
        const b = o.business || {};
        return `<article class="adm-item" data-id="${esc(o.id)}">
          <div class="it-head"><div><div class="it-title">${washLink(o.target, o.tname)}</div><div class="it-sub">${esc(b.name || o.biz || '')} · paid ${o.paidAt ? esc(ago(Number(o.paidAt))) : ''}${b.phone ? ` · <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}</div></div>${pill(ORDER_ST, o.st)}</div>
          <fieldset style="border:0;padding:0;margin:0"><legend class="small muted" style="margin-bottom:6px">Checklist (tick what passed)</legend>
            <div class="checkgrid">${CHECKS.map(([k, l]) => `<label><input type="checkbox" name="${k}"> ${esc(l)}</label>`).join('')}</div></fieldset>
          <label class="field"><span>Inspector notes</span><textarea name="note" maxlength="300" placeholder="Date and time of visit, what was checked, anything to fix"></textarea></label>
          <div class="adm-actions"><button class="btn good" type="button" data-act="verify-pass">${ic('badge')} Passed — verify</button><button class="btn danger" type="button" data-act="verify-fail">Not passed</button></div>
        </article>`;
      }).join('')}</div>` : empty('No inspections due.')}`;
  };

  RENDER.ads = (j) => {
    const list = j.ads || [];
    const now = Date.now();
    return `${title('Ads', 'Every nearby-ad campaign. Campaigns go live when you confirm their payment in Orders & payments.')}
      ${list.length ? `<div class="adm-list">${list.map((a) => {
        const st = a.st === 'live' && a.end && now >= a.end ? 'ended' : a.st;
        return `<article class="adm-item" data-id="${esc(a.id)}">
          <div class="it-head"><div><div class="it-title">${esc(a.title)}</div><div class="it-sub">${esc(a.biz)} · ${esc(a.cat)} · within ${esc(a.r)} km${a.place ? ` of ${esc(a.place)}` : ''}</div></div>${pill(AD_ST, st)}</div>
          <div class="small">${esc(a.text)}</div>
          <div class="small muted">${a.start ? `Runs ${esc(fmtDate(a.start))} – ${esc(fmtDate(a.end))}` : `Created ${esc(ago(a.at))} · not started`}${a.offer ? ` · Offer: ${esc(a.offer.title)} (${nf(a.offer.cost)} coins)` : ''}${a.note ? ` · ${esc(a.note)}` : ''}</div>
          ${st === 'live' ? `<div class="adm-actions"><button class="btn sm" type="button" data-act="ad-paused">Pause</button><button class="btn sm danger" type="button" data-act="ad-ended">End now</button></div>`
          : st === 'paused' ? `<div class="adm-actions"><button class="btn sm" type="button" data-act="ad-live">Resume</button><button class="btn sm danger" type="button" data-act="ad-ended">End now</button></div>`
          : st === 'awaiting_payment' ? `<div class="adm-actions"><button class="btn sm" type="button" data-go="orders">Review in Orders &amp; payments</button></div>` : ''}
        </article>`;
      }).join('')}</div>` : empty('No ad campaigns yet.')}`;
  };

  RENDER.reports = (j) => {
    const list = j.reports || [];
    return `${title('Hygiene reports', 'Open reports from people using the washrooms. Resolving one gives the scout who sent it a bonus. Municipal officers see the same reports for their area on the Civic dashboard.')}
      <div class="adm-toolbar"><label class="field"><span>Acting as (shown publicly on resolved reports)</span><input id="actor" maxlength="60" value="${esc(A.actor)}" placeholder="Swachh Scan team"></label></div>
      ${list.length ? `<div class="adm-list">${list.map((r) => `<article class="adm-item" data-id="${esc(r.id)}" data-w="${esc(r.w)}">
          <div class="it-head"><div><div class="it-title">${washLink(r.w, r.n)}</div><div class="it-sub">${esc(areaOf(r))}${areaOf(r) ? ' · ' : ''}reported ${esc(ago(r.at))}${r.scout ? ' by a scout' : ''}</div></div>${r.status === 'ack' ? '<span class="st info">Acknowledged</span>' : '<span class="st warn">Open</span>'}</div>
          <div class="adm-tags">${r.issues.map((i) => `<span class="tag issue">${esc(ISSUES[i] || i)}</span>`).join('')}</div>
          ${r.note ? `<p class="adm-quote">${esc(r.note)}</p>` : ''}
          ${r.response ? `<div class="small muted">Response by ${esc(r.by)}: ${esc(r.response)}</div>` : ''}
          <label class="field"><span>Response (optional, shown to the public)</span><input name="note" maxlength="200" placeholder="e.g. Cleaned and water restored"></label>
          <div class="adm-actions">
            ${r.status === 'open' ? `<button class="btn sm" type="button" data-act="rep-ack">Acknowledge</button>` : ''}
            <button class="btn sm good" type="button" data-act="rep-resolved">${ic('check', 'sm')} Resolved</button>
            <button class="btn sm danger" type="button" data-act="rep-rejected">Reject as invalid</button>
            <button class="btn sm" type="button" data-act="rep-cleaned">${ic('broom', 'sm')} Mark washroom cleaned</button>
          </div>
        </article>`).join('')}</div>` : empty('No open reports.')}`;
  };

  function rewardForm(r) {
    r = r || { icon: '🎁', mode: 'gen', limitDays: 7, order: 0, active: true };
    const isNew = !r.id;
    return `<form class="card form" id="rewardForm" novalidate>
      <h2>${isNew ? 'New reward' : `Edit “${esc(r.title)}”`}</h2>
      <div class="adm-fields">
        <label class="field"><span>Icon (emoji)</span><input name="icon" value="${esc(r.icon || '🎁')}" maxlength="8"></label>
        <label class="field req"><span>Title</span><input name="title" value="${esc(r.title || '')}" maxlength="80" required placeholder="₹50 off at Café Coffee"></label>
        <label class="field"><span>Partner</span><input name="partner" value="${esc(r.partner || '')}" maxlength="60"></label>
        <label class="field req"><span>Cost (coins)</span><input name="cost" type="number" min="10" max="100000" step="1" value="${esc(r.cost || '')}" required></label>
        <label class="field"><span>Codes</span><select name="mode"><option value="gen"${r.mode !== 'pool' ? ' selected' : ''}>We generate codes (add stock)</option><option value="pool"${r.mode === 'pool' ? ' selected' : ''}>Partner codes (paste a list)</option></select></label>
        <label class="field"><span>Once per scout every … days</span><input name="limitDays" type="number" min="0" max="365" step="1" value="${esc(r.limitDays != null ? r.limitDays : 7)}"></label>
        <label class="field"><span>Order in the list</span><input name="order" type="number" min="-1000" max="1000" step="1" value="${esc(r.order || 0)}"></label>
        <label class="field"><span>Ask scouts for</span><select name="needs" aria-describedby="needsHelp">${Object.entries(NEEDS).map(([v, l]) => `<option value="${v}"${(r.needs || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="hint" id="needsHelp">For rewards you deliver: a mobile recharge needs a phone number, a T-shirt an address. It shows in the voucher lookup and is deleted once the voucher is marked used.</span></label>
      </div>
      <label class="field"><span>Terms shown to scouts</span><textarea name="terms" maxlength="200">${esc(r.terms || '')}</textarea></label>
      <label class="adm-check"><input type="checkbox" name="active"${r.active !== false ? ' checked' : ''}> Active (shown in the catalogue)</label>
      <p class="form-error" id="rewardErr" role="alert" hidden></p>
      <div class="adm-actions"><button class="btn primary" type="submit">${ic('check')} ${isNew ? 'Create reward' : 'Save changes'}</button><button class="btn" type="button" data-act="reward-cancel">Cancel</button></div>
    </form>`;
  }

  RENDER.rewards = (j) => {
    const list = j.rewards || [];
    return `${title('Rewards', 'What scouts can spend Swachh Coins on. A reward shows as “coming soon” until it has stock (generated codes) or partner codes. Rewards you deliver can ask the scout for a phone number or address when they redeem. Business offers come from paid ad campaigns.')}
      ${A.editReward ? rewardForm(A.editReward === 'new' ? null : A.editReward) : `<div class="adm-toolbar"><button class="btn primary" type="button" data-act="reward-new">${ic('plus')} New reward</button></div>`}
      ${list.length ? `<div class="tbl-wrap"><table class="data"><thead><tr><th scope="col">Reward</th><th scope="col" class="num">Cost</th><th scope="col">Codes</th><th scope="col">Asks for</th><th scope="col" class="num">Left</th><th scope="col" class="num">Redeemed</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>
        ${list.map((r) => `<tr data-id="${esc(r.id)}">
          <td><span aria-hidden="true">${esc(r.icon || '🎁')}</span> <strong>${esc(r.title)}</strong>${r.partner ? `<br><span class="muted">${esc(r.partner)}</span>` : ''}${r.sample ? ' <span class="st">Sample</span>' : ''}${r.aid ? ' <span class="st info">Business offer</span>' : ''}</td>
          <td class="num">${nf(r.cost)}</td>
          <td>${r.aid ? 'Business offer' : r.mode === 'pool' ? 'Partner codes' : 'Generated'}</td>
          <td>${r.needs ? esc(NEEDS[r.needs] || r.needs) : '<span class="muted">—</span>'}</td>
          <td class="num">${nf(r.mode === 'pool' ? r.pool : r.stock)}</td>
          <td class="num">${nf(r.redeemed || 0)}</td>
          <td>${r.active ? '<span class="st good">Active</span>' : '<span class="st">Off</span>'}</td>
          <td class="acts">${r.aid
            ? `<button class="btn sm" type="button" data-act="reward-toggle">${r.active ? 'Switch off' : 'Switch on'}</button>`
            : `<button class="btn sm" type="button" data-act="reward-edit">Edit</button>${r.mode === 'pool' ? `<button class="btn sm" type="button" data-act="reward-codes">Add codes</button>` : `<button class="btn sm" type="button" data-act="reward-stock">Add stock</button>`}<button class="btn sm danger" type="button" data-act="reward-delete">Delete</button>`}</td>
        </tr>`).join('')}</tbody></table></div>` : empty('No rewards yet.')}`;
  };

  RENDER.keys = (j) => {
    const list = j.keys || [];
    const scope = (s) => { s = s || {}; const parts = [...(s.states || []).map((x) => `State: ${x}`), ...(s.districts || []).map((x) => `District: ${x}`), ...(s.cities || []).map((x) => `City: ${x}`)]; return parts.length ? parts.join(' · ') : 'All of India'; };
    return `${title('Officer keys', 'Access keys for municipal officers on the Civic dashboard. A key can be limited to states, districts or cities; officers then see and resolve only reports in their area, and their confirmations pay the reporter’s bonus.')}
      <form class="card form" id="keyForm" novalidate>
        <h2>Create a key</h2>
        <div class="adm-fields two">
          <label class="field req"><span>Name (shown on resolved reports)</span><input name="name" maxlength="80" required placeholder="Pune Municipal Corporation"></label>
          <label class="field"><span>Department</span><input name="dept" maxlength="80" placeholder="Solid Waste Management"></label>
        </div>
        <div class="adm-fields">
          <label class="field"><span>States / UTs</span><textarea name="states" rows="2" placeholder="Maharashtra"></textarea></label>
          <label class="field"><span>Districts</span><textarea name="districts" rows="2" placeholder="Pune&#10;Bilaspur, Chhattisgarh"></textarea></label>
          <label class="field"><span>Cities</span><textarea name="cities" rows="2" placeholder="Pimpri-Chinchwad"></textarea></label>
          <p class="hint small muted" style="grid-column:1/-1;margin:0">One per line. Leave all three empty for all of India. Some district and city names exist in two states (e.g. Bilaspur): add the state after a comma.</p>
        </div>
        <p class="small muted" style="margin:0">Names must match the map’s state, district or city names.</p>
        <p class="form-error" id="keyErr" role="alert" hidden></p>
        <div><button class="btn primary" type="submit">${ic('lock')} Create key</button></div>
        ${A.newKey ? `<div class="keybox" id="newKeyBox"><div class="notice-box warn">${ic('alert')}<p><strong>Copy this key now and send it to ${esc(A.newKey.name)} privately.</strong> It is shown only once; if it’s lost, revoke it and create a new one.</p></div><code id="newKeyCode">${esc(A.newKey.key)}</code><div><button class="btn" type="button" data-act="key-copy">${ic('copy')} Copy key</button> <button class="btn ghost" type="button" data-act="key-hide">I’ve saved it</button></div></div>` : ''}
      </form>
      <h3 class="eyebrow">${ic('landmark')} Active keys</h3>
      ${list.length ? `<div class="tbl-wrap"><table class="data"><thead><tr><th scope="col">Officer</th><th scope="col">Area</th><th scope="col">Created</th><th scope="col">Key ID</th><th scope="col">Actions</th></tr></thead><tbody>
        ${list.map((k) => `<tr data-hash="${esc(k.hash)}"><td><strong>${esc(k.name)}</strong>${k.dept ? `<br><span class="muted">${esc(k.dept)}</span>` : ''}</td><td>${esc(scope(k.scope))}</td><td>${k.at ? esc(fmtDate(k.at)) : ''}</td><td><code>${esc(k.hint)}</code></td><td class="acts"><button class="btn sm danger" type="button" data-act="key-revoke">Revoke</button></td></tr>`).join('')}
      </tbody></table></div>` : empty('No officer keys yet.')}`;
  };

  RENDER.scouts = (j) => {
    const list = j.users || [];
    return `${title('Scouts', 'Search by name, 6-letter invite code or user ID. Without a search you see the top earners and the newest scouts.')}
      <form class="adm-toolbar" id="userSearch" role="search"><label class="field"><span>Search scouts</span><input type="search" name="q" value="${esc(A.userQ)}" placeholder="Name, invite code or user ID"></label><button class="btn primary" type="submit">${ic('search')} Search</button>${A.userQ ? `<button class="btn" type="button" data-act="user-clear">Clear</button>` : ''}</form>
      ${list.length ? `<div class="tbl-wrap"><table class="data"><thead><tr><th scope="col">Scout</th><th scope="col">Invite code</th><th scope="col" class="num">Coins</th><th scope="col" class="num">Earned</th><th scope="col" class="num">Ratings</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Washrooms</th><th scope="col" class="num">Invites</th><th scope="col">Joined</th><th scope="col">Actions</th></tr></thead><tbody>
        ${list.map((u) => `<tr data-uid="${esc(u.uid)}" data-name="${esc(u.name)}"><td><strong>${esc(u.name)}</strong>${u.banned ? ' <span class="st bad">Banned</span>' : ''}<br><code class="muted small">${esc(u.uid)}</code></td><td><code>${esc(u.ref || '')}</code></td><td class="num">${nf(u.coins)}</td><td class="num">${nf(u.earned)}</td><td class="num">${nf(u.rated)}</td><td class="num">${nf(u.reports)}</td><td class="num">${nf(u.places)}</td><td class="num">${nf(u.refs)}</td><td>${u.created ? esc(fmtDate(u.created)) : ''}</td>
          <td class="acts"><button class="btn sm${u.banned ? '' : ' danger'}" type="button" data-act="${u.banned ? 'user-unban' : 'user-ban'}">${u.banned ? 'Unban' : 'Ban'}</button><button class="btn sm" type="button" data-act="user-adjust">Adjust coins</button><button class="btn sm" type="button" data-act="user-rename">Rename</button></td></tr>`).join('')}
      </tbody></table></div>` : empty(A.userQ ? 'No scouts match.' : 'No scouts yet.')}`;
  };

  RENDER.voucher = () => {
    const v = A.voucher;
    // rewards that are delivered (recharge, T-shirt) carry the scout's phone number or address until marked used
    const isPhone = !!(v && v.contact && /^(\+91\d{10}|1800\d{6,7})$/.test(v.contact));
    const contact = v && v.contact
      ? (isPhone ? `<dt>Phone</dt><dd><a href="tel:${esc(v.contact)}"><strong>${esc(v.contact.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2'))}</strong></a></dd>` : `<dt>Deliver to</dt><dd style="white-space:pre-wrap"><strong>${esc(v.contact)}</strong></dd>`)
      : '';
    return `${title('Voucher lookup', 'Check a voucher code a scout shows you (they look like SS-ABCD-2345) and mark it used.')}
      <form class="adm-toolbar" id="voucherForm"><label class="field"><span>Voucher code</span><input name="code" value="${esc(v && v.code ? v.code : '')}" placeholder="SS-ABCD-2345" autocapitalize="characters" spellcheck="false"></label><button class="btn primary" type="submit">${ic('search')} Look up</button></form>
      ${v && v.error ? `<div class="notice-box warn" role="alert">${ic('alert')}<p>${esc(v.error)}</p></div>` : ''}
      ${v && v.rw ? `<article class="adm-item" id="voucherResult" tabindex="-1"><div class="it-head"><div><div class="it-title">${esc(v.title || '')}</div><div class="it-sub">${esc(v.partner || '')}</div></div>${v.st === 'used' ? '<span class="st">Used</span>' : '<span class="st good">Valid</span>'}</div>
        <dl class="adm-kv"><dt>Code</dt><dd><strong>${esc(v.code)}</strong></dd>${v.pc ? `<dt>Partner code</dt><dd>${esc(v.pc)}</dd>` : ''}<dt>Scout</dt><dd>${esc(v.scout || '')}</dd><dt>Issued</dt><dd>${v.ts ? esc(fmtDateTime(v.ts)) : ''}</dd>${v.cost ? `<dt>Cost</dt><dd>${nf(Number(v.cost))} coins</dd>` : ''}${v.usedAt ? `<dt>Used</dt><dd>${esc(fmtDateTime(v.usedAt))}</dd>` : ''}${contact}</dl>
        ${v.contact && v.st !== 'used' ? `<p class="small muted" style="margin:0">${ic('lock', 'sm')} The ${isPhone ? 'phone number' : 'address'} is deleted from Swachh Scan once you mark this voucher used. Copy it first if you still need it for delivery.</p>` : ''}
        ${v.st !== 'used' ? `<div class="adm-actions"><button class="btn good" type="button" data-act="voucher-use">${ic('check')} Mark as used</button></div>` : ''}</article>` : ''}`;
  };

  // ------------------------------------------------------------------ small form dialog (amounts, codes, names)
  function ask(opts) {
    return new Promise((resolve) => {
      const d = $('#askDialog');
      $('#askTitle').textContent = opts.title;
      const p = $('#askText');
      p.hidden = !opts.text;
      p.textContent = opts.text || '';
      const f = $('#askForm');
      f.innerHTML = opts.fields.map((x) => `<label class="field${x.required ? ' req' : ''}"><span>${esc(x.label)}</span>${x.type === 'textarea'
        ? `<textarea name="${x.name}" rows="6" maxlength="${x.max || 20000}"${x.required ? ' required' : ''} placeholder="${esc(x.placeholder || '')}">${esc(x.value || '')}</textarea>`
        : `<input name="${x.name}" type="${x.type || 'text'}" value="${esc(x.value == null ? '' : x.value)}"${x.min != null ? ` min="${x.min}"` : ''}${x.max != null && x.type === 'number' ? ` max="${x.max}"` : ''}${x.type === 'number' ? ' step="1"' : ` maxlength="${x.max || 200}"`}${x.required ? ' required' : ''} placeholder="${esc(x.placeholder || '')}">`}${x.hint ? `<span class="hint">${esc(x.hint)}</span>` : ''}</label>`).join('')
        + `<p class="form-error" role="alert" hidden></p><div class="dlg-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${esc(opts.ok || 'Save')}</button></div>`;
      let done = false;
      const finish = (v) => { if (done) return; done = true; f.onsubmit = null; d.removeEventListener('close', onClose); resolve(v); };
      const onClose = () => finish(null);
      d.addEventListener('close', onClose);
      f.onsubmit = (e) => {
        e.preventDefault();
        const out = {};
        for (const x of opts.fields) {
          const el = f.elements[x.name];
          const v = el.value.trim();
          if (x.required && !v) { const er = f.querySelector('.form-error'); er.hidden = false; er.textContent = `${x.label} is required.`; el.focus(); return; }
          out[x.name] = x.type === 'number' ? Number(v) : v;
        }
        finish(out);
        d.close();
      };
      openDialog(d);
    });
  }

  // ------------------------------------------------------------------ actions
  const panel = $('#panel');
  panel.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { switchTab(go.dataset.go, true); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'tab-retry') { b.disabled = true; b.textContent = 'Trying again…'; await refreshCounts(); await loadTab(A.tab, true); return; }
    const item = b.closest('[data-id]');
    const id = item ? item.dataset.id : '';
    const val = (name) => { const el = item && item.querySelector(`[name="${name}"]`); return el ? el.value.trim() : ''; };

    if (act === 'place-approve') {
      await post({ action: 'place', id, decision: 'approve', edits: { n: val('n'), city: val('city'), d: val('d') } }, b, 'Approved. It’s on the map and the scout got their coins.');
    } else if (act === 'place-reject') {
      if (!confirm('Reject this washroom suggestion?')) return;
      await post({ action: 'place', id, decision: 'reject', note: val('note') }, b, 'Rejected.');
    } else if (act === 'claim-approve') {
      await post({ action: 'claim', id, decision: 'approve', note: val('note') }, b, 'Claim approved.');
    } else if (act === 'claim-reject') {
      if (!confirm('Reject this claim?')) return;
      await post({ action: 'claim', id, decision: 'reject', note: val('note') }, b, 'Claim rejected.');
    } else if (act === 'order-paid') {
      const o = ((A.data.orders || {}).orders || []).find((x) => x.id === id) || {};
      if (!confirm(o.kind === 'verify' ? 'Confirm you received this payment? The washroom then waits for its inspection.' : 'Confirm you received this payment? The service starts now.')) return;
      await post({ action: 'order-paid', id }, b, o.kind === 'verify' ? 'Payment confirmed. Record the inspection in Inspections after the visit.' : o.kind && o.kind.startsWith('ad') ? 'Payment confirmed. The ad is live.' : 'Payment confirmed. The service is on.');
    } else if (act === 'order-reject') {
      const note = val('reason');
      if (!note) { toast('Write a reason first — the business sees it.'); const el = item.querySelector('[name="reason"]'); if (el) el.focus(); return; }
      if (!confirm('Reject this order?')) return;
      await post({ action: 'order-reject', id, note }, b, 'Order rejected.');
    } else if (act === 'verify-pass' || act === 'verify-fail') {
      const checks = {};
      CHECKS.forEach(([k]) => { const el = item.querySelector(`[name="${k}"]`); checks[k] = !!(el && el.checked); });
      const pass = act === 'verify-pass';
      if (pass && !Object.values(checks).some(Boolean) && !confirm('No checks are ticked. Verify anyway?')) return;
      if (!pass && !confirm('Record this inspection as not passed?')) return;
      await post({ action: 'verify-result', id, pass, checks, note: val('note') }, b, pass ? 'Verified. The badge is live.' : 'Recorded as not passed.');
    } else if (act.startsWith('ad-')) {
      const state = act.slice(3);
      if (state === 'ended' && !confirm('End this campaign now? It can’t be restarted.')) return;
      await post({ action: 'ad-state', id, state }, b, { paused: 'Campaign paused.', live: 'Campaign resumed.', ended: 'Campaign ended.' }[state]);
    } else if (act.startsWith('rep-')) {
      const w = item.dataset.w;
      const by = A.actor || 'Swachh Scan team';
      const note = val('note');
      if (act === 'rep-ack') await post({ action: 'report', id, status: 'ack', note, by }, b, 'Acknowledged.');
      const rep = ((A.data.reports || {}).reports || []).find((x) => x.id === id) || {};
      if (act === 'rep-resolved') await post({ action: 'report', id, status: 'resolved', note, by }, b, rep.scout ? 'Resolved. The scout who reported it got a bonus.' : 'Resolved.');
      if (act === 'rep-rejected') { if (!confirm('Reject this report as invalid?')) return; await post({ action: 'report', id, status: 'rejected', note, by }, b, 'Rejected.'); }
      if (act === 'rep-cleaned') { if (!confirm('Mark this washroom cleaned? Every open report for it will be resolved.')) return; const r = await post({ action: 'cleaned', id: w, note, by }, b, null); if (r) toast(`Marked cleaned. ${nf(r.resolved || 0)} report${r.resolved === 1 ? '' : 's'} resolved.`); }
    } else if (act === 'reward-new') {
      A.editReward = 'new'; rerender(); const f = $('#rewardForm [name="title"]'); if (f) f.focus();
    } else if (act === 'reward-cancel') {
      const was = A.editReward && A.editReward !== 'new' ? A.editReward.id : '';
      A.editReward = null; rerender();
      restoreFocus([was && `[data-id="${CSS.escape(was)}"] [data-act="reward-edit"]`, '[data-act="reward-new"]']);
    } else if (act === 'reward-edit') {
      const r = (A.data.rewards.rewards || []).find((x) => x.id === id);
      A.editReward = r || null; rerender(); const f = $('#rewardForm [name="title"]'); if (f) f.focus();
    } else if (act === 'reward-toggle') {
      const r = (A.data.rewards.rewards || []).find((x) => x.id === id);
      await post({ action: 'reward-save', reward: { id, active: !r.active } }, b, r.active ? 'Switched off.' : 'Switched on.');
    } else if (act === 'reward-stock') {
      const v = await ask({ title: 'Add stock', text: 'How many more of this reward can scouts redeem? Use a negative number to remove stock.', ok: 'Add stock', fields: [{ name: 'add', label: 'Number to add', type: 'number', min: -100000, max: 100000, required: true, value: 10 }] });
      if (v) await post({ action: 'reward-stock', id, add: Math.round(v.add) }, null, 'Stock updated.', b);
    } else if (act === 'reward-codes') {
      const v = await ask({ title: 'Add partner codes', text: 'Paste the codes from your partner, one per line (up to 1,000). Each scout who redeems gets one.', ok: 'Add codes', fields: [{ name: 'codes', label: 'Codes', type: 'textarea', required: true, placeholder: 'MOVIE-2Q8F\nMOVIE-7KD1' }] });
      if (v) {
        const codes = v.codes.split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean);
        const r = await post({ action: 'reward-codes', id, codes }, null, null, b);
        if (r) toast(`Added ${nf(r.added)} codes. ${nf(r.pool)} available.`);
      }
    } else if (act === 'reward-delete') {
      if (!confirm('Delete this reward? Vouchers already issued stay valid.')) return;
      await post({ action: 'reward-delete', id }, b, 'Reward deleted.');
    } else if (act === 'key-copy') {
      try { await navigator.clipboard.writeText(A.newKey.key); toast('Key copied.'); } catch (err) { toast('Select the key and copy it.'); }
    } else if (act === 'key-hide') {
      A.newKey = null; rerender();
      restoreFocus(['#keyForm [name="name"]']);
    } else if (act === 'key-revoke') {
      const row = b.closest('[data-hash]');
      if (!confirm('Revoke this key? The officer loses access immediately.')) return;
      await post({ action: 'key-revoke', hash: row.dataset.hash }, b, 'Key revoked.');
    } else if (act === 'user-clear') {
      A.userQ = ''; await loadTab('scouts', false);
      restoreFocus(['#userSearch [name="q"]']);
    } else if (act.startsWith('user-')) {
      const row = b.closest('[data-uid]');
      const uid = row.dataset.uid, name = row.dataset.name;
      if (act === 'user-ban') { if (!confirm(`Ban ${name}? They are hidden from the leaderboards and can’t earn or redeem coins. Unbanning restores their place.`)) return; await post({ action: 'user-ban', uid, banned: true }, b, 'Scout banned.'); }
      if (act === 'user-unban') await post({ action: 'user-ban', uid, banned: false }, b, 'Scout unbanned.');
      if (act === 'user-adjust') {
        const v = await ask({ title: `Adjust coins for ${name}`, text: 'Positive numbers add coins (they count towards tier and leaderboards). Negative numbers only reduce the balance.', ok: 'Adjust', fields: [{ name: 'amount', label: 'Coins', type: 'number', min: -100000, max: 100000, required: true }, { name: 'reason', label: 'Reason (the scout sees it)', required: true, max: 120 }] });
        if (v) { if (!Number.isFinite(v.amount) || !v.amount) { toast('Enter a number of coins.'); return; } await post({ action: 'user-adjust', uid, amount: Math.round(v.amount), reason: v.reason }, null, 'Coins adjusted.', b); }
      }
      if (act === 'user-rename') {
        const v = await ask({ title: `Rename ${name}`, ok: 'Rename', fields: [{ name: 'name', label: 'New display name', required: true, max: 24, value: name }] });
        if (v) await post({ action: 'user-rename', uid, name: v.name }, null, 'Renamed.', b);
      }
    } else if (act === 'voucher-use') {
      if (!confirm('Mark this voucher as used?')) return;
      const r = await post({ action: 'voucher-use', code: A.voucher.code }, b, 'Marked as used.');
      if (r) { await lookupVoucher(A.voucher.code, true); }
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.id === 'showAll') { A.showAll = e.target.checked; loadTab('orders', false); }
  });
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'actor') { A.actor = e.target.value.trim(); try { sessionStorage.setItem('ss.admin.actor', A.actor); } catch (err) { /* ignore */ } }
  });

  panel.addEventListener('submit', async (e) => {
    const f = e.target;
    e.preventDefault();
    if (f.id === 'rewardForm') {
      const v = (n) => f.elements[n].value.trim();
      const err = $('#rewardErr');
      if (!v('title') || !v('cost')) { err.hidden = false; err.textContent = 'Title and cost are required.'; f.elements[v('title') ? 'cost' : 'title'].focus(); return; }
      const reward = { icon: v('icon'), title: v('title'), partner: v('partner'), cost: Number(v('cost')), mode: v('mode'), limitDays: Number(v('limitDays') || 0), terms: v('terms'), needs: v('needs'), order: Number(v('order') || 0), active: f.elements.active.checked };
      if (A.editReward && A.editReward !== 'new') reward.id = A.editReward.id;
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true;
      const r = await api('/api/admin', { token: PW, body: { action: 'reward-save', reward } });
      btn.disabled = false;
      if (!r.ok) {
        if (r.status === 401) { signOut('Your admin session ended. Sign in again.'); return; }
        err.hidden = false; err.textContent = r.j.error || 'Couldn’t save.'; btn.focus(); return;
      }
      A.editReward = null;
      toast(reward.id ? 'Reward saved.' : 'Reward created. Add stock or codes so scouts can redeem it.');
      await loadTab('rewards', false);
      restoreFocus([`[data-id="${CSS.escape(r.j.id || reward.id || '')}"] [data-act]`, '[data-act="reward-new"]']);
    } else if (f.id === 'ownerForm') {
      const wid = f.elements.wid.value.trim();
      const err = $('#ownerErr');
      err.hidden = true;
      if (!wid || !confirm(`Remove the operator of ${wid}?`)) return;
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true;
      const r = await api('/api/admin', { token: PW, body: { action: 'owner-remove', id: wid } });
      btn.disabled = false;
      if (!r.ok) { err.hidden = false; err.textContent = r.j.error || 'Couldn’t remove the operator.'; return; }
      toast('Operator removed.');
      f.reset();
    } else if (f.id === 'keyForm') {
      const v = (n) => f.elements[n].value.trim();
      const err = $('#keyErr');
      if (!v('name')) { err.hidden = false; err.textContent = 'Name is required.'; f.elements.name.focus(); return; }
      const list = (s) => s.split(/\n|;/).map((x) => x.trim()).filter(Boolean);
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true;
      const r = await api('/api/admin', { token: PW, body: { action: 'key-create', name: v('name'), dept: v('dept'), states: list(v('states')), districts: list(v('districts')), cities: list(v('cities')) } });
      btn.disabled = false;
      if (!r.ok) { err.hidden = false; err.textContent = r.j.error || 'Couldn’t create the key.'; return; }
      A.newKey = { key: r.j.key, name: r.j.officer.name };
      await refreshCounts();
      await loadTab('keys', false);
      const code = $('#newKeyCode'); if (code) { code.scrollIntoView({ block: 'center' }); const c = $('[data-act="key-copy"]'); if (c) c.focus(); }
    } else if (f.id === 'userSearch') {
      A.userQ = f.elements.q.value.trim();
      await loadTab('scouts', false);
      const q = $('#userSearch [name="q"]'); if (q) q.focus();
    } else if (f.id === 'voucherForm') {
      await lookupVoucher(f.elements.code.value);
    }
  });

  async function lookupVoucher(code, focusResult) {
    code = String(code || '').toUpperCase().replace(/\s/g, '');
    if (!code) { A.voucher = { error: 'Enter a code.' }; rerender(); const i = $('#voucherForm [name="code"]'); if (i) i.focus(); return; }
    const r = await get('voucher', `&code=${encodeURIComponent(code)}`);
    if (r.status === 401) { signOut('Your admin session ended. Sign in again.'); return; }
    A.voucher = r.ok ? r.j.voucher : { code, error: r.j.error || 'Not found.' };
    rerender();
    const res = focusResult && $('#voucherResult');
    if (res) res.focus(); else { const inp = $('#voucherForm [name="code"]'); if (inp) inp.focus(); }
  }

  function rerender() {
    const d = A.data[A.tab] || {};
    panel.innerHTML = RENDER[A.tab](d);
  }

  // ------------------------------------------------------------------ boot
  if (PW) trySignin(PW, false); else { showSignin(''); }
})();
