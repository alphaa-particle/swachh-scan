/* Shared helpers for every page (no framework, no build step): formatting, storage, the API client,
   the Swachh Scout profile on this device, coin toasts, usage events, theme, and the site header / tab bar. */
(function () {
  'use strict';

  const nfmt = new Intl.NumberFormat('en-IN');
  const root = document.documentElement;

  // The basemap for every map on the site (one place to swap it, e.g. for a provider with an API key or one that
  // shows India's official boundaries). OpenStreetMap's tiles are free with attribution for light use.
  const TILES = {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: 'Map &amp; washroom data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)',
    maxZoom: 19,
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function ic(name, cls) {
    return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="/img/icons.svg#i-${name}"/></svg>`;
  }
  function nf(n) { return nfmt.format(n); }
  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }

  /** Read JSON from localStorage; returns the fallback if storage is blocked, corrupt, or holds the wrong type. */
  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (!v) return fallback;
      const parsed = JSON.parse(v);
      const kind = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
      return fallback === undefined || kind(parsed) === kind(fallback) ? parsed : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { if (val === undefined || val === null || val === '') localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  /** 'OSM-N123' -> {type:'node', num:'123'} */
  function osmRef(id) {
    const m = /^OSM-([NWR])(\d+)$/.exec(id || '');
    if (!m) return null;
    return { type: { N: 'node', W: 'way', R: 'relation' }[m[1]], num: m[2] };
  }

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  const fmtDate = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 30) { const d = Math.round(s / 86400); return `${d} day${d === 1 ? '' : 's'} ago`; }
    return fmtDate(t);
  }
  const initials = (name) => (String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?');

  // ------------------------------------------------------------------ theme (device setting unless the user picked one)
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() { const t = root.dataset.theme; return t ? t === 'dark' : darkMQ.matches; }
  function applyTheme() {
    const t = lsGet('ss.theme', '');
    if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
    root.classList.toggle('dark', isDark());
  }
  function setTheme(t) { lsSet('ss.theme', t); applyTheme(); window.dispatchEvent(new Event('ss-theme')); }
  darkMQ.addEventListener('change', () => { applyTheme(); window.dispatchEvent(new Event('ss-theme')); });
  applyTheme();

  // ------------------------------------------------------------------ API client
  /** -> {ok, status, j, enabled}. Never throws. Sends the scout token when there is one. */
  async function api(path, opts) {
    opts = opts || {};
    const headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const tok = opts.token || (opts.auth === false ? '' : Account.token());
    if (tok) headers.authorization = `Bearer ${tok}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 12000);
    try {
      const r = await fetch(path, { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, keepalive: !!opts.keepalive });
      const isJson = (r.headers.get('content-type') || '').includes('json');
      if (!isJson) {
        // a static host answers /api with a page or "not found" / "not supported": there is no server here at all.
        // Anything else (e.g. a 502/504 page from the platform) is a temporary server problem, not "switched off".
        if (r.ok || [404, 405, 501].includes(r.status)) return { ok: false, status: r.status, j: { error: 'This feature needs the site’s server, which isn’t running here.' }, enabled: false, noApi: true };
        return { ok: false, status: r.status, j: { error: 'The server had a problem. Please try again in a minute.' }, enabled: null };
      }
      const j = await r.json().catch(() => ({}));
      if (j && j.enabled === false) return { ok: false, status: r.status, j: { error: 'This feature switches on when the site’s database is connected.' }, enabled: false };
      if (r.status === 401 && j && j.code === 'bad_token' && !opts.token) Account.forget();
      return { ok: r.ok, status: r.status, j: j || {}, enabled: true };
    } catch (e) {
      return { ok: false, status: 0, j: { error: 'Couldn’t reach the server. Check your connection and try again.' }, enabled: null };
    } finally { clearTimeout(timer); }
  }

  // ------------------------------------------------------------------ Swachh Scout profile on this device
  const Account = {
    token() { const t = lsGet('ss.token', ''); return typeof t === 'string' && /^[a-z2-9]{12}\.[A-Za-z0-9_-]{24,64}$/.test(t) ? t : ''; },
    has() { return !!this.token(); },
    cached() { const p = lsGet('ss.profile', {}); return p && typeof p.coins === 'number' ? p : null; },
    save(token, profile) { lsSet('ss.token', token); this.cache(profile); },
    cache(p) {
      if (!p) return;
      const prev = this.cached() || {};
      lsSet('ss.profile', { name: p.name != null ? p.name : prev.name, coins: p.coins != null ? p.coins : prev.coins, earned: p.earned != null ? p.earned : prev.earned, tier: p.tier ? p.tier.name : prev.tier, at: Date.now() });
      renderCoins();
    },
    setCoins(balance) { const p = this.cached() || {}; p.coins = balance; p.at = Date.now(); lsSet('ss.profile', p); renderCoins(true); },
    forget() { lsSet('ss.token', ''); lsSet('ss.profile', ''); renderCoins(); },
    /** Make sure there is a profile (created silently the first time someone earns coins). */
    async ensure() {
      if (this.has()) return { ok: true };
      const ref = lsGet('ss.ref', '');
      const r = await api('/api/me', { body: { action: 'create', ref: ref || undefined }, auth: false });
      if (!r.ok) return { ok: false, enabled: r.enabled, error: r.j.error };
      this.save(r.j.token, r.j.profile);
      lsSet('ss.newProfile', true);
      return { ok: true, created: true, profile: r.j.profile };
    },
    async refresh() {
      if (!this.has()) return null;
      const r = await api('/api/me');
      if (r.ok) { this.cache(r.j.profile); return r.j; }
      return null;
    },
  };

  // ------------------------------------------------------------------ toast (with a coin variant)
  let toastTimer = 0;
  function toast(msg, opts) {
    opts = opts || {};
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.classList.toggle('coins', !!opts.coins);
    if (opts.html) t.innerHTML = opts.html; else t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), opts.ms || 3800);
  }
  /** "+15 Swachh Coins" after an action; updates the coin pill. coins = {awarded, balance, got:[{c, d}]} */
  function coinToast(coins, lead) {
    if (!coins) { if (lead) toast(lead); return; }
    if (typeof coins.balance === 'number') Account.setCoins(coins.balance);
    const earned = (coins.got || []).filter((g) => g.c > 0);
    if (!earned.length) { if (lead) toast(lead); return; }
    const total = earned.reduce((a, g) => a + g.c, 0);
    const extra = earned.length > 1 ? earned.slice(1).map((g) => g.d).join(' · ') : '';
    toast('', { coins: true, ms: 5200, html: `<span class="coin" aria-hidden="true">S</span><span><b>+${nf(total)} Swachh Coins</b>${lead ? ` · ${esc(lead)}` : ''}${extra ? `<br><small>${esc(extra)}</small>` : ''}</span>` });
  }

  // ------------------------------------------------------------------ usage events (views, directions, calls…) for operator analytics
  const Track = {
    q: [], seen: new Set(), off: false, timer: 0,
    add(target, type, onceKey) {
      if (this.off || !target) return;
      const k = onceKey || `${target}:${type}`;
      if (this.seen.has(k)) return;
      this.seen.add(k);
      this.q.push([target, type]);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 8000);
    },
    flush(keepalive) {
      if (!this.q.length || this.off) return;
      const e = this.q.splice(0, 40);
      api('/api/business', { body: { action: 'events', e }, auth: false, keepalive: !!keepalive, timeout: 8000 }).then((r) => {
        if (r.enabled === false) { this.off = true; return; } // no server or no database: stop collecting
        if (!r.ok && this.q.length < 200) { this.q.unshift(...e); clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 30000); } // try again later
      });
    },
  };
  window.addEventListener('pagehide', () => Track.flush(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) Track.flush(true); });

  // ------------------------------------------------------------------ scripts loaded on demand (QR codes, maps)
  const scripts = {};
  function loadScript(src, integrity) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.onload = () => res();
      s.onerror = () => { delete scripts[src]; rej(new Error('Script failed to load')); };
      document.head.appendChild(s);
    });
    return scripts[src];
  }
  async function qr(canvas, value, size) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js', 'sha256-25ncr0CpJhgbzkUiR3wu/Fkk9sSykRG2qX+upHfJUos=');
    // padding gives the quiet zone scanners need when the code is printed
    return new window.QRious({ element: canvas, value, size: size || 280, padding: Math.round((size || 280) / 9), level: 'M', background: '#ffffff', foreground: '#000000' });
  }
  function upiLink(upi, amount, note) {
    return `upi://pay?pa=${encodeURIComponent(upi.id).replace(/%40/g, '@')}&pn=${encodeURIComponent(upi.name || 'Swachh Scan')}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
  }

  // ------------------------------------------------------------------ dialogs
  let dialogReturn = null, dialogReturnSel = null;
  /** returnTo: a selector (or element) to focus when the dialog closes, for when the opener is re-rendered or hidden. */
  function openDialog(d, returnTo) {
    dialogReturn = typeof returnTo === 'object' && returnTo ? returnTo : document.activeElement;
    dialogReturnSel = typeof returnTo === 'string' ? returnTo : null;
    d.showModal();
    const first = d.querySelector('[autofocus], input:not([type="hidden"]), a[href], button:not([data-close])');
    if (first) first.focus();
  }
  function wireDialogs() {
    document.querySelectorAll('dialog:not([data-wired])').forEach((d) => {
      d.dataset.wired = '1';
      d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
      d.addEventListener('close', () => {
        let t = dialogReturn && dialogReturn.isConnected && dialogReturn.offsetParent !== null ? dialogReturn : null;
        if (!t && dialogReturnSel) t = document.querySelector(dialogReturnSel);
        if (t) t.focus();
        dialogReturn = null; dialogReturnSel = null;
      });
    });
  }

  // ------------------------------------------------------------------ site header, tab bar, menu
  const NAV = [
    { href: '/', label: 'Map', short: 'Map', icon: 'map' },
    { href: '/leaderboard.html', label: 'Leaderboard', short: 'Ranks', icon: 'trophy' },
    { href: '/me.html', label: 'Rewards', short: 'Rewards', icon: 'gift' },
    { href: '/business.html', label: 'For business', icon: 'store' },
    { href: '/civic.html', label: 'Civic dashboard', icon: 'landmark' },
  ];
  const here = () => {
    let p = location.pathname || '/';
    if (p === '/index.html') p = '/';
    if (p !== '/' && !p.endsWith('.html')) p += '.html'; // clean URLs (/me) -> /me.html
    return p;
  };
  function renderChrome() {
    const cur = here();
    const isCur = (href) => (href === '/' ? cur === '/' : cur === href);
    const head = document.getElementById('siteHead');
    if (head) {
      head.className = 'site-head';
      head.innerHTML = `<a class="brand" href="/" aria-label="Swachh Scan home"><img class="brand-mark" src="/favicon.svg" alt="" width="30" height="30"><span>Swachh<b>Scan</b></span></a>
        <nav class="site-nav" aria-label="Main">${NAV.map((n) => `<a href="${n.href}"${isCur(n.href) ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('')}</nav>
        <div class="head-right"><a class="coin-pill" data-coins href="/me.html"></a></div>`;
    }
    const tab = document.getElementById('tabbar');
    if (tab) {
      tab.className = 'tabbar';
      tab.setAttribute('aria-label', 'Main');
      tab.innerHTML = NAV.slice(0, 3).map((n) => `<a href="${n.href}"${isCur(n.href) ? ' aria-current="page"' : ''}>${ic(n.icon)}<span>${esc(n.short)}</span></a>`).join('')
        + `<button type="button" data-menu${['/business.html', '/civic.html'].includes(cur) ? ' aria-current="page"' : ''}>${ic('menu')}<span>More</span></button>`;
      document.body.classList.add('has-tabbar');
    }
    if (!document.getElementById('menuDialog')) {
      const d = document.createElement('dialog');
      d.id = 'menuDialog';
      d.setAttribute('aria-labelledby', 'menuTitle');
      d.innerHTML = `<div class="dlg"><button class="icon-btn close" type="button" data-close aria-label="Close">${ic('x')}</button>
        <h2 id="menuTitle">Swachh Scan</h2>
        <ul class="menu-list">
          ${NAV.map((n) => `<li><a href="${n.href}">${ic(n.icon)}<span>${esc(n.label)}<small>${{ '/': 'Find a clean washroom near you', '/leaderboard.html': 'Top scouts and the Honor Roll', '/me.html': 'Your coins, badges and rewards', '/business.html': 'Advertise nearby, manage your washrooms', '/civic.html': 'Washrooms that need cleaning' }[n.href]}</small></span></a></li>`).join('')}
        </ul>
        <h3 class="eyebrow" style="margin-top:18px">Appearance</h3>
        <div class="seg" role="radiogroup" aria-label="Appearance">${[['', 'Device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}"${lsGet('ss.theme', '') === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <p class="rate-note" style="margin-top:14px"><a href="/admin.html">Admin</a></p>
      </div>`;
      document.body.appendChild(d);
      d.addEventListener('change', (e) => { if (e.target.name === 'theme') setTheme(e.target.value); });
    }
    wireDialogs();
    document.addEventListener('click', (e) => { if (e.target.closest('[data-menu]')) openDialog(document.getElementById('menuDialog')); });
    renderCoins();
    // coins can be earned elsewhere (a washroom approved, a report confirmed fixed): refresh a balance older than a minute
    const p = Account.cached();
    if (Account.has() && p && Date.now() - (p.at || 0) > 60e3) Account.refresh();
  }
  let shownCoins = null, refreshing = false;
  function renderCoins(bump) {
    const p = Account.cached();
    // a profile on this device but no cached balance (e.g. restored elsewhere, storage trimmed): fetch it once
    if (Account.has() && !p && !refreshing) { refreshing = true; Account.refresh().finally(() => { refreshing = false; }); }
    document.querySelectorAll('[data-coins]').forEach((el) => {
      if (Account.has()) {
        el.classList.remove('join');
        el.innerHTML = `<span class="coin" aria-hidden="true">S</span>${p ? nf(p.coins || 0) : '…'}`;
        el.setAttribute('aria-label', p ? `${nf(p.coins || 0)} Swachh Coins. Open your rewards` : 'Your Swachh Coins');
        if (bump && shownCoins !== p.coins && el.animate) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 450 });
      } else {
        el.classList.add('join');
        el.innerHTML = `${ic('gift', 'sm')} Earn coins`;
        el.setAttribute('aria-label', 'Earn Swachh Coins');
      }
    });
    shownCoins = p ? p.coins : null;
  }

  // someone opened an invite link: remember the code until a profile is created
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref && /^[A-Za-z2-9]{6}$/.test(ref) && !Account.has()) lsSet('ss.ref', ref.toUpperCase());
  } catch (e) { /* ignore */ }

  window.SS = {
    TILES, esc, ic, nf, pct, lsGet, lsSet, osmRef, fetchJSON, fmtDate, fmtDateTime, ago, initials,
    api, Account, toast, coinToast, Track, loadScript, qr, upiLink, openDialog, wireDialogs, isDark, setTheme, renderChrome, renderCoins,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderChrome); else renderChrome();
})();
