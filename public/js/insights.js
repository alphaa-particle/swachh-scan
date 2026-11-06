/* Swachh Scan — Insights page. Reads /data/meta.json (built from every sheet of the workbook). */
(function () {
  'use strict';
  const { esc, nf, pct, fetchJSON } = window.SS;
  const $ = (s) => document.querySelector(s);

  // sequential blue ramp (light -> dark) for table heat cells; labels flip to white on the darker half
  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95'];
  function heat(v) {
    const i = Math.max(0, Math.min(RAMP.length - 1, Math.round((v / 100) * (RAMP.length - 1))));
    return `background:${RAMP[i]};color:${i >= 8 ? '#ffffff' : '#000000'}`; // black on #2a78d6 is 4.76:1
  }

  // ---------- tooltip shared by all charts
  const tip = $('#tip');
  function showTip(el, x, y) {
    tip.innerHTML = el.getAttribute('data-tip');
    tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 10;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 18;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = top + 'px';
  }
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('show');
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', () => tip.classList.remove('show'));

  // ---------- chart/table toggles
  document.querySelectorAll('.toggle').forEach((t) => {
    t.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      const card = t.closest('.card');
      t.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      card.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.view; });
    });
  });

  // ---------- chart builders (single series, so no legend: the card title names it)
  function bars(el, rows, opts) {
    const max = Math.max(...rows.map((r) => r.value), 1);
    const scale = opts.max || max;
    el.innerHTML = rows.map((r) => {
      const w = (r.value / scale) * 100;
      const tag = r.href ? 'a' : 'div';
      return `<${tag} class="bar-row" ${r.href ? `href="${esc(r.href)}"` : 'role="img" tabindex="0"'} data-tip="${esc(r.tip)}" aria-label="${esc(r.label)}: ${esc(opts.fmt(r.value))}">
        <span class="b-label">${esc(r.label)}</span>
        <span class="b-track"><span class="b-fill${r.value > 0 ? ' nz' : ''}" style="width:${w}%"></span></span>
        <span class="b-val">${esc(opts.fmt(r.value))}</span>
      </${tag}>`;
    }).join('');
  }

  function cols(el, labelsEl, rows, labelEvery) {
    const max = Math.max(...rows.map((r) => r.value), 1);
    el.innerHTML = rows.map((r) => `<div class="col" role="img" tabindex="0" data-tip="${esc(r.tip)}" aria-label="${esc(r.label)}: ${nf(r.value)}"><div class="c-fill${r.value > 0 ? ' nz' : ''}" style="height:${(r.value / max) * 100}%"></div></div>`).join('');
    labelsEl.innerHTML = rows.map((r, i) => `<span>${i % (labelEvery || 1) === 0 || i === rows.length - 1 ? esc(r.short || r.label) : ''}</span>`).join('');
  }

  function table(el, head, rows) {
    el.innerHTML = `<thead><tr>${head.map((h) => `<th class="${h.num ? 'num' : ''}">${esc(h.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${head[i].num ? 'num' : ''}${c && c.heat != null ? ' heat' : ''}"${c && c.heat != null ? ` style="${heat(c.heat)}"` : ''}>${c && c.html != null ? c.html : esc(c && c.v != null ? c.v : c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }

  // ---------- render
  function render(m) {
    const a = m.about;
    const total = +a['Total washrooms'];
    const standalone = +a['Standalone public toilets'];
    const facKey = Object.keys(a).find((k) => k.startsWith('Facilities with a toilet'));
    const fac = +a[facKey];
    const downloaded = a['Data downloaded'] ? new Date(a['Data downloaded']).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

    const inputRows = ((m.cleaning && m.cleaning.steps) || []).find((x) => x.stage === 'Input');
    const verified = +a['Recently verified'] || 0;
    $('#heroText').textContent = `${nf(total)} washrooms across ${a['States / UTs covered']} states and union territories, cleaned and de-duplicated from ${inputRows ? nf(inputRows.count) : ''} OpenStreetMap records downloaded ${downloaded}.`;

    $('#tiles').innerHTML = [
      { label: 'Washrooms on the map', val: nf(total), sub: 'after cleaning and de-duplication', hero: true },
      { label: 'Recently verified', val: nf(verified), sub: `${Math.round((100 * verified) / total)}% edited in the last 5 years` },
      { label: 'Standalone public toilets', val: nf(standalone), sub: `${pct(standalone, total)}% of all` },
      { label: 'Toilets inside facilities', val: nf(fac), sub: 'malls, restaurants, petrol pumps…' },
      { label: 'States & UTs', val: a['States / UTs covered'], sub: `${a['Districts covered']} districts` },
    ].map((t) => `<div class="tile${t.hero ? ' hero-tile' : ''}"><div class="t-label">${esc(t.label)}</div><div class="t-val">${esc(t.val)}</div><div class="t-sub">${esc(t.sub)}</div></div>`).join('');

    // what we know
    const K = m.stats.known;
    const knownRows = [
      ['Free to use', K.free, 'with fee info'],
      ['Wheelchair accessible', K.wheelchair, 'with wheelchair info (incl. limited)'],
      ['Has a women’s toilet', K.women, 'with men/women info'],
      ['Open 24 hours', K.open247, 'with opening hours'],
      ['Handwashing available', K.handwashing, 'with handwashing info'],
      ['Western (seated) toilet', K.western, 'with toilet style info'],
      ['Drinking water', K.water, 'with drinking water info'],
      ['Baby changing', K.baby, 'with baby changing info'],
    ];
    $('#known').innerHTML = knownRows.map(([name, k, what]) => {
      const p = Math.round((100 * k.yes) / (k.known || 1));
      return `<div class="known-row"><span class="k-name">${esc(name)}</span>
        <span class="meter" role="img" aria-label="${p}%" data-tip="${esc(`<strong>${esc(name)}</strong>${nf(k.yes)} of ${nf(k.known)} washrooms ${esc(what)}`)}"><span style="width:${p}%"></span></span>
        <span class="k-note"><strong>${p}%</strong> of ${nf(k.known)} ${esc(what)} <span style="color:var(--muted)">(${Math.round((100 * k.known) / total)}% of all)</span></span></div>`;
    }).join('');

    // by state
    const states = m.byState.slice().sort((x, y) => y['Total washrooms'] - x['Total washrooms']);
    bars($('#stateBars'), states.map((s) => ({
      label: s['State / UT'], value: s['Total washrooms'], href: `/?state=${encodeURIComponent(s['State / UT'])}`,
      tip: `<strong>${esc(s['State / UT'])}</strong>${nf(s['Total washrooms'])} washrooms<br>${nf(s['Standalone public toilets'])} standalone · ${nf(s['Facilities with toilet'])} in facilities<br>${s['Districts with data']} district${s['Districts with data'] === 1 ? '' : 's'} with data`,
    })), { fmt: nf });
    const pcols = ['% recently verified', '% with free/paid info', '% with wheelchair info', '% with men/women info', '% with opening hours'].filter((c) => c in (states[0] || {}));
    const plabels = { '% recently verified': 'Recently verified', '% with free/paid info': 'Free/paid info', '% with wheelchair info': 'Wheelchair info', '% with men/women info': 'Men/women info', '% with opening hours': 'Opening hours' };
    table($('#stateTable'),
      [{ label: 'State / UT' }, { label: 'Washrooms', num: true }, { label: 'Standalone', num: true }, { label: 'In facilities', num: true }, { label: 'Districts', num: true },
        ...pcols.map((c) => ({ label: plabels[c], num: true }))],
      states.map((s) => [
        { html: `<a href="/?state=${encodeURIComponent(s['State / UT'])}">${esc(s['State / UT'])}</a>` },
        nf(s['Total washrooms']), nf(s['Standalone public toilets']), nf(s['Facilities with toilet']), s['Districts with data'],
        ...pcols.map((c) => ({ v: `${s[c]}%`, heat: s[c] })),
      ]));

    // categories (top 14 + other)
    const cats = m.byCategory.slice().sort((x, y) => y.Washrooms - x.Washrooms);
    const top = cats.slice(0, 14);
    const rest = cats.slice(14);
    const restN = rest.reduce((s, c) => s + c.Washrooms, 0);
    const catRows = top.map((c) => ({ label: c.Category, value: c.Washrooms, href: `/?cat=${encodeURIComponent(c.Category)}`, tip: `<strong>${esc(c.Category)}</strong>${nf(c.Washrooms)} washrooms · ${c['Share %']}%` }));
    if (restN) catRows.push({ label: `Other (${rest.length} types)`, value: restN, tip: `<strong>${rest.length} other types</strong>${nf(restN)} washrooms, e.g. ${esc(rest.slice(0, 4).map((c) => c.Category).join(', '))}` });
    bars($('#catBars'), catRows, { fmt: nf });
    $('#catSub').textContent = `${cats.length} types of place. Select one to see it on the map.`;
    table($('#catTable'), [{ label: 'Category' }, { label: 'Group' }, { label: 'Washrooms', num: true }, { label: 'Share', num: true }],
      cats.map((c) => [{ html: `<a href="/?cat=${encodeURIComponent(c.Category)}">${esc(c.Category)}</a>` }, c.Group || '', nf(c.Washrooms), `${c['Share %']}%`]));

    // completeness per column
    const fill = m.features.filter((f) => f.Chart).sort((x, y) => y['% filled'] - x['% filled']);
    bars($('#fillBars'), fill.map((f) => ({
      label: f.Column, value: f['% filled'],
      tip: `<strong>${esc(f.Column)}</strong>${esc(f['What it means'])}<br>${nf(f['Rows filled'])} of ${nf(total)} filled`,
    })), { fmt: (v) => `${v}%`, max: 100 });
    table($('#fillTable'), [{ label: 'Detail' }, { label: 'Rows filled', num: true }, { label: '% filled', num: true }],
      fill.map((f) => [f.Column, nf(f['Rows filled']), `${f['% filled']}%`]));

    // detail score distribution
    const ds = m.stats.detailScore;
    cols($('#scoreCols'), $('#scoreLabels'), ds.map((n, i) => ({ label: `${i} of 9 details`, short: String(i), value: n, tip: `<strong>${i} of 9 details</strong>${nf(n)} washrooms (${pct(n, total)}%)` })));
    $('#scoreNote').textContent = `${nf(ds[0])} washrooms (${Math.round((100 * ds[0]) / total)}%) have none of the 9 details yet — just a location.`;

    // freshness
    const yrs = m.stats.editedByYear;
    cols($('#yearCols'), $('#yearLabels'), yrs.map(([y, n]) => ({ label: String(y), short: `’${String(y).slice(2)}`, value: n, tip: `<strong>${y}</strong>${nf(n)} records last edited` })), 3);
    const thisYear = new Date().getFullYear();
    const recent = yrs.filter(([y]) => y >= thisYear - 2).reduce((s, [, n]) => s + n, 0);
    $('#yearNote').textContent = `${Math.round((100 * recent) / total)}% were edited in ${thisYear - 2} or later.`;

    // how the data was cleaned
    if (m.cleaning) {
      const c = m.cleaning;
      const ref = new Date(c.referenceDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      $('#cleanIntro').innerHTML = `Every record from the workbook went through the steps below before it reached the map. Freshness is measured from the data download date (${esc(ref)}): records last edited more than ${c.staleDropYears} years earlier were removed; records ${c.staleStripYears}–${c.staleDropYears} years old keep only their location and are marked “not recently verified”.`;
      table($('#cleanTable'), [{ label: 'Stage' }, { label: 'What happened' }, { label: 'Records', num: true }, { label: 'Note' }],
        c.steps.map((x) => [{ html: `<strong>${esc(x.stage)}</strong>` }, x.what, nf(x.count), x.note || '']));
    }

    // about, sources, dictionary
    $('#aboutProse').innerHTML = `<p>${esc(a.Important)}</p><p>All numbers on this page are calculated from the cleaned data shown on the map, and the downloads below contain that cleaned data.</p><p><strong>Credit:</strong> ${esc(a['Credit required'])}</p>
      <p>The workbook has these sheets: ${Object.entries(m.sheets).map(([k, v]) => `<strong>${esc(k)}</strong> (${esc(v.charAt(0).toLowerCase() + v.slice(1))})`).join('; ')}.</p>`;
    const link = (s) => {
      const text = String(s || '');
      const m = /https?:\/\/[^\s)"'<>]+/.exec(text);
      if (!m) return esc(text);
      const url = m[0].replace(/[.,;]+$/, '');
      const at = text.indexOf(url);
      return esc(text.slice(0, at)) + `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>` + esc(text.slice(at + url.length));
    };
    table($('#sourcesTable'), [{ label: 'Source' }, { label: 'Status' }, { label: 'What it covers / how it was used' }, { label: 'Licence / terms' }, { label: 'Link / next step' }],
      m.sources.map((s) => [{ html: `<strong>${esc(s.Source)}</strong>` }, s.Status, s['What it covers / how it was used'], s['Licence / terms'], { html: link(s['Link / next step']) }]));
    table($('#featuresTable'), [{ label: 'Column' }, { label: 'What it means' }, { label: 'OpenStreetMap tag / source' }, { label: 'Filled', num: true }],
      m.features.map((f) => [{ html: `<strong>${esc(f.Column)}</strong>` }, f['What it means'], { html: `<code>${esc(f['OpenStreetMap tag / source'])}</code>` }, `${f['% filled']}%`]));

    $('#foot').innerHTML = `Washroom data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, available under the Open Database Licence. Site data built ${esc(m.built)}.`;
  }

  fetchJSON('/data/meta.json').then(render).catch((e) => {
    console.error(e);
    $('#heroText').textContent = 'Couldn’t load the data. Please refresh the page.';
  });
})();
