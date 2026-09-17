/* Ad review app (GitHub Pages + Google Apps Script backend).
 * Pages: index.html (projects) and project.html?p=<project>. Data: data/<project>.json (built by
 * scripts/build_web_review.py). Decisions live in the Google Sheet, one "batch" per data.batches[].
 * Access: the review link carries #k=<key>; it is kept in this browser afterwards. No key = view only. */
(function () {
  'use strict';
  var CFG = window.REVIEW_CONFIG || {};
  var KEY_STORE = 'ss-review-key', WHO_STORE = 'ss-review-who', POLL_MS = 20000;
  var LABEL = { '': 'To review', warn: 'Adjust', ok: 'Accepted', out: 'Rejected' };
  var REASONS = ['Photo', 'Text', 'Composition', 'Colors', 'Message', 'Format'];

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var m = location.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (m) { store(KEY_STORE, m[1]); history.replaceState(null, '', location.pathname + location.search); }
  var KEY = store(KEY_STORE) || '';
  var canReview = !!(KEY && CFG.endpoint);

  function api(batch) {
    return fetch(CFG.endpoint + '?key=' + encodeURIComponent(KEY) + '&batch=' + encodeURIComponent(batch)).then(function (r) { return r.json(); });
  }
  function getJSON(url) { return fetch(url, { cache: 'no-cache' }).then(function (r) { return r.json(); }); }

  /* status of a piece = live decision for its current version, else the baseline baked at build time */
  function stateOf(piece, remote) {
    var d = (remote.decisiones || {})[piece.id], r = (remote.respuestas || {})[piece.id];
    var version = Math.max(piece.version || 1, (r && r.version) || 1);
    var out = { estado: piece.baseline || '', nota: '', who: '', motivos: [], version: version, reply: r || null };
    if (d && (!d.version || +d.version === version)) {      // a decision on an older version no longer counts
      out.estado = d.estado || '';
      if (d.estado) { out.nota = d.nota || ''; out.who = d.who || ''; out.motivos = d.motivos || []; }
    }
    if (r && r.tipo === 'descartada') out.estado = 'out';
    return out;
  }

  /* ───────── home ───────── */
  function home() {
    var root = document.getElementById('projects');
    getJSON('data/projects.json').then(function (projects) {
      projects.forEach(function (p) {
        var counts = el('div', { class: 'counts' }, [el('span', { class: 'count', text: p.total + ' pieces' })]);
        var card = el('a', { class: 'project', href: 'project.html?p=' + p.id }, [
          el('div', { class: 'logo' }, [el('img', { src: p.logo, alt: '' })]),
          el('h2', { text: p.name }), el('p', { text: p.blurb }), counts, el('span', { class: 'open', text: 'Open project →' })
        ]);
        root.appendChild(card);
        if (!canReview) return;
        Promise.all([getJSON('data/' + p.id + '.json'), Promise.all(p.batches.map(api))]).then(function (res) {
          var c = { '': 0, warn: 0, ok: 0, out: 0 };
          res[0].pieces.forEach(function (piece) { var remote = res[1][res[0].batches.indexOf(piece.batch)] || {}; c[stateOf(piece, remote).estado]++; });
          counts.textContent = '';
          [['', 'todo', 'to review'], ['warn', 'warn', 'adjust'], ['ok', 'ok', 'accepted'], ['out', 'out', 'rejected']].forEach(function (x) {
            counts.appendChild(el('span', { class: 'count ' + x[1], text: c[x[0]] + ' ' + x[2] }));
          });
        }).catch(function () {});
      });
    });
    if (!canReview) document.getElementById('banner').hidden = false;
  }

  /* ───────── project ───────── */
  function project() {
    var pid = new URLSearchParams(location.search).get('p') || '';
    var data = null, remote = {}, pending = 0, tab = '', filter = '', current = null;
    var grid = document.getElementById('grid'), tabs = document.getElementById('tabs'), filters = document.getElementById('filters');
    var sync = document.getElementById('sync'), dlg = document.getElementById('focusbox');
    document.body.dataset.project = pid;

    var whoInput = document.getElementById('who');
    whoInput.value = store(WHO_STORE) || '';
    whoInput.addEventListener('change', function () { store(WHO_STORE, whoInput.value.trim()); });
    if (!canReview) { document.getElementById('banner').hidden = false; document.querySelector('.who').hidden = true; sync.textContent = 'View only'; }

    function st(piece) { return stateOf(piece, remote[piece.batch] || {}); }
    function visible() { return data.pieces.filter(function (p) { return (tab === 'all' || st(p).estado === tab) && (!filter || p.batchLabel === filter); }); }

    function renderTabs() {
      var c = { '': 0, warn: 0, ok: 0, out: 0 };
      data.pieces.forEach(function (p) { if (!filter || p.batchLabel === filter) c[st(p).estado]++; });
      tabs.textContent = '';
      [['', 'To review'], ['warn', 'Adjust'], ['ok', 'Accepted'], ['out', 'Rejected'], ['all', 'All']].forEach(function (t) {
        var n = t[0] === 'all' ? c[''] + c.warn + c.ok + c.out : c[t[0]];
        tabs.appendChild(el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === t[0]), onclick: function () { tab = t[0]; render(); } },
          [document.createTextNode(t[1]), el('b', { text: String(n) })]));
      });
    }
    function renderFilters() {
      var labels = []; data.pieces.forEach(function (p) { if (labels.indexOf(p.batchLabel) < 0) labels.push(p.batchLabel); });
      filters.textContent = '';
      if (labels.length < 2) return;
      [''].concat(labels).forEach(function (l) {
        filters.appendChild(el('button', { class: 'filter', type: 'button', 'aria-pressed': String(filter === l), text: l || 'Everything', onclick: function () { filter = l; render(); } }));
      });
    }
    function tile(p) {
      var s = st(p), first = p.media[0], gone = s.estado === 'out' && (p.deleted || (s.reply && s.reply.tipo === 'descartada')) || !first;
      var thumb = el('button', { class: 'thumb', type: 'button', 'aria-label': 'Focus on ' + p.id + ': ' + p.title, onclick: function () { openFocus(p.id); } }, [
        gone ? el('span', { class: 'gone', text: 'Deleted' }) : el('img', { src: first.poster || first.src, alt: '', loading: 'lazy' }),
        !gone && first.type === 'video' ? el('span', { class: 'kind', text: '▶ Video' }) : (!gone && p.media.length > 1 ? el('span', { class: 'kind', text: p.media.length + ' formats' }) : null),
        el('span', { class: 'badge', 'data-state': s.estado, text: LABEL[s.estado] })
      ]);
      function quick(v, label) {
        return el('button', { class: 'act', type: 'button', 'data-v': v, 'aria-pressed': String(s.estado === v), disabled: canReview ? null : '', text: label, onclick: function () {
          if (v === 'ok') save(p, { estado: s.estado === 'ok' ? '' : 'ok', nota: s.nota, motivos: [] });
          else openFocus(p.id, v);                       // adjust / reject need a comment: go to focus view
        } });
      }
      return el('article', { class: 'tile', 'data-state': s.estado }, [
        thumb,
        el('div', { class: 'meta' }, [
          el('div', { class: 'idrow' }, [el('span', { class: 'pid', text: p.id }), s.version > 1 ? el('span', { class: 'ver', text: 'v' + s.version }) : null, el('span', { class: 'batch', text: p.batchLabel })]),
          el('h3', { text: p.title }),
          el('div', { class: 'by', text: s.estado && s.who ? LABEL[s.estado] + ' by ' + s.who : '' })
        ]),
        el('div', { class: 'actions' }, [quick('ok', 'Accept'), quick('warn', 'Adjust'), quick('out', 'Reject'),
          el('button', { class: 'act focus', type: 'button', text: 'Focus', onclick: function () { openFocus(p.id); } })])
      ]);
    }
    function render() {
      renderTabs(); renderFilters();
      grid.textContent = '';
      var list = visible();
      if (!list.length) grid.appendChild(el('p', { class: 'empty', text: tab === '' ? 'Nothing left to review here.' : 'No pieces in this tab.' }));
      list.forEach(function (p) { grid.appendChild(tile(p)); });
      if (current && dlg.open) paintFocus();
    }

    /* save a decision */
    function save(p, body, savedEl) {
      var s = st(p), b = remote[p.batch] = remote[p.batch] || { decisiones: {}, respuestas: {} };
      b.decisiones = b.decisiones || {};
      b.decisiones[p.id] = { estado: body.estado, nota: body.nota || '', who: whoInput.value.trim(), motivos: body.motivos || [], version: s.version, t: 'pending' };
      render();
      if (savedEl) savedEl.textContent = 'Saving…';
      pending++;
      return fetch(CFG.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: KEY, action: 'decision', batch: p.batch, id: p.id, estado: body.estado, nota: body.nota || '', who: whoInput.value.trim(), extra: { motivos: body.motivos || [], version: s.version } }) })
        .then(function (r) { return r.json(); })
        .then(function (res) { pending--; var out = document.getElementById('fb-saved'); if (out && current === p.id) out.textContent = res && res.ok ? 'Saved. Claude picks it up on its next check.' : (res && res.error === 'bad_key' ? 'This link’s key is not valid. Ask Gustavo for a new link.' : 'Couldn’t save. Try again.'); })
        .catch(function () { pending--; var out = document.getElementById('fb-saved'); if (out) out.textContent = 'Couldn’t save. Check your connection and try again.'; });
    }

    /* focus modal */
    function openFocus(id, intent) {
      current = id; paintFocus(intent);
      if (!dlg.open) dlg.showModal();
      if (intent) { var ta = document.getElementById('fb-note'); if (ta) ta.focus(); }
    }
    function step(delta) { var list = visible(), i = list.map(function (x) { return x.id; }).indexOf(current) + delta; if (list[i]) { current = list[i].id; paintFocus(); } }
    function paintFocus(intent) {
      var p = data.pieces.filter(function (x) { return x.id === current; })[0]; if (!p) return;
      var s = st(p), draft = { estado: intent || s.estado, motivos: s.motivos.slice() };
      var gone = s.estado === 'out' && (p.deleted || (s.reply && s.reply.tipo === 'descartada')) || !p.media.length;
      // one format at a time (stacking them looked like the image repeating); switcher when there are several
      var media = el('div', { class: 'fb-media' });
      function showFormat(i) {
        media.textContent = '';
        if (gone) { media.appendChild(el('div', { class: 'gone', text: 'Deleted' })); return; }
        var mm = p.media[i];
        if (p.media.length > 1) media.appendChild(el('div', { class: 'formats', role: 'group', 'aria-label': 'Format' }, p.media.map(function (x, j) {
          return el('button', { type: 'button', 'aria-pressed': String(j === i), text: (x.label || ('Format ' + (j + 1))).split(' · ')[0], onclick: function () { showFormat(j); } });
        })));
        var node = mm.type === 'video' ? el('video', { src: mm.src, poster: mm.poster || null, controls: '', muted: '', loop: '', playsinline: '' }) : el('img', { src: mm.src, alt: p.id + ': ' + p.title });
        media.appendChild(el('figure', {}, [node, el('figcaption', { text: mm.label || '' })]));
      }
      showFormat(0);
      var info = el('div', { class: 'fb-info' });
      info.appendChild(el('div', { class: 'fb-head' }, [
        el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:8px' }, [
          el('div', { class: 'idrow' }, [el('span', { class: 'pid', text: p.id }), s.version > 1 ? el('span', { class: 'ver', text: 'v' + s.version }) : null, el('span', { class: 'batch', text: p.batchLabel + (p.group ? ' · ' + p.group : '') }), el('span', { class: 'badge', style: 'position:static', 'data-state': s.estado, text: LABEL[s.estado] })]),
          el('h2', { text: p.title })]),
        el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', text: '✕', onclick: function () { dlg.close(); } })]));
      if (p.chips.length) info.appendChild(el('div', { class: 'chips' }, p.chips.map(function (c) { return el('span', { class: 'chip', text: c }); })));
      if (s.reply && s.reply.mensaje) info.appendChild(el('div', { class: 'say' }, [el('span', { class: 'k', text: 'Claude' }), el('span', { text: s.reply.mensaje })]));
      if (p.change) info.appendChild(el('div', { class: 'say' }, [el('span', { class: 'k', text: 'Version ' + p.version }), el('span', { text: p.change })]));
      if (p.onImage) info.appendChild(el('p', { class: 'onimage' }, [el('span', { class: 'k', text: 'On the image' }), el('span', { text: p.onImage })]));
      p.copy.forEach(function (c) {
        var d = el('details', {}, [el('summary', { text: c.title })]);
        c.blocks.forEach(function (b) { if (b.sub) d.appendChild(el('div', { class: 'sub', text: b.sub })); d.appendChild(el('pre', { text: b.text })); });
        info.appendChild(d);
      });
      if (p.notes.length) info.appendChild(el('div', {}, [el('span', { class: 'k', text: 'Good to know' }), el('ul', { class: 'notes' }, p.notes.map(function (n) { return el('li', { text: n }); }))]));

      var saved = el('div', { class: 'saved', id: 'fb-saved', text: s.estado && s.who ? LABEL[s.estado] + ' by ' + s.who + '.' : '' });
      var ta = el('textarea', { id: 'fb-note', placeholder: 'For Adjust, say what to change. For Reject, say why (it helps Claude learn).', disabled: canReview ? null : '' });
      ta.value = s.nota;
      var why = el('div', { class: 'why', role: 'group' }, REASONS.map(function (r) {
        return el('button', { type: 'button', 'aria-pressed': String(draft.motivos.indexOf(r) >= 0), text: r, disabled: canReview ? null : '', onclick: function (ev) {
          var i = draft.motivos.indexOf(r); if (i >= 0) draft.motivos.splice(i, 1); else draft.motivos.push(r);
          ev.currentTarget.setAttribute('aria-pressed', String(i < 0));
        } });
      }));
      var whyWrap = el('div', { hidden: data.reasons && (draft.estado === 'warn' || draft.estado === 'out') ? null : '' }, [el('label', { text: 'What’s off? (pick any that apply)' }), why]);
      function btn(v, label) {
        return el('button', { class: 'act', type: 'button', 'data-v': v, 'aria-pressed': String(draft.estado === v), text: label, disabled: canReview ? null : '', onclick: function () {
          draft.estado = draft.estado === v ? '' : v;
          seg.querySelectorAll('.act').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === draft.estado)); });
          whyWrap.hidden = !(data.reasons && (draft.estado === 'warn' || draft.estado === 'out'));
          if (draft.estado === 'ok' || draft.estado === '') commit();
        } });
      }
      function commit() { save(p, { estado: draft.estado, nota: ta.value, motivos: draft.estado === 'ok' ? [] : draft.motivos }, saved); }
      var seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Decision for ' + p.id }, [btn('ok', 'Accept'), btn('warn', 'Adjust'), btn('out', 'Reject')]);
      var send = el('button', { class: 'act focus', type: 'button', text: 'Save decision', disabled: canReview ? null : '', onclick: commit });
      info.appendChild(el('div', { class: 'decide' }, [seg, whyWrap, el('label', { for: 'fb-note', text: 'Comment' }), ta, el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [send, saved])]));
      var list = visible().map(function (x) { return x.id; }), i = list.indexOf(current);
      info.appendChild(el('div', { class: 'fb-nav' }, [
        el('button', { type: 'button', text: '← Previous', disabled: i > 0 ? null : '', onclick: function () { step(-1); } }),
        el('button', { type: 'button', text: 'Next →', disabled: i >= 0 && i < list.length - 1 ? null : '', onclick: function () { step(1); } })]));
      var box = dlg.querySelector('.fb'); box.textContent = ''; box.appendChild(media); box.appendChild(info);
    }
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () { dlg.querySelectorAll('video').forEach(function (v) { v.pause(); }); current = null; });
    document.addEventListener('keydown', function (ev) {
      if (!dlg.open || /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
      if (ev.key === 'ArrowRight') step(1); if (ev.key === 'ArrowLeft') step(-1);
    });

    function pull() {
      if (!canReview || pending || (dlg.open && document.activeElement && document.activeElement.id === 'fb-note')) return;
      Promise.all(data.batches.map(api)).then(function (res) {
        if (pending) return;
        var ok = true, last = '';
        res.forEach(function (r, i) { if (r && r.ok) { remote[data.batches[i]] = r; if (r.last_check > last) last = r.last_check; } else ok = false; });
        sync.textContent = ok ? 'Connected' + (last ? ' · Claude checked at ' + new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : (res[0] && res[0].error === 'bad_key' ? 'Invalid review link' : 'Not connected');
        if (!(dlg.open)) render(); else { renderTabs(); }
      }).catch(function () { sync.textContent = 'Not connected'; });
    }

    getJSON('data/' + pid + '.json').then(function (d) {
      data = d;
      document.title = d.name + ' · Ad review';
      document.getElementById('pname').textContent = d.name;
      render(); pull();
      setInterval(function () { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
    }).catch(function () { grid.appendChild(el('p', { class: 'empty', text: 'Project not found.' })); });
  }

  if (document.body.dataset.page === 'home') home(); else project();
})();
