/* Civic dashboard: washrooms that need attention (public), the cleaning log, the officer action queue, and coverage. */
(function () {
  'use strict';
  const { esc, ic, nf, api, toast, ago, fmtDateTime, loadScript } = window.SS;
  const $ = (s, el) => (el || document).querySelector(s);
  const ISSUES = {
    dirty: 'Dirty', smell: 'Bad smell', no_water: 'No water', no_soap: 'No soap', no_light: 'No light',
    broken: 'Broken door, lock or fittings', clogged: 'Blocked or overflowing', unsafe: 'Felt unsafe',
    closed: 'Closed during opening hours', no_access: 'Not wheelchair accessible', overcharged: 'Charged more than listed',
    missing: 'Not here / wrong location', other: 'Something else',
  };
  const STATUS = { open: ['Open', 'bad'], ack: ['Acknowledged', 'warn'], resolved: ['Resolved', 'good'], rejected: ['Rejected', ''] };
  let PUB = null;
  let filt = { st: '', d: '', q: '' };
  let officerKey = '';
  try { officerKey = sessionStorage.getItem('ss.officer') || ''; } catch (e) { /* ignore */ }

  // ------------------------------------------------------------------ tabs
  const tabs = [...document.querySelectorAll('#civicTabs [role="tab"]')];
  function show(name, focus) {
    tabs.forEach((t) => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== `p-${name}`; });
    const u = new URL(location.href);
    if (name === 'attention') u.searchParams.delete('tab'); else u.searchParams.set('tab', name);
    history.replaceState(null, '', u);
    if (name === 'officer') renderOfficer();
    if (name === 'attention' && PUB) drawMap();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.tab, true); }
    });
  });

  // ------------------------------------------------------------------ public data
  /** fresh: after an officer's update, skip the short CDN cache so the counts and the log show it straight away. */
  async function loadPublic(fresh) {
    const r = await api(`/api/civic?action=public${fresh ? `&t=${Date.now()}` : ''}`, { auth: false });
    if (r.enabled === false) {
      PUB = null;
      $('#civicKpis').innerHTML = '';
      const off = r.noApi
        ? `<div class="card" style="margin-top:16px"><h2>Live reports need the site’s server</h2><p class="c-sub">The server functions aren’t running on this host (for example a static preview), so live reports, ratings and the cleaning log can’t load here. The coverage of mapped washrooms is in the “Coverage &amp; data” tab.</p></div>`
        : `<div class="card" style="margin-top:16px"><h2>Live reports aren’t switched on yet</h2><p class="c-sub">This dashboard fills up with ratings and hygiene reports once the site’s database is connected. The coverage of mapped washrooms is in the “Coverage &amp; data” tab.</p></div>`;
      $('#p-attention').innerHTML = off;
      $('#p-cleaned').innerHTML = off;
      return;
    }
    if (!r.ok) {
      // a temporary problem: say so in both live tabs, with a retry (keep showing older data if we had it)
      if (PUB) { toast(r.j.error || 'Couldn’t refresh the dashboard.'); return; }
      $('#civicKpis').innerHTML = '';
      const card = (id) => `<div class="card" style="margin-top:16px" role="alert"><h2 style="margin:0 0 4px">Couldn’t load the dashboard</h2><p class="c-sub">${esc(r.j.error || 'Please try again in a moment.')}</p><button class="btn" type="button" data-retry="${id}">${ic('refresh', 'sm')} Try again</button></div>`;
      $('#p-attention').innerHTML = card('attention');
      $('#p-cleaned').innerHTML = card('cleaned');
      return;
    }
    PUB = r.j;
    const t = PUB.totals;
    $('#civicKpis').innerHTML = [
      ['Open problem reports', t.openReports, 'Waiting for the operator or municipality'],
      ['Washrooms need attention', t.needAttention, 'Open reports, or rated poorly since the last cleaning'],
      ['Cleanings logged', t.cleanings, 'Cleanings and fixes by officers and operators'],
      ['Reports (recent)', t.recentReports, 'Last 5,000 reports'],
    ].map(([l, v, s]) => `<div class="kpi"><div class="k-label">${l}</div><div class="k-val">${nf(v)}</div><div class="k-sub">${s}</div></div>`).join('');
    renderAttention();
    renderCleaned();
  }
  ['#p-attention', '#p-cleaned'].forEach((sel) => $(sel).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-retry]');
    if (!b) return;
    b.disabled = true; b.textContent = 'Trying again…';
    const which = b.dataset.retry;
    await loadPublic(true);
    // focus the retry button again if it still fails, otherwise the section heading
    const next = $(`#p-${which} [data-retry]`) || $(`#p-${which} h2`);
    if (next) { if (next.tagName === 'H2') next.setAttribute('tabindex', '-1'); next.focus(); }
  }));

  function renderAttention() {
    const list = PUB.attention || [];
    const states = [...new Set(list.map((x) => x.st).filter(Boolean))].sort();
    const districts = [...new Set(list.filter((x) => !filt.st || x.st === filt.st).map((x) => x.d).filter(Boolean))].sort();
    $('#p-attention').innerHTML = `
      <div class="card" style="margin-top:16px">
        <div class="row between"><div><h2 style="margin:0">Needs attention</h2><p class="c-sub" style="margin:4px 0 0">Most urgent first: open reports count most, then how low the latest ratings are. A washroom that is only rated poorly leaves this list once it’s marked cleaned, until newer ratings come in.</p></div></div>
        <div class="grid-3" style="margin-top:12px">
          <label class="field"><span>State / UT</span><select id="fSt"><option value="">All of India</option>${states.map((s) => `<option${s === filt.st ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field"><span>District</span><select id="fD"><option value="">All districts</option>${districts.map((s) => `<option${s === filt.d ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field"><span>Search</span><input id="fQ" type="search" value="${esc(filt.q)}" placeholder="Name or area"></label>
        </div>
        <div class="minimap" id="civicMap" style="height:320px;margin-top:4px" role="region" aria-label="Map of washrooms that need attention"></div>
        <p class="rate-note"><span style="color:#d43c3c">●</span> open problem reports &nbsp; <span style="color:#e2a91c">●</span> poor recent rating only</p>
        <div id="attList" style="margin-top:10px"></div>
      </div>`;
    $('#fSt').addEventListener('change', (e) => { filt.st = e.target.value; filt.d = ''; renderAttention(); });
    $('#fD').addEventListener('change', (e) => { filt.d = e.target.value; renderAttentionList(); drawMap(); });
    $('#fQ').addEventListener('input', (e) => { filt.q = e.target.value; renderAttentionList(); drawMap(); });
    renderAttentionList();
    drawMap();
  }
  function filtered() {
    const q = filt.q.trim().toLowerCase();
    return (PUB.attention || []).filter((x) => (!filt.st || x.st === filt.st) && (!filt.d || x.d === filt.d) && (!q || `${x.n} ${x.area}`.toLowerCase().includes(q)));
  }
  function renderAttentionList() {
    const list = filtered();
    $('#attList').innerHTML = list.length ? `<div class="tbl-wrap"><table class="data"><thead><tr><th>Washroom</th><th>Area</th><th class="num">Open reports</th><th class="num">Recent rating</th><th class="num">All-time</th><th>Last cleaned</th></tr></thead><tbody>${list.slice(0, 200).map((x) => `<tr>
        <td><a href="/?id=${encodeURIComponent(x.id)}">${esc(x.n)}</a></td><td>${esc(x.area)}</td>
        <td class="num">${x.open ? `<span class="st bad">${x.open}</span>` : '—'}</td>
        <td class="num">${x.recent != null ? `${x.recent.toFixed(1)}★` : '—'}</td>
        <td class="num">${x.avg != null ? `${x.avg.toFixed(1)}★ (${x.ratings})` : '—'}</td>
        <td>${x.lastCleaned ? `${esc(ago(x.lastCleaned.at))}<br><small class="muted">${esc(x.lastCleaned.by)}</small>` : '—'}</td></tr>`).join('')}</tbody></table></div>${list.length > 200 ? `<p class="rate-note">Showing the 200 most urgent of ${nf(list.length)}.</p>` : ''}`
      : `<div class="empty"><p>${PUB.attention.length ? 'Nothing matches these filters.' : 'Nothing needs attention right now. 🎉'}</p></div>`;
  }

  // a small Leaflet map, loaded only when this tab is shown
  let lmap = null, layer = null;
  async function drawMap() {
    const el = $('#civicMap');
    if (!el || el.offsetParent === null) return;
    try {
      if (!document.querySelector('link[href*="leaflet.css"]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; l.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; l.crossOrigin = '';
        document.head.appendChild(l);
      }
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
    } catch (e) { el.innerHTML = '<p class="loading-line">The map couldn’t load.</p>'; return; }
    const L = window.L;
    if (!lmap || lmap.getContainer() !== el) {
      lmap = L.map(el, { zoomControl: true, scrollWheelZoom: false }).setView([22.5, 79], 4);
      L.tileLayer(SS.TILES.url, { maxZoom: SS.TILES.maxZoom, attribution: SS.TILES.attribution }).addTo(lmap);
      layer = L.layerGroup().addTo(lmap);
    }
    layer.clearLayers();
    const pts = filtered().filter((x) => typeof x.la === 'number');
    for (const x of pts) {
      L.circleMarker([x.la, x.lo], { radius: 6 + Math.min(8, x.open * 2), color: '#fff', weight: 2, fillColor: x.open ? '#d43c3c' : '#e2a91c', fillOpacity: 0.9 })
        .bindPopup(`<b>${esc(x.n)}</b><br>${esc(x.area)}<br>${x.open ? `${x.open} open report${x.open === 1 ? '' : 's'}` : ''}${x.recent != null ? ` · recent ${x.recent.toFixed(1)}★` : ''}<br><a href="/?id=${encodeURIComponent(x.id)}">Open on the map</a>`)
        .addTo(layer);
    }
    if (pts.length) lmap.fitBounds(L.latLngBounds(pts.map((x) => [x.la, x.lo])), { maxZoom: 14, padding: [24, 24] });
    setTimeout(() => lmap.invalidateSize(), 50);
  }

  function renderCleaned() {
    const c = PUB.cleaned || [];
    $('#p-cleaned').innerHTML = `<div class="card" style="margin-top:16px"><h2 style="margin:0 0 4px">Recently cleaned</h2><p class="c-sub">One entry for each cleaning or fix recorded by a municipal officer, the Swachh Scan team or the washroom’s operator. Updates to the same washroom by the same person within 30 minutes count once. When an officer confirms a fix, the scout who reported it gets bonus coins.</p>
      ${c.length ? `<div class="rows">${c.map((x) => `<div class="rowcard"><span class="o-ico" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--good-bg);color:var(--good)">${ic('broom')}</span><div class="main"><div class="title"><a href="/?id=${encodeURIComponent(x.id)}">${esc(x.n)}</a></div><div class="sub">${esc(x.area)} · by ${esc(x.by)} · ${esc(ago(x.at))}${x.resolved ? ` · closed ${x.resolved} report${x.resolved === 1 ? '' : 's'}` : ''}</div></div></div>`).join('')}</div>` : '<p class="muted">No cleanings logged yet.</p>'}</div>`;
  }

  // ------------------------------------------------------------------ officer
  async function renderOfficer() {
    const el = $('#p-officer');
    if (!officerKey) {
      el.innerHTML = `<div class="card" style="margin-top:16px;max-width:560px"><h2 style="margin:0 0 4px">Municipal officer sign-in</h2>
        <p class="c-sub">Officers get an access key from the Swachh Scan team. It shows every open report in your area, with the details people wrote, so you can send a cleaning team and close the report.</p>
        <form class="form" id="keyForm" onsubmit="return false"><label class="field"><span>Access key</span><input name="key" autocomplete="off" spellcheck="false" placeholder="ak_…" required></label>
        <p class="form-error" id="keyErr" role="alert" hidden></p><button class="btn primary" type="submit">${ic('lock')} Sign in</button></form>
        <p class="rate-note">Want access for your municipality? Write to the Swachh Scan team.</p></div>`;
      $('#keyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const k = f.elements.key.value.trim();
        const er = $('#keyErr');
        if (!k) { er.textContent = 'Enter your access key.'; er.hidden = false; f.elements.key.focus(); return; }
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        const r = await api('/api/civic?action=me', { token: k });
        btn.disabled = false;
        if (!r.ok) {
          er.textContent = r.enabled === false
            ? (r.noApi ? 'Officer sign-in needs the site’s server functions, which aren’t running on this host.' : 'The site’s database isn’t connected yet.')
            : (r.j.error || 'Couldn’t sign in. Please try again.');
          er.hidden = false;
          f.elements.key.focus();
          return;
        }
        officerKey = k;
        try { sessionStorage.setItem('ss.officer', k); } catch (err) { /* ignore */ }
        await renderOfficer();
        const h = $('#p-officer h2');
        if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
      });
      return;
    }
    el.innerHTML = '<div class="loading-line">Loading your queue…</div>';
    const r = await api('/api/civic?action=queue', { token: officerKey });
    if (r.status === 401) { officerKey = ''; try { sessionStorage.removeItem('ss.officer'); } catch (e) { /* ignore */ } renderOfficer(); return; }
    if (!r.ok) {
      el.innerHTML = `<div class="card" style="margin-top:16px" role="alert"><h2 style="margin:0 0 4px">Couldn’t load your queue</h2><p class="c-sub">${esc(r.j.error || 'Please try again in a moment.')}</p>
        <div class="row"><button class="btn" type="button" data-o="refresh">${ic('refresh', 'sm')} Try again</button><button class="btn ghost" type="button" data-o="signout">${ic('logout', 'sm')} Sign out</button></div></div>`;
      return;
    }
    const { officer, groups, lowRated } = r.j;
    const sc = officer.scope || {};
    const area = [...(sc.states || []), ...(sc.districts || []), ...(sc.cities || [])].join(', ') || 'All of India';
    let h = `<div class="card" style="margin-top:16px"><div class="row between"><div><h2 style="margin:0">${esc(officer.name)}</h2><p class="c-sub" style="margin:2px 0 0">${officer.dept ? `${esc(officer.dept)} · ` : ''}Area: ${esc(area)}</p></div>
      <div class="row"><button class="btn sm" type="button" data-o="refresh">${ic('refresh', 'sm')} Refresh</button><button class="btn sm" type="button" data-o="signout">${ic('logout', 'sm')} Sign out</button></div></div>
      <label class="field" style="margin-top:12px;max-width:520px"><span>Note added to your updates (optional, shown publicly)</span><input id="oNote" maxlength="200" placeholder="e.g. Cleaning team sent, water supply restored"></label></div>`;
    h += `<h2 class="eyebrow" id="oqOpen" tabindex="-1">${ic('flag')} Open reports <span class="spacer"></span><span class="muted small" style="text-transform:none;letter-spacing:0">${nf(groups.reduce((a, g) => a + g.reports.length, 0))} in ${nf(groups.length)} washroom${groups.length === 1 ? '' : 's'}</span></h2>`;
    h += groups.length ? `<div class="rows">${groups.map((g) => `<div class="card" style="margin:0" data-w="${esc(g.id)}">
        <div class="row between"><div><b><a href="/?id=${encodeURIComponent(g.id)}" target="_blank" rel="noopener">${esc(g.n)}</a></b><div class="small muted">${esc(g.area)}${g.la ? ` · <a href="https://www.google.com/maps/dir/?api=1&destination=${g.la},${g.lo}" target="_blank" rel="noopener">Directions</a>` : ''}</div></div>
          <button class="btn good sm" type="button" data-o="cleaned" data-id="${esc(g.id)}" aria-label="Mark ${esc(g.n)} cleaned and close all its reports">${ic('broom', 'sm')} Mark cleaned (all)</button></div>
        <div class="report-list">${g.reports.map((x) => `<div class="report-item"><div class="ri-top"><b>${esc(x.issues.map((k) => ISSUES[k] || k).join(', '))}</b><span class="st ${STATUS[x.status][1]}">${STATUS[x.status][0]}</span></div>
          ${x.note ? `<div style="margin:4px 0">“${esc(x.note)}”</div>` : ''}<div class="small muted">${esc(fmtDateTime(x.at))} (${esc(ago(x.at))})${x.scout ? ' · by a Swachh Scout' : ''}${x.status === 'ack' && x.by ? ` · acknowledged by ${esc(x.by)}` : ''}</div>
          <div class="row" style="margin-top:6px">${x.status === 'open' ? `<button class="btn sm" type="button" data-o="ack" data-r="${esc(x.id)}">Acknowledge</button>` : ''}<button class="btn sm good" type="button" data-o="resolved" data-r="${esc(x.id)}"${x.scout ? ' data-scout="1"' : ''}>Resolved</button><button class="btn sm danger" type="button" data-o="rejected" data-r="${esc(x.id)}">Not valid</button></div></div>`).join('')}</div>
      </div>`).join('')}</div>` : '<div class="card soft"><p style="margin:0">No open reports in your area. 🎉</p></div>';
    if (lowRated.length) {
      h += `<h2 class="eyebrow" id="oqLow" tabindex="-1">${ic('star')} Rated poorly lately (no open report)</h2><p class="c-sub" style="margin:-4px 0 10px">Send a team, then mark it cleaned: it leaves this list and “Needs attention” until newer ratings come in.</p><div class="tbl-wrap"><table class="data"><thead><tr><th>Washroom</th><th>Area</th><th class="num">Recent</th><th class="num">All-time</th><th><span class="visually-hidden">Action</span></th></tr></thead><tbody>${lowRated.map((x) => `<tr><td><a href="/?id=${encodeURIComponent(x.id)}" target="_blank" rel="noopener">${esc(x.n)}</a></td><td>${esc(x.area)}</td><td class="num">${x.recent != null ? x.recent.toFixed(1) + '★' : '—'}</td><td class="num">${x.avg != null ? `${x.avg.toFixed(1)}★ (${x.ratings})` : '—'}</td><td><button class="btn sm good" type="button" data-o="cleaned" data-id="${esc(x.id)}" data-low="1" aria-label="Mark ${esc(x.n)} cleaned">Mark cleaned</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    el.innerHTML = h;
  }
  $('#p-officer').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-o]');
    if (!b) return;
    const o = b.dataset.o;
    const focusFirst = (sels) => { for (const s of sels) { const t = s && $(`#p-officer ${s}`); if (t) { t.focus(); return; } } };
    if (o === 'signout') { officerKey = ''; try { sessionStorage.removeItem('ss.officer'); } catch (err) { /* ignore */ } await renderOfficer(); focusFirst(['input[name="key"]']); return; }
    if (o === 'refresh') { b.disabled = true; await renderOfficer(); focusFirst(['[data-o="refresh"]']); return; }
    const note = ($('#oNote') || {}).value || '';
    if (o === 'rejected' && !confirm('Close this report as not valid? The reporter gets no bonus.')) return;
    // where keyboard focus goes once the queue is redrawn (this control is replaced or gone)
    const q = (v) => CSS.escape(v || '');
    const grp = b.closest('[data-w]');
    const w = grp ? grp.dataset.w : '';
    const next = o === 'ack' ? [`[data-o="resolved"][data-r="${q(b.dataset.r)}"]`]
      : o === 'cleaned' ? (b.dataset.low ? ['#oqLow', '#oqOpen'] : ['#oqOpen'])
        : [w && `[data-w="${q(w)}"] [data-r]`, w && `[data-w="${q(w)}"] [data-o="cleaned"]`, '#oqOpen'];
    b.disabled = true;
    const body = o === 'cleaned' ? { action: 'cleaned', id: b.dataset.id, note } : { action: 'update', report: b.dataset.r, status: o, note };
    const r = await api('/api/civic', { token: officerKey, body });
    if (!r.ok) {
      toast(r.j.error || 'Couldn’t save. Try again.');
      b.disabled = false; b.focus();
      if (r.status === 401) renderOfficer();
      return;
    }
    toast(o === 'cleaned' ? `Marked cleaned${r.j.resolved ? ` — ${r.j.resolved} report${r.j.resolved === 1 ? '' : 's'} closed` : ''}${b.dataset.low ? '. It’s off the list until new ratings come in.' : ''}`
      : o === 'ack' ? 'Acknowledged' : o === 'resolved' ? (b.dataset.scout ? 'Resolved — the scout who reported it gets bonus coins' : 'Resolved') : 'Closed as not valid');
    await renderOfficer();
    focusFirst(next);
    loadPublic(true);
  });

  const startTab = new URLSearchParams(location.search).get('tab');
  if (['cleaned', 'officer', 'coverage'].includes(startTab)) show(startTab);
  loadPublic();
})();
