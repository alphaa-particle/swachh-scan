/* Swachh Scan — map app. Plain JS + Leaflet; reads /data/washrooms.json. */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);

  // If the map libraries didn't load (CDN blocked, offline, failed integrity check) say so instead of a blank page.
  if (!window.L || !window.L.heatLayer || !window.SS) {
    const box = document.getElementById('loading');
    if (box) box.innerHTML = '<div style="text-align:center;padding:24px;max-width:340px">The map couldn’t load. Check your internet connection and refresh the page.</div>';
    return;
  }
  const { esc, ic, nf, lsGet, lsSet, osmRef, fetchJSON } = window.SS;
  const SSX = window.SS;
  const toast = (msg) => SSX.toast(msg);

  // ------------------------------------------------------------------ config
  const INDIA = [[6.5, 68.0], [35.7, 97.5]];
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The basemap is SS.TILES in common.js (shared by every map on the site). Dark mode darkens it with a CSS filter.
  const LIST_LIMIT = 60;
  // Coin values and limits come from the server (/api/state rules, set in api/_lib/config.js); these are the fallbacks
  // until it answers, so the map never promises a different number from the one the server pays.
  const COINS = { rate: 10, firstRating: 5, report: 5, place: 50 };
  const LIMITS = { ratingsRewardedPerDay: 10, reportsRewardedPerDay: 5 };
  const RATE_COOLDOWN = 7 * 864e5; // coins for rating the same washroom: once every 7 days
  const REPORT_GAP = 12 * 3600e3; // one report per washroom per scout every 12 hours
  function setRules(rules) {
    if (!rules || typeof rules !== 'object') return;
    const take = (dst, src) => { if (src && typeof src === 'object') for (const k of Object.keys(dst)) if (Number.isFinite(src[k]) && src[k] >= 0) dst[k] = src[k]; };
    take(COINS, rules.coins);
    take(LIMITS, rules.limits);
  }
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
  const motion = (o) => Object.assign({ animate: !REDUCED }, o);

  // ------------------------------------------------------------------ state
  const S = {
    items: [], byId: new Map(), filtered: [], total: 0, withHours: [],
    f: blankFilters(), me: null, selected: null, lastSelectedId: null, view: 'list',
    places: [], downloaded: null, areas: null, alias: new Map(), pendingRate: null, pendingId: null, sort: 'near',
  };

  function blankFilters() {
    return {
      q: '', type: '', cat: '', state: '', district: '', fee: '', open: '', access: '',
      wc: '', g: '', baby: false, western: false, indian: false, urinal: false,
      hw: false, tp: false, dw: false, sh: false, disp: '', minq: 0, since: '',
      rated: false, stars4: false, verified: false,
    };
  }

  // ------------------------------------------------------------------ labels
  const L_WC = { yes: 'Accessible', limited: 'Limited access', no: 'Not accessible' };
  const L_G = { separate: 'Separate men & women', men: 'Men only', women: 'Women only', unisex: 'Unisex' };
  const L_YN = { yes: 'Yes', no: 'No', limited: 'Limited' };

  function styleLabel(ts) {
    if (!ts) return null;
    if (ts === 'U') return 'Urinals only';
    const p = [];
    if (ts.includes('I')) p.push('Indian (squat)');
    if (ts.includes('W')) p.push('Western (seated)');
    if (ts.includes('U')) p.push('urinals');
    return p.join(' + ').replace(/^./, (c) => c.toUpperCase());
  }

  function placeLine(it, max) {
    const parts = [];
    const add = (v) => {
      if (!v) return;
      const lv = v.toLowerCase();
      if (parts.some((p) => p.toLowerCase().includes(lv))) return;
      parts.push(v);
    };
    add(it.a); add(it.city); add(it.d); add(it.st);
    return parts.slice(0, max || parts.length).join(', ');
  }

  function kindLabel(it) {
    if (!it.s) return `Toilet inside: ${it.c}`;
    // a generic name ("Public toilet") already says what it is, so show where it is instead
    return it.gen ? `Public toilet · ${placeLine(it, 2) || it.st}` : 'Public toilet';
  }

  // ------------------------------------------------------------------ time & hours (always India time)
  const istFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let NOW = null;
  function tickNow() {
    const parts = istFmt.formatToParts(new Date());
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const day = DAYS.indexOf(get('weekday'));
    const min = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
    NOW = { day: day < 0 ? 0 : day, min, key: `${day}-${min}`, t: Date.now() };
    return NOW;
  }
  /** The current IST time, refreshed if it is more than 20 s old (so idle tabs never show stale open/closed). */
  function now() { return !NOW || Date.now() - NOW.t > 20000 ? tickNow() : NOW; }

  function fmtTime(min) {
    if (min >= 1440 || min === 0) return 'midnight';
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`;
  }

  /** -> {open:true|false, text, tone} or null when hours are unknown */
  function hoursStatus(sc, t, soe) {
    if (!sc) return null;
    if (sc === '24/7') return { open: true, text: 'Open 24 hours', tone: 'good' };
    const openEnded = (d, e) => (soe || []).some(([od, oe]) => od === d && oe === e); // OSM "18:00+": closes at 18:00 or later
    const nextOpening = () => {
      for (let k = 0; k < 8; k++) {
        const d = (t.day + k) % 7;
        for (const [s] of sc[d] || []) {
          if (k === 0 && s <= t.min) continue;
          return { s, when: k === 0 ? '' : k === 1 ? ' tomorrow' : k === 7 ? ` next ${DAYS[d]}` : ` ${DAYS[d]}` };
        }
      }
      return null;
    };
    for (const [s, e] of sc[t.day] || []) {
      if (t.min < s || t.min >= e) continue;
      if (openEnded(t.day, e)) {
        return { open: true, text: e === 1440 ? 'Open · closing time not mapped' : `Open · closes ${fmtTime(e)} or later`, tone: 'good' };
      }
      // follow an interval that runs to midnight into the next day's 00:00 interval
      let d = t.day, end = e, hops = 0;
      while (end === 1440 && hops < 7) {
        const nd = (d + 1) % 7, first = (sc[nd] || [])[0];
        if (!first || first[0] !== 0) break;
        d = nd; end = first[1]; hops++;
      }
      if (end === 1440 && hops === 7) return { open: true, text: 'Open 24 hours', tone: 'good' };
      const remaining = hops * 1440 + end - t.min; // minutes until closing, across days
      const when = hops === 0 ? '' : hops === 1 ? ' tomorrow' : hops === 7 ? ` next ${DAYS[d]}` : ` ${DAYS[d]}`;
      return { open: true, text: `Open · closes ${fmtTime(end)}${when}`, tone: remaining <= 30 ? 'warn' : 'good' };
    }
    // not inside any opening interval. If the last one had an open-ended close we can't say it's closed.
    const today = sc[t.day] || [];
    const earlier = today.filter(([, e]) => e <= t.min);
    const yday = sc[(t.day + 6) % 7] || [];
    const last = earlier.length ? [t.day, earlier[earlier.length - 1]] : yday.length && yday[yday.length - 1][1] === 1440 ? [(t.day + 6) % 7, yday[yday.length - 1]] : null;
    const next = nextOpening();
    if (last && openEnded(last[0], last[1][1])) {
      return { open: null, text: `Closing time not mapped${next ? ` · opens ${fmtTime(next.s)}${next.when}` : ''}`, tone: 'warn' };
    }
    if (next) return { open: false, text: `Closed · opens ${fmtTime(next.s)}${next.when}`, tone: 'bad' };
    return { open: false, text: 'Closed', tone: 'bad' };
  }

  function statusOf(it) {
    if (!it.sc) return null;
    const t = now();
    if (it._stk !== t.key) { it._st = hoursStatus(it.sc, t, it.soe); it._stk = t.key; }
    return it._st;
  }

  function ago(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (months < 1) return 'this month';
    if (months < 12) return `${Math.round(months)} month${Math.round(months) === 1 ? '' : 's'} ago`;
    const y = Math.floor(months / 12);
    return `${y} year${y === 1 ? '' : 's'} ago`;
  }
  const fmtDate = (dateStr) => new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  // ------------------------------------------------------------------ geo
  function distKm(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fmtDist(km) {
    if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${nf(Math.round(km))} km`;
  }
  function walkMin(km) { return km <= 3 ? `${Math.max(1, Math.round((km * 1.25) / 0.08))} min walk` : ''; }

  // ------------------------------------------------------------------ small DOM helpers
  /** Re-render a container without losing keyboard focus on the control the user was on. */
  function keepFocus(container, render) {
    const a = document.activeElement;
    let sel = null;
    if (a && a !== document.body && container.contains(a)) {
      const ds = a.dataset || {};
      for (const k of ['id', 'chip', 'area', 'act', 'i']) {
        if (ds[k] != null) { sel = `[data-${k}="${window.CSS && CSS.escape ? CSS.escape(ds[k]) : ds[k]}"]`; break; }
      }
      if (!sel && a.id) sel = '#' + a.id;
    }
    render();
    if (sel) { const el = container.querySelector(sel); if (el) el.focus({ preventScroll: true }); }
  }

  function fetchTimeout(url, ms, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(timer));
  }

  // ------------------------------------------------------------------ ratings
  // mode: 'loading' -> 'shared' (API + database), 'local' (no API on this host: saved on this device),
  // or 'unavailable' (API exists but failed right now).
  // Community layer from /api/state: open hygiene reports, recent cleanings, featured & verified washrooms, operators.
  const Community = {
    issues: {}, fixed: {}, featured: new Set(), verified: {}, owned: new Set(), places: [],
    set(j) {
      this.issues = j.issues && typeof j.issues === 'object' ? j.issues : {};
      this.fixed = j.fixed && typeof j.fixed === 'object' ? j.fixed : {};
      this.featured = new Set(Array.isArray(j.featured) ? j.featured : []);
      this.verified = j.verified && typeof j.verified === 'object' ? j.verified : {};
      this.owned = new Set(Array.isArray(j.owned) ? j.owned : []);
      this.places = Array.isArray(j.places) ? j.places : [];
    },
    open(id) { return this.issues[id] || 0; },
  };

  const Ratings = {
    mode: 'loading', data: {}, mine: {}, lastTry: 0,
    get shared() { return this.mode === 'shared'; },
    loadMine() {
      const m = lsGet('ss.myRatings', {});
      this.mine = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
      for (const k of Object.keys(this.mine)) {
        const v = this.mine[k];
        if (!v || typeof v !== 'object' || !Number.isInteger(v.stars)) delete this.mine[k];
      }
    },
    async init() {
      this.lastTry = Date.now();
      try {
        const r = await fetchTimeout('/api/state', 6000, { headers: { accept: 'application/json' } });
        const isJson = (r.headers.get('content-type') || '').includes('json');
        // a static host (no server functions) answers with a page or "not found / not supported" — same rule as SS.api
        if (r.status === 404 || (!isJson && (r.ok || r.status === 405 || r.status === 501))) { this.mode = 'local'; return; }
        if (!r.ok || !isJson) { this.mode = 'unavailable'; return; } // e.g. a 502/504 page: a temporary problem
        const j = await r.json();
        if (!j || !j.enabled) { this.mode = 'local'; return; }
        this.data = j.ratings && typeof j.ratings === 'object' ? j.ratings : {};
        Community.set(j);
        setRules(j.rules);
        this.mode = 'shared';
      } catch (e) {
        this.mode = 'unavailable';
      }
    },
    summary(id) {
      const mine = this.mine[id] || null;
      const yn = (v) => (v === true ? [1, 0] : v === false ? [0, 1] : [0, 0]);
      const fromMine = (m) => ({ n: 1, avg: m.stars, water: yn(m.water), soap: yn(m.soap), safe: yn(m.safe) });
      if (this.mode === 'shared') {
        const s = this.data[id];
        if (s && s.n) return { n: s.n, avg: s.sum / s.n, water: s.water, soap: s.soap, safe: s.safe, mine };
        // our own accepted rating may not be in a (briefly cached) GET yet
        // an accepted rating may be missing from the (briefly cached) GET for a few minutes
        if (mine && mine.shared && !mine.blocked && !mine.pending && Date.now() - mine.at < 6 * 60e3) return Object.assign(fromMine(mine), { mine });
        return mine ? { n: 0, mine } : null;
      }
      if (this.mode === 'local' && mine) return Object.assign(fromMine(mine), { mine, local: true });
      return null;
    },
    avg(id) { const s = this.summary(id); return s && s.n ? s.avg : null; },
    /** startsCooldown: the server took this rating from our Scout profile, which starts its 7-day coin cooldown
        for this washroom unless one is already running (the server keeps the first one: SET … NX). */
    remember(id, r, startsCooldown) {
      const now = Date.now();
      let coinAt = this.coinStart(id);
      if (startsCooldown && !(coinAt && now - coinAt < RATE_COOLDOWN)) coinAt = now;
      this.mine[id] = Object.assign({}, r, { at: now, coinAt: coinAt || 0 });
      lsSet('ss.myRatings', this.mine);
    },
    coinStart(id) {
      const m = this.mine[id];
      if (!m) return 0;
      if (Number.isFinite(m.coinAt)) return m.coinAt;
      return m.shared && !m.blocked && Number.isFinite(m.at) ? m.at : 0; // saved before coinAt existed: assume the last rating
    },
    /** When rating this washroom earns coins again (0 = it does now). No profile yet: the new one starts fresh. */
    coinsFrom(id) {
      if (!SSX.Account.has()) return 0;
      const t = this.coinStart(id);
      return t && Date.now() - t < RATE_COOLDOWN ? t + RATE_COOLDOWN : 0;
    },
    /** Only ratings the server accepted (or refused as a same-day duplicate) block another one today. */
    ratedToday(id) {
      const m = this.mine[id];
      if (!m || !m.shared) return false;
      if (m.pending) return Date.now() - m.at < 6 * 60e3; // unconfirmed: wait a few minutes, then offer the form again
      return Date.now() - m.at < 864e5;
    },
    pending(id) { const m = this.mine[id]; return !!(m && m.pending && this.ratedToday(id)); },
    async submit(id, r) {
      if (this.mode === 'local') { this.remember(id, Object.assign({}, r, { shared: false })); return { ok: true, local: true }; }
      if (this.mode !== 'shared') return { ok: false, error: 'Ratings are unavailable right now. Please try again in a little while.' };
      try {
        // the first rating creates this device's Swachh Scout profile, so the coins have somewhere to go
        const acct = await SSX.Account.ensure();
        const res = await SSX.api('/api/ratings', { body: Object.assign({ id }, r), timeout: 10000 });
        if (res.status === 0) throw new Error('offline');
        const j = res.j;
        if (j.rating) this.data[id] = j.rating;
        if (res.ok) {
          if (j.auth === false) SSX.Account.forget();
          this.remember(id, Object.assign({}, r, { shared: true }), !!j.coins); // coins come back only for a recognised profile
          return { ok: true, coins: j.coins, created: !!acct.created, authLost: j.auth === false };
        }
        if (j.code === 'maybe_saved') {
          // the server may have stored it; don't invite a second rating that could be counted twice
          this.remember(id, Object.assign({}, r, { shared: true, pending: true }), SSX.Account.has());
          return { ok: false, final: true, error: j.error };
        }
        if (j.code === 'already_rated') {
          this.remember(id, Object.assign({}, r, { shared: true, blocked: true }));
          return { ok: false, final: true, error: j.error || 'This washroom was already rated from your network today.' };
        }
        return { ok: false, error: j.error || 'Couldn’t save your rating. Please try again.' };
      } catch (e) {
        return { ok: false, error: 'Couldn’t reach the server. Check your connection and try again.' };
      }
    },
  };

  /** Problems this device reported recently: the server takes one report per washroom per scout every 12 hours.
      Kept per Scout profile ({id: {t, u}}), since a new or restored profile has its own allowance. */
  const uidNow = () => SSX.Account.token().split('.')[0];
  const Reports = {
    mine: {},
    load() {
      const m = lsGet('ss.myReports', {});
      this.mine = {};
      for (const [k, v] of Object.entries(m || {})) if (v && Number.isFinite(v.t) && Date.now() - v.t < REPORT_GAP) this.mine[k] = { t: v.t, u: String(v.u || '') };
    },
    remember(id) { this.load(); this.mine[id] = { t: Date.now(), u: uidNow() }; lsSet('ss.myReports', this.mine); },
    /** When this washroom can be reported again (0 = now). */
    until(id) { const v = this.mine[id]; return v && v.u === uidNow() && Date.now() - v.t < REPORT_GAP ? v.t + REPORT_GAP : 0; },
  };

  // ------------------------------------------------------------------ map
  const map = L.map('map', { zoomControl: false, zoomSnap: 0.5, minZoom: isMobile() ? 3.5 : 4, maxBounds: [[-5, 55], [45, 110]], maxBoundsViscosity: 0.7 });
  map.fitBounds(INDIA);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer(SSX.TILES.url, { maxZoom: SSX.TILES.maxZoom, attribution: SSX.TILES.attribution }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  // the container can change size (layout settling, phone rotation, sidebar) — keep Leaflet in sync
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById('map'));

  /** Pin markup: the visible "WC" is decorative; screen readers get the washroom's name instead. */
  const pinFlags = (it) => `${Community.featured.has(it.id) ? ' feat' : ''}${Community.open(it.id) ? ' issue' : ''}${it.src === 'c' ? ' comm' : ''}`;
  const pinHTML = (fac, sel, name, flags) => `<div class="pin${fac ? ' fac' : ''}${sel ? ' sel' : ''}${flags || ''}"><span aria-hidden="true">WC</span>${name ? `<span class="visually-hidden">${esc(name)}</span>` : ''}</div>`;
  const selIcon = (it) => L.divIcon({ className: 'pin-wrap', html: pinHTML(!it.s, true, '', pinFlags(it)), iconSize: [26, 26], iconAnchor: [13, 13] });
  const pinIcon = (it) => L.divIcon({ className: 'pin-wrap', html: pinHTML(!it.s, false, `${it.n}${it.s ? '' : `, ${it.c}`}${Community.featured.has(it.id) ? ', featured' : ''}${Community.open(it.id) ? ', problem reported' : ''}`, pinFlags(it)), iconSize: [26, 26], iconAnchor: [13, 13] });
  /** Featured / problem badges arrive after the pins are drawn: refresh the icons that exist. */
  function refreshPinIcons() { for (const it of S.items) if (it._m) it._m.setIcon(pinIcon(it)); }

  // Zoomed out: a density heatmap (nothing pops open while scrolling). Street level: one pin per washroom.
  const PIN_ZOOM = 14;
  // single-hue sequential teal ramp over a muted basemap
  const RAMPS = {
    dark: { 0.15: '#0f5a4c', 0.4: '#139a80', 0.7: '#45d1ad', 1: '#d4f8ec' },
    light: { 0.15: '#a6dfd1', 0.4: '#3fb497', 0.7: '#0f8670', 1: '#073f35' },
  };
  let HEAT_GRADIENT = SSX.isDark() ? RAMPS.dark : RAMPS.light;
  const heat = L.heatLayer([], { radius: 13, blur: 15, maxZoom: PIN_ZOOM, minOpacity: 0.35, gradient: HEAT_GRADIENT });
  const pins = L.layerGroup();
  const inPinMode = () => map.getZoom() >= PIN_ZOOM;

  // a small legend / hint while the heatmap is showing
  const legendHTML = () => {
    const stops = Object.entries(HEAT_GRADIENT).sort((x, y) => x[0] - y[0]).map(([k, c]) => `${c} ${Math.round(k * 100)}%`).join(', '); // "1" sorts first in object key order
    return `<div class="map-hint-row"><span>Fewer</span><span class="heat-key" style="background:linear-gradient(90deg, ${stops})"></span><span>More</span></div><div class="map-hint-sub">Zoom in or tap the map to see each washroom</div>`;
  };
  // the ramp runs light→dark on the light map and dark→bright on the dark one, so the words follow the theme
  const legendLabel = () => `Heatmap legend: ${SSX.isDark() ? 'darker teal means fewer washrooms, brighter teal means more' : 'paler teal means fewer washrooms, darker teal means more'}. Zoom in or tap the map to see each washroom.`;
  const HintControl = L.Control.extend({
    // on phones the bottom of the map is the busy part (sheet, attribution), so the legend sits top-left under the chips
    options: { position: isMobile() ? 'topleft' : 'bottomleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'map-hint');
      el.setAttribute('role', 'img'); // a plain div's aria-label is ignored by screen readers
      el.setAttribute('aria-label', legendLabel());
      el.innerHTML = legendHTML();
      L.DomEvent.disableClickPropagation(el);
      this._el = el;
      return el;
    },
  });
  const hint = new HintControl();
  window.addEventListener('ss-theme', () => {
    HEAT_GRADIENT = SSX.isDark() ? RAMPS.dark : RAMPS.light;
    L.Util.setOptions(heat, { gradient: HEAT_GRADIENT });
    if (heat._heat) heat._heat.gradient(HEAT_GRADIENT);
    if (map.hasLayer(heat)) heat.redraw();
    if (hint._el) { hint._el.innerHTML = legendHTML(); hint._el.setAttribute('aria-label', legendLabel()); }
  });

  function drawPins() {
    const b = map.getBounds().pad(0.3);
    const want = new Set();
    for (const it of S.filtered) if (b.contains([it.la, it.lo])) want.add(markerFor(it));
    pins.eachLayer((m) => { if (!want.has(m)) pins.removeLayer(m); });
    want.forEach((m) => { if (!pins.hasLayer(m)) pins.addLayer(m); });
  }
  function renderMapLayers() {
    if (inPinMode()) {
      if (map.hasLayer(heat)) {
        if (heat._frame) { L.Util.cancelAnimFrame(heat._frame); heat._frame = null; }
        map.removeLayer(heat);
      }
      if (!map.hasLayer(pins)) pins.addTo(map);
      if (hint._map) hint.remove();
      drawPins();
    } else {
      if (map.hasLayer(pins)) map.removeLayer(pins);
      if (!map.hasLayer(heat)) heat.addTo(map);
      if (!hint._map) hint.addTo(map);
    }
  }
  function updateMapData() {
    const pts = S.filtered.map((it) => [it.la, it.lo]);
    // leaflet.heat redraws on setLatLngs and throws if the layer is off the map, so just store the points then
    if (map.hasLayer(heat)) heat.setLatLngs(pts); else heat._latlngs = pts;
    if (inPinMode()) drawPins();
  }
  // in heatmap mode a tap zooms in towards that spot
  map.on('click', (e) => {
    if (inPinMode()) return;
    map.setZoomAround(e.latlng, Math.min(PIN_ZOOM, Math.floor(map.getZoom()) + 2), { animate: !REDUCED });
  });

  const selMarker = L.marker([0, 0], { icon: selIcon({ s: 1 }), zIndexOffset: 2000, interactive: false, keyboard: false });
  let meMarker = null, meCircle = null;

  function markerFor(it) {
    if (!it._m) {
      // keyboard:false — individual pins are not tab stops; the results list is the keyboard route to each washroom
      it._m = L.marker([it.la, it.lo], {
        icon: pinIcon(it),
        title: it.n, keyboard: false, riseOnHover: true,
      });
      it._m.on('click', () => select(it, { fly: false, focus: true }));
    }
    return it._m;
  }

  // ------------------------------------------------------------------ sponsored cards from nearby businesses
  const Ads = {
    cache: new Map(), pending: new Set(),
    keyFor(lat, lon, dp) { return `${lat.toFixed(dp)},${lon.toFixed(dp)}`; },
    async load(k, lat, lon, dp) {
      if (this.pending.has(k)) return;
      this.pending.add(k);
      const r = await SSX.api(`/api/business?action=ads&lat=${lat.toFixed(dp)}&lon=${lon.toFixed(dp)}`, { auth: false, timeout: 6000 });
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value); // street-level panning adds a key every ~100 m
      this.cache.set(k, r.ok && Array.isArray(r.j.ads) ? r.j.ads : []);
      this.pending.delete(k);
    },
    /** Ads whose radius really covers this point (the server matched the point rounded to ~100 m). */
    covering(list, p) { return list.filter((a) => !(a.r > 0) || distKm(p, { lat: a.la, lon: a.lo }) <= a.r); },
    /** First ad for the list at street level, or null (loads in the background and re-renders the list).
        ref is where the user is (or the map centre when we don't know): a 500 m ad must show at the shop's door. */
    current(ref) {
      if (!Ratings.shared || map.getZoom() < 13) return null;
      const k = this.keyFor(ref.lat, ref.lon, 3);
      const list = this.cache.get(k);
      if (list === undefined) {
        if (!this.pending.has(k)) this.load(k, ref.lat, ref.lon, 3).then(() => { if (S.view === 'list') renderList(); });
        return null;
      }
      return this.covering(list, ref)[0] || null;
    },
    async near(lat, lon) {
      const k = this.keyFor(lat, lon, 3);
      if (!this.cache.has(k)) await this.load(k, lat, lon, 3);
      return this.covering(this.cache.get(k) || [], { lat, lon });
    },
  };
  // A sponsored card counts as an impression only once at least half of it is on screen (not merely in the list).
  const adWatched = new Set();
  const adSeen = window.IntersectionObserver ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      SSX.Track.add(`ad:${e.target.dataset.adId}`, 'i');
      adSeen.unobserve(e.target); adWatched.delete(e.target);
    }
  }, { threshold: 0.5 }) : null;
  function watchAds(container) {
    for (const el of adWatched) if (!el.isConnected) { adSeen.unobserve(el); adWatched.delete(el); } // replaced by a re-render
    container.querySelectorAll('.sponsored[data-ad-id]').forEach((el) => {
      if (!adSeen) { SSX.Track.add(`ad:${el.dataset.adId}`, 'i'); return; }
      adSeen.observe(el); adWatched.add(el);
    });
  }
  /** "Get offer": hand the Rewards page the scout's own position (when the map has a fresh one from "Near me"), so a
      nearby shop's offer is ready to redeem there. It stays on this device (not in the URL), and the map centre is
      never passed on: the Rewards page sends this position when redeeming, and the shop's offer is only for people
      who are actually near it. Without a fix, the Rewards page asks for the location itself. */
  function shareSpotForOffers() {
    if (S.me && Date.now() - S.me.t < 15 * 60e3) lsSet('ss.offersHere', { lat: S.me.lat, lon: S.me.lon, t: S.me.t });
  }
  function adCard(a, from) {
    const ref = from || refPoint();
    const km = distKm(ref, { lat: a.la, lon: a.lo });
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${a.la},${a.lo}`;
    const id = esc(a.id);
    return `<div class="sponsored" data-ad-id="${id}">
      <div class="sp-top">${ic('megaphone', 'sm')} Sponsored · ${esc(a.cat)} · <span class="dist">${fmtDist(km)}</span></div>
      <div class="sp-title">${esc(a.title)}</div>
      <div class="sp-text">${esc(a.text)} — ${esc(a.biz)}</div>
      ${a.offer ? `<div class="sp-text">${ic('gift', 'sm')} <b>${esc(a.offer.title)}</b> for ${nf(a.offer.cost)} Swachh Coins</div>` : ''}
      <div class="sp-actions">
        <a class="btn sm" href="${dir}" target="_blank" rel="noopener sponsored" data-adk="${id}" data-kind="dir">${ic('directions', 'sm')} Directions</a>
        ${a.phone ? `<a class="btn sm" href="tel:${esc(a.phone)}" data-adk="${id}" data-kind="call">${ic('phone', 'sm')} Call</a>` : ''}
        ${a.url ? `<a class="btn sm" href="${esc(a.url)}" target="_blank" rel="noopener sponsored" data-adk="${id}" data-kind="web">${ic('ext', 'sm')} Website</a>` : ''}
        ${a.offer ? `<a class="btn sm coinbtn" href="/me.html?reward=${encodeURIComponent(a.offer.reward)}#rewards" data-adk="${id}" data-kind="offer">Get offer</a>` : ''}
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------ filtering
  // keeps letters, combining marks (needed for Indian scripts) and digits; strips Latin accents
  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  const roundedAvg = (a) => Math.round(a * 10) / 10;

  function matches(it, f, tokens) {
    if (f.type === 'pub' && !it.s) return false;
    if (f.type === 'fac' && it.s) return false;
    if (f.cat && it.c !== f.cat) return false;
    if (f.state && it.st !== f.state) return false;
    if (f.district && it.d !== f.district) return false;
    if (f.fee && it.fee !== f.fee) return false;
    if (f.open === '247' && it.sc !== '24/7') return false;
    if (f.open === 'now') { const st = statusOf(it); if (!st || !st.open) return false; }
    if (f.access && it.acc !== f.access) return false;
    if (f.wc === 'yes' && it.wc !== 'yes') return false;
    if (f.wc === 'any' && it.wc !== 'yes' && it.wc !== 'limited') return false;
    if (f.g === 'f' && !['separate', 'women', 'unisex'].includes(it.g)) return false;
    if (f.g === 'm' && !['separate', 'men', 'unisex'].includes(it.g)) return false;
    if ((f.g === 'separate' || f.g === 'unisex') && it.g !== f.g) return false;
    if (f.baby && it.bc !== 'yes' && it.bc !== 'limited') return false;
    if (f.western && !(it.ts || '').includes('W')) return false;
    if (f.indian && !(it.ts || '').includes('I')) return false;
    if (f.urinal && !(it.ts || '').includes('U')) return false;
    if (f.hw && it.hw !== 'yes') return false;
    if (f.tp && it.tp !== 'yes') return false;
    if (f.dw && it.dw !== 'yes') return false;
    if (f.sh && it.sh !== 'yes') return false;
    if (f.disp && it.disp !== f.disp) return false;
    if (f.minq && it.q < f.minq) return false;
    if (f.since && (!it.ed || it.ed < f.since)) return false;
    if (f.verified && !it.v) return false;
    if (f.rated || f.stars4) {
      const a = Ratings.avg(it.id);
      if (a == null) return false;
      if (f.stars4 && roundedAvg(a) < 4) return false; // same rounding as the "4.0" shown to the user
    }
    for (const t of tokens) if (!it._s.includes(t)) return false;
    return true;
  }

  function activeFilterCount(f) {
    const b = blankFilters();
    return Object.keys(b).filter((k) => k !== 'q' && f[k] !== b[k]).length;
  }

  function apply(opts) {
    opts = opts || {};
    tickNow();
    const tokens = norm(S.f.q).split(' ').filter(Boolean);
    S.filtered = S.items.filter((it) => matches(it, S.f, tokens));
    updateMapData();
    renderChips();
    renderCount();
    if (S.view === 'filters') updateFilterSubmit();
    renderList();
    syncURL();
    if (opts.fit && S.filtered.length) fitItems(S.filtered);
  }

  /** Padding that keeps fitted results inside the part of the map the user can see. */
  function fitPad(extra) {
    if (!isMobile()) return { paddingTopLeft: [extra, extra], paddingBottomRight: [extra, extra] };
    const hs = sheetHeights();
    const top = topInset() + 12;
    // with the sheet at full height no map is visible, so fit for the half-height sheet the user returns to
    const sheetH = sheetState === 'full' ? hs.half : hs[sheetState];
    const bottom = Math.max(PEEK, Math.min(sheetH, map.getSize().y - top - 160)) + 12;
    return { paddingTopLeft: [extra, top], paddingBottomRight: [extra, bottom] };
  }

  function fitItems(list, maxZoom) {
    if (!list.length) return;
    if (list.length === 1) return flyVisible([list[0].la, list[0].lo], 17);
    const b = L.latLngBounds(list.map((it) => [it.la, it.lo]));
    map.flyToBounds(b, motion(Object.assign({ maxZoom: maxZoom || 16, duration: 0.6 }, fitPad(40))));
  }

  // ------------------------------------------------------------------ chips (built once, then updated in place so focus is kept)
  const CHIPS = [
    { label: 'Open now', icon: 'clock', on: (f) => f.open === 'now', toggle: (f) => { f.open = f.open === 'now' ? '' : 'now'; } },
    { label: 'Free', icon: 'rupee', on: (f) => f.fee === 'free', toggle: (f) => { f.fee = f.fee === 'free' ? '' : 'free'; } },
    { label: 'Wheelchair', icon: 'wheelchair', on: (f) => !!f.wc, toggle: (f) => { f.wc = f.wc ? '' : 'any'; } },
    { label: 'Women', icon: 'people', on: (f) => f.g === 'f', toggle: (f) => { f.g = f.g === 'f' ? '' : 'f'; } },
    { label: 'Baby changing', icon: 'baby', on: (f) => f.baby, toggle: (f) => { f.baby = !f.baby; } },
    { label: 'Western seat', icon: 'seat', on: (f) => f.western, toggle: (f) => { f.western = !f.western; } },
    { label: 'Public toilets only', icon: 'pin', on: (f) => f.type === 'pub', toggle: (f) => { f.type = f.type === 'pub' ? '' : 'pub'; } },
    { label: 'Rated 4★+', icon: 'star', on: (f) => f.stars4, toggle: (f) => { f.stars4 = !f.stars4; } },
  ];
  $('#chips').innerHTML = `<button class="chip" type="button" aria-pressed="true" data-chip="q" hidden></button>`
    + CHIPS.map((c, i) => `<button class="chip" type="button" data-chip="${i}" aria-pressed="false">${ic(c.icon, 'sm')} ${esc(c.label)}</button>`).join('');

  function renderChips() {
    const qChip = $('#chips [data-chip="q"]');
    qChip.hidden = !S.f.q;
    if (S.f.q) {
      qChip.innerHTML = `“${esc(S.f.q)}” ${ic('x', 'sm')}`;
      qChip.setAttribute('aria-label', `Search: ${S.f.q}. Clear search`);
    }
    CHIPS.forEach((c, i) => $(`#chips [data-chip="${i}"]`).setAttribute('aria-pressed', String(c.on(S.f))));
    const n = activeFilterCount(S.f);
    const badge = $('#filterBadge');
    badge.hidden = !n; badge.textContent = n;
    $('#filtersBtn').setAttribute('aria-pressed', String(S.view === 'filters'));
  }
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    if (b.dataset.chip === 'q') { clearSearch(true); return; }
    CHIPS[+b.dataset.chip].toggle(S.f);
    if (S.view === 'filters') syncFilterForm();
    apply();
  });

  function clearSearch(focusInput) {
    S.f.q = '';
    qInput.value = '';
    $('#qClear').hidden = true;
    hideSuggest();
    apply();
    if (focusInput) qInput.focus();
  }

  let lastCount = '';
  function renderCount() {
    const n = S.filtered.length;
    const html = n === S.total
      ? `<strong>${nf(S.total)}</strong> washrooms across India`
      : `<strong>${nf(n)}</strong> of ${nf(S.total)} match`;
    if (html !== lastCount) { $('#count').innerHTML = html; lastCount = html; } // don't re-announce identical text
  }

  // ------------------------------------------------------------------ list view
  function refPoint() {
    const b = map.getBounds();
    if (S.me && b.contains([S.me.lat, S.me.lon])) return { lat: S.me.lat, lon: S.me.lon, me: true };
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, me: false };
  }

  function tagsFor(it) {
    const t = [];
    const st = statusOf(it);
    if (st) t.push(`<span class="tag ${st.tone}">${ic('clock')}${esc(st.open === null ? 'Hours unclear' : st.open ? (it.sc === '24/7' ? '24 hours' : 'Open now') : 'Closed')}</span>`);
    if (it.fee === 'free') t.push(`<span class="tag good">Free</span>`);
    if (it.fee === 'paid') t.push(`<span class="tag">${ic('rupee')}Paid${it.pr && it.pr.length < 14 ? ' · ' + esc(it.pr) : ''}</span>`);
    if (it.wc === 'yes' || it.wc === 'limited') t.push(`<span class="tag">${ic('wheelchair')}${it.wc === 'yes' ? 'Accessible' : 'Limited'}</span>`);
    if (it.bc === 'yes') t.push(`<span class="tag">${ic('baby')}Baby</span>`);
    if (!it.v) t.push(`<span class="tag muted">Not recently verified</span>`);
    const r = Ratings.summary(it.id);
    if (r && r.n) t.push(`<span class="tag star">${ic('star', 'fill')}<span class="visually-hidden">Rated </span>${roundedAvg(r.avg).toFixed(1)}${r.local ? '' : ` (${r.n})`}</span>`);
    if (Community.featured.has(it.id)) t.unshift(`<span class="tag feat">${ic('sparkle')}Featured</span>`);
    if (Community.verified[it.id]) t.push(`<span class="tag ver">${ic('shield')}Swachh Verified</span>`);
    if (Community.open(it.id)) t.push(`<span class="tag issue">${ic('alert')}Problem reported</span>`);
    else if (Community.fixed[it.id]) t.push(`<span class="tag fixed">${ic('broom')}Cleaned ${esc(SSX.ago(Community.fixed[it.id][0]))}</span>`);
    if (it.src === 'c') t.push(`<span class="tag comm">Added by scouts</span>`);
    return t.join('');
  }

  function renderList() {
    if (S.view !== 'list' || !S.items.length) return;
    keepFocus($('#listView'), renderListNow);
  }

  function renderListNow() {
    const el = $('#listView');
    const b = map.getBounds();
    const ref = refPoint();
    const inView = [];
    for (const it of S.filtered) if (b.contains([it.la, it.lo])) inView.push(it);
    for (const it of inView) it._d = distKm(ref, { lat: it.la, lon: it.lo });
    if (S.sort === 'clean') {
      // cleanest first: rated washrooms by stars (problems reported sink), then the rest by distance
      const score = (it) => { const a = Ratings.avg(it.id); return a == null ? -1 : a - (Community.open(it.id) ? 2 : 0); };
      for (const it of inView) it._c = score(it);
      inView.sort((a, b2) => b2._c - a._c || a._d - b2._d);
    } else inView.sort((a, b2) => a._d - b2._d);
    const shown = inView.slice(0, LIST_LIMIT);

    let html = '';
    if (!lsGet('ss.noticeDismissed', false)) {
      html += `<div class="notice">${ic('info')}<p>These are washrooms mapped by OpenStreetMap volunteers, not every washroom in India. Coverage is strong in big cities and thin in small towns. Details can be missing or out of date.</p><button type="button" id="noticeX" aria-label="Dismiss this note">${ic('x')}</button></div>`;
    }
    html += `<div class="legend"><span><i class="key"></i>Public toilet</span><span><i class="key fac"></i>Toilet inside a facility (mall, restaurant, petrol pump…)</span>${Ratings.shared ? `<span><i class="key" style="background:#d43c3c"></i>Problem reported</span><span><i class="key" style="box-shadow:0 0 0 2px #e2a91c"></i>Featured</span>` : ''}</div>`;
    if (Ratings.shared && !SSX.Account.has() && !lsGet('ss.earnDismissed', false)) {
      html += `<div class="earn-hint"><span class="coin" aria-hidden="true">S</span><span style="flex:1">Rate washrooms and report problems to earn <b>Swachh Coins</b> for rewards.</span><a href="/me.html">How</a><button type="button" class="icon-btn" id="earnX" aria-label="Dismiss" style="width:28px;height:28px">${ic('x', 'sm')}</button></div>`;
    }

    if (!S.filtered.length) {
      const nFilters = activeFilterCount(S.f);
      if (S.f.q && !nFilters) {
        html += `<div class="empty"><p>No washrooms match “${esc(S.f.q)}”.</p><p class="rate-note">Try a city, district or PIN code, or check the spelling.</p><button class="btn" type="button" data-act="clearq">Clear search</button></div>`;
      } else if (S.f.q) {
        html += `<div class="empty"><p>No washrooms match “${esc(S.f.q)}” with these filters.</p><div class="cta-row"><button class="btn" type="button" data-act="clearq">Clear search</button><button class="btn" type="button" data-act="reset">Reset filters</button></div></div>`;
      } else {
        html += `<div class="empty"><p>No washrooms match these filters.</p><p class="rate-note">Most washrooms don’t have every detail mapped yet, so detailed filters hide many places.</p><button class="btn" type="button" data-act="reset">Reset filters</button></div>`;
      }
    } else if (!inView.length) {
      html += `<div class="empty"><p>No matching washrooms in this part of the map.</p><button class="btn primary" type="button" data-act="nearest">${ic('locate')} Show the nearest ones</button></div>`;
    } else if (map.getZoom() < 9 && !ref.me && !S.f.q) {
      // zoomed out over a whole region: a distance-sorted list means little, so offer a starting point instead
      const groups = new Map();
      for (const it of inView) {
        const k = `${it.d || it.st}|${it.st}`;
        let g = groups.get(k);
        if (!g) { g = { name: it.d || it.st, st: it.st, items: [] }; groups.set(k, g); }
        g.items.push(it);
      }
      S.areas = [...groups.values()].sort((a, b2) => b2.items.length - a.items.length).slice(0, 14);
      html += `<div class="start">
        <h2>Find a washroom near you</h2>
        <p>Use your location, search for a place, or pick an area. ${nf(inView.length)} washrooms are in view.</p>
        <button class="btn primary block" type="button" data-act="locate">${ic('locate')} Use my location</button>
        <h3 class="start-sub">Areas with the most washrooms</h3>
        <div class="cities">${S.areas.map((g, i) => `<button class="chip" type="button" data-area="${i}">${esc(g.name)} <small>${nf(g.items.length)}</small></button>`).join('')}</div>
      </div>`;
    } else {
      const row = (it) => {
        const km = it._d;
        return `<li><button class="result" type="button" data-id="${esc(it.id)}">
          <span class="mk${it.s ? '' : ' fac'}"></span>
          <span class="r-main">
            <span class="r-title">${esc(it.n)}</span>
            <span class="r-sub">${esc(it.s ? placeLine(it, 2) : `${it.c} · ${placeLine(it, 2)}`)}</span>
            <span class="r-tags">${tagsFor(it)}</span>
          </span>
          <span class="r-dist">${fmtDist(km)}${ref.me && walkMin(km) ? `<small>${walkMin(km)}</small>` : ''}</span>
        </button></li>`;
      };
      html += `<div class="list-head"><h2>${nf(inView.length)} in this area</h2>
        <div class="toggle" role="group" aria-label="Sort"><button type="button" data-sort="near" aria-pressed="${S.sort === 'near'}">Nearest</button><button type="button" data-sort="clean" aria-pressed="${S.sort === 'clean'}">Cleanest</button></div></div>
        <p class="attrib" style="margin:-2px 0 4px">${S.sort === 'clean' ? 'Best-rated first, then the rest by distance' : ref.me ? 'Nearest to you' : 'Nearest to the map centre'}</p>`;
      // paid "Featured" listings get their own clearly labelled slot; the main list stays honest
      const feat = inView.filter((it) => Community.featured.has(it.id)).slice(0, 2);
      if (feat.length && S.sort === 'near' && inView.length > 3) html += `<div class="featured-strip"><div class="sp-top eyebrow" style="margin:6px 4px">${ic('sparkle', 'sm')} Featured nearby</div><ul class="results" style="padding:0">${feat.map(row).join('')}</ul></div>`;
      const ad = Ads.current(ref);
      html += `<ul class="results">`;
      shown.forEach((it, i) => {
        html += row(it);
        if (i === 2 && ad) html += `<li>${adCard(ad, ref)}</li>`;
      });
      if (ad && shown.length < 3) html += `<li>${adCard(ad, ref)}</li>`;
      html += `</ul>`;
      if (inView.length > shown.length) html += `<p class="attrib">Showing the nearest ${LIST_LIMIT}. Zoom in to see the rest.</p>`;
    }
    html += `<div class="list-foot">
      <button class="btn sm" type="button" data-act="csv">${ic('download', 'sm')} Download ${S.filtered.length === S.total ? 'all' : nf(S.filtered.length)} as CSV</button>
      <a class="btn sm" href="/civic.html">${ic('landmark', 'sm')} Washrooms needing cleaning</a>
    </div>
    <p class="attrib">Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, ODbL${S.downloaded ? ` · downloaded ${esc(fmtDate(S.downloaded.slice(0, 10)))}` : ''}. Opening times are shown in India time.</p>`;
    el.innerHTML = html;
    watchAds(el);
  }

  $('#listView').addEventListener('click', (e) => {
    if (e.target.closest('#noticeX')) { lsSet('ss.noticeDismissed', true); renderList(); $('#filtersBtn').focus({ preventScroll: true }); return; }
    if (e.target.closest('#earnX')) { lsSet('ss.earnDismissed', true); renderList(); $('#filtersBtn').focus({ preventScroll: true }); return; }
    const so = e.target.closest('[data-sort]');
    if (so) { S.sort = so.dataset.sort; renderList(); const nb = $(`#listView [data-sort="${S.sort}"]`); if (nb) nb.focus(); return; }
    const adk = e.target.closest('[data-adk]');
    if (adk) {
      SSX.Track.add(`ad:${adk.dataset.adk}`, 'k', `ad:${adk.dataset.adk}:k:${adk.dataset.kind || ''}`);
      if (adk.dataset.kind === 'offer') shareSpotForOffers();
      return;
    }
    const r = e.target.closest('.result');
    if (r) { const it = S.byId.get(r.dataset.id); if (it) select(it, { fly: true, focus: true }); return; }
    const area = e.target.closest('[data-area]');
    if (area && S.areas) { const g = S.areas[+area.dataset.area]; if (g) fitItems(g.items, 14); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'reset') resetFilters();
    if (a.dataset.act === 'clearq') clearSearch(true);
    if (a.dataset.act === 'nearest') showNearest();
    if (a.dataset.act === 'csv') downloadCSV();
    if (a.dataset.act === 'locate') locateMe();
  });

  function showNearest() {
    const ref = refPoint();
    const near = S.filtered.map((it) => [distKm(ref, { lat: it.la, lon: it.lo }), it]).sort((a, b) => a[0] - b[0]).slice(0, 5).map((x) => x[1]);
    const pts = near.map((it) => [it.la, it.lo]);
    if (S.me) pts.push([S.me.lat, S.me.lon]);
    map.flyToBounds(L.latLngBounds(pts), motion(Object.assign({ maxZoom: 16, duration: 0.6 }, fitPad(50))));
  }

  function resetFilters() {
    const q = S.f.q;
    S.f = blankFilters();
    S.f.q = q;
    if (S.view === 'filters') syncFilterForm();
    apply();
  }

  let listTimer = 0;
  map.on('moveend', () => {
    if (S.items.length) renderMapLayers();
    clearTimeout(listTimer);
    listTimer = setTimeout(renderList, 120);
  });

  // ------------------------------------------------------------------ filters view
  function buildFilterView() {
    const cats = countBy(S.items, 'c');
    const states = countBy(S.items, 'st');
    const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
    const groupOf = new Map(S.items.map((it) => [it.c, it.cg || 'Other places']));
    const groups = [...new Set(cats.map(([k]) => groupOf.get(k)))];
    const catOptions = groups.map((gname) => `<optgroup label="${esc(gname)}">${cats.filter(([k]) => groupOf.get(k) === gname).map(([k, n]) => opt(k, `${k} (${nf(n)})`)).join('')}</optgroup>`).join('');
    const hoursShare = Math.round((100 * S.withHours.length) / (S.total || 1));
    const seg = (name, label, opts) => `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${esc(v)}"><span>${esc(l)}</span></label>`).join('')}</div>`;
    const check = (name, label) => `<label class="check"><input type="checkbox" name="${name}"> ${esc(label)}</label>`;
    const field = (label, inner, style) => `<label class="field"${style ? ` style="${style}"` : ''}><span>${esc(label)}</span>${inner}</label>`;
    const thisYear = new Date().getFullYear();

    $('#filterView').innerHTML = `<form class="filters" id="filterForm" onsubmit="return false" aria-label="Filters">
      <h3>Type of place</h3>
      ${seg('type', 'Type of place', [['', 'All'], ['pub', 'Public toilets'], ['fac', 'In a facility']])}
      ${field('Category', `<select name="cat">${opt('', 'All categories')}${catOptions}</select>`, 'margin-top:10px')}

      <h3>Location</h3>
      ${field('State / UT', `<select name="state">${opt('', 'All of India')}${states.map(([k, n]) => opt(k, `${k} (${nf(n)})`)).join('')}</select>`)}
      ${field('District', '<select name="district"></select>')}

      <h3>Cost &amp; hours</h3>
      ${seg('fee', 'Cost', [['', 'Any cost'], ['free', 'Free'], ['paid', 'Paid']])}
      <div style="height:8px"></div>
      ${seg('open', 'Opening hours', [['', 'Any time'], ['now', 'Open now'], ['247', 'Open 24 hours']])}
      <p class="hint">Opening hours are known for about ${hoursShare}% of washrooms. “Open now” uses India time.</p>

      <h3>Who can use it</h3>
      ${seg('access', 'Who can use it', [['', 'Anyone'], ['public', 'Public'], ['customers', 'Customers'], ['restricted', 'Restricted']])}

      <h3>Accessibility &amp; family</h3>
      <div class="grid2">
        ${field('Wheelchair', `<select name="wc">${opt('', 'Any')}${opt('any', 'Accessible or limited')}${opt('yes', 'Fully accessible')}</select>`)}
        ${field('Men / women', `<select name="g">${opt('', 'Any')}${opt('f', 'Has women’s toilet')}${opt('m', 'Has men’s toilet')}${opt('separate', 'Separate men & women')}${opt('unisex', 'Unisex')}</select>`)}
      </div>
      <div class="checks">${check('baby', 'Baby changing')}</div>

      <h3>Toilet style</h3>
      <div class="checks">${check('western', 'Western (seated)')}${check('indian', 'Indian (squat)')}${check('urinal', 'Urinals')}</div>

      <h3>Facilities</h3>
      <div class="checks">${check('hw', 'Handwashing')}${check('tp', 'Toilet paper')}${check('dw', 'Drinking water')}${check('sh', 'Shower')}</div>
      ${field('Disposal type', `<select name="disp">${opt('', 'Any')}${['Flush', 'Pour flush', 'Pit latrine', 'Bucket', 'Chemical', 'Flush / bucket'].map((d) => opt(d, d)).join('')}</select>`, 'margin-top:6px')}

      <h3>User ratings</h3>
      <div class="checks">${check('rated', 'Has a rating')}${check('stars4', 'Rated 4★ or more')}</div>

      <h3>Data quality</h3>
      <div class="grid2">
        ${field('Details mapped', `<select name="minq">${opt('0', 'Any')}${opt('2', '2 or more of 9')}${opt('4', '4 or more of 9')}${opt('6', '6 or more of 9')}</select>`)}
        ${field('Last updated', `<select name="since">${opt('', 'Any time')}${[2, 5].map((y) => opt(`${thisYear - y}-01-01`, `Since ${thisYear - y}`)).join('')}${opt(`${thisYear}-01-01`, 'This year')}</select>`)}
      </div>
      <div class="checks">${check('verified', 'Recently verified only')}</div>
      <p class="hint">“Recently verified” means edited on OpenStreetMap in the last 5 years. Older records show only their location. Filters only match places where that detail is known.</p>
    </form>
    <div class="filter-actions">
      <button class="btn" type="button" data-fact="reset">Reset</button>
      <button class="btn primary" type="button" data-fact="done" id="filterDone">Show results</button>
    </div>`;

    const form = $('#filterForm');
    form.addEventListener('change', (e) => {
      const el = e.target;
      const k = el.name;
      if (!(k in S.f)) return;
      if (el.type === 'checkbox') S.f[k] = el.checked;
      else if (k === 'minq') S.f[k] = +el.value;
      else S.f[k] = el.value;
      if (k === 'state') { S.f.district = ''; fillDistricts(); }
      apply({ fit: k === 'state' || k === 'district' });
    });
    $('#filterView').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fact]');
      if (!b) return;
      if (b.dataset.fact === 'reset') resetFilters();
      if (b.dataset.fact === 'done') { if (isMobile()) setSheet('half'); showView('list', { focus: true }); }
    });
  }

  function fillDistricts() {
    const sel = $('#filterForm select[name="district"]');
    const pool = S.f.state ? S.items.filter((it) => it.st === S.f.state) : [];
    const ds = countBy(pool, 'd');
    sel.innerHTML = S.f.state
      ? `<option value="">All districts</option>` + ds.map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${nf(n)})</option>`).join('')
      : `<option value="">Choose a state first</option>`;
    sel.disabled = !S.f.state;
    sel.value = S.f.district;
  }

  function syncFilterForm() {
    const form = $('#filterForm');
    if (!form) return;
    fillDistricts();
    for (const el of form.elements) {
      if (!el.name || !(el.name in S.f)) continue;
      const v = S.f[el.name];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === String(v);
      else el.value = String(v);
    }
    updateFilterSubmit();
  }
  function updateFilterSubmit() {
    const b = $('#filterDone');
    if (b) b.textContent = S.filtered.length ? `Show ${nf(S.filtered.length)} washroom${S.filtered.length === 1 ? '' : 's'}` : 'No matches';
  }

  function countBy(list, key) {
    const m = new Map();
    for (const it of list) if (it[key]) m.set(it[key], (m.get(it[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  $('#filtersBtn').addEventListener('click', () => showView(S.view === 'filters' ? 'list' : 'filters', { focus: true }));

  // ------------------------------------------------------------------ detail view
  function fact(icon, label, value, tone) {
    const cls = value == null ? 'unknown' : tone || '';
    return `<div class="fact ${cls}">${ic(icon)}<div><div class="f-label">${esc(label)}</div><div class="f-val">${value == null ? 'Not known' : esc(value)}</div></div></div>`;
  }
  const ynTone = (v) => (v === 'yes' ? 'yes' : v === 'no' ? 'no' : '');

  function starsHTML(avg) {
    const shown = roundedAvg(avg);
    let h = `<span class="stars" role="img" aria-label="${shown.toFixed(1)} out of 5 stars">`;
    for (let i = 1; i <= 5; i++) h += ic('star', shown >= i - 0.25 ? 'on' : 'off');
    return h + '</span>';
  }

  function aspectRow(label, pair) {
    if (!pair || !(pair[0] + pair[1])) return '';
    const tot = pair[0] + pair[1];
    const p = Math.round((pair[0] / tot) * 100);
    return `<div><span>${esc(label)}</span><span class="meter" aria-hidden="true"><span style="width:${p}%"></span></span><span>${pair[0]} of ${tot} yes</span></div>`;
  }

  function ratingSectionHTML(it, openForm) {
    const r = Ratings.summary(it.id);
    let h = `<div class="section" id="rateSection"><h3 id="rateHeading" tabindex="-1">Cleanliness &amp; user ratings</h3>`;
    if (Ratings.mode === 'loading') return h + `<p class="rate-note" style="margin:0">Loading ratings…</p></div>`;
    if (Ratings.mode === 'unavailable') {
      return h + `<p class="rate-note" style="margin:0 0 8px">Ratings couldn’t be loaded right now.</p><button class="btn block" type="button" data-act="retry-ratings">Try again</button></div>`;
    }
    if (r && r.n) {
      h += `<div class="rating-sum"><span class="rating-big" aria-hidden="true">${roundedAvg(r.avg).toFixed(1)}</span><div>${starsHTML(r.avg)}<div class="rate-note" style="margin:2px 0 0">${r.local ? 'Your rating (saved on this device)' : `${r.n} rating${r.n === 1 ? '' : 's'}`}</div></div></div>
        <div class="aspects">${aspectRow('Water available', r.water)}${aspectRow('Soap available', r.soap)}${aspectRow('Felt safe', r.safe)}</div>`;
    } else if (Ratings.shared && Ratings.ratedToday(it.id) && Ratings.mine[it.id].blocked) {
      h += `<p class="rate-note" style="margin:0">Someone on your network rated this washroom today. It can take a few minutes to show here.</p>`;
    } else {
      h += `<p class="rate-note" style="margin:0">No cleanliness ratings yet. Visited recently? Be the first to rate it.</p>`;
    }
    const mine = Ratings.mine[it.id];
    let inner;
    if (Ratings.shared && Ratings.ratedToday(it.id)) {
      // the server takes one rating per washroom per network per day, so don't offer a form it would refuse
      inner = mine.blocked ? '' : mine.pending
        ? `<p class="rate-note">Your rating may not have been saved. Check back in a few minutes; if it doesn’t appear you can rate again.</p>`
        : `<p class="rate-note">You rated it ${mine.stars}★ today. Thanks for helping!</p>`;
    } else if (openForm) {
      inner = rateForm(Ratings.shared ? null : mine, it.id);
    } else {
      const label = !mine ? 'Rate this washroom' : Ratings.shared ? 'Rate a new visit' : 'Update your rating';
      inner = `<button class="btn ${r && r.n ? '' : 'primary'} block" type="button" data-act="rate" style="margin-top:12px">${ic('star')} ${label}</button>`;
    }
    return h + `<div id="rateWrap">${inner}</div></div>`;
  }

  function rateForm(mine, id) {
    const wait = Ratings.shared ? Ratings.coinsFrom(id) : 0;
    const yn = (name, label) => `<div class="yn"><span id="yn-${name}">${esc(label)}</span><div class="seg" role="radiogroup" aria-labelledby="yn-${name}">
      <label><input type="radio" name="${name}" value="yes"${mine && mine[name] === true ? ' checked' : ''}><span>Yes</span></label>
      <label><input type="radio" name="${name}" value="no"${mine && mine[name] === false ? ' checked' : ''}><span>No</span></label></div></div>`;
    const stars = mine ? mine.stars : 0;
    return `<form class="rate-form" id="rateForm" onsubmit="return false">
      <p id="starsLabel">How clean was it?</p>
      <div class="star-input" role="radiogroup" aria-labelledby="starsLabel">
        ${[1, 2, 3, 4, 5].map((n) => `<label class="star-opt${stars >= n ? ' on' : ''}"><input class="visually-hidden" type="radio" name="stars" value="${n}"${stars === n ? ' checked' : ''}><span aria-hidden="true">${ic('star')}</span><span class="visually-hidden">${n} star${n > 1 ? 's' : ''}</span></label>`).join('')}
      </div>
      ${yn('water', 'Water was available')}${yn('soap', 'Soap was available')}${yn('safe', 'I felt safe')}
      <button class="btn primary block" type="submit" style="margin-top:12px"${stars ? '' : ' disabled'}>Submit rating</button>
      <p class="rate-note">${Ratings.shared ? `Ratings are shared with everyone; your name is never shown with them. One rating per washroom per day. ${wait ? `Coins for a washroom are paid once a week, so this rating earns none (again from ${esc(SSX.fmtDateTime(wait))}), but it still helps everyone.` : 'You earn Swachh Coins on this device’s Scout profile.'}` : 'Shared ratings aren’t switched on for this site yet, so your rating is saved on this device only.'}</p>
    </form>`;
  }

  /** What this scout can still earn here: the server's coin rules, minus what this device's recent ratings and
      reports have used up (coins for a washroom once every 7 days; one report per washroom every 12 hours). */
  function earnHintHTML(it) {
    if (!Ratings.shared || Ratings.ratedToday(it.id)) return '';
    const parts = [];
    const wait = Ratings.coinsFrom(it.id);
    if (wait) parts.push(`Coins for rating it again from <b>${esc(SSX.fmtDateTime(wait))}</b>`);
    else if (COINS.rate) {
      const first = !(Ratings.summary(it.id) || {}).n && !Ratings.mine[it.id];
      parts.push(`Rate it: <b>+${nf(COINS.rate)} coins</b>${first && COINS.firstRating ? ` (+${nf(COINS.firstRating)} if you’re the first to rate it)` : ''}`);
    }
    if (COINS.report && !Reports.until(it.id)) parts.push(`Report a problem: <b>+${nf(COINS.report)}</b>`);
    return parts.length ? `<div class="earn-hint" id="earnHint"><span class="coin" aria-hidden="true">S</span><span>${parts.join(' · ')}</span></div>` : '';
  }
  function refreshEarnHint(it) {
    const old = $('#earnHint'), html = earnHintHTML(it);
    if (old) { if (html) old.outerHTML = html; else old.remove(); } else if (html) { const a = $('#detailView .actions'); if (a) a.insertAdjacentHTML('afterend', html); }
  }

  /** Scroll the sheet — never the page — so el sits at its top (scrollIntoView would also scroll the document). */
  function scrollSheetTo(el) {
    const body = $('#sheetBody');
    if (!el || !body.contains(el)) return;
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 4;
  }

  function statusTagHTML(it) {
    const st = statusOf(it);
    return st ? `<span class="tag ${st.tone}" id="detailStatus">${ic('clock')}${esc(st.text)}</span>` : `<span class="tag" id="detailStatus">${ic('clock')}Hours not known</span>`;
  }

  function hoursTableHTML(it) {
    const t = now();
    const sc = it.sc === '24/7' ? Array.from({ length: 7 }, () => [[0, 1440]]) : it.sc;
    const oe = (d, e) => (it.soe || []).some(([od, x]) => od === d && x === e);
    return `<table class="hours" id="hoursTable"><caption class="visually-hidden">Weekly opening hours, India time</caption><tbody>${sc.map((day, i) => `<tr class="${i === t.day ? 'today' : ''}"><th scope="row">${DAYS_LONG[i]}${i === t.day ? ' (today)' : ''}</th><td>${day.length ? day.map(([s, e]) => (s === 0 && e === 1440 ? 'Open 24 hours' : oe(i, e) ? (e === 1440 ? `from ${fmtTime(s)}, closing time not mapped` : `${fmtTime(s)} – ${fmtTime(e)} or later`) : `${fmtTime(s)} – ${fmtTime(e)}`)).join(', ') : 'Closed'}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderDetail(it, openForm) {
    const ref = osmRef(it.id);
    const osmUrl = ref ? `https://www.openstreetmap.org/${ref.type}/${ref.num}` : 'https://www.openstreetmap.org';
    const editUrl = ref ? `https://www.openstreetmap.org/edit?${ref.type}=${ref.num}` : 'https://www.openstreetmap.org/edit';
    const noteUrl = `https://www.openstreetmap.org/note/new#map=19/${it.la}/${it.lo}`;
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${it.la},${it.lo}`;
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${it.la},${it.lo}`;
    const phones = Array.isArray(it.ph) ? it.ph : (it.ph || '').split(/[;,]/).map((p) => p.trim()).filter(Boolean);
    const dist = S.me ? distKm(S.me, { lat: it.la, lon: it.lo }) : null;

    let h = `<div class="detail">
      <div class="detail-top">
        <button class="btn ghost sm" type="button" data-act="back">${ic('back', 'sm')} Back to list</button>
        <button class="icon-btn" type="button" data-act="back" aria-label="Close details">${ic('x')}</button>
      </div>
      <div class="detail-head">
        <span class="kind"><span class="mk${it.s ? '' : ' fac'}"></span>${esc(kindLabel(it))}</span>
        <h2 id="detailTitle" tabindex="-1">${esc(it.n)}</h2>
        ${it.nl ? `<div class="local">${esc(it.nl)}</div>` : ''}
        <div class="status-line">
          ${it.sc ? statusTagHTML(it) : ''}
          ${it.fee === 'free' ? `<span class="tag good">Free</span>` : it.fee === 'paid' ? `<span class="tag">${ic('rupee')}Paid${it.pr ? ' · ' + esc(it.pr) : ''}</span>` : ''}
          ${it.wc === 'yes' || it.wc === 'limited' ? `<span class="tag">${ic('wheelchair')}${it.wc === 'yes' ? 'Wheelchair accessible' : 'Limited wheelchair access'}</span>` : ''}
          ${dist != null ? `<span class="tag">${ic('pin')}${fmtDist(dist)} away</span>` : ''}
          ${it.v ? '' : `<span class="tag warn">${ic('alert')}Not recently verified</span>`}
          ${Community.featured.has(it.id) ? `<span class="tag feat">${ic('sparkle')}Featured</span>` : ''}
          ${Community.verified[it.id] ? `<span class="tag ver">${ic('shield')}Swachh Verified · ${esc(SSX.fmtDate(Community.verified[it.id].at))}</span>` : ''}
          ${Community.open(it.id) ? `<span class="tag issue">${ic('alert')}${Community.open(it.id)} problem${Community.open(it.id) === 1 ? '' : 's'} reported</span>` : Community.fixed[it.id] ? `<span class="tag fixed">${ic('broom')}Cleaned ${esc(SSX.ago(Community.fixed[it.id][0]))}</span>` : ''}
          ${it.src === 'c' ? `<span class="tag comm">Added by Swachh Scouts</span>` : ''}
        </div>
      </div>
      <div class="actions">
        <a class="btn primary" href="${dir}" target="_blank" rel="noopener" data-track="d">${ic('directions')} Directions</a>
        <a class="btn" href="${gmaps}" target="_blank" rel="noopener" data-track="d">${ic('map')} Google Maps</a>
        <button class="btn" type="button" data-act="share">${ic('share')} Share</button>
        ${phones[0] ? `<a class="btn" href="tel:${esc(phones[0].replace(/[^\d+]/g, ''))}" data-track="c">${ic('phone')} Call</a>` : ''}
      </div>`;
    h += earnHintHTML(it);

    if (!it.s && it.acc !== 'public') {
      h += `<div class="callout">${ic('building')}<span>This toilet is part of another place (${esc(it.c)}). It may be for customers only — ask the staff.</span></div>`;
    }
    if (!it.v) {
      h += `<div class="callout warn">${ic('alert')}<span>Last updated on OpenStreetMap ${it.ed ? esc(ago(it.ed)) : 'a long time ago'}, so only its location is shown. Details that old aren’t reliable. Been here recently? Rate it or add its details.</span></div>`;
    }

    h += ratingSectionHTML(it, openForm);
    if (Ratings.shared) {
      const fx = Community.fixed[it.id];
      const again = Reports.until(it.id);
      h += `<div class="section" id="hygiene"><h3 id="hygieneHeading" tabindex="-1">Problems &amp; cleaning</h3>
        <p class="rate-note" style="margin:0 0 8px">${Community.open(it.id) ? `${Community.open(it.id)} open problem${Community.open(it.id) === 1 ? '' : 's'}. The operator and the municipality see every report.` : 'No open problems reported.'}${fx ? ` Last cleaned ${esc(SSX.ago(fx[0]))} by ${esc(fx[1])}.` : ''}</p>
        <div class="report-list" id="issuesList"></div>
        ${again
          ? `<p class="rate-note" style="margin:10px 0 0">Thanks for your report. You can report this washroom again from ${esc(SSX.fmtDateTime(again))}.</p>`
          : `<button class="btn block" type="button" data-act="report" style="margin-top:10px">${ic('flag')} Report a problem${COINS.report ? ` (+${nf(COINS.report)} coins)` : ''}</button>`}
      </div>
      <div class="section" id="adsBox" hidden></div>`;
    }

    // only the facilities that are actually known for this washroom
    const facts = [
      it.accl && fact('door', 'Who can use', it.accl, it.acc === 'public' ? 'yes' : it.acc === 'restricted' ? 'no' : ''),
      it.wc && fact('wheelchair', 'Wheelchair', L_WC[it.wc], ynTone(it.wc)),
      it.g && fact('people', 'Men / women', L_G[it.g]),
      it.bc && fact('baby', 'Baby changing', L_YN[it.bc], ynTone(it.bc)),
      it.ts && fact('seat', 'Toilet style', styleLabel(it.ts)),
      it.disp && fact('flush', 'Disposal', it.disp),
      it.hw && fact('hand', 'Handwashing', it.hws ? 'Yes (separate)' : L_YN[it.hw], ynTone(it.hw)),
      it.soap && fact('soap', 'Soap', L_YN[it.soap], ynTone(it.soap)),
      it.tp && fact('roll', 'Toilet paper', L_YN[it.tp], ynTone(it.tp)),
      it.dw && fact('droplet', 'Drinking water', L_YN[it.dw], ynTone(it.dw)),
      it.sh && fact('shower', 'Shower', L_YN[it.sh], ynTone(it.sh)),
      it.fee && fact('rupee', 'Cost', it.fee === 'free' ? 'Free' : `Paid${it.pr ? ' · ' + it.pr : ''}`, it.fee === 'free' ? 'yes' : ''),
    ].filter(Boolean);
    if (facts.length) h += `<div class="section"><h3>Facilities</h3><div class="facts">${facts.join('')}</div></div>`;

    if (it.oh) {
      h += `<div class="section"><h3>Opening hours</h3>`;
      if (it.sc) {
        h += hoursTableHTML(it);
        if (it.sca) h += `<p class="raw">Some rules (public holidays, seasons, “or later” closing times) can’t be shown in this table — check the hours as mapped below.</p>`;
        h += `<p class="raw">As mapped: <code>${esc(it.oh)}</code></p>`;
      } else {
        h += `<p style="margin:0">${esc(it.oh)}</p>`;
      }
      h += `</div>`;
    }

    const locRows = [
      ['Address', it.a], ['City / town', it.city], ['District', it.d], ['State / UT', it.st], ['PIN code', it.pin],
      ['Coordinates', `${it.la.toFixed(5)}, ${it.lo.toFixed(5)}`],
    ].filter((r) => r[1]);
    h += `<div class="section"><h3>Location <button class="btn ghost sm" type="button" data-act="copy">${ic('copy', 'sm')} Copy</button></h3><dl class="kv">${locRows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (it.loc === 'near') h += `<p class="raw">This point is within 3 km of a district boundary, so it was assigned to the nearest district.</p>`;
    if (it.loc === 'island') h += `<p class="raw">Island or coastal point outside the boundary map; assigned to the nearest state.</p>`;
    h += `</div>`;

    if (it.op || phones.length || it.web) {
      h += `<div class="section"><h3>Operator &amp; contact</h3><dl class="kv">
        ${it.op ? `<dt>Run by</dt><dd>${esc(it.op)}</dd>` : ''}
        ${phones.length ? `<dt>Phone</dt><dd>${phones.map((p) => `<a href="tel:${esc(p.replace(/[^\d+]/g, ''))}">${esc(p)}</a>`).join('<br>')}</dd>` : ''}
        ${it.web ? `<dt>Website</dt><dd><a href="${esc(it.web)}" target="_blank" rel="noopener nofollow">${esc(it.web.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></dd>` : ''}
      </dl></div>`;
    }

    h += `<div class="section"><h3>About this record</h3>
      <dl class="kv">
        ${it.ed ? `<dt>Last edited</dt><dd>${esc(fmtDate(it.ed))} (${esc(ago(it.ed))})</dd>` : ''}
        <dt>Source</dt><dd>${it.src === 'c' ? `Added by a Swachh Scout, checked by the Swachh Scan team${it.at ? ` on ${esc(SSX.fmtDate(it.at))}` : ''}` : `OpenStreetMap${it.ids && it.ids.length > 1 ? ` · combines ${it.ids.length} mapped points for this toilet` : ''}`}</dd>
        <dt>Swachh Scan ID</dt><dd><code>${esc(it.id)}</code></dd>
      </dl>
    </div>
    <div class="section"><h3>Help keep this accurate</h3><div class="links">
      ${it.src === 'c' ? '' : `<a href="${noteUrl}" target="_blank" rel="noopener">${ic('edit')}<span>Wrong details or closed for good?<small>Leave a note on OpenStreetMap, no account needed</small></span></a>`}
      <a href="/business.html?claim=${encodeURIComponent(it.id)}">${ic('store')}<span>${Community.owned.has(it.id) ? 'Managed by a verified operator' : 'Do you run this washroom?'}<small>${Community.owned.has(it.id) ? 'Operators see reports and fix them faster' : 'Claim it to answer reports, get Featured and see analytics'}</small></span></a>
      ${it.src === 'c' ? '' : `<a href="${editUrl}" target="_blank" rel="noopener">${ic('edit')}<span>Add or fix details<small>Edit this washroom on OpenStreetMap</small></span></a>
      <a href="${osmUrl}" target="_blank" rel="noopener">${ic('ext')}<span>View on OpenStreetMap<small>See the original record and its history</small></span></a>`}
      <button class="link-btn" type="button" data-act="qr">${ic('qr')}<span>Scan-to-rate QR code<small>Print it for the washroom so visitors can rate it</small></span></button>
    </div></div>
    </div>`;

    $('#detailView').innerHTML = h;
    if (openForm) bindRateForm(it);
    if (Ratings.shared) { loadIssues(it); loadDetailAds(it); }
  }

  const ISSUES = {
    dirty: 'Dirty', smell: 'Bad smell', no_water: 'No water', no_soap: 'No soap', no_light: 'No light',
    broken: 'Broken door, lock or fittings', clogged: 'Blocked or overflowing', unsafe: 'Felt unsafe',
    closed: 'Closed during opening hours', no_access: 'Not wheelchair accessible', overcharged: 'Charged more than listed',
    missing: 'Not here / wrong location', other: 'Something else',
  };
  const STATUS = { open: ['Open', 'bad'], ack: ['Being looked at', 'warn'], resolved: ['Fixed', 'good'], rejected: ['Closed', ''] };
  async function loadIssues(it) {
    const r = await SSX.api(`/api/community?action=issues&id=${encodeURIComponent(it.id)}`, { auth: false, timeout: 8000 });
    const box = $('#issuesList');
    if (!box || S.selected !== it || !r.ok) return;
    const list = r.j.reports || [];
    box.innerHTML = list.slice(0, 5).map((x) => {
      const [label, tone] = STATUS[x.status] || STATUS.open;
      return `<div class="report-item"><div class="ri-top"><span>${esc(x.issues.map((k) => ISSUES[k] || k).join(', '))}</span><span class="st ${tone}">${label}</span></div>
        <div class="muted small">Reported ${esc(SSX.ago(x.at))}${x.by && x.status !== 'open' ? ` · ${esc(x.by)}` : ''}${x.response ? ` — “${esc(x.response)}”` : ''}</div></div>`;
    }).join('');
  }
  async function loadDetailAds(it) {
    const ads = await Ads.near(it.la, it.lo);
    const box = $('#adsBox');
    if (!box || S.selected !== it || !ads.length) return;
    box.hidden = false;
    box.innerHTML = `<h3>Nearby</h3>${ads.slice(0, 2).map((a) => adCard(a, { lat: it.la, lon: it.lo })).join('')}`;
    box.querySelectorAll('.sponsored').forEach((el) => { el.style.margin = '0 0 8px'; });
    watchAds(box); // counted when scrolled into view, not when the washroom opens
  }

  /** Re-render just the rating section (keeps scroll position and the rest of the page). */
  function refreshRateSection(it, openForm, focusSel) {
    const old = $('#rateSection');
    if (!old) return;
    old.outerHTML = ratingSectionHTML(it, openForm);
    if (openForm) bindRateForm(it);
    if (focusSel) { const el = $(focusSel); if (el) el.focus({ preventScroll: false }); }
  }

  function bindRateForm(it) {
    const form = $('#rateForm');
    if (!form) return;
    const submit = form.querySelector('[type="submit"]');
    const starsVal = () => { const el = form.querySelector('input[name="stars"]:checked'); return el ? +el.value : 0; };
    form.querySelector('.star-input').addEventListener('change', () => {
      const n = starsVal();
      form.querySelectorAll('.star-opt').forEach((l, i) => l.classList.toggle('on', i < n));
      submit.disabled = !n;
    });
    form.addEventListener('submit', async () => {
      const stars = starsVal();
      if (!stars) return;
      const val = (n) => { const el = form.querySelector(`input[name="${n}"]:checked`); return el ? el.value === 'yes' : null; };
      submit.disabled = true;
      submit.textContent = 'Saving…';
      const wait = Ratings.coinsFrom(it.id); // before submit() moves it
      const res = await Ratings.submit(it.id, { stars, water: val('water'), soap: val('soap'), safe: val('safe') });
      if (res.ok && !res.local) {
        let lead = res.created ? 'Thanks! Your Scout profile was created — see Rewards' : 'Thanks for rating!';
        const earned = res.coins && (res.coins.got || []).some((g) => g.c > 0);
        // say why no coins came, instead of a silent "thanks"
        if (res.authLost) lead += ' This device’s Scout profile wasn’t recognised, so it earned no coins.';
        else if (res.coins && !earned) {
          lead += wait ? ` Coins for this washroom again from ${SSX.fmtDateTime(wait)}.`
            : ` No coins this time: they’re paid once a week per washroom, for up to ${nf(LIMITS.ratingsRewardedPerDay)} ratings a day.`;
        }
        SSX.coinToast(res.coins, lead);
      } else toast(res.ok ? 'Thanks! Saved on this device.' : res.error);
      if (!res.ok && !res.final) {
        // keep what the user entered so they can try again
        submit.disabled = false;
        submit.textContent = 'Submit rating';
        return;
      }
      if (S.selected === it) { refreshEarnHint(it); refreshRateSection(it, false, '#rateHeading'); }
      if (S.f.rated || S.f.stars4) apply(); else renderList();
    });
  }

  $('#detailView').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a || !S.selected) return;
    const it = S.selected;
    const act = a.dataset.act;
    if (act === 'back') { e.preventDefault(); closeDetail(); }
    if (act === 'share') { shareItem(it); SSX.Track.add(it.id, 's'); }
    if (act === 'copy') copyText(`${it.n}\n${placeLine(it)}\n${it.la.toFixed(6)}, ${it.lo.toFixed(6)}\nhttps://www.google.com/maps/search/?api=1&query=${it.la},${it.lo}`, 'Location copied');
    if (act === 'rate') { refreshRateSection(it, true, '#rateForm input[name="stars"]'); }
    if (act === 'retry-ratings') {
      a.disabled = true; a.textContent = 'Loading…';
      await Ratings.init();
      onRatingsReady();
      const target = $('#rateForm input[name="stars"]') || $('#rateHeading'); // the form opens if this was a scan-to-rate link
      if (target) target.focus();
    }
    if (act === 'qr') showQR(it);
    if (act === 'report') openReport(it);
  });
  $('#detailView').addEventListener('click', (e) => {
    const t = e.target.closest('[data-track]');
    if (t && S.selected) SSX.Track.add(S.selected.id, t.dataset.track);
    const adk = e.target.closest('[data-adk]');
    if (adk) SSX.Track.add(`ad:${adk.dataset.adk}`, 'k', `ad:${adk.dataset.adk}:k:${adk.dataset.kind || ''}`);
    if (adk && adk.dataset.kind === 'offer') shareSpotForOffers();
  });

  // ------------------------------------------------------------------ selection, views & browser history
  let pushedDetail = false; // true when opening a washroom added a history entry (so Back returns to the list)

  function select(it, opts) {
    opts = opts || {};
    const fromOtherView = S.view !== 'detail';
    S.selected = it;
    S.lastSelectedId = it.id;
    SSX.Track.add(it.id, 'v');
    selMarker.setLatLng([it.la, it.lo]).setIcon(selIcon(it));
    if (!map.hasLayer(selMarker)) selMarker.addTo(map);
    renderDetail(it, !!opts.rate);
    showView('detail');
    $('#sheetBody').scrollTop = 0;
    if (opts.rate) setTimeout(() => scrollSheetTo($('#rateSection')), 50);
    if (opts.fly) flyVisible([it.la, it.lo], Math.max(map.getZoom(), 17));
    else ensureVisible([it.la, it.lo]);
    if (opts.fromPop || opts.boot) syncURL();
    else if (fromOtherView) { syncURL('push'); pushedDetail = true; } else syncURL();
    if (opts.focus) { const t = $('#detailTitle'); if (t) t.focus({ preventScroll: true }); }
  }

  function clearSelection() {
    if (!S.selected) return;
    S.selected = null;
    pushedDetail = false;
    if (map.hasLayer(selMarker)) map.removeLayer(selMarker);
  }

  function closeDetail() {
    if (pushedDetail) { pushedDetail = false; history.back(); return; } // popstate finishes the job
    clearSelection();
    showView('list', { focus: true });
    syncURL();
  }

  window.addEventListener('popstate', (e) => {
    if (!S.items.length) return;
    pushedDetail = false;
    const id = new URLSearchParams(location.search).get('id');
    const it = id && (S.byId.get(id) || S.byId.get(S.alias.get(id)));
    if (it) {
      select(it, { fly: true, fromPop: true });
      // Forward into a washroom we pushed earlier: the list entry is right behind it again
      if (e.state && e.state.detail) pushedDetail = true;
    } else if (S.view === 'detail') { clearSelection(); showView('list', { focus: true }); }
    syncURL();
  });

  function showView(v, opts) {
    opts = opts || {};
    const prev = S.view;
    if (v !== 'detail' && S.selected) { clearSelection(); syncURL(); } // leaving a washroom by any route deselects it
    S.view = v;
    $('#listView').hidden = v !== 'list';
    $('#filterView').hidden = v !== 'filters';
    $('#detailView').hidden = v !== 'detail';
    if (v === 'filters') { if (!$('#filterForm')) buildFilterView(); syncFilterForm(); setSheet('full'); }
    if (v === 'list') renderList();
    if (v === 'detail' && sheetState === 'peek') setSheet('half');
    $('#filtersBtn').setAttribute('aria-pressed', String(v === 'filters'));
    if (v !== 'detail') $('#sheetBody').scrollTop = 0;
    if (opts.focus && prev !== v) {
      let target = null;
      if (v === 'list') target = (S.lastSelectedId && $(`#listView [data-id="${CSS.escape(S.lastSelectedId)}"]`)) || $('#filtersBtn');
      if (v === 'filters') target = $('#filterForm input, #filterForm select');
      if (target) target.focus({ preventScroll: v === 'list' });
    }
  }

  function topInset() { return isMobile() ? $('.topbar').getBoundingClientRect().bottom : 0; }

  /** On phones the top bar and bottom sheet cover part of the map: centre the point in the gap between them. */
  function flyVisible(latlng, zoom) {
    if (!isMobile()) return map.flyTo(latlng, zoom, motion({ duration: 0.6 }));
    const target = map.project(latlng, zoom).add([0, (sheetPx() - topInset()) / 2]);
    map.flyTo(map.unproject(target, zoom), zoom, motion({ duration: 0.6 }));
  }
  function ensureVisible(latlng) {
    const p = map.latLngToContainerPoint(latlng);
    const size = map.getSize();
    const bottom = size.y - (isMobile() ? sheetPx() : 0) - 30;
    const top = topInset() + 30;
    if (p.y > bottom || p.y < top || p.x < 30 || p.x > size.x - 30) flyVisible(latlng, map.getZoom());
  }

  // ------------------------------------------------------------------ bottom sheet (phones)
  const sheet = $('#sheet');
  const handle = $('#sheetHandle');
  let sheetState = 'peek';
  const PEEK = 150;
  const ORDER = ['peek', 'half', 'full'];
  const SHEET_LABEL = { peek: 'Show more of the list', half: 'Expand the list to full screen', full: 'Collapse the list' };
  function sheetHeights() {
    const vh = $('.app').getBoundingClientRect().height || window.innerHeight;
    const topBottom = $('.topbar').getBoundingClientRect().bottom;
    const full = Math.max(PEEK + 100, vh - topBottom - 8);
    return { peek: PEEK, half: Math.min(full, Math.round(vh * 0.52)), full };
  }
  function sheetPx() { return isMobile() ? sheetHeights()[sheetState] : 0; }
  function setSheet(state) {
    sheetState = state;
    document.documentElement.style.setProperty('--topbar-h', Math.round($('.topbar').getBoundingClientRect().bottom) + 'px');
    handle.setAttribute('aria-expanded', String(state !== 'peek'));
    handle.setAttribute('aria-label', SHEET_LABEL[state]);
    if (!isMobile()) { sheet.style.removeProperty('--sheet-h'); return; }
    const h = sheetHeights()[state] + 'px';
    sheet.style.setProperty('--sheet-h', h);
    document.documentElement.style.setProperty('--sheet-h', h);
  }
  const cycleSheet = () => setSheet(ORDER[(ORDER.indexOf(sheetState) + 1) % 3]);
  document.documentElement.style.setProperty('--sheet-peek', PEEK + 'px');
  // keyboard (Enter/Space produce a click with detail 0); pointer taps are handled by the drag code below
  handle.addEventListener('click', (e) => { if (e.detail === 0) cycleSheet(); });

  (function sheetDrag() {
    let startY = 0, startH = 0, moved = false, active = false;
    const grab = [handle, $('#sheetHead')];
    const down = (e) => {
      if (!isMobile() || e.target.closest('#filtersBtn')) return;
      active = true; moved = false; startY = e.clientY; startH = sheet.getBoundingClientRect().height;
      sheet.classList.add('dragging');
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    const move = (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const hs = sheetHeights();
      sheet.style.setProperty('--sheet-h', Math.min(hs.full, Math.max(hs.peek - 40, startH - dy)) + 'px');
    };
    const up = (e) => {
      if (!active) return;
      active = false;
      sheet.classList.remove('dragging');
      if (!moved) {
        if (e.currentTarget === handle) cycleSheet(); else setSheet(sheetState);
        return;
      }
      const h = sheet.getBoundingClientRect().height;
      const dy = e.clientY - startY;
      const hs = sheetHeights();
      let best = ORDER.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
      if (best === sheetState && Math.abs(dy) > 50) {
        const i = ORDER.indexOf(sheetState) + (dy < 0 ? 1 : -1);
        best = ORDER[Math.max(0, Math.min(2, i))];
      }
      setSheet(best);
    };
    grab.forEach((g) => {
      g.addEventListener('pointerdown', down);
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
  })();
  window.addEventListener('resize', () => setSheet(sheetState));

  // ------------------------------------------------------------------ search
  const qInput = $('#q'), sugg = $('#suggest');
  let suggItems = [], suggActive = -1, suggTimer = 0, suggFor = null;
  const GENERIC = new Set(['public toilet', 'toilet', 'toilets', 'public toilets', 'sbm', 'sbm toilet', 'restroom', 'washroom']);

  // former names people still search for
  const OLD_NAMES = {
    bengaluru: 'bangalore', 'bengaluru urban': 'bangalore', 'bengaluru rural': 'bangalore', gurugram: 'gurgaon', mumbai: 'bombay',
    'mumbai suburban': 'bombay', chennai: 'madras', thiruvananthapuram: 'trivandrum', kochi: 'cochin', ernakulam: 'cochin',
    mysuru: 'mysore', kolkata: 'calcutta', pune: 'poona', prayagraj: 'allahabad', puducherry: 'pondicherry', vadodara: 'baroda',
    panaji: 'panjim', 'north goa': 'panjim', varanasi: 'benares banaras', visakhapatnam: 'vizag', kozhikode: 'calicut',
    thrissur: 'trichur', kannur: 'cannanore', mangaluru: 'mangalore', 'dakshina kannada': 'mangalore', belagavi: 'belgaum',
    kalaburagi: 'gulbarga', tiruchirappalli: 'trichy', thoothukudi: 'tuticorin', narmadapuram: 'hoshangabad',
  };
  function oldNames(name) { return name ? OLD_NAMES[name.toLowerCase()] || '' : ''; }

  function buildPlaces() {
    const places = new Map();
    const add = (key, type, name, sub, it) => {
      let p = places.get(key);
      if (!p) { p = { type, name, sub, st: it.st, n: 0, items: [], key: norm(name), alt: norm(oldNames(name)) }; places.set(key, p); }
      p.n++; p.items.push(it);
    };
    for (const it of S.items) {
      add('s|' + it.st, 'state', it.st, 'State / UT', it);
      if (it.d) add('d|' + it.d + '|' + it.st, 'district', it.d, `District · ${it.st}`, it);
      if (it.city) add('c|' + norm(it.city) + '|' + it.st, 'city', it.city, `City / town · ${it.st}`, it);
    }
    // a city with the same name as a district in the same state is already covered by the district entry
    const districtKeys = new Set([...places.values()].filter((p) => p.type === 'district').map((p) => p.key + '|' + p.st));
    for (const [k, p] of places) if (p.type === 'city' && districtKeys.has(p.key + '|' + p.st)) places.delete(k);
    S.places = [...places.values()];
  }

  function runSuggest() {
    const raw = qInput.value;
    const q = norm(raw);
    $('#qClear').hidden = !raw;
    suggActive = -1;
    qInput.removeAttribute('aria-activedescendant');
    if (q.length < 2) { hideSuggest(); return; }
    const tokens = q.split(' ');
    const places = S.places
      .map((p) => ({ p, score: p.key.startsWith(q) || (p.alt && p.alt.split(' ').some((a) => a.startsWith(q))) ? 2 : p.key.includes(q) || (p.alt && p.alt.includes(q)) ? 1 : 0 }))
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score || b.p.n - a.p.n || (a.p.type === 'state' ? -1 : 1))
      .slice(0, 5).map((x) => x.p);
    const ref = refPoint();
    const fNoQ = Object.assign({}, S.f, { q: '' });
    const named = [];
    for (const it of S.items) {
      if (!matches(it, fNoQ, tokens)) continue; // respect the active filters, as "Show all" will
      const nn = norm(it.n);
      const score = (nn.startsWith(q) ? 3 : nn.includes(q) ? 2 : 1) - (GENERIC.has(nn) ? 1.5 : 0);
      named.push({ it, score, d: distKm(ref, { lat: it.la, lon: it.lo }) });
    }
    named.sort((a, b) => b.score - a.score || a.d - b.d);
    const total = named.length;
    const withFilters = activeFilterCount(S.f) > 0;
    suggItems = [];
    let h = '';
    if (places.length) {
      h += `<li class="group" role="presentation">Places</li>`;
      for (const p of places) {
        suggItems.push({ kind: 'place', p });
        h += `<li role="option" aria-selected="false" id="sg${suggItems.length - 1}" data-i="${suggItems.length - 1}">${ic('pin')}<span class="s-main"><span class="s-title">${esc(p.name)}</span><span class="s-sub">${esc(p.sub)}</span></span><span class="s-count">${nf(p.n)}</span></li>`;
      }
    }
    if (named.length) {
      h += `<li class="group" role="presentation">Washrooms</li>`;
      for (const x of named.slice(0, 6)) {
        suggItems.push({ kind: 'item', it: x.it });
        h += `<li role="option" aria-selected="false" id="sg${suggItems.length - 1}" data-i="${suggItems.length - 1}"><span class="mk${x.it.s ? '' : ' fac'}"></span><span class="s-main"><span class="s-title">${esc(x.it.n)}</span><span class="s-sub">${esc(placeLine(x.it, 2))}</span></span><span class="s-count">${fmtDist(x.d)}</span></li>`;
      }
    }
    suggItems.push({ kind: 'all' });
    h += `<li role="option" aria-selected="false" id="sg${suggItems.length - 1}" data-i="${suggItems.length - 1}">${ic('search')}<span class="s-main"><span class="s-title">Show all ${nf(total)} matching “${esc(raw.trim())}”</span><span class="s-sub">${withFilters ? 'With your current filters' : 'Filters the map to these results'}</span></span></li>`;
    sugg.innerHTML = h;
    sugg.hidden = false;
    suggFor = raw;
    qInput.setAttribute('aria-expanded', 'true');
  }

  function hideSuggest() { sugg.hidden = true; qInput.setAttribute('aria-expanded', 'false'); qInput.removeAttribute('aria-activedescendant'); suggActive = -1; }

  function applySearch(text) {
    clearTimeout(suggTimer);
    hideSuggest();
    S.f.q = text.trim().slice(0, 100);
    $('#qClear').hidden = !qInput.value;
    apply({ fit: true });
    if (S.view !== 'list') showView('list');
  }

  function pickSuggest(i) {
    const s = suggItems[i];
    if (!s) return;
    hideSuggest();
    if (s.kind === 'place') {
      qInput.value = '';
      $('#qClear').hidden = true;
      if (S.f.q) { S.f.q = ''; apply(); }
      if (S.view !== 'list') showView('list');
      fitItems(s.p.items, s.p.type === 'state' ? 10 : 14);
    } else if (s.kind === 'item') {
      select(s.it, { fly: true, focus: true });
    } else {
      applySearch(qInput.value);
    }
    if (isMobile() && s.kind !== 'item') qInput.blur(); // hide the on-screen keyboard
  }

  qInput.addEventListener('input', () => {
    suggActive = -1;
    qInput.removeAttribute('aria-activedescendant');
    $('#qClear').hidden = !qInput.value;
    clearTimeout(suggTimer);
    suggTimer = setTimeout(runSuggest, 110);
  });
  qInput.addEventListener('focus', () => { if (qInput.value) runSuggest(); });
  qInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition in progress (Hindi/Tamil keyboards etc.)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden || suggFor !== qInput.value) return;
      e.preventDefault();
      suggActive = suggActive < 0 && e.key === 'ArrowUp' ? suggItems.length - 1 : (suggActive + (e.key === 'ArrowDown' ? 1 : -1) + suggItems.length) % suggItems.length;
      sugg.querySelectorAll('[role="option"]').forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === suggActive)));
      qInput.setAttribute('aria-activedescendant', 'sg' + suggActive);
      const el = $('#sg' + suggActive); // keep it in view inside the list only (scrollIntoView can move the page too)
      if (el) {
        if (el.offsetTop < sugg.scrollTop) sugg.scrollTop = el.offsetTop - 6;
        else if (el.offsetTop + el.offsetHeight > sugg.scrollTop + sugg.clientHeight) sugg.scrollTop = el.offsetTop + el.offsetHeight - sugg.clientHeight + 6;
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(suggTimer);
      if (suggActive >= 0 && !sugg.hidden && suggFor === qInput.value) pickSuggest(suggActive);
      else if (qInput.value.trim()) { applySearch(qInput.value); if (isMobile()) qInput.blur(); }
      else { clearSearch(); }
    } else if (e.key === 'Escape') { hideSuggest(); }
  });
  sugg.addEventListener('mousedown', (e) => e.preventDefault());
  sugg.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) pickSuggest(+li.dataset.i); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hideSuggest(); });
  // keyboard focus moving on (Tab to the chips…) closes the list so it never covers the focused control.
  // Only when focus lands on another element: a tap on an option leaves relatedTarget empty and is handled by click.
  $('.search').addEventListener('focusout', (e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) hideSuggest(); });
  $('#qClear').addEventListener('click', () => clearSearch(true));

  // ------------------------------------------------------------------ locate me
  $('#locateBtn').addEventListener('click', locateMe);
  function locateMe() {
    if (!navigator.geolocation) { toast('Location isn’t available on this device.'); return; }
    const btn = $('#locateBtn');
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
      S.me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
      const ll = [S.me.lat, S.me.lon];
      if (!meMarker) {
        meMarker = L.marker(ll, { icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: 1500 }).addTo(map);
        meCircle = L.circle(ll, { radius: S.me.acc, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(S.me.acc); }
      const pool = S.filtered.length ? S.filtered : S.items;
      const near = pool.map((it) => [distKm(S.me, { lat: it.la, lon: it.lo }), it]).sort((a, b) => a[0] - b[0]);
      if (!near.length) return;
      const [d0, it0] = near[0];
      const pts = near.slice(0, 5).filter((x) => x[0] < Math.max(3, d0 * 1.5)).map((x) => [x[1].la, x[1].lo]);
      pts.push(ll);
      if (S.view !== 'list') showView('list');
      if (sheetState === 'peek' && isMobile()) setSheet('half');
      map.flyToBounds(L.latLngBounds(pts), motion(Object.assign({ maxZoom: 16, duration: 0.8 }, fitPad(60))));
      const filtered = S.filtered.length && (activeFilterCount(S.f) || S.f.q);
      toast(d0 > 25
        ? `The nearest ${filtered ? 'washroom matching your filters' : 'mapped washroom'} is ${fmtDist(d0)} away.`
        : `Nearest${filtered ? ' match' : ''}: ${it0.n}, ${fmtDist(d0)} away`);
    }, (err) => {
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
      toast(err.code === 1 ? 'Location permission was denied. Allow it in your browser to find nearby washrooms.' : 'Couldn’t get your location. Try again.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  // ------------------------------------------------------------------ add missing / QR / share / CSV
  // returnTo: what gets focus when the dialog closes if its opener was re-rendered or hidden meanwhile
  const openDialog = (d, returnTo) => SSX.openDialog(d, returnTo);
  SSX.wireDialogs();

  // ---- report a hygiene problem
  function openReport(it) {
    if (!Ratings.shared) { toast('Reporting switches on when the site’s database is connected.'); return; }
    const sendLabel = `Send report${COINS.report ? ` · +${nf(COINS.report)} coins` : ''}`;
    $('#reportBody').innerHTML = `<p><b>${esc(it.n)}</b><br><span class="muted small">${esc(placeLine(it, 2))}</span></p>
      <form class="form" id="reportForm" onsubmit="return false">
        <fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:650;margin-bottom:6px">What was wrong? Choose all that apply.</legend>
        <div class="checkgrid">${Object.entries(ISSUES).map(([k, v]) => `<label><input type="checkbox" name="issue" value="${k}"> ${esc(v)}</label>`).join('')}</div></fieldset>
        <label class="field"><span>Anything else? (optional)</span><textarea name="note" maxlength="280" placeholder="e.g. No water since morning, door lock broken"></textarea><span class="hint">Seen by the operator and the municipality. Don’t include phone numbers or names.</span></label>
        <p class="form-error" id="reportErr" role="alert" hidden></p>
        <button class="btn primary block" type="submit" disabled>${sendLabel}</button>
      </form>`;
    const form = $('#reportForm');
    const btn = form.querySelector('[type="submit"]');
    form.addEventListener('change', () => { btn.disabled = !form.querySelector('input[name="issue"]:checked'); });
    form.addEventListener('submit', async () => {
      const issues = [...form.querySelectorAll('input[name="issue"]:checked')].map((x) => x.value);
      if (!issues.length) return;
      const err = $('#reportErr');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Sending…';
      const acct = await SSX.Account.ensure();
      const r = await SSX.api('/api/community', { body: { action: 'report', id: it.id, issues, note: form.note.value.trim() || undefined } });
      if (!r.ok) {
        if (r.j.code === 'already_reported') Reports.remember(it.id); // the server's 12-hour window: stop offering the form
        err.hidden = false; err.textContent = r.j.error || 'Couldn’t send the report. Please try again.';
        btn.disabled = false; btn.textContent = sendLabel;
        return;
      }
      // the token wasn't recognised (e.g. a profile reset on the server): forget it, as ratings do, so the next
      // contribution creates a working profile instead of earning nothing in silence
      const authLost = r.j.auth === false;
      if (authLost) SSX.Account.forget();
      Reports.remember(it.id);
      Community.issues[it.id] = (Community.issues[it.id] || 0) + 1;
      Community.featured.delete(it.id); // a featured listing pauses while a problem is open (the server does the same)
      if (it._m) it._m.setIcon(pinIcon(it));
      if (S.selected === it) selMarker.setIcon(selIcon(it)); // the big selected pin sits on top and would hide the red dot
      $('#reportDialog').close(); // focus then goes to the Problems heading (returnTo), as the button is re-rendered
      const lead = authLost ? 'Report sent. This device’s Scout profile wasn’t recognised, so it earned no coins.'
        : acct.created ? 'Report sent — your Scout profile was created' : 'Report sent. Thank you!';
      SSX.coinToast(r.j.coins, lead);
      if (S.selected === it) {
        renderDetail(it, false);
        scrollSheetTo($('#hygiene'));
        const hh = $('#hygieneHeading'); if (hh) hh.focus({ preventScroll: true });
      }
      renderList();
    });
    openDialog($('#reportDialog'), '#hygieneHeading');
  }

  // ---- add a missing washroom: pick the spot on the map, then a short form (reviewed before it appears)
  const CATS = ['Petrol pump', 'Restaurant / café', 'Mall / shop', 'Railway / bus station', 'Metro station', 'Hospital / clinic', 'Place of worship', 'Park', 'Tourist place', 'Office / government', 'Other'];
  let picking = false;
  function startPick() {
    if (!Ratings.shared) { showAddOSM(); return; }
    picking = true;
    document.body.classList.add('picking'); // hides the round buttons, which would sit under the pick bar on phones
    // leaving the washroom deselects it and drops ?id= from the URL (showView does both)
    if (S.view !== 'list') showView('list');
    else if (S.selected) { clearSelection(); syncURL(); }
    if (isMobile()) setSheet('peek');
    if (map.getZoom() < 17) map.setZoom(17, { animate: !REDUCED });
    $('#pickOverlay').hidden = false; $('#pickBar').hidden = false;
    $('#pickOk').focus();
  }
  function endPick() { picking = false; document.body.classList.remove('picking'); $('#pickOverlay').hidden = true; $('#pickBar').hidden = true; }
  $('#pickCancel').addEventListener('click', () => { endPick(); $('#addBtn').focus(); });
  $('#pickOk').addEventListener('click', () => { const c = map.getCenter(); endPick(); showAddForm(c.lat, c.lng); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking) { endPick(); $('#addBtn').focus(); } });

  function osmLinks(lat, lon) {
    const z = 18;
    return `<div class="row" style="flex-direction:column;align-items:stretch">
      <a class="btn block" target="_blank" rel="noopener" href="https://www.openstreetmap.org/note/new#map=${z}/${lat.toFixed(6)}/${lon.toFixed(6)}">${ic('flag')} Leave a note on OpenStreetMap</a>
      <a class="btn block" target="_blank" rel="noopener" href="https://www.openstreetmap.org/edit#map=${z}/${lat.toFixed(6)}/${lon.toFixed(6)}">${ic('edit')} Add it in the OpenStreetMap editor</a></div>`;
  }
  function showAddOSM() {
    const c = map.getCenter();
    $('#addBody').innerHTML = `<p>Move the map so the washroom is in the centre, then add it to <strong>OpenStreetMap</strong>, the free map these washrooms come from. It appears here at the next data refresh.</p>${osmLinks(c.lat, c.lng)}
      <p class="rate-note">Tip for mappers: tag it <code>amenity=toilets</code> and add <code>fee</code>, <code>opening_hours</code>, <code>wheelchair</code>, <code>female</code>/<code>male</code>, <code>changing_table</code>.</p>`;
    openDialog($('#addDialog'), '#addBtn');
  }
  /** Close the add dialog, then run next — after the dialog's own close handler has put focus back, so next can move it. */
  function closeAddThen(next) {
    const d = $('#addDialog');
    d.addEventListener('close', next, { once: true });
    d.close();
  }
  function showAddForm(lat, lon, keep) {
    const sel = (name, label, opts) => `<label class="field"><span>${label}</span><select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`;
    $('#addBody').innerHTML = `<p class="small muted">Location: ${lat.toFixed(5)}, ${lon.toFixed(5)} · <button type="button" class="link" id="addMove">change</button></p>
      <form class="form" id="addForm" onsubmit="return false">
        <label class="field req"><span>Name or description</span><input name="n" required minlength="3" maxlength="80" placeholder="e.g. Public toilet near Gandhi Market gate"></label>
        ${sel('kind', 'What kind of place?', [['pub', 'A public toilet'], ...CATS.map((c) => [c, `Toilet inside: ${c}`])])}
        <div class="grid-2">
          ${sel('fee', 'Cost', [['', 'Not sure'], ['free', 'Free'], ['paid', 'Paid']])}
          <label class="field"><span>Price (if paid)</span><input name="pr" maxlength="20" placeholder="₹5"></label>
          ${sel('g', 'Men / women', [['', 'Not sure'], ['separate', 'Separate men & women'], ['unisex', 'Unisex'], ['women', 'Women only'], ['men', 'Men only']])}
          ${sel('wc', 'Wheelchair', [['', 'Not sure'], ['yes', 'Accessible'], ['limited', 'Limited'], ['no', 'Not accessible']])}
          ${sel('bc', 'Baby changing', [['', 'Not sure'], ['yes', 'Yes'], ['no', 'No']])}
          <label class="field"><span>Opening hours</span><input name="oh" maxlength="80" placeholder="e.g. 6am–10pm, or 24 hours"></label>
        </div>
        <label class="field"><span>Address or landmark (optional)</span><input name="a" maxlength="140"></label>
        <label class="field"><span>Note for the reviewers (optional)</span><textarea name="note" maxlength="280"></textarea></label>
        <p class="form-error" id="addErr" role="alert" hidden></p>
        <button class="btn primary block" type="submit">${ic('plus')} Add washroom${COINS.place ? ` · +${nf(COINS.place)} coins when approved` : ''}</button>
        <p class="rate-note">We check every new washroom before it appears on the map. It’s also great to add it to OpenStreetMap so every map gets it.</p>
      </form>`;
    const form = $('#addForm');
    if (keep) for (const [k, v] of Object.entries(keep)) if (form.elements[k]) form.elements[k].value = v;
    $('#addMove').addEventListener('click', () => closeAddThen(() => { map.setView([lat, lon], Math.max(17, map.getZoom())); startPick(); }));
    form.addEventListener('submit', () => submitAdd(form, lat, lon, false));
    // opened from "Use this spot", which is hidden by then: closing returns focus to the Add button
    if (!$('#addDialog').open) openDialog($('#addDialog'), '#addBtn');
    form.elements.n.focus(); // start at the name, not the "change" link above it
  }
  async function submitAdd(form, lat, lon, confirm) {
    const err = $('#addErr');
    const btn = form.querySelector('[type="submit"]');
    if (!form.reportValidity()) return;
    err.hidden = true; btn.disabled = true;
    const v = (k) => form.elements[k].value.trim();
    const kind = v('kind');
    const body = { action: 'place', n: v('n'), s: kind === 'pub', c: kind === 'pub' ? undefined : kind, la: lat, lo: lon, fee: v('fee') || undefined, pr: v('pr') || undefined, g: v('g') || undefined, wc: v('wc') || undefined, bc: v('bc') || undefined, oh: v('oh') || undefined, a: v('a') || undefined, note: v('note') || undefined, confirm: confirm || undefined };
    const acct = await SSX.Account.ensure();
    if (!acct.ok) { err.hidden = false; err.textContent = acct.error || 'Couldn’t create your Scout profile. Please try again.'; btn.disabled = false; return; }
    const r = await SSX.api('/api/community', { body });
    btn.disabled = false;
    if (r.status === 409 && r.j.code === 'duplicate') {
      const ex = S.byId.get(r.j.existing);
      err.hidden = false;
      err.innerHTML = `${esc(r.j.error)} <button type="button" class="link" id="dupOpen">Open it</button> · <button type="button" class="link" id="dupNo">No, it’s a different one</button>`;
      // select after the dialog's close handler has run, or it would pull focus back to the Add button
      $('#dupOpen').addEventListener('click', () => closeAddThen(() => { if (ex) select(ex, { fly: true, focus: true }); }));
      $('#dupNo').addEventListener('click', () => submitAdd(form, lat, lon, true));
      return;
    }
    if (!r.ok) { err.hidden = false; err.textContent = r.j.error || 'Couldn’t send it. Please try again.'; return; }
    const coins = Number.isFinite(r.j.coinsOnApproval) ? r.j.coinsOnApproval : COINS.place;
    $('#addBody').innerHTML = `<div class="notice-box">${ic('check')}<p tabindex="-1" id="addDone"><b>Thanks! “${esc(body.n)}” is waiting for review.</b>${coins ? `<br>You’ll get <b>+${nf(coins)} Swachh Coins</b> when it’s approved${acct.created ? ' — your Scout profile was created on this device' : ''}.` : ''}</p></div>
      <p style="margin-top:14px">Help every map: add it to OpenStreetMap too.</p>${osmLinks(lat, lon)}
      <div class="row" style="margin-top:12px"><a class="btn" href="/me.html">See my activity</a><button class="btn primary" type="button" data-close>Done</button></div>`;
    $('#addDone').focus(); // the form (and the focused button) was replaced: read the result out
  }
  $('#addBtn').addEventListener('click', startPick);

  async function showQR(it) {
    const url = `${location.origin}/?id=${encodeURIComponent(it.id)}&rate=1`;
    $('#qrName').textContent = `${it.n} — ${placeLine(it, 2)}`;
    openDialog($('#qrDialog'));
    try {
      const canvas = $('#qrCanvas');
      await SSX.qr(canvas, url, 280);
      $('#qrDownload').href = canvas.toDataURL('image/png');
      $('#qrDownload').download = `swachh-scan-${it.id}.png`;
    } catch (e) {
      toast('Couldn’t load the QR generator. Check your connection.');
    }
  }

  function itemLink(it) { return `${location.origin}/?id=${encodeURIComponent(it.id)}`; }
  async function shareItem(it) {
    const url = itemLink(it);
    if (navigator.share) {
      try { await navigator.share({ title: `${it.n} · Swachh Scan`, text: `${it.n}, ${placeLine(it, 2)}`, url }); } catch (e) { /* cancelled */ }
    } else copyText(url, 'Link copied');
  }
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch (e) { toast('Couldn’t copy automatically. Your browser blocked the clipboard.'); }
  }

  function downloadCSV() {
    const cols = [
      ['Swachh Scan ID', (it) => it.id], ['Name', (it) => it.n], ['Name in local script', (it) => it.nl],
      ['Category', (it) => it.c], ['Standalone public toilet', (it) => (it.s ? 'Yes' : 'No')],
      ['State / UT', (it) => it.st], ['District', (it) => it.d], ['City / Town', (it) => it.city], ['Address', (it) => it.a], ['PIN code', (it) => it.pin],
      ['Latitude', (it) => it.la], ['Longitude', (it) => it.lo],
      ['Free or paid', (it) => it.fee], ['Price', (it) => it.pr], ['Opening hours', (it) => it.oh], ['Who can use', (it) => it.accl],
      ['Wheelchair', (it) => it.wc], ['Men / women', (it) => it.g && L_G[it.g]], ['Baby changing', (it) => it.bc],
      ['Toilet style', (it) => styleLabel(it.ts)], ['Handwashing', (it) => it.hw], ['Toilet paper', (it) => it.tp],
      ['Drinking water', (it) => it.dw], ['Shower', (it) => it.sh], ['Disposal type', (it) => it.disp],
      ['Operator', (it) => it.op], ['Phone', (it) => (Array.isArray(it.ph) ? it.ph : [it.ph]).filter(Boolean).map((x) => String(x).replace(/^\+91\s?(?=18[06]0)/, '').replace(/^\+91\s?/, '0')).join('; ')], ['Website', (it) => it.web],
      ['Last edited on OSM', (it) => it.ed], ['Recently verified', (it) => (it.v ? 'Yes' : 'No')], ['Detail score (0-9)', (it) => it.q],
      ['Merged OSM records', (it) => (it.ids ? it.ids.join(' ') : it.id)],
      ['User rating (avg)', (it) => { const a = Ratings.avg(it.id); return a == null ? '' : a.toFixed(2); }],
      ['Source URL', (it) => { const r = osmRef(it.id); return r ? `https://www.openstreetmap.org/${r.type}/${r.num}` : ''; }],
    ];
    // Text that starts with = + - @ is treated as a formula by spreadsheet apps (and '+91…' phones lose the '+').
    // Prefix it with an apostrophe so it stays text (OWASP CSV-injection guidance). Numbers are left alone.
    const cell = (v) => {
      if (typeof v === 'number') return String(v);
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map((c) => cell(c[0])).join(',')];
    for (const it of S.filtered) lines.push(cols.map((c) => cell(c[1](it))).join(','));
    lines.push('', cell('Data © OpenStreetMap contributors, Open Database Licence (ODbL) 1.0 — https://www.openstreetmap.org/copyright'));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `swachh-scan-washrooms-${S.filtered.length}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ URL state (?id=, ?q=, ?state=, ?district=, ?cat=)
  function syncURL(mode) {
    const p = new URLSearchParams();
    if (S.selected) p.set('id', S.selected.id);
    if (S.f.q) p.set('q', S.f.q);
    if (S.f.state) p.set('state', S.f.state);
    if (S.f.district) p.set('district', S.f.district);
    if (S.f.cat) p.set('cat', S.f.cat);
    const qs = p.toString();
    const url = qs ? `?${qs}` : location.pathname;
    if (mode === 'push') history.pushState({ ss: 1, detail: true }, '', url);
    else if (url !== location.search && !(url === location.pathname && !location.search)) history.replaceState(history.state, '', url);
  }

  /** Match a URL value against real values, ignoring case; anything else is dropped. */
  function pickValue(val, values) {
    if (!val) return '';
    val = val.trim();
    if (values.has(val)) return val;
    const low = val.toLowerCase();
    for (const v of values) if (v.toLowerCase() === low) return v;
    return '';
  }

  // ------------------------------------------------------------------ ratings arrive after the map is usable
  /** Washrooms added by scouts (approved) join the map once /api/state arrives. */
  function addCommunityPlaces() {
    let added = 0;
    for (const p of Community.places) {
      if (!p || !p.id || S.byId.has(p.id) || typeof p.la !== 'number' || !p.st) continue;
      const it = Object.assign({}, p, { src: 'c', v: true, c: p.c || (p.s ? 'Public toilet' : 'Other'), cg: p.cg || (p.s ? 'Public toilets' : 'Added by scouts') });
      it.ed = new Date(p.at || Date.now()).toISOString().slice(0, 10);
      it.q = ['fee', 'oh', 'wc', 'g', 'bc', 'ts', 'hw', 'op', 'a'].filter((k) => it[k]).length;
      it._s = norm([it.n, it.c, it.st, it.d, it.city, it.a].filter(Boolean).join(' '));
      S.items.push(it); S.byId.set(it.id, it); added++;
    }
    if (added) { S.total = S.items.length; buildPlaces(); }
    return added;
  }

  function onRatingsReady() {
    const added = addCommunityPlaces();
    refreshPinIcons();
    if (S.selected) selMarker.setIcon(selIcon(S.selected));
    if (added || S.f.rated || S.f.stars4) apply(); else renderList();
    if (S.pendingId) {
      const it = S.byId.get(S.pendingId);
      S.pendingId = null;
      if (it) { map.setView([it.la, it.lo], 17, { animate: false }); select(it, { fly: false, boot: true, rate: S.pendingRate === it.id }); }
      else toast('That washroom isn’t on the map (yet).');
    }
    if (S.view === 'detail' && S.selected) {
      const openForm = S.pendingRate === S.selected.id && Ratings.mode !== 'unavailable' && !(Ratings.shared && Ratings.ratedToday(S.selected.id));
      if (Ratings.shared) {
        // the whole page gains sections (problems, offers, badges) once the community data is here
        const scroll = $('#sheetBody').scrollTop;
        renderDetail(S.selected, openForm);
        $('#sheetBody').scrollTop = scroll;
        if (openForm) { const f = $('#rateForm input[name="stars"]'); if (f) f.focus({ preventScroll: true }); }
      } else refreshRateSection(S.selected, openForm, openForm ? '#rateForm input[name="stars"]' : null);
      if (openForm) scrollSheetTo($('#rateSection'));
    }
    if (Ratings.mode !== 'unavailable') S.pendingRate = null; // keep it for "Try again"
  }

  // ------------------------------------------------------------------ keep open/closed status current
  function snapshotStatuses() {
    let changed = false;
    for (const it of S.withHours) {
      const st = statusOf(it);
      const sig = st.tone + st.text;
      if (it._sig !== sig) { it._sig = sig; changed = true; }
    }
    return changed;
  }
  function refreshStatuses() {
    if (!S.items.length) return;
    tickNow();
    if (!snapshotStatuses()) return; // nothing changed: don't rebuild anything (keeps focus and screen readers calm)
    if (S.f.open === 'now') apply(); else renderList();
    if (S.view === 'detail' && S.selected && S.selected.sc) {
      const tag = $('#detailStatus'); if (tag) tag.outerHTML = statusTagHTML(S.selected);
      const tbl = $('#hoursTable'); if (tbl) tbl.outerHTML = hoursTableHTML(S.selected);
    }
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    tickNow();
    setSheet('peek');
    renderChips();
    Ratings.loadMine();
    Reports.load();
    const data = await fetchJSON('/data/washrooms.json');
    S.downloaded = data.downloaded || null;
    S.items = data.items;
    for (const [oldId, current] of Object.entries(data.alias || {})) S.alias.set(oldId, current);
    S.total = S.items.length;
    for (const it of S.items) {
      S.byId.set(it.id, it);
      it._s = norm([it.n, ...(it.alt || []), it.nl, it.c, it.st, it.d, it.city, oldNames(it.city), oldNames(it.d), it.a, it.pin, it.op].filter(Boolean).join(' '));
      for (const alias of it.ids || []) if (alias !== it.id) S.alias.set(alias, it.id);
      if (it.sc) S.withHours.push(it);
    }
    buildPlaces();

    const p = new URLSearchParams(location.search);
    const states = new Set(S.items.map((it) => it.st));
    const cats = new Set(S.items.map((it) => it.c));
    const q = (p.get('q') || '').trim().slice(0, 100);
    if (q) { S.f.q = q; qInput.value = q; $('#qClear').hidden = false; }
    S.f.state = pickValue(p.get('state'), states);
    const dPool = S.f.state ? S.items.filter((it) => it.st === S.f.state) : S.items;
    S.f.district = pickValue(p.get('district'), new Set(dPool.map((it) => it.d).filter(Boolean)));
    if (S.f.district && !S.f.state) {
      const st = new Set(S.items.filter((it) => it.d === S.f.district).map((it) => it.st));
      if (st.size === 1) S.f.state = [...st][0]; else S.f.district = '';
    }
    S.f.cat = pickValue(p.get('cat'), cats);
    const wantedId = p.get('id');
    const target = wantedId && (S.byId.get(wantedId) || S.byId.get(S.alias.get(wantedId)));

    map.invalidateSize({ pan: false });
    if (!target) {
      map.fitBounds(INDIA, isMobile()
        ? { animate: false, paddingTopLeft: [0, topInset()], paddingBottomRight: [0, PEEK] }
        : { animate: false });
    }
    apply({ fit: !target && !!(S.f.q || S.f.state || S.f.district || S.f.cat) });
    renderMapLayers();
    $('#loading').hidden = true;
    if (p.get('rate') === '1' && wantedId) SSX.Track.add(target ? target.id : wantedId, 'q'); // a scan of the printed QR code
    if (target) {
      map.setView([target.la, target.lo], 17, { animate: false });
      if (p.get('rate') === '1') S.pendingRate = target.id; // the form opens as soon as ratings have loaded
      select(target, { fly: false, boot: true, rate: p.get('rate') === '1' });
    } else if (wantedId && /^SS-[a-z2-9]{8}$/.test(wantedId)) {
      S.pendingId = wantedId; // a washroom added by scouts: it arrives with /api/state
      if (p.get('rate') === '1') S.pendingRate = wantedId;
    } else if (wantedId) {
      toast('That washroom isn’t in the current list. It may have been removed from OpenStreetMap.');
    }
    snapshotStatuses();

    // ratings load in the background so a slow or missing API never blocks the map
    Ratings.init().then(onRatingsReady);
    setInterval(refreshStatuses, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatuses(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) refreshStatuses(); });
  }

  boot().catch((err) => {
    console.error(err);
    $('#loading').innerHTML = '<div style="text-align:center;padding:20px">Couldn’t load the washroom data. Please refresh the page.</div>';
  });
})();
