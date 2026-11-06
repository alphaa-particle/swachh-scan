/* Swachh Scan — For business: services & prices, business details, nearby ads, washroom claims and services,
   orders paid by UPI, and checking customers' offer codes. Talks to /api/business (see api/business.js). */
(function () {
  'use strict';
  const { esc, ic, nf, api, Account, toast, fmtDate, ago, qr, upiLink, loadScript } = window.SS;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

  // must match api/business.js and api/_lib/config.js
  const ROLES = ['Operator / contractor', 'Owner', 'Municipal staff', 'Facility manager'];
  const ISSUES = {
    dirty: 'Dirty', smell: 'Bad smell', no_water: 'No water', no_soap: 'No soap', no_light: 'No light',
    broken: 'Broken door, lock or fittings', clogged: 'Blocked or overflowing', unsafe: 'Felt unsafe',
    closed: 'Closed during opening hours', no_access: 'Not wheelchair accessible', overcharged: 'Charged more than listed',
    missing: 'Not here / wrong location', other: 'Something else',
  };
  const COIN_COSTS = [50, 100, 150, 200, 300, 500];
  const RADII = [[0.5, '500 m'], [1, '1 km'], [2, '2 km'], [5, '5 km']];
  // shown (without prices) when the server isn't connected
  const FALLBACK_PLANS = {
    featured: { label: 'Featured listing', days: 30, what: 'Featured badge, highlighted pin and the top slot in nearby results. Pauses automatically while a hygiene report is open.' },
    analytics: { label: 'Analytics', days: 30, what: 'Daily views, direction requests, calls, QR scans, ratings and reports for your washroom, with your rank in the district.' },
    verify: { label: 'Verification visit', days: 180, what: 'An inspector checks cleanliness, water, soap, lighting, locks and access. Passing earns a “Verified by Swachh Scan” badge for 6 months.' },
    ad7: { label: 'Nearby ad · 7 days', days: 7, what: 'A sponsored card shown to people looking for washrooms within your chosen radius.' },
    ad30: { label: 'Nearby ad · 30 days', days: 30, what: 'A sponsored card shown to people looking for washrooms within your chosen radius.' },
  };
  const ORDER_ST = {
    awaiting_payment: ['Awaiting payment', 'warn'], payment_submitted: ['Checking payment', 'info'], active: ['Active', 'good'],
    inspection: ['Inspection due', 'info'], completed: ['Completed', 'good'], rejected: ['Not approved', 'bad'], cancelled: ['Cancelled', ''],
  };
  const KIND_ICON = { ad7: 'megaphone', ad30: 'megaphone', featured: 'sparkle', verify: 'shield', analytics: 'chart' };
  const TABS = [
    { id: 'overview', label: 'Overview' }, { id: 'ads', label: 'Ads' }, { id: 'washrooms', label: 'My washrooms' },
    { id: 'orders', label: 'Orders' }, { id: 'codes', label: 'Offer codes' },
  ];

  const B = {
    enabled: true, noApi: false, plans: null, categories: ['Café', 'Restaurant', 'Pharmacy', 'Store', 'Fuel', 'Hotel', 'Service', 'Other'],
    // dashError: the dashboard couldn't be loaded for this device's profile (a temporary problem, not "no business yet")
    dash: null, dashError: null, plansError: null, tab: 'overview', started: false, editProfile: false, showLanding: false,
    claimId: null, claimPick: null, claimMissing: false, openOrder: null, adFormOpen: null,
    draft: { r: 1, plan: 'ad7', cat: '', offerOn: false, offerCost: 100, offerStock: 50 },
    adStats: {}, wrStats: {}, searchQ: '',
  };

  const rupees = (n) => `₹${nf(n)}`;
  const fmtPhone = (p) => { const m = /^\+91(\d{5})(\d{5})$/.exec(p || ''); return m ? `+91 ${m[1]} ${m[2]}` : p || ''; };
  const dayLabel = (k) => { const d = new Date(`${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}T00:00:00`); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
  const plan = (k) => (B.plans && B.plans[k]) || FALLBACK_PLANS[k];
  const priceOf = (k) => (B.plans && B.plans[k] ? rupees(B.plans[k].price) : '');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

  // ------------------------------------------------------------------ server calls
  async function loadPlans() {
    B.plansError = null;
    const r = await api('/api/business?action=plans', { auth: false });
    if (r.enabled === false) { B.enabled = false; B.noApi = !!r.noApi; }
    else if (r.ok) { B.plans = r.j.plans; if (r.j.categories) B.categories = r.j.categories; }
    else B.plansError = r.j.error || 'Couldn’t load the prices.';
  }

  async function loadDash() {
    B.dashError = null;
    if (!Account.has()) { B.dash = null; return; }
    const r = await api('/api/business?action=dash');
    if (r.ok) { B.dash = r.j; if (r.j.plans) B.plans = r.j.plans; if (r.j.categories) B.categories = r.j.categories; }
    else if (r.status === 401) B.dash = null;
    else if (r.enabled === false) { B.enabled = false; B.noApi = !!r.noApi; }
    // a temporary problem: keep what we had (never treat it as "no business yet") and offer a retry
    else B.dashError = r.j.error || 'Couldn’t load your dashboard.';
  }

  /** Load (or reload after an error) the prices and this device's dashboard, then draw the page. */
  async function reload() {
    if (!B.plans) await loadPlans();
    if (B.enabled) await loadDash();
    render();
  }

  /** POST an action; disables the button, shows the error next to it. */
  async function act(action, body, btn, errEl) {
    let label = '';
    if (btn) { label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Saving…'; }
    if (errEl) errEl.textContent = '';
    const r = await api('/api/business', { body: Object.assign({ action }, body) });
    if (btn && document.contains(btn)) { btn.disabled = false; btn.innerHTML = label; }
    if (!r.ok) {
      const msg = r.j.error || 'Something went wrong. Please try again.';
      if (errEl) errEl.textContent = msg; else toast(msg);
    }
    return r;
  }

  async function refresh(focusSel) {
    await loadDash();
    render();
    if (focusSel) { const el = $(focusSel) || $('#panel'); if (el) el.focus({ preventScroll: false }); }
  }

  function notice(msg, kind) {
    $('#notice').innerHTML = msg ? `<div class="notice-box${kind === 'warn' ? ' warn' : ''}" style="margin-top:14px"${kind === 'warn' ? ' role="alert"' : ''}>${ic(kind === 'warn' ? 'alert' : 'info')}<div><p>${msg}</p></div></div>` : '';
  }
  /** The page-level status line: not switched on here, or a temporary loading problem with a retry. Returns true if shown. */
  function statusNotice() {
    if (!B.enabled) {
      notice(B.noApi
        ? 'Business sign-up, ads and services need the site’s server functions, which aren’t running on this host (for example a static preview). They work on the deployed site.'
        : 'Business services switch on when the site’s database is connected (Upstash for Redis in Vercel). Prices and sign-up appear here then.', 'warn');
      return true;
    }
    const err = B.dashError || B.plansError;
    if (!err) return false;
    notice(`<b>${B.dashError ? 'Couldn’t load your business dashboard.' : 'Couldn’t load the prices.'}</b> ${esc(err)}</p><p style="margin-top:8px"><button class="btn sm" type="button" data-act="retry">${ic('refresh', 'sm')} Try again</button>`, 'warn');
    return true;
  }

  // ------------------------------------------------------------------ landing: services & prices
  function renderOffers() {
    const card = (icon, title, price, per, what, cta, tab) => `<div class="offer">
      <span class="o-ico">${ic(icon)}</span>
      <h3>${esc(title)}</h3>
      ${price ? `<div class="price">${price} <small>${esc(per)}</small></div>` : ''}
      <p>${esc(what)}</p>
      ${B.enabled ? `<button class="btn" type="button" data-start="${tab}">${esc(cta)}</button>` : ''}
    </div>`;
    const ad7 = plan('ad7'), ad30 = plan('ad30');
    $('#offers').innerHTML = [
      card('megaphone', 'Nearby ads', priceOf('ad7'), `/ ${ad7.days} days`, `${B.plans ? `Or ${priceOf('ad30')} for ${ad30.days} days. ` : ''}${ad7.what} Add an offer people unlock with Swachh Coins to bring them in.`, 'Create an ad', 'ads'),
      card('sparkle', plan('featured').label, priceOf('featured'), `/ ${plan('featured').days} days`, plan('featured').what, 'Feature my washroom', 'washrooms'),
      card('shield', plan('verify').label, priceOf('verify'), `· valid ${Math.round(plan('verify').days / 30)} months`, plan('verify').what, 'Book a visit', 'washrooms'),
      card('chart', plan('analytics').label, priceOf('analytics'), `/ ${plan('analytics').days} days`, plan('analytics').what, 'See my numbers', 'washrooms'),
    ].join('');
  }

  function renderCta() {
    const el = $('#cta');
    if (!B.enabled) { el.innerHTML = ''; return; }
    const hasBiz = B.dash && B.dash.profile;
    // couldn't check whether this device already has a business: don't invite it to sign up again
    if (!hasBiz && (B.started || (B.dashError && Account.has()))) { el.innerHTML = ''; return; }
    el.innerHTML = hasBiz
      ? `<button class="btn primary" type="button" data-act="hide-landing">${ic('back', 'sm')} Back to your dashboard</button>`
      : `<button class="btn primary" type="button" data-start="">${ic('store')} Get started — it’s free to sign up</button>
         <span class="small muted">You only pay for the services you choose.</span>`;
  }

  // ------------------------------------------------------------------ main render
  function render() {
    renderOffers();
    renderCta();
    const hasBiz = !!(B.dash && B.dash.profile);
    $('#landing').hidden = hasBiz && !B.showLanding;
    $('#hero').hidden = hasBiz && !B.showLanding; // returning businesses go straight to their dashboard
    const app = $('#app');
    const shown = statusNotice();
    if (!B.enabled) { app.innerHTML = ''; return; }
    if (!hasBiz) {
      // the server didn't say "no business profile" (it failed): never show the first-time sign-up form
      if (B.dashError && Account.has()) { app.innerHTML = ''; return; }
      if (B.claimId && !B.started) {
        if (!shown) notice(`To claim ${B.claimPick ? `<b>${esc(B.claimPick.n)}</b>${B.claimPick.area ? ` (${esc(B.claimPick.area)})` : ''}` : 'this washroom'}, first add your business details. It will be ready to claim right after.</p><p style="margin-top:8px"><button class="btn sm primary" type="button" data-start="washrooms">${ic('store', 'sm')} Get started</button>`);
      } else if (B.started && !shown) notice('');
      app.innerHTML = B.started ? profileFormHTML(null) : '';
      if (B.started) wireProfileForm();
      return;
    }
    if (B.showLanding) { app.innerHTML = ''; return; }
    if (!shown) notice('');
    const d = B.dash;
    const unpaid = d.orders.filter((o) => o.status === 'awaiting_payment').length;
    const openReps = d.washrooms.reduce((a, w) => a + w.reports.filter((r) => r.status === 'open' || r.status === 'ack').length, 0);
    const counts = { orders: unpaid, washrooms: openReps };
    app.innerHTML = `<div class="biz-head">
        <span class="avatar sm" aria-hidden="true">${esc(SS.initials(d.profile.name))}</span>
        <div class="grow"><p class="eyebrow">Business dashboard</p><h1 id="bizName" tabindex="-1">${esc(d.profile.name)}</h1><div class="sub">${esc(d.profile.contact)} · ${esc(d.profile.email)} · ${esc(fmtPhone(d.profile.phone))}</div></div>
        <button class="btn sm" type="button" data-act="edit-profile" aria-expanded="${B.editProfile}">${ic('edit', 'sm')} Business details</button>
        <button class="btn sm" type="button" data-act="show-landing">${ic('store', 'sm')} Services &amp; prices</button>
      </div>
      ${B.editProfile ? `<div class="card">${profileFormHTML(d.profile)}</div>` : ''}
      <div class="tabs" role="tablist" aria-label="Business dashboard">${TABS.map((t) => `<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel" aria-selected="${B.tab === t.id}" tabindex="${B.tab === t.id ? 0 : -1}" data-tab="${t.id}">${esc(t.label)}${counts[t.id] ? `<span class="n" aria-label="${counts[t.id]} need attention">${counts[t.id]}</span>` : ''}</button>`).join('')}</div>
      <section class="panel" id="panel" role="tabpanel" aria-labelledby="tab-${B.tab}" tabindex="-1"></section>`;
    if (B.editProfile) wireProfileForm();
    renderPanel();
  }

  function renderPanel() {
    const panel = $('#panel');
    if (!panel) return;
    if (B.pickMap) { B.pickMap.remove(); B.pickMap = null; }
    const fn = { overview: overviewHTML, ads: adsHTML, washrooms: washroomsHTML, orders: ordersHTML, codes: codesHTML }[B.tab] || overviewHTML;
    panel.innerHTML = fn();
    afterPanel();
  }

  function afterPanel() {
    if (B.tab === 'ads') { if ($('#campForm')) initCampaignForm(); loadAdStats(); }
    if (B.tab === 'orders') drawQRs();
    if (B.tab === 'washrooms') { initClaim(); loadWashroomStats(); }
    if (B.tab === 'codes') loadOfferCodes();
  }

  function setTab(id, focus) {
    if (!TABS.some((t) => t.id === id)) return;
    B.tab = id;
    history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
    $$('[role="tab"]').forEach((b) => { const on = b.dataset.tab === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    const p = $('#panel');
    if (p) p.setAttribute('aria-labelledby', `tab-${id}`);
    renderPanel();
    const tb = $(`#tab-${id}`);
    if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus && tb) tb.focus();
  }

  // ------------------------------------------------------------------ business details
  function profileFormHTML(p) {
    p = p || {};
    const f = (name, label, type, val, attrs, req) => `<label class="field${req ? ' req' : ''}"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(val || '')}" ${attrs || ''}${req ? ' required' : ''}></label>`;
    return `<form class="form" id="profileForm" novalidate${p.name ? '' : ' style="margin-top:18px"'}>
      ${p.name ? '<h3 style="margin:0">Business details</h3>' : `<div class="card" style="margin:0"><h2 style="margin:0 0 4px">Your business details</h2><p class="c-sub">We use these on invoices and to contact you about orders. Customers see only your business name.</p>`}
      <div class="grid-2">
        ${f('name', 'Business or organisation name', 'text', p.name, 'maxlength="80" autocomplete="organization"', true)}
        ${f('contact', 'Contact person', 'text', p.contact, 'maxlength="60" autocomplete="name"', true)}
        ${f('phone', 'Phone', 'tel', p.phone, 'maxlength="20" autocomplete="tel" inputmode="tel" placeholder="98765 43210"', true)}
        ${f('email', 'Email', 'email', p.email, 'maxlength="120" autocomplete="email"', true)}
        ${f('gst', 'GSTIN (optional)', 'text', p.gst, 'maxlength="15" autocapitalize="characters" placeholder="22AAAAA0000A1Z5"', false)}
      </div>
      <p class="form-error" data-err role="alert"></p>
      <div class="row">
        <button class="btn primary" type="submit">${p.name ? 'Save details' : 'Continue'}</button>
        ${p.name ? '<button class="btn ghost" type="button" data-act="edit-profile">Cancel</button>' : ''}
      </div>
      <p class="small muted" style="margin:0">No password needed: this device stays signed in. To use another device, copy your backup code from <a href="/me.html">Rewards</a>.</p>
      ${p.name ? '' : '</div>'}
    </form>`;
  }
  function wireProfileForm() {
    const form = $('#profileForm');
    if (!form) return;
    if (!B.editProfile) { const first = form.querySelector('input'); if (first) first.focus(); }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (n) => form.elements[n].value.trim();
      const err = form.querySelector('[data-err]');
      const missing = ['name', 'contact', 'phone', 'email'].find((n) => !v(n));
      if (missing) { err.textContent = 'Please fill in the required fields.'; form.elements[missing].focus(); return; }
      // edit: true marks a change to existing details (the server can refuse a first-time sign-up over an existing profile)
      const r = await act('profile', { name: v('name'), contact: v('contact'), phone: v('phone'), email: v('email'), gst: v('gst'), edit: !!B.editProfile }, form.querySelector('[type="submit"]'), err);
      if (!r.ok) return;
      const edited = B.editProfile;
      toast(edited ? 'Details saved' : 'Welcome! Your business dashboard is ready.');
      B.editProfile = false;
      await refresh();
      if (B.claimId) setTab('washrooms');
      $('#app').scrollIntoView({ block: 'start', behavior: 'smooth' });
      const back = $(edited ? '[data-act="edit-profile"]' : '#bizName');
      if (back) back.focus({ preventScroll: true });
    });
  }

  async function start(tab) {
    if (!B.enabled) return;
    const r = await Account.ensure();
    if (!r.ok) { notice(esc(r.error || 'Couldn’t start. Please try again.'), 'warn'); return; }
    await loadDash();
    if (B.dashError || !B.enabled) {
      // couldn't tell whether this device already has a business: show the error, not the sign-up form
      render();
      const retry = $('#notice [data-act="retry"]');
      if (retry) retry.focus();
      return;
    }
    if (tab) B.tab = tab;
    B.started = true;
    B.showLanding = false;
    render();
    if (B.dash && B.dash.profile) { setTab(B.tab); $('#app').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else { const f = $('#profileForm'); if (f) f.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  }

  // ------------------------------------------------------------------ overview
  function overviewHTML() {
    const d = B.dash;
    const now = Date.now();
    const live = d.campaigns.filter((a) => a.st === 'live' && a.end > now).length;
    const unpaid = d.orders.filter((o) => o.status === 'awaiting_payment');
    const checking = d.orders.filter((o) => o.status === 'payment_submitted');
    const openReps = d.washrooms.flatMap((w) => w.reports.filter((r) => r.status === 'open' || r.status === 'ack').map((r) => [w, r]));
    const pendingClaims = d.claims.filter((c) => c.status === 'pending');
    const kpi = (label, val, sub) => `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-val">${nf(val)}</div>${sub ? `<div class="k-sub">${esc(sub)}</div>` : ''}</div>`;
    const steps = [];
    const step = (icon, html, btn, done) => steps.push(`<li class="${done ? 'done' : ''}">${ic(done ? 'check' : icon)}<span class="grow">${html}</span>${btn || ''}</li>`);
    if (unpaid.length) step('rupee', `<b>${unpaid.length} order${unpaid.length > 1 ? 's' : ''} waiting for payment.</b> Pay by UPI to switch ${unpaid.length > 1 ? 'them' : 'it'} on.`, `<button class="btn sm primary" type="button" data-goto="orders">Pay now</button>`);
    if (openReps.length) step('alert', `<b>${openReps.length} open hygiene report${openReps.length > 1 ? 's' : ''}</b> on your washrooms. Fix and close them — Featured listings pause while a report is open.`, `<button class="btn sm" type="button" data-goto="washrooms">See reports</button>`);
    if (checking.length) step('clock', `We’re checking ${checking.length} payment${checking.length > 1 ? 's' : ''}. This usually takes less than a working day.`, '', false);
    if (pendingClaims.length) step('clock', `Your claim for <b>${esc(pendingClaims[0].name)}</b>${pendingClaims.length > 1 ? ` and ${pendingClaims.length - 1} more` : ''} is waiting for review.`, '');
    if (!d.washrooms.length && !pendingClaims.length) step('building', '<b>Run a public washroom?</b> Claim it to answer reports, get it featured and see how many people use it.', `<button class="btn sm" type="button" data-goto="washrooms">Claim a washroom</button>`);
    if (!d.campaigns.length) step('megaphone', '<b>Have a shop, café or pharmacy nearby?</b> Show people looking for a washroom your offer.', `<button class="btn sm" type="button" data-goto="ads">Create an ad</button>`);
    if (d.washrooms.length && d.washrooms.some((w) => !w.verified)) step('shield', 'Book a verification visit to earn the “Verified by Swachh Scan” badge.', `<button class="btn sm" type="button" data-goto="washrooms">Book a visit</button>`);
    step('lock', 'Save your backup code so you can open this dashboard on another device.', `<a class="btn sm" href="/me.html#backup">Backup code</a>`);
    return `<div class="kpis">
        ${kpi('Washrooms you manage', d.washrooms.length, pendingClaims.length ? `${pendingClaims.length} claim${pendingClaims.length > 1 ? 's' : ''} pending` : '')}
        ${kpi('Live ads', live, `${d.campaigns.length} in total`)}
        ${kpi('Orders to pay', unpaid.length, checking.length ? `${checking.length} being checked` : '')}
        ${kpi('Open reports', openReps.length, 'on your washrooms')}
      </div>
      <h3 class="eyebrow">${ic('check')}Next steps</h3>
      <ul class="next-steps">${steps.join('')}</ul>`;
  }

  // ------------------------------------------------------------------ ads
  function campStatus(a) {
    const now = Date.now();
    const o = B.dash.orders.find((x) => x.id === a.order);
    if (a.st === 'awaiting_payment') return o && o.status === 'payment_submitted' ? ['Checking payment', 'info'] : ['Awaiting payment', 'warn'];
    if (a.st === 'rejected') return ['Not approved', 'bad'];
    if (a.st === 'cancelled') return ['Cancelled', ''];
    if (a.st === 'ended' || (a.end && now >= a.end)) return ['Ended', ''];
    if (a.st === 'paused') return ['Paused', 'warn'];
    if (a.st === 'live') return ['Live', 'good'];
    return [a.st, ''];
  }

  function sponsoredHTML(a, km) {
    const dist = km == null ? '' : km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} m` : `${km.toFixed(1)} km`;
    return `<div class="sponsored">
      <div class="sp-top">${ic('megaphone', 'sm')}<span>Sponsored · ${esc(a.cat || 'Nearby')}</span>${dist ? `<span style="text-transform:none;letter-spacing:0">· ${dist}</span>` : ''}</div>
      <div class="sp-title">${esc(a.title || 'Your headline')}</div>
      <div class="sp-text">${esc(a.text || 'Your message to people nearby.')}</div>
      <div class="small muted">${esc(a.biz || '')}</div>
      <div class="sp-actions">
        ${a.offer && a.offer.title ? `<span class="btn sm coinbtn"><span class="coin" aria-hidden="true">S</span>${esc(a.offer.title)} · ${nf(a.offer.cost)} coins</span>` : ''}
        ${a.url ? `<span class="btn sm">${ic('ext', 'sm')} Website</span>` : ''}
        ${a.phone ? `<span class="btn sm">${ic('phone', 'sm')} Call</span>` : ''}
        <span class="btn sm">${ic('directions', 'sm')} Directions</span>
      </div>
    </div>`;
  }

  function adsHTML() {
    const d = B.dash;
    const list = d.campaigns;
    const formOpen = B.adFormOpen == null ? !list.length : B.adFormOpen;
    let h = '';
    if (formOpen) h += campaignFormHTML();
    else h += `<button class="btn primary" type="button" data-act="new-ad">${ic('plus')} Create a campaign</button>`;
    h += `<h3 class="eyebrow">${ic('megaphone')}Your campaigns</h3>`;
    if (!list.length) h += `<div class="muted-box">No campaigns yet. Your ad appears as a “Sponsored” card to people looking for washrooms near your location.</div>`;
    for (const a of list) {
      const [label, tone] = campStatus(a);
      const started = !!a.start;
      const ended = a.end && Date.now() >= a.end;
      const canToggle = (a.st === 'live' || a.st === 'paused') && !ended;
      const order = d.orders.find((o) => o.id === a.order);
      h += `<article class="item" aria-labelledby="ad-${esc(a.id)}">
        <div class="item-top">
          <div><h3 id="ad-${esc(a.id)}">${esc(a.title)}</h3>
            <div class="meta">${esc(plan(a.plan).label)} · ${esc(a.cat)} · ${a.r < 1 ? `${a.r * 1000} m` : `${a.r} km`} around ${esc(a.place || `${a.la.toFixed(4)}, ${a.lo.toFixed(4)}`)}</div></div>
          <span class="st ${tone}">${esc(label)}</span>
        </div>
        <p class="small" style="margin:8px 0 0;color:var(--text-2)">${esc(a.text)}</p>
        <div class="tags">
          ${started ? `<span class="tag">${ic('clock')}${esc(fmtDate(a.start))} – ${esc(fmtDate(a.end))}</span>` : `<span class="tag">${ic('clock')}Created ${esc(ago(a.at))}</span>`}
          ${a.offer ? `<span class="tag feat"><span class="coin" aria-hidden="true" style="width:14px;height:14px;font-size:8px">S</span>${esc(a.offer.title)} · ${nf(a.offer.cost)} coins · ${nf(a.offer.stock)} offers</span>` : ''}
        </div>
        ${a.st === 'rejected' && a.note ? `<div class="notice-box warn" style="margin-top:10px">${ic('alert')}<p>${esc(a.note)}</p></div>` : ''}
        ${started ? `<div class="sub-sec" data-adstats="${esc(a.id)}">${adStatsHTML(a)}</div>` : ''}
        <div class="acts">
          ${a.st === 'awaiting_payment' && order ? `<button class="btn sm primary" type="button" data-pay="${esc(order.id)}">${ic('rupee', 'sm')} ${order.status === 'payment_submitted' ? 'Payment details' : `Pay ${rupees(order.amount)}`}</button>` : ''}
          ${canToggle ? `<button class="btn sm" type="button" data-adstate="${esc(a.id)}" data-to="${a.st === 'live' ? 'paused' : 'live'}">${a.st === 'live' ? 'Pause' : 'Resume'}</button>` : ''}
        </div>
        <p class="form-error" data-err="${esc(a.id)}" role="alert"></p>
      </article>`;
    }
    return h;
  }

  function adStatsHTML(a) {
    const s = B.adStats[a.id];
    if (!s) return '<div class="small muted">Loading stats…</div>';
    if (s.error) return `<div class="small muted">${esc(s.error)}</div>`;
    const imp = s.series.reduce((x, d) => x + d.impressions, 0);
    const clk = s.series.reduce((x, d) => x + d.clicks, 0);
    const ctr = imp ? `${(Math.round((clk / imp) * 1000) / 10).toFixed(1)}%` : '–';
    return `<div class="kpis">
        <div class="kpi"><div class="k-label">Seen</div><div class="k-val">${nf(imp)}</div><div class="k-sub">last 30 days</div></div>
        <div class="kpi"><div class="k-label">Tapped</div><div class="k-val">${nf(clk)}</div><div class="k-sub">CTR ${ctr}</div></div>
        ${a.offer ? `<div class="kpi"><div class="k-label">Offers redeemed</div><div class="k-val">${nf(s.redeemed)}</div><div class="k-sub">of ${nf(a.offer.stock)}</div></div>` : ''}
      </div>
      ${spark(s.series.map((d) => ({ day: d.day, v: d.impressions })), 'v', 'Seen per day')}`;
  }

  async function loadAdStats() {
    const ids = B.dash.campaigns.filter((a) => a.start).map((a) => a.id);
    await Promise.all(ids.map(async (id) => {
      const r = await api(`/api/business?action=analytics&ad=${encodeURIComponent(id)}`);
      B.adStats[id] = r.ok ? r.j : { error: r.j.error || 'Stats unavailable right now.' };
      const box = $(`[data-adstats="${CSS.escape(id)}"]`);
      const a = B.dash.campaigns.find((x) => x.id === id);
      if (box && a) box.innerHTML = adStatsHTML(a);
    }));
  }

  function spark(series, key, label) {
    const vals = series.map((s) => s[key] || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...vals);
    const peak = vals.indexOf(Math.max(...vals));
    const bars = series.map((s, i) => { const v = vals[i]; return `<span class="${v ? '' : 'z'}" style="height:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%" title="${esc(dayLabel(s.day))}: ${nf(v)}"></span>`; }).join('');
    return `<div class="chart-block"><div class="c-title">${esc(label)}<span>${nf(total)} in 30 days</span></div>
      <div class="spark" role="img" aria-label="${esc(label)}: ${nf(total)} in the last 30 days${total ? `, highest ${nf(vals[peak])} on ${esc(dayLabel(series[peak].day))}` : ''}">${bars}</div>
      <div class="spark-axis" aria-hidden="true"><span>${esc(dayLabel(series[0].day))}</span><span>Today</span></div></div>`;
  }

  function campaignFormHTML() {
    const dr = B.draft;
    const cats = B.categories;
    const seg = (name, opts, cur) => `<div class="seg radios" role="radiogroup" aria-label="${esc(name)}">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${esc(v)}"${String(cur) === String(v) ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
    return `<div class="card" style="margin-top:0">
      <div class="row between"><h2 style="margin:0">Create a nearby ad</h2>${B.dash.campaigns.length ? '<button class="btn ghost sm" type="button" data-act="close-ad">Close</button>' : ''}</div>
      <p class="c-sub">Shown as a “Sponsored” card to people looking for a washroom within your radius, on the map and next to washroom details.</p>
      <div class="camp-grid">
        <form class="form" id="campForm" novalidate>
          <label class="field req"><span>Headline</span><input name="title" maxlength="60" value="${esc(dr.title || '')}" placeholder="Fresh chai, 2 minutes away" required><span class="counter" data-count="title"></span></label>
          <label class="field req"><span>Message</span><textarea name="text" maxlength="140" rows="2" placeholder="Clean seating, filtered water and snacks. Open 7 am – 11 pm." required>${esc(dr.text || '')}</textarea><span class="counter" data-count="text"></span></label>
          <label class="field req"><span>Category</span><select name="cat" required><option value="">Choose…</option>${cats.map((c) => `<option${dr.cat === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <div class="field req"><span id="locLabel">Your location</span>
            <div class="minimap" id="pickMap" role="application" aria-labelledby="locLabel" aria-describedby="locHelp"></div>
            <div class="row" style="margin-top:6px">
              <button class="btn sm" type="button" data-act="use-loc">${ic('locate', 'sm')} Use my location</button>
              <span class="small muted" id="locHelp">${dr.la ? `Pinned at ${dr.la.toFixed(5)}, ${dr.lo.toFixed(5)} · drag the pin to adjust` : 'Tap the map where your business is, then drag the pin to adjust.'}</span>
            </div>
            <label class="field" style="margin-top:8px"><span>Or paste coordinates (from Google Maps)</span><input name="coords" inputmode="decimal" autocomplete="off" placeholder="18.5204, 73.8567" value="${dr.la ? `${dr.la}, ${dr.lo}` : ''}"></label>
          </div>
          <label class="field"><span>Area name shown to people</span><input name="place" maxlength="80" value="${esc(dr.place || '')}" placeholder="FC Road, Pune"></label>
          <div class="field req"><span>Show it to people within</span>${seg('r', RADII.map(([v, l]) => [v, l]), dr.r)}</div>
          <div class="grid-2">
            <label class="field"><span>Website (optional)</span><input name="url" type="url" inputmode="url" maxlength="300" value="${esc(dr.url || '')}" placeholder="example.com"></label>
            <label class="field"><span>Phone (optional)</span><input name="phone" type="tel" inputmode="tel" maxlength="20" value="${esc(dr.phone || '')}" placeholder="98765 43210"></label>
          </div>
          <div class="field req"><span>How long</span>${seg('plan', [['ad7', `7 days${B.plans ? ` · ${priceOf('ad7')}` : ''}`], ['ad30', `30 days${B.plans ? ` · ${priceOf('ad30')}` : ''}`]], dr.plan)}</div>
          <label class="check"><input type="checkbox" name="offerOn"${dr.offerOn ? ' checked' : ''}> Add an offer people unlock with Swachh Coins</label>
          <div id="offerFields" class="stack"${dr.offerOn ? '' : ' hidden'}>
            <p class="small muted" style="margin:0">Scouts earn coins by rating and reporting washrooms. They spend them on your offer and show you a code (SS-XXXX-XXXX) that you check under “Offer codes”.</p>
            <label class="field req"><span>Offer</span><input name="offerTitle" maxlength="60" value="${esc(dr.offerTitle || '')}" placeholder="Free cutting chai"></label>
            <div class="grid-2">
              <label class="field req"><span>Coins needed</span><select name="offerCost">${COIN_COSTS.map((c) => `<option value="${c}"${Number(dr.offerCost) === c ? ' selected' : ''}>${c} coins</option>`).join('')}</select></label>
              <label class="field req"><span>Number of offers</span><input name="offerStock" type="number" min="1" max="1000" step="1" value="${esc(dr.offerStock)}"></label>
            </div>
          </div>
          <p class="form-error" data-err="camp" role="alert"></p>
          <div class="row"><button class="btn primary" type="submit">${ic('megaphone')} Create campaign${B.plans ? ` · ${priceOf(dr.plan)}` : ''}</button><span class="small muted">You pay on the next step. It goes live once we confirm the payment.</span></div>
        </form>
        <div class="preview-wrap">
          <h3 class="eyebrow" style="margin-top:0">${ic('eye')}Preview</h3>
          <div class="phone"><div class="fake-row"><span class="mk"></span><span class="bar"></span></div><div id="adPreview" style="margin:8px 0"></div><div class="fake-row"><span class="mk fac"></span><span class="bar"></span></div></div>
          <p class="small muted">This is how people nearby will see it.</p>
        </div>
      </div>
    </div>`;
  }

  function readDraft(form) {
    const e = form.elements;
    const dr = B.draft;
    dr.title = e.title.value; dr.text = e.text.value; dr.cat = e.cat.value; dr.place = e.place.value;
    dr.url = e.url.value; dr.phone = e.phone.value;
    const r = form.querySelector('input[name="r"]:checked'); if (r) dr.r = Number(r.value);
    const p = form.querySelector('input[name="plan"]:checked'); if (p) dr.plan = p.value;
    dr.offerOn = e.offerOn.checked; dr.offerTitle = e.offerTitle.value; dr.offerCost = Number(e.offerCost.value); dr.offerStock = e.offerStock.value;
  }
  function updatePreview() {
    const dr = B.draft;
    const prev = $('#adPreview');
    if (prev) prev.innerHTML = sponsoredHTML({ title: dr.title, text: dr.text, cat: dr.cat, biz: B.dash.profile.name, url: dr.url, phone: dr.phone, offer: dr.offerOn ? { title: dr.offerTitle || 'Your offer', cost: dr.offerCost } : null }, Math.min(0.2, dr.r));
    ['title', 'text'].forEach((n) => { const c = $(`[data-count="${n}"]`); const max = n === 'title' ? 60 : 140; if (c) c.textContent = `${(dr[n] || '').length} / ${max}`; });
    const sub = $('#campForm [type="submit"]');
    if (sub && B.plans) sub.innerHTML = `${ic('megaphone')} Create campaign · ${priceOf(dr.plan)}`;
    if (B.pickCircle) {
      B.pickCircle.setRadius(dr.r * 1000);
      if (B.lastR !== dr.r && B.pickMap) B.pickMap.fitBounds(B.pickCircle.getBounds(), { padding: [12, 12] });
    }
    B.lastR = dr.r;
  }

  async function ensureLeaflet() {
    if (window.L) return;
    if (!document.querySelector('link[data-leaflet]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      l.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; l.crossOrigin = ''; l.dataset.leaflet = '1';
      document.head.appendChild(l);
    }
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
  }

  async function initCampaignForm() {
    const form = $('#campForm');
    updatePreview();
    form.addEventListener('input', () => { readDraft(form); $('#offerFields').hidden = !B.draft.offerOn; updatePreview(); });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'coords') {
        const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{2,3}(?:\.\d+)?)\s*$/.exec(e.target.value);
        const err = form.querySelector('[data-err="camp"]');
        if (!m || +m[1] < 6 || +m[1] > 37.5 || +m[2] < 68 || +m[2] > 97.6) { err.textContent = 'Enter coordinates in India as “latitude, longitude”, e.g. 18.5204, 73.8567.'; return; }
        err.textContent = '';
        if (B.placePin && window.L) B.placePin(L.latLng(+m[1], +m[2]), true);
        return;
      }
      readDraft(form); $('#offerFields').hidden = !B.draft.offerOn; updatePreview();
    });
    form.addEventListener('submit', submitCampaign);
    try { await ensureLeaflet(); } catch (e) { $('#pickMap').innerHTML = '<div class="loading-line">The map couldn’t load. Check your connection.</div>'; return; }
    if (!document.contains(form)) return;
    const dr = B.draft;
    const m = L.map('pickMap', { zoomControl: true, scrollWheelZoom: false });
    B.pickMap = m;
    L.tileLayer(SS.TILES.url, { maxZoom: SS.TILES.maxZoom, attribution: SS.TILES.attribution }).addTo(m);
    m.attributionControl.setPrefix(false);
    if (dr.la) m.setView([dr.la, dr.lo], 15); else m.setView([22.6, 79.5], 4);
    const place = (ll, fly) => {
      dr.la = Math.round(ll.lat * 1e6) / 1e6; dr.lo = Math.round(ll.lng * 1e6) / 1e6;
      if (!B.pickMarker || !m.hasLayer(B.pickMarker)) {
        B.pickMarker = L.marker(ll, { draggable: true, keyboard: true, title: 'Your business (drag to move)', icon: L.divIcon({ className: 'pin-wrap', html: '<div class="pin"><span aria-hidden="true">AD</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(m);
        B.pickMarker.on('dragend', () => place(B.pickMarker.getLatLng()));
        B.pickCircle = L.circle(ll, { radius: dr.r * 1000, color: '#0a7c68', weight: 1.5, fillOpacity: 0.08, interactive: false }).addTo(m);
      } else { B.pickMarker.setLatLng(ll); B.pickCircle.setLatLng(ll); }
      const help = $('#locHelp');
      if (help) help.textContent = `Pinned at ${dr.la.toFixed(5)}, ${dr.lo.toFixed(5)} · drag the pin to adjust`;
      const co = form.elements.coords;
      if (co && document.activeElement !== co) co.value = `${dr.la}, ${dr.lo}`;
      if (fly || m.getZoom() < 12) m.setView(ll, Math.max(m.getZoom(), 15));
    };
    B.pickMarker = null; B.pickCircle = null;
    if (dr.la) place(L.latLng(dr.la, dr.lo));
    m.on('click', (e) => place(e.latlng));
    B.placePin = place;
    setTimeout(() => m.invalidateSize(), 50);
  }

  function useMyLocation(btn) {
    if (!navigator.geolocation) { toast('Location isn’t available on this device.'); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false;
      if (B.placePin && window.L) B.placePin(L.latLng(pos.coords.latitude, pos.coords.longitude), true);
    }, (err) => {
      btn.disabled = false;
      toast(err.code === 1 ? 'Location permission was denied. Tap the map instead.' : 'Couldn’t get your location. Tap the map instead.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  async function submitCampaign(e) {
    e.preventDefault();
    const form = e.currentTarget;
    readDraft(form);
    const dr = B.draft;
    const err = form.querySelector('[data-err="camp"]');
    const need = [['title', 'a headline'], ['text', 'a message'], ['cat', 'a category']].find(([k]) => !String(dr[k] || '').trim());
    if (need) { err.textContent = `Add ${need[1]}.`; form.elements[need[0]].focus(); return; }
    if (!dr.la) { err.textContent = 'Tap the map to pin where your business is.'; $('#pickMap').focus(); return; }
    if (dr.offerOn && !String(dr.offerTitle || '').trim()) { err.textContent = 'Describe your offer, or untick it.'; form.elements.offerTitle.focus(); return; }
    const body = { title: dr.title.trim(), text: dr.text.trim(), cat: dr.cat, la: dr.la, lo: dr.lo, r: dr.r, place: (dr.place || '').trim(), url: (dr.url || '').trim(), phone: (dr.phone || '').trim(), plan: dr.plan };
    if (dr.offerOn) body.offer = { title: dr.offerTitle.trim(), cost: Number(dr.offerCost), stock: Math.round(Number(dr.offerStock) || 0) };
    const r = await act('campaign', body, form.querySelector('[type="submit"]'), err);
    if (!r.ok) return;
    toast('Campaign created. Pay to send it live.');
    B.draft = { r: dr.r, plan: dr.plan, cat: '', offerOn: false, offerCost: 100, offerStock: 50 };
    B.adFormOpen = false;
    B.openOrder = r.j.order.id;
    await loadDash();
    render();
    setTab('orders');
    const o = $(`#order-${CSS.escape(r.j.order.id)}`);
    if (o) o.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const h = $(`#ot-${CSS.escape(r.j.order.id)}`);
    if (h) h.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ my washrooms: claim + manage
  let WR = null, WRAlias = null;
  async function loadWashrooms() {
    if (WR) return WR;
    const [d, st] = await Promise.all([SS.fetchJSON('/data/washrooms.json'), api('/api/state', { auth: false })]);
    WRAlias = new Map(Object.entries(d.alias || {}));
    const area = (it) => [it.city, it.d, it.st].filter(Boolean).filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 2).join(', ');
    WR = d.items.map((it) => {
      for (const a of it.ids || []) if (a !== it.id) WRAlias.set(a, it.id);
      return { id: it.id, n: it.n, s: it.s, c: it.c, area: area(it), key: norm([it.n, ...(it.alt || []), it.c, it.a, it.city, it.d, it.st, it.pin, it.op, it.id].filter(Boolean).join(' ')) };
    });
    if (st.ok && Array.isArray(st.j.places)) {
      for (const p of st.j.places) WR.push({ id: p.id, n: p.n, s: p.s, c: p.c, area: area(p), key: norm([p.n, p.c, p.a, p.city, p.d, p.st, p.id].filter(Boolean).join(' ')), community: true });
    }
    return WR;
  }
  function findWashroom(id) {
    if (!WR) return null;
    const real = WRAlias.get(id) || id;
    return WR.find((w) => w.id === real) || null;
  }

  async function initClaim() {
    if (B.claimId && !B.claimPick && !B.claimMissing) {
      const box = $('#claimBox');
      try {
        await loadWashrooms();
        const w = findWashroom(B.claimId);
        if (w) B.claimPick = w; else B.claimMissing = true;
      } catch (e) { B.claimMissing = true; }
      if (box && document.contains(box)) { box.outerHTML = claimBoxHTML(); wireClaim(); }
      return;
    }
    wireClaim();
  }

  function claimBoxHTML() {
    const d = B.dash;
    const owned = new Set(d.washrooms.map((w) => w.id));
    let inner;
    if (B.claimId && !B.claimPick && !B.claimMissing) inner = '<div class="loading-line">Finding the washroom…</div>';
    else if (B.claimPick && owned.has(B.claimPick.id)) {
      inner = `<div class="notice-box">${ic('check')}<p>You already manage <b>${esc(B.claimPick.n)}</b>. Its reports and services are below.</p></div><button class="btn sm" type="button" data-act="claim-other" style="margin-top:10px">Claim a different washroom</button>`;
    } else if (B.claimPick) {
      const w = B.claimPick;
      const pending = d.claims.find((c) => c.washroom === w.id && c.status === 'pending');
      inner = `<div class="picked"><span class="mk${w.s ? '' : ' fac'}"></span><span class="grow"><b>${esc(w.n)}</b><small>${esc([w.s ? 'Public toilet' : w.c, w.area].filter(Boolean).join(' · '))} · ID ${esc(w.id)}</small></span><button class="btn sm ghost" type="button" data-act="claim-other">Change</button></div>`;
      inner += pending
        ? `<p class="small" style="margin:10px 0 0">${ic('clock', 'sm')} Your claim for this washroom is waiting for review.</p>`
        : `<form class="form" id="claimForm" style="margin-top:12px" novalidate>
            <label class="field req"><span>Your role</span><select name="role" required><option value="">Choose…</option>${ROLES.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
            <label class="field req"><span>How can we confirm it?</span><textarea name="note" maxlength="400" rows="3" minlength="10" placeholder="e.g. Contract with Pune Municipal Corporation, ref PMC/SBM/2024/118. Call the site supervisor on 98765 43210." required></textarea><span class="hint">A contract or licence number, a photo you can email us, or a contact at the site. We check every claim before it’s approved.</span></label>
            <p class="form-error" data-err="claim" role="alert"></p>
            <div class="row"><button class="btn primary" type="submit">Send claim</button></div>
          </form>`;
    } else {
      inner = `${B.claimMissing ? `<div class="notice-box warn" style="margin-bottom:10px">${ic('alert')}<p>We couldn’t find washroom “${esc(B.claimId)}”. Search for it below.</p></div>` : ''}
        <label class="field"><span>Find your washroom</span><input class="input" id="wrSearch" type="search" placeholder="Name, area, PIN code or Swachh Scan ID" autocomplete="off" value="${esc(B.searchQ)}" aria-describedby="wrSearchHelp" aria-controls="wrResults"></label>
        <p class="small muted" id="wrSearchHelp" style="margin:4px 0 0">Tip: open the washroom on the <a href="/">map</a> and tap “Do you run this washroom?” near the bottom of its page.</p>
        <p class="visually-hidden" id="wrCount" role="status"></p>
        <ul class="search-results" id="wrResults"></ul>`;
    }
    return `<div class="card" id="claimBox" style="margin-top:0"><h2 style="margin:0 0 4px">Claim a washroom you run</h2><p class="c-sub">Free. Once approved you can answer hygiene reports and buy services for it.</p>${inner}</div>`;
  }

  function wireClaim() {
    const s = $('#wrSearch');
    if (s) {
      let timer = 0;
      const run = async () => {
        B.searchQ = s.value;
        const out = $('#wrResults');
        const count = $('#wrCount');
        const say = (t) => { if (count) count.textContent = t; };
        const q = norm(s.value);
        if (q.length < 2) { out.innerHTML = ''; say(''); return; }
        if (!WR) { out.innerHTML = '<li class="small muted">Loading washrooms…</li>'; try { await loadWashrooms(); } catch (e) { out.innerHTML = '<li class="small muted">Couldn’t load the washroom list.</li>'; say('Couldn’t load the washroom list.'); return; } }
        if (norm(s.value) !== q) return;
        const tokens = q.split(' ');
        const exact = findWashroom(s.value.trim());
        const hits = [];
        if (exact) hits.push(exact);
        for (const w of WR) {
          if (hits.length >= 20) break;
          if (w === exact) continue;
          if (tokens.every((t) => w.key.includes(t))) hits.push(w);
        }
        hits.sort((a, b) => (norm(b.n).startsWith(tokens[0]) ? 1 : 0) - (norm(a.n).startsWith(tokens[0]) ? 1 : 0));
        out.innerHTML = hits.length
          ? hits.map((w) => `<li><button type="button" data-pick="${esc(w.id)}"><span class="mk${w.s ? '' : ' fac'}"></span><span><b>${esc(w.n)}</b><small>${esc([w.s ? 'Public toilet' : w.c, w.area].filter(Boolean).join(' · '))} · ${esc(w.id)}</small></span></button></li>`).join('')
          : '<li class="small muted">No washrooms match. Try the area or PIN code.</li>';
        say(hits.length ? `${hits.length}${hits.length >= 20 ? ' or more' : ''} washroom${hits.length === 1 ? '' : 's'} found` : 'No washrooms match.');
      };
      s.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
      if (s.value) run();
    }
    const f = $('#claimForm');
    if (f) {
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = f.querySelector('[data-err="claim"]');
        const role = f.elements.role.value, note = f.elements.note.value.trim();
        if (!role) { err.textContent = 'Choose your role.'; f.elements.role.focus(); return; }
        if (note.length < 10) { err.textContent = 'Tell us how we can confirm that you run it (at least 10 characters).'; f.elements.note.focus(); return; }
        const r = await act('claim', { id: B.claimPick.id, role, note }, f.querySelector('[type="submit"]'), err);
        if (!r.ok) return;
        toast('Claim sent. We’ll review it within a working day.');
        B.claimId = null; B.claimPick = null;
        history.replaceState(null, '', `${location.pathname}#washrooms`);
        await refresh('#claimsHead');
      });
    }
  }

  function washroomsHTML() {
    const d = B.dash;
    let h = claimBoxHTML();
    const claims = d.claims.filter((c) => c.status !== 'approved' || !d.washrooms.some((w) => w.id === c.washroom));
    if (claims.length) {
      h += `<h3 class="eyebrow" id="claimsHead" tabindex="-1">${ic('clock')}Your claims</h3><div class="rows">${claims.map((c) => {
        const tone = c.status === 'pending' ? 'info' : c.status === 'approved' ? 'good' : 'bad';
        const label = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not approved' }[c.status] || c.status;
        return `<div class="rowcard"><div class="main"><div class="title">${esc(c.name || c.washroom)}</div><div class="sub">${esc(c.role)} · ID ${esc(c.washroom)} · sent ${esc(ago(c.at))}${c.note ? ` · ${esc(c.note)}` : ''}</div></div><span class="st ${tone}">${esc(label)}</span></div>`;
      }).join('')}</div>`;
    }
    h += `<h3 class="eyebrow">${ic('building')}Washrooms you manage</h3>`;
    if (!d.washrooms.length) h += '<div class="muted-box">None yet. Once a claim is approved, the washroom appears here with its reports, rating and services.</div>';
    for (const w of d.washrooms) h += washroomItemHTML(w);
    return h;
  }

  function openOrderFor(kind, id) {
    return B.dash.orders.find((o) => o.kind === kind && o.target === id && ['awaiting_payment', 'payment_submitted', 'inspection'].includes(o.status));
  }

  function washroomItemHTML(w) {
    const now = Date.now();
    const open = w.reports.filter((r) => r.status === 'open' || r.status === 'ack');
    const closed = w.reports.filter((r) => r.status !== 'open' && r.status !== 'ack');
    const service = (kind, label, active) => {
      const o = openOrderFor(kind, w.id);
      if (o) return `<button class="btn sm" type="button" data-goto="orders" data-open-order="${esc(o.id)}">${ic('clock', 'sm')} ${esc(label)}: ${esc((ORDER_ST[o.status] || [o.status])[0].toLowerCase())}</button>`;
      const verb = active ? (kind === 'verify' ? 'Re-verify' : `Extend ${label}`) : { featured: 'Feature it', analytics: 'Get analytics', verify: 'Book a verification visit' }[kind];
      return `<button class="btn sm${active ? '' : ' primary'}" type="button" data-order="${kind}" data-target="${esc(w.id)}">${ic(KIND_ICON[kind], 'sm')} ${esc(verb)}${B.plans ? ` · ${priceOf(kind)}` : ''}</button>`;
    };
    const ver = w.verified;
    const lastVer = w.lastVerification;
    const poorRecent = !!(w.rating && w.rating.n >= 2 && w.rating.recent != null && w.rating.recent < 3);
    return `<article class="item" aria-labelledby="wr-${esc(w.id)}">
      <div class="item-top">
        <div><h3 id="wr-${esc(w.id)}" tabindex="-1">${esc(w.name)}</h3><div class="meta">${esc(w.area)} · ID ${esc(w.id)} · <a href="/?id=${encodeURIComponent(w.id)}">Open on the map</a></div></div>
        ${w.rating ? `<span class="tag star">${ic('star', 'fill')}${w.rating.avg.toFixed(1)} · ${nf(w.rating.n)} rating${w.rating.n === 1 ? '' : 's'}</span>` : '<span class="tag muted">No ratings yet</span>'}
      </div>
      <div class="tags">
        ${w.rating && w.rating.recent != null ? `<span class="tag ${w.rating.recent < 3 ? 'bad' : 'good'}" title="Weighted towards the latest ratings">Recent score ${Number(w.rating.recent).toFixed(1)}</span>` : ''}
        ${w.featuredUntil ? `<span class="tag feat">${ic('sparkle')}Featured until ${esc(fmtDate(w.featuredUntil))}${open.length || poorRecent ? ' · paused' : ''}</span>` : ''}
        ${ver ? `<span class="tag ver">${ic('shield')}Verified until ${esc(fmtDate(ver.exp))}</span>` : lastVer ? `<span class="tag muted">Verification expired ${esc(fmtDate(lastVer.exp))}</span>` : ''}
        ${w.analyticsUntil ? `<span class="tag">${ic('chart')}Analytics until ${esc(fmtDate(w.analyticsUntil))}</span>` : ''}
        ${open.length ? `<span class="tag issue">${ic('alert')}${open.length} open report${open.length > 1 ? 's' : ''}</span>` : `<span class="tag good">${ic('check')}No open reports</span>`}
      </div>
      ${w.featuredUntil && (open.length || poorRecent) ? `<p class="small feat-pause">${ic('alert', 'sm')}<span>${open.length
        ? 'Featured is paused while a hygiene report is open. It comes back as soon as the reports below are closed.'
        : 'Featured is paused while recent ratings are below 3★. It comes back when newer ratings lift the recent score.'}</span></p>` : ''}

      <div class="sub-sec"><h4>Hygiene reports</h4>
        ${open.length ? open.map((r) => `<div class="rep">
            <div class="row between"><b>${esc(r.issues.map((i) => ISSUES[i] || i).join(', '))}</b><span class="st ${r.status === 'ack' ? 'info' : 'warn'}">${r.status === 'ack' ? 'Acknowledged' : 'Open'}</span></div>
            <div class="small muted">Reported ${esc(ago(r.at))}${r.scout ? ' by a Swachh Scout' : ''}${r.status === 'ack' && r.by ? ` · acknowledged by ${esc(r.by)}` : ''}</div>
            ${r.note ? `<p class="r-note">“${esc(r.note)}”</p>` : ''}
            ${r.response ? `<p class="r-note small">Your note: ${esc(r.response)}</p>` : ''}
            <div class="r-acts">
              <label class="visually-hidden" for="rn-${esc(r.id)}">Note for this report (optional, shown publicly on the washroom page)</label>
              <input class="input" id="rn-${esc(r.id)}" maxlength="200" placeholder="Public note (optional), e.g. Cleaned at 4 pm" aria-describedby="rnh-${esc(r.id)}">
              ${r.status === 'open' ? `<button class="btn sm" type="button" data-respond="${esc(r.id)}" data-status="ack">Acknowledge</button>` : ''}
              <button class="btn sm good" type="button" data-respond="${esc(r.id)}" data-status="resolved">${ic('check', 'sm')} Mark fixed</button>
            </div>
            <p class="small muted" id="rnh-${esc(r.id)}" style="margin:4px 0 0">Your note is shown to everyone on the washroom’s page, next to this report. Don’t include names or phone numbers.</p>
            <p class="form-error" data-err="${esc(r.id)}" role="alert"></p>
          </div>`).join('') : '<p class="small muted" style="margin:0">No open reports. Keep it that way: people see when a washroom was last cleaned.</p>'}
        ${closed.length ? `<details class="more"><summary>${closed.length} closed in the last 30 days</summary><div style="margin-top:8px">${closed.map((r) => `<div class="rep"><b>${esc(r.issues.map((i) => ISSUES[i] || i).join(', '))}</b> <span class="st ${r.status === 'resolved' ? 'good' : ''}">${r.status === 'resolved' ? 'Fixed' : 'Closed'}</span><div class="small muted">${esc(ago(r.at))}${r.by ? ` · ${esc(r.by)}` : ''}${r.response ? ` · ${esc(r.response)}` : ''}</div></div>`).join('')}</div></details>` : ''}
        <form class="inline-form" data-cleaned="${esc(w.id)}" style="margin-top:12px">
          <label class="field"><span>Just cleaned it? Note (optional, shown publicly on the washroom page)</span><input class="input" name="note" maxlength="200" placeholder="e.g. Cleaned and water restored"></label>
          <button class="btn" type="submit">${ic('broom', 'sm')} We cleaned it</button>
        </form>
        <p class="small muted" style="margin:6px 0 0">Closes every open report, shows when it was last cleaned on the map and adds it to the public cleaning log on the <a href="/civic.html?tab=cleaned">civic dashboard</a>.</p>
        <p class="form-error" data-err="clean-${esc(w.id)}" role="alert"></p>
      </div>

      <div class="sub-sec"><h4>Services</h4>
        <div class="acts" style="margin-top:0">
          ${service('featured', 'Featured', !!w.featuredUntil)}
          ${service('analytics', 'Analytics', !!w.analyticsUntil)}
          ${service('verify', 'Verification', !!ver)}
        </div>
        <p class="form-error" data-err="svc-${esc(w.id)}" role="alert"></p>
      </div>

      ${w.analyticsUntil ? `<div class="sub-sec" data-wrstats="${esc(w.id)}">${wrStatsHTML(w.id)}</div>` : ''}
    </article>`;
  }

  function wrStatsHTML(id) {
    const s = B.wrStats[id];
    if (!s) return '<h4>Last 30 days</h4><div class="small muted">Loading analytics…</div>';
    if (s.error) return `<h4>Last 30 days</h4><div class="small muted">${esc(s.error)}</div>`;
    const sum = (k) => s.series.reduce((a, d) => a + (d[k] || 0), 0);
    const rn = sum('rn'), rs = sum('rs');
    const kpi = (label, val, sub) => `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-val">${val}</div>${sub ? `<div class="k-sub">${esc(sub)}</div>` : ''}</div>`;
    return `<h4>Last 30 days</h4>
      <div class="kpis">
        ${kpi('Page views', nf(sum('v')))}
        ${kpi('Directions', nf(sum('d')))}
        ${kpi('Calls', nf(sum('c')))}
        ${kpi('QR scans', nf(sum('q')))}
        ${kpi('Shares', nf(sum('s')))}
        ${kpi('Ratings', nf(rn), rn ? `avg ${(rs / rn).toFixed(1)} ★` : '')}
        ${kpi('Reports', nf(sum('rp')))}
        ${s.rank ? kpi('District rank', `#${nf(s.rank.rank)}`, `of ${nf(s.rank.of)} rated in ${s.rank.area}`) : ''}
      </div>
      <div class="grid-2" style="margin-top:4px">
        <div>${spark(s.series, 'v', 'Page views per day')}</div>
        <div>${spark(s.series, 'd', 'Direction requests per day')}</div>
        <div>${spark(s.series, 'rn', 'Ratings per day')}</div>
        <div>${spark(s.series, 'rp', 'Reports per day')}</div>
      </div>`;
  }

  async function loadWashroomStats() {
    const ids = B.dash.washrooms.filter((w) => w.analyticsUntil).map((w) => w.id);
    await Promise.all(ids.map(async (id) => {
      const r = await api(`/api/business?action=analytics&id=${encodeURIComponent(id)}`);
      B.wrStats[id] = r.ok ? r.j : { error: r.j.error || 'Analytics unavailable right now.' };
      const box = $(`[data-wrstats="${CSS.escape(id)}"]`);
      if (box) box.innerHTML = wrStatsHTML(id);
    }));
  }

  // ------------------------------------------------------------------ orders & UPI payment
  function ordersHTML() {
    const d = B.dash;
    if (!d.orders.length) return '<div class="muted-box">No orders yet. Services you buy for your washrooms and ads you create appear here with their payment status.</div>';
    const firstUnpaid = d.orders.find((o) => o.status === 'awaiting_payment');
    const openId = B.openOrder || (firstUnpaid && firstUnpaid.id);
    let h = '';
    if (!d.upi) h += `<div class="notice-box" style="margin-bottom:12px">${ic('info')}<p>Online UPI payment isn’t set up on this site yet. Our team will contact you at <b>${esc(d.profile.email)}</b> with an invoice. Once you’ve paid, enter the payment reference on the order.</p></div>`;
    for (const o of d.orders) {
      const [label, tone] = ORDER_ST[o.status] || [o.status, ''];
      const expanded = o.id === openId && (o.status === 'awaiting_payment' || o.status === 'payment_submitted');
      let body = '';
      if (o.status === 'awaiting_payment' || o.status === 'payment_submitted') body = payPanelHTML(o, expanded);
      else if (o.status === 'active') body = `<p class="small" style="margin:8px 0 0">${ic('check', 'sm')} Paid ${o.paidAt ? esc(fmtDate(o.paidAt)) : ''}${o.until ? ` · active until <b>${esc(fmtDate(o.until))}</b>` : ''}</p>`;
      else if (o.status === 'inspection') body = `<p class="small" style="margin:8px 0 0">${ic('check', 'sm')} Paid. Our inspector will contact you on ${esc(fmtPhone(d.profile.phone))} to schedule the visit.</p>`;
      else if (o.status === 'completed') body = `<p class="small" style="margin:8px 0 0"><span class="st ${o.result === 'passed' ? 'good' : 'bad'}">${o.result === 'passed' ? 'Passed' : 'Not passed'}</span> ${o.note ? esc(o.note) : ''}</p>`;
      else if (o.status === 'rejected') body = `<div class="notice-box warn" style="margin-top:8px">${ic('alert')}<p>${esc(o.note || 'This order wasn’t approved.')} If you already paid, we’ll refund you.</p></div>`;
      h += `<article class="item" id="order-${esc(o.id)}" aria-labelledby="ot-${esc(o.id)}">
        <div class="item-top">
          <div style="display:flex;gap:10px;align-items:flex-start;min-width:0"><span class="o-ico" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);flex:none">${ic(KIND_ICON[o.kind] || 'rupee')}</span>
            <div style="min-width:0"><h3 id="ot-${esc(o.id)}" tabindex="-1">${esc(o.label)}</h3><div class="meta">${esc(o.targetName || o.target)} · ${esc(rupees(o.amount))} · ordered ${esc(fmtDate(o.at))} · #${esc(o.id)}</div></div></div>
          <span class="st ${tone}">${esc(label)}</span>
        </div>
        ${body}
      </article>`;
    }
    return h;
  }

  function payPanelHTML(o, expanded) {
    const d = B.dash;
    const note = `Swachh Scan ${o.id}`;
    const link = d.upi ? upiLink(d.upi, o.amount, note) : '';
    const submitted = o.status === 'payment_submitted';
    let h = `<details class="more" data-paydetails="${esc(o.id)}"${expanded || submitted ? ' open' : ''}><summary>${submitted ? 'Payment details' : `Pay ${esc(rupees(o.amount))}`}</summary><div style="margin-top:12px">`;
    if (submitted) h += `<div class="notice-box" style="margin-bottom:12px">${ic('clock')}<p>Thanks! We’re checking your payment (reference <b>${esc(o.utr)}</b>). This usually takes less than a working day. Wrong reference? Correct it below.</p></div>`;
    if (d.upi && !submitted) {
      h += `<div class="pay-box">
        <canvas data-upi="${esc(link)}" width="168" height="168" role="img" aria-label="UPI QR code to pay ${esc(rupees(o.amount))} to ${esc(d.upi.name)}"></canvas>
        <div class="pay-info">
          <div><b>Scan with any UPI app</b><div class="small muted">Google Pay, PhonePe, Paytm, BHIM or your bank’s app.</div></div>
          <a class="btn primary" href="${esc(link)}">${ic('rupee')} Pay ${esc(rupees(o.amount))} with UPI</a>
          <div class="small muted">On a phone, the button opens your UPI app with everything filled in.</div>
          <div><div class="small muted">Or pay to UPI ID</div><div class="row"><span class="upi-id">${esc(d.upi.id)}</span><button class="btn sm ghost" type="button" data-copy="${esc(d.upi.id)}">${ic('copy', 'sm')} Copy</button></div>
          <div class="small muted">Amount ${esc(rupees(o.amount))} · add the note “${esc(note)}”</div></div>
        </div>
      </div>`;
    } else if (!d.upi && !submitted) {
      h += `<div class="muted-box">We’ll email an invoice for ${esc(rupees(o.amount))} to ${esc(d.profile.email)}. After paying, enter the payment reference here.</div>`;
    }
    h += `<form class="inline-form" data-utr="${esc(o.id)}" style="margin-top:14px">
        <label class="field"><span>UPI reference (UTR)</span><input class="input" name="utr" inputmode="numeric" autocomplete="off" maxlength="22" placeholder="12-digit number from your payment app" value="${esc(o.utr || '')}" aria-describedby="utrhelp-${esc(o.id)}"></label>
        <button class="btn primary" type="submit">${submitted ? 'Update reference' : 'I’ve paid'}</button>
        ${o.status === 'awaiting_payment' ? `<button class="btn ghost danger" type="button" data-cancel="${esc(o.id)}">Cancel order</button>` : ''}
      </form>
      <p class="small muted" id="utrhelp-${esc(o.id)}" style="margin:6px 0 0">Find it in your UPI app under the payment’s details (“UPI Ref No.” or “UTR”).</p>
      <p class="form-error" data-err="utr-${esc(o.id)}" role="alert"></p>
    </div></details>`;
    return h;
  }

  function drawQRs() {
    $$('canvas[data-upi]').forEach((c) => {
      qr(c, c.dataset.upi, 168).catch(() => { c.replaceWith(Object.assign(document.createElement('p'), { className: 'small muted', textContent: 'The QR code couldn’t load. Use the UPI ID instead.' })); });
    });
    if (B.openOrder) {
      const el = $(`#order-${CSS.escape(B.openOrder)}`);
      if (el) setTimeout(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
      B.openOrder = null;
    }
  }

  // ------------------------------------------------------------------ offer codes
  function codesHTML() {
    const offers = B.dash.campaigns.filter((a) => a.offer && a.rw);
    return `<div class="card" style="margin-top:0">
        <h2 style="margin:0 0 4px">Check a customer’s offer code</h2>
        <p class="c-sub">Scouts show a code like <b>SS-ABCD-2345</b> when they redeem your offer. Check it, then mark it as used so it can’t be used twice.</p>
        <form class="inline-form" id="codeForm" novalidate>
          <label class="field"><span>Offer code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="SS-ABCD-2345" style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.05em"></label>
          <button class="btn primary" type="submit">Check code</button>
        </form>
        <p class="form-error" data-err="code" role="alert"></p>
        <div class="verify-out" id="codeOut" aria-live="polite"></div>
      </div>
      <h3 class="eyebrow">${ic('ticket')}Your coin offers</h3>
      ${offers.length ? offers.map((a) => `<article class="item"><div class="item-top"><div><h3>${esc(a.offer.title)}</h3><div class="meta">${nf(a.offer.cost)} coins · ${nf(a.offer.stock)} offers · from “${esc(a.title)}”</div></div><span class="st ${campStatus(a)[1]}">${esc(campStatus(a)[0])}</span></div><div class="sub-sec" data-codes="${esc(a.id)}"><div class="small muted">Loading codes…</div></div></article>`).join('')
        : '<div class="muted-box">No coin offers yet. Add one when you create an ad and people can unlock it with the Swachh Coins they earn.</div>'}`;
  }

  function loadOfferCodes() {
    const form = $('#codeForm');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); checkCode(false); });
    return loadCodeLists();
  }
  async function loadCodeLists() {
    const offers = B.dash.campaigns.filter((a) => a.offer && a.rw);
    await Promise.all(offers.map(async (a) => {
      const r = await api(`/api/business?action=analytics&ad=${encodeURIComponent(a.id)}`);
      const box = $(`[data-codes="${CSS.escape(a.id)}"]`);
      if (!box) return;
      if (!r.ok) { box.innerHTML = `<div class="small muted">${esc(r.j.error || 'Couldn’t load codes.')}</div>`; return; }
      const v = r.j.vouchers || [];
      box.innerHTML = v.length
        ? `<h4>Redeemed (${nf(r.j.redeemed)})</h4><div class="tbl-wrap"><table class="data"><thead><tr><th scope="col">Code</th><th scope="col">Redeemed</th><th scope="col">Status</th></tr></thead><tbody>${v.map((x) => `<tr><td><code>${esc(x.code)}</code></td><td>${esc(x.at ? ago(x.at) : '')}</td><td>${x.status === 'used' ? `<span class="st">Used ${x.usedAt ? esc(ago(x.usedAt)) : ''}</span>` : '<span class="st good">Not used yet</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="small muted">Nobody has redeemed this offer yet.</div>';
    }));
  }

  async function checkCode(use) {
    const form = $('#codeForm');
    const err = $('[data-err="code"]');
    const out = $('#codeOut');
    const code = use ? B.lastCode : String(form.elements.code.value || '').toUpperCase().replace(/\s/g, '');
    err.textContent = '';
    if (!/^SS-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code || '')) { err.textContent = 'Codes look like SS-ABCD-2345.'; form.elements.code.focus(); return; }
    B.lastCode = code;
    const btn = use ? $('#useCode') : form.querySelector('[type="submit"]');
    const r = await act('verify-code', use ? { code, use: true } : { code }, btn, err);
    const j = r.j || {};
    // already used: on a check, or when marking it used was refused because another counter or device got there first
    if (j.status === 'used' && (!use || !r.ok || j.ok === false)) {
      err.textContent = '';
      out.innerHTML = `<div class="notice-box warn">${ic('alert')}<p><b>${esc(j.title || 'Offer')}</b> · <span class="voucher-code">${esc(code)}</span><br>This code was already used${j.usedAt ? ` ${esc(ago(j.usedAt))}` : ''}. Don’t accept it again.</p></div>`;
      if (use) { loadCodeLists(); form.elements.code.focus(); }
      return;
    }
    if (!r.ok) { out.innerHTML = ''; if (use) form.elements.code.focus(); return; }
    if (j.status === 'used') {
      out.innerHTML = `<div class="notice-box">${ic('check')}<p><b>Done — ${esc(j.title)}</b> for <span class="voucher-code">${esc(code)}</span> is now marked as used.</p></div>`;
      toast('Code marked as used');
      form.elements.code.value = '';
      form.elements.code.focus();
      loadCodeLists();
    } else {
      out.innerHTML = `<div class="notice-box">${ic('check')}<p><b>Valid: ${esc(j.title)}</b><br><span class="voucher-code">${esc(code)}</span> · redeemed ${esc(j.at ? ago(j.at) : '')}. Give the offer, then mark the code as used.</p></div>
        <button class="btn good" type="button" id="useCode" style="margin-top:10px">${ic('check')} Mark as used</button>`;
      $('#useCode').addEventListener('click', () => checkCode(true));
      $('#useCode').focus();
    }
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const startBtn = t.closest('[data-start]');
    if (startBtn) {
      const label = startBtn.innerHTML;
      startBtn.disabled = true; startBtn.textContent = 'Starting…';
      await start(startBtn.dataset.start);
      if (document.contains(startBtn)) { startBtn.disabled = false; startBtn.innerHTML = label; }
      return;
    }
    const retry = t.closest('[data-act="retry"]');
    if (retry) {
      retry.disabled = true; retry.textContent = 'Trying again…';
      await reload();
      // still failing: the new Try again button; otherwise the dashboard (or the page) heading
      const next = $('#notice [data-act="retry"]') || $('#bizName') || $('#cta button') || $('#hero h1');
      if (next) { if (next.tabIndex < 0 && !next.hasAttribute('tabindex')) next.setAttribute('tabindex', '-1'); next.focus(); }
      return;
    }
    if (!t.closest('#app, #landing')) return;
    const tab = t.closest('[role="tab"]');
    if (tab) { setTab(tab.dataset.tab); return; }
    const go = t.closest('[data-goto]');
    if (go) { if (go.dataset.openOrder) B.openOrder = go.dataset.openOrder; setTab(go.dataset.goto, true); return; }
    const a = t.closest('[data-act]');
    if (a) {
      const act2 = a.dataset.act;
      if (act2 === 'edit-profile') { B.editProfile = !B.editProfile; render(); if (B.editProfile) { const f = $('#profileForm input'); if (f) f.focus(); } else $('[data-act="edit-profile"]').focus(); }
      if (act2 === 'show-landing') { B.showLanding = true; render(); $('#landing').scrollIntoView({ block: 'start', behavior: 'smooth' }); const c = $('#cta button'); if (c) c.focus({ preventScroll: true }); }
      if (act2 === 'hide-landing') { B.showLanding = false; render(); const tb = $(`#tab-${B.tab}`); if (tb) tb.focus(); }
      if (act2 === 'new-ad') { B.adFormOpen = true; renderPanel(); const f = $('#campForm input'); if (f) f.focus(); }
      if (act2 === 'close-ad') { B.adFormOpen = false; renderPanel(); const b = $('[data-act="new-ad"]'); if (b) b.focus(); }
      if (act2 === 'use-loc') useMyLocation(a);
      if (act2 === 'claim-other') { B.claimPick = null; B.claimId = null; B.claimMissing = false; history.replaceState(null, '', `${location.pathname}#washrooms`); const box = $('#claimBox'); box.outerHTML = claimBoxHTML(); wireClaim(); const s = $('#wrSearch'); if (s) s.focus(); }
      return;
    }
    const pick = t.closest('[data-pick]');
    if (pick) {
      B.claimPick = findWashroom(pick.dataset.pick);
      B.claimId = B.claimPick ? B.claimPick.id : null;
      const box = $('#claimBox'); box.outerHTML = claimBoxHTML(); wireClaim();
      const r = $('#claimForm select'); if (r) r.focus();
      return;
    }
    const pay = t.closest('[data-pay]');
    if (pay) { B.openOrder = pay.dataset.pay; setTab('orders'); return; }
    const ord = t.closest('[data-order]');
    if (ord) {
      const err = $(`[data-err="svc-${CSS.escape(ord.dataset.target)}"]`);
      const r = await act('order', { kind: ord.dataset.order, target: ord.dataset.target }, ord, err);
      if (!r.ok) return;
      toast(`${r.j.order.label}: order created. Pay to switch it on.`);
      B.openOrder = r.j.order.id;
      await loadDash(); render(); setTab('orders');
      const h = $(`#ot-${CSS.escape(r.j.order.id)}`);
      if (h) h.focus({ preventScroll: true });
      return;
    }
    const st = t.closest('[data-adstate]');
    if (st) {
      const r = await act('campaign-state', { ad: st.dataset.adstate, state: st.dataset.to }, st, $(`[data-err="${CSS.escape(st.dataset.adstate)}"]`));
      if (r.ok) { toast(st.dataset.to === 'paused' ? 'Campaign paused' : 'Campaign is live again'); await refresh(`[data-adstate="${CSS.escape(st.dataset.adstate)}"]`); }
      return;
    }
    const resp = t.closest('[data-respond]');
    if (resp) {
      const id = resp.dataset.respond;
      const note = ($(`#rn-${CSS.escape(id)}`) || {}).value || '';
      const r = await act('respond', { report: id, status: resp.dataset.status, note }, resp, $(`[data-err="${CSS.escape(id)}"]`));
      if (r.ok) {
        toast(resp.dataset.status === 'resolved' ? 'Report closed as fixed. Thank you!' : 'Report acknowledged');
        const wr = resp.closest('article');
        await refresh(resp.dataset.status === 'ack' ? `[data-respond="${CSS.escape(id)}"][data-status="resolved"]` : wr ? `#${CSS.escape(wr.querySelector('h3').id)}` : null);
      }
      return;
    }
    const cancel = t.closest('[data-cancel]');
    if (cancel) {
      if (!window.confirm('Cancel this order?')) return;
      const r = await act('cancel', { order: cancel.dataset.cancel }, cancel, $(`[data-err="utr-${CSS.escape(cancel.dataset.cancel)}"]`));
      if (r.ok) { toast('Order cancelled'); await refresh(`#ot-${CSS.escape(cancel.dataset.cancel)}`); }
      return;
    }
    const copy = t.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast('UPI ID copied'); } catch (err) { toast('Couldn’t copy. Select the UPI ID and copy it.'); }
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.matches('[data-utr]')) {
      e.preventDefault();
      const id = f.dataset.utr;
      const err = $(`[data-err="utr-${CSS.escape(id)}"]`);
      const utr = f.elements.utr.value.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z0-9]{10,22}$/.test(utr)) { err.textContent = 'Enter the 12-digit UPI reference (UTR) from your payment app.'; f.elements.utr.focus(); return; }
      const r = await act('payref', { order: id, utr }, f.querySelector('[type="submit"]'), err);
      if (r.ok) { toast('Thanks! We’ll confirm your payment soon.'); B.openOrder = id; await refresh(`#ot-${CSS.escape(id)}`); }
    }
    if (f.matches('[data-cleaned]')) {
      e.preventDefault();
      const id = f.dataset.cleaned;
      const r = await act('cleaned', { id, note: f.elements.note.value.trim() }, f.querySelector('[type="submit"]'), $(`[data-err="clean-${CSS.escape(id)}"]`));
      if (r.ok) { toast(r.j.resolved ? `Marked as cleaned · ${r.j.resolved} report${r.j.resolved > 1 ? 's' : ''} closed` : 'Marked as cleaned'); await refresh(`form[data-cleaned="${CSS.escape(id)}"] [type="submit"]`); }
    }
  });

  // arrow keys move between tabs (WAI-ARIA tabs pattern)
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab) return;
    const i = TABS.findIndex((t) => t.id === tab.dataset.tab);
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    setTab(TABS[n].id, true);
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    const p = new URLSearchParams(location.search);
    const claim = p.get('claim');
    if (claim && claim.length <= 40) { B.claimId = claim; B.tab = 'washrooms'; }
    const h = location.hash.slice(1);
    if (!claim && TABS.some((t) => t.id === h)) B.tab = h;
    await loadPlans();
    if (B.enabled) await loadDash();
    if (B.claimId && !(B.dash && B.dash.profile)) {
      // show which washroom is being claimed even before sign-up
      loadWashrooms().then(() => { B.claimPick = findWashroom(B.claimId); if (!B.claimPick) B.claimMissing = true; if (!(B.dash && B.dash.profile)) render(); }).catch(() => {});
    }
    render();
  }
  boot();
})();
