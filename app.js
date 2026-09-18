/* Ad review app (GitHub Pages + Google Apps Script backend).
 * Pages: index.html (projects) and project.html?p=<project>. Data: data/<project>.json (built by
 * scripts/build_web_review.py). Decisions live in the Google Sheet, one "batch" per data.batches[].
 * Access: the review link carries #k=<key> (optionally &who=<name>); both are kept in this browser
 * afterwards. No key = view only. */
(function () {
  'use strict';
  var CFG = window.REVIEW_CONFIG || {};
  var KEY_STORE = 'ss-review-key', WHO_STORE = 'ss-review-who', POLL_MS = 20000;
  var SAVE_TIMEOUT_MS = 25000, RETRY_MS = [1500, 3000, 6000], ADVANCE_MS = 600, NOTICE_MS = 9000;
  var LABEL = { '': 'To review', warn: 'Adjust', ok: 'Accepted', out: 'Rejected' };
  var REASONS = ['Photo', 'Text', 'Composition', 'Colors', 'Message', 'Format'];
  var RIBBON = { working: 'Claude is working on it', rehecha: 'New version — please review', final: 'Saved to posts', descartada: 'Deleted' };
  var NAME_HINT = 'Type your name first so Claude knows who decided';
  var BAD_KEY = 'This link’s key is not valid. Ask Gustavo for a new link.';
  var RETRYABLE = { busy: 1, server_error: 1, bad_response: 1 };   // transient backend answers; anything else is final
  var ERRMSG = { bad_key: BAD_KEY, too_long: 'comment too long (max 5000 characters)' };
  function errMsg(res) { var e = res && res.error; return ERRMSG[e] || ('rejected by the server' + (e ? ' (' + e + ')' : '')); }

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
  function sameSet(a, b) { a = (a || []).slice().sort(); b = (b || []).slice().sort(); return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  /* the review link: #k=<key> or #k=<key>&who=<name>; both go to localStorage and leave the URL */
  var hash = location.hash || '';
  var mk = hash.match(/(?:^#|[#&])k=([A-Za-z0-9_-]+)/), mw = hash.match(/(?:^#|[#&])who=([^&]+)/);
  var linkWho = '';
  if (mw) { try { linkWho = decodeURIComponent(mw[1].replace(/\+/g, ' ')).trim().slice(0, 40); } catch (e) { /* malformed escape: ignore the name */ } }
  if (mk) store(KEY_STORE, mk[1]);
  if (linkWho) store(WHO_STORE, linkWho);
  // the link is only cleaned when the browser kept the key (private tabs may block storage: then the hash stays)
  if ((mk || mw) && (!mk || store(KEY_STORE) === mk[1])) history.replaceState(null, '', location.pathname + location.search);
  var KEY = store(KEY_STORE) || (mk ? mk[1] : '');
  var canReview = !!(KEY && CFG.endpoint);

  function api(batch) {
    return fetch(CFG.endpoint + '?key=' + encodeURIComponent(KEY) + '&batch=' + encodeURIComponent(batch)).then(function (r) { return r.json(); });
  }
  function getJSON(url) { return fetch(url, { cache: 'no-cache' }).then(function (r) { return r.json(); }); }

  /* status of a piece = live decision for its current version, else the baseline baked at build time.
   * Also derives from Claude's reply: filed (final/descartada for this version, no newer decision → buttons locked)
   * and the ribbon shown under the title. */
  function stateOf(piece, remote) {
    var d = (remote.decisiones || {})[piece.id], r = (remote.respuestas || {})[piece.id];
    var version = Math.max(piece.version || 1, (r && r.version) || 1);
    var out = { estado: piece.baseline || '', nota: '', who: '', motivos: [], version: version, reply: r || null, pending: false, newer: false, filed: false, ribbon: '' };
    if (d && (!d.version || +d.version === version)) {      // a decision on an older version no longer counts
      out.estado = d.estado || '';
      if (d.estado) { out.nota = d.nota || ''; out.who = d.who || ''; out.motivos = d.motivos || []; }
      out.pending = d.t === 'pending';
      // a decision made after Claude's reply (or still being saved) reopens the piece for Claude;
      // an empty one (Claude's reset after a remake, a reviewer's Clear) does not: the reply still stands
      out.newer = !!r && !!d.estado && (out.pending || (d.t || '') > (r.decision_t || r.t || ''));
    }
    if (r && (r.version || 1) >= version && !out.newer) {
      if (r.tipo === 'descartada') out.estado = 'out';
      if (r.tipo === 'final' || r.tipo === 'descartada') out.filed = true;
      if (RIBBON[r.tipo] && (r.tipo !== 'rehecha' || out.estado === '')) out.ribbon = RIBBON[r.tipo];
    }
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
    var data = null, remote = {}, tab = '', filter = '', current = null;
    var gen = 0, inflight = 0;     // saves: generation counter + saves in flight; a pull() that started before the last save is discarded
    var overlay = {};              // id → {batch, dec}: decisions made in this browser, kept over older server rows until the server echoes them
    var stuck = {};                // id → tab where the piece was decided this session: it stays in that tab (dimmed) until tab/filter changes
    var reopened = {};             // id → true: "Filed by Claude" lock lifted for this browser session
    var drafts = {};               // id → unsent Adjust/Reject draft dropped when the modal closed; restored when the piece is opened again
    var failed = [];               // saves that gave up after the retries: [{p, body, msg, retry}] shown in the error bar
    var pending = {};              // id → save job in flight: a new save on the same piece aborts it (its retries stop, its handlers are skipped)
    var nav = null;                // ids the focus modal steps through, frozen when it opens
    var fx = null;                 // live handles into the focus modal (refreshed in place on save / pull)
    var tiles = {};                // id → tile node currently in the grid
    var grid = document.getElementById('grid'), tabs = document.getElementById('tabs'), filters = document.getElementById('filters');
    var sync = document.getElementById('sync'), dlg = document.getElementById('focusbox');
    var phone = window.matchMedia ? window.matchMedia('(max-width:720px)') : { matches: false };
    document.body.dataset.project = pid;

    var whoInput = document.getElementById('who'), whoHint = el('span', { class: 'hint', hidden: '' });
    whoInput.parentNode.appendChild(whoHint);
    whoInput.value = store(WHO_STORE) || linkWho || '';
    whoInput.addEventListener('change', function () { setWho(whoInput.value); });
    function setWho(v) { v = v.trim(); whoInput.value = v; store(WHO_STORE, v); if (v) whoHint.hidden = true; if (fx && fx.whoInput.value.trim() !== v) fx.whoInput.value = v; }
    /* a decision needs a name; without one, point at the name field (modal or header) and let the click through next time */
    function ensureName() {
      if (whoInput.value.trim()) { store(WHO_STORE, whoInput.value.trim()); return true; }
      if (dlg.open && fx) { fx.whoRow.hidden = false; fx.whoHint.textContent = NAME_HINT; fx.whoHint.hidden = false; fx.whoInput.focus(); }
      else { whoHint.textContent = NAME_HINT; whoHint.hidden = false; whoInput.focus(); }
      return false;
    }
    if (!canReview) { document.getElementById('banner').hidden = false; document.querySelector('.who').hidden = true; sync.textContent = 'View only'; }

    /* page-level bars (bottom of the screen): short notices and the persistent "was NOT saved" list.
     * They live inside the dialog while it is open, otherwise the modal's backdrop would cover them. */
    var bars = el('div', { class: 'bars', id: 'bars' }), errbar = el('div', { class: 'errbar', role: 'alert', hidden: '' });
    bars.appendChild(errbar); document.body.appendChild(bars);
    function notify(text) {
      var n = el('div', { class: 'notice', role: 'status' }, [el('span', { text: text }),
        el('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', text: '✕', onclick: function () { n.remove(); } })]);
      bars.insertBefore(n, errbar);
      setTimeout(function () { n.remove(); }, NOTICE_MS);
    }
    function paintErrors() {
      errbar.textContent = ''; errbar.hidden = !failed.length;
      failed.forEach(function (f) {
        errbar.appendChild(el('div', { class: 'row' }, [
          el('span', { class: 'msg', text: f.p.id + ' was NOT saved' + (f.msg ? ' — ' + f.msg : '') }),
          f.retry ? el('button', { type: 'button', text: 'Retry', onclick: function () { forget(f); save(f.p, f.body); } }) : null,
          f.retry ? el('span', { class: 'dot', text: '·' }) : null,
          el('button', { type: 'button', text: 'Dismiss', onclick: function () { forget(f); } })]));
      });
    }
    function forget(f) { var i = failed.indexOf(f); if (i >= 0) failed.splice(i, 1); paintErrors(); }

    function byId(id) { return data.pieces.filter(function (x) { return x.id === id; })[0]; }
    function st(piece) { return stateOf(piece, remote[piece.batch] || {}); }
    function isGone(p, s) { return !!(p.deleted || (s.reply && s.reply.tipo === 'descartada' && (s.reply.version || 1) >= s.version)) || !p.media.length; }
    function visible() {
      return data.pieces.filter(function (p) { return (tab === 'all' || st(p).estado === tab || stuck[p.id] === tab) && (!filter || p.batchLabel === filter); });
    }

    function renderTabs() {
      var c = { '': 0, warn: 0, ok: 0, out: 0 };
      data.pieces.forEach(function (p) { if (!filter || p.batchLabel === filter) c[st(p).estado]++; });
      tabs.textContent = '';
      [['', 'To review'], ['warn', 'Adjust'], ['ok', 'Accepted'], ['out', 'Rejected'], ['all', 'All']].forEach(function (t) {
        var n = t[0] === 'all' ? c[''] + c.warn + c.ok + c.out : c[t[0]];
        tabs.appendChild(el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === t[0]), onclick: function () { if (tab === t[0]) return; tab = t[0]; stuck = {}; render(); } },
          [document.createTextNode(t[1]), el('b', { text: String(n) })]));
      });
    }
    function renderFilters() {
      var labels = []; data.pieces.forEach(function (p) { if (labels.indexOf(p.batchLabel) < 0) labels.push(p.batchLabel); });
      filters.textContent = '';
      if (labels.length < 2) return;
      [''].concat(labels).forEach(function (l) {
        filters.appendChild(el('button', { class: 'filter', type: 'button', 'aria-pressed': String(filter === l), text: l || 'Everything', onclick: function () { if (filter === l) return; filter = l; stuck = {}; render(); } }));
      });
    }
    function reopenLink(p) {
      return el('button', { class: 'link', type: 'button', text: 'Reopen', onclick: function () { reopened[p.id] = true; refresh(p); } });
    }
    function tile(p) {
      var s = st(p), first = p.media[0], gone = isGone(p, s), locked = s.filed && !reopened[p.id];
      var thumb = el('button', { class: 'thumb', type: 'button', 'aria-label': 'Focus on ' + p.id + ': ' + p.title, onclick: function () { openFocus(p.id); } }, [
        gone ? el('span', { class: 'gone', text: 'Deleted' }) : el('img', { src: first.thumb || first.poster || first.src, alt: '', loading: 'lazy', width: '1080', height: '1080' }),
        !gone && first.type === 'video' ? el('span', { class: 'kind', text: '▶ Video' }) : (!gone && p.media.length > 1 ? el('span', { class: 'kind', text: p.media.length + ' formats' }) : null),
        el('span', { class: 'badge', 'data-state': s.estado, text: s.pending ? 'Saving…' : LABEL[s.estado] })
      ]);
      function quick(v, label) {
        return el('button', { class: 'act', type: 'button', 'data-v': v, 'aria-pressed': String(s.estado === v), disabled: canReview ? null : '', text: label, onclick: function () {
          var live = st(p);                               // live state, not the one captured at render (a double click lands on the replaced tile)
          if (live.estado === v) return;                  // already chosen: a second click changes nothing
          if (v === 'ok') { if (ensureName()) save(p, { estado: 'ok', nota: live.nota, motivos: [] }); }
          else openFocus(p.id, v);                        // adjust / reject need a comment: go to focus view
        } });
      }
      var focusBtn = el('button', { class: 'act focus', type: 'button', text: 'Focus', onclick: function () { openFocus(p.id); } });
      var actions = locked
        ? el('div', { class: 'actions locked' }, [el('span', { class: 'filed', text: 'Filed by Claude ✓' }), reopenLink(p), focusBtn])
        : el('div', { class: 'actions' }, [quick('ok', 'Accept'), quick('warn', 'Adjust'), quick('out', 'Reject'), focusBtn]);
      var done = stuck[p.id] === tab && tab !== 'all' && s.estado !== tab;   // decided this session, no longer belongs to this tab: stays, dimmed
      var node = el('article', { class: 'tile' + (done ? ' done' : ''), 'data-state': s.estado }, [
        thumb,
        el('div', { class: 'meta' }, [
          el('div', { class: 'idrow' }, [el('span', { class: 'pid', text: p.id }), s.version > 1 ? el('span', { class: 'ver', text: 'v' + s.version }) : null, el('span', { class: 'batch', text: p.batchLabel })]),
          el('h3', { text: p.title }),
          s.ribbon ? el('div', { class: 'ribbon', 'data-kind': s.reply.tipo, text: s.ribbon }) : null,
          el('div', { class: 'by', text: s.estado && s.who ? LABEL[s.estado] + ' by ' + s.who : '' })
        ]),
        actions
      ]);
      tiles[p.id] = node;
      return node;
    }
    function refreshTile(p) { var old = tiles[p.id]; if (old && old.parentNode === grid) grid.replaceChild(tile(p), old); }
    function render() {
      renderTabs(); renderFilters();
      grid.textContent = ''; tiles = {};
      var list = visible();
      if (!list.length) grid.appendChild(el('p', { class: 'empty', text: tab === '' ? 'Nothing left to review here.' : 'No pieces in this tab.' }));
      list.forEach(function (p) { grid.appendChild(tile(p)); });
      syncFocus();
    }
    /* cheap update after a save: counts, that piece's tile, and the modal in place */
    function refresh(p, msg) {
      renderTabs(); refreshTile(p);
      if (fx && fx.id === p.id) { if (msg !== undefined) fx.msg = msg; fx.refresh(); }
    }

    /* ───────── saving ───────── */
    /* one POST with a timeout, retried with back-off (the backend upsert is idempotent) on network errors, timeouts
     * and transient backend answers; a deterministic rejection (bad_key, too_long, …) comes back at once.
     * job = {ctl, dead}: the current AbortController, and whether a later save on the same piece superseded this one */
    function post(payload, attempt, job) {
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      job.ctl = ctl;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, SAVE_TIMEOUT_MS);
      return fetch(CFG.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: payload, signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.json(); })
        .then(function (res) { clearTimeout(timer); if (res && (res.ok || (res.error && !RETRYABLE[res.error]))) return res; throw new Error((res && res.error) || 'bad_response'); })
        .catch(function (err) {
          clearTimeout(timer);
          if (job.dead || attempt >= RETRY_MS.length) throw err;
          return wait(RETRY_MS[attempt]).then(function () { if (job.dead) throw err; return post(payload, attempt + 1, job); });
        });
    }
    /* save a decision: optimistic locally, then POST; on final failure roll back and list it in the error bar */
    function save(p, body) {
      if (!canReview) return Promise.resolve(null);
      var s = st(p), b = remote[p.batch] = remote[p.batch] || { decisiones: {}, respuestas: {} };
      b.decisiones = b.decisiones || {};
      var prev = b.decisiones[p.id] || null;               // what the piece goes back to if the save fails
      if (pending[p.id]) {                                  // an earlier save of this piece still in flight: this one replaces it
        pending[p.id].dead = true; if (pending[p.id].ctl) pending[p.id].ctl.abort();
        if (prev && prev.t === 'pending') prev = pending[p.id].prev;   // roll back past it, never to a decision that never landed
      }
      var job = pending[p.id] = { ctl: null, dead: false, prev: prev };
      var dec = { estado: body.estado || '', nota: body.nota || '', who: whoInput.value.trim(), motivos: body.motivos || [], version: s.version, t: 'pending' };
      b.decisiones[p.id] = dec; overlay[p.id] = { batch: p.batch, dec: dec };
      if (!(p.id in stuck)) stuck[p.id] = tab;
      failed = failed.filter(function (f) { return f.p.id !== p.id; }); paintErrors();
      gen++; inflight++;
      var payload = JSON.stringify({ key: KEY, action: 'decision', batch: p.batch, id: p.id, estado: dec.estado, nota: dec.nota, who: dec.who, extra: { motivos: dec.motivos, version: dec.version } });
      refresh(p, 'Saving…');
      return post(payload, 0, job).then(function (res) {
        inflight--;
        if (job.dead) return null;                          // superseded: the later save owns the piece now
        delete pending[p.id];
        if (res && res.ok) { dec.t = res.t || new Date().toISOString(); refresh(p, 'Sent to Claude ✓'); return res; }
        rollback(p, dec, prev, body, errMsg(res), false);
        return res;
      }).catch(function () { inflight--; if (job.dead) return null; delete pending[p.id]; rollback(p, dec, prev, body, '', true); return null; });
    }
    function rollback(p, dec, prev, body, msg, retry) {
      var b = remote[p.batch];
      if (b && b.decisiones[p.id] === dec) { if (prev) b.decisiones[p.id] = prev; else delete b.decisiones[p.id]; }   // a later save on the same piece wins otherwise
      if (overlay[p.id] && overlay[p.id].dec === dec) delete overlay[p.id];
      failed.push({ p: p, body: body, msg: msg, retry: retry }); paintErrors();
      if (fx && fx.id === p.id && (dec.estado === 'warn' || dec.estado === 'out')) fx.touched = true;   // the modal keeps the choice + comment as an unsent draft
      refresh(p, msg || ('Couldn’t save ' + p.id + '. Use Retry at the bottom of the page.'));
    }

    /* ───────── focus modal ───────── */
    function openFocus(id, intent) {
      if (!dlg.open) { nav = visible().map(function (x) { return x.id; }); dlg.appendChild(bars); }
      if (nav.indexOf(id) < 0) nav.push(id);
      current = id; paintFocus({ intent: intent });
      if (!dlg.open) dlg.showModal();
      if (intent && fx) fx.ta.focus();
    }
    function step(delta) {
      if (!nav || !leaveDraft('nav')) return;
      var i = nav.indexOf(current) + delta;
      if (nav[i]) { current = nav[i]; paintFocus(); }
    }
    /* after Accept / Send: move on to the next piece of the frozen list (stay on the last one) */
    function advance(id) {
      setTimeout(function () {
        if (!dlg.open || current !== id || !nav) return;
        var i = nav.indexOf(id); if (i >= 0 && i < nav.length - 1) step(1);
      }, ADVANCE_MS);
    }
    /* an unsent draft (Adjust/Reject choice, or just a typed comment) when the reviewer leaves the piece:
     * sendable → sent; incomplete → blocked with a hint (nav) or kept for the next opening + notice (close) */
    function leaveDraft(kind) {
      if (!fx || !fx.isDraft()) return true;
      var why = fx.blocker();
      if (!why && !fx.commit(true)) why = 'type your name first';   // commit() already pointed at the name field
      if (!why) return true;
      if (kind === 'nav') { if (fx.blocker()) fx.showHint(); return false; }
      drafts[fx.id] = fx.snapshot();
      notify(fx.id + ' was not sent: ' + why + '. Open it again to finish.');
      return true;
    }
    /* when a pull changed the reply/version of the open piece, repaint (keeping format + draft); otherwise refresh in place */
    function syncFocus() {
      if (!fx || !dlg.open) return;
      var p = byId(fx.id); if (!p) return;
      var s = st(p), sig = s.version + '|' + (s.reply ? s.reply.tipo + '|' + s.reply.version + '|' + s.reply.t : '');
      if (sig !== fx.sig) paintFocus({ preserve: true }); else fx.refresh();
    }

    function paintFocus(opts) {
      opts = opts || {};
      var p = byId(current); if (!p) return;
      var s = st(p), old = opts.preserve && fx && fx.id === p.id ? fx : null, gone = isGone(p, s);
      var keep = old && old.touched ? old : null, d0 = drafts[p.id]; delete drafts[p.id];   // unsent choice / typed text survive the repaint
      var f = { id: p.id, fmt: old ? old.fmt : 0, msg: old ? old.msg : '', touched: !!(keep || d0 || opts.intent), sig: s.version + '|' + (s.reply ? s.reply.tipo + '|' + s.reply.version + '|' + s.reply.t : '') };
      var draft = f.draft = keep ? { estado: keep.draft.estado, motivos: keep.draft.motivos.slice() } : d0 ? { estado: d0.estado, motivos: d0.motivos.slice() } : { estado: s.estado, motivos: s.motivos.slice() };
      if (opts.intent) draft.estado = opts.intent;
      if (f.fmt >= p.media.length) f.fmt = 0;

      // one format at a time (stacking them looked like the image repeating); switcher when there are several
      var media = el('div', { class: 'fb-media' });
      function showFormat(i) {
        f.fmt = i; media.textContent = '';
        if (gone) { media.appendChild(el('div', { class: 'gone', text: 'Deleted' })); return; }
        var mm = p.media[i];
        if (p.media.length > 1) media.appendChild(el('div', { class: 'formats', role: 'group', 'aria-label': 'Format' }, p.media.map(function (x, j) {
          return el('button', { type: 'button', 'aria-pressed': String(j === i), text: (x.label || ('Format ' + (j + 1))).split(' · ')[0], onclick: function () { showFormat(j); } });
        })));
        var node = mm.type === 'video' ? el('video', { src: mm.src, poster: mm.poster || null, controls: '', muted: '', loop: '', playsinline: '' }) : el('img', { src: mm.src, alt: p.id + ': ' + p.title });
        media.appendChild(el('figure', {}, [node, el('figcaption', { text: mm.label || '' })]));
      }
      showFormat(f.fmt);

      var info = el('div', { class: 'fb-info' });
      var badge = el('span', { class: 'badge', style: 'position:static', 'data-state': s.estado, text: LABEL[s.estado] });
      info.appendChild(el('div', { class: 'fb-head' }, [
        el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:8px' }, [
          el('div', { class: 'idrow' }, [el('span', { class: 'pid', text: p.id }), s.version > 1 ? el('span', { class: 'ver', text: 'v' + s.version }) : null, el('span', { class: 'batch', text: p.batchLabel + (p.group ? ' · ' + p.group : '') }), badge]),
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

      /* decision area */
      var by = el('div', { class: 'by', id: 'fb-by' }), status = el('div', { class: 'saved', id: 'fb-saved', role: 'status' });
      var ta = el('textarea', { id: 'fb-note', maxlength: '5000', placeholder: 'For Adjust, say what to change. For Reject, say why (it helps Claude learn).', disabled: canReview ? null : '' });
      ta.value = keep ? keep.ta.value : d0 ? d0.note : s.nota;
      var hint = el('div', { class: 'hint', hidden: '' });
      ta.addEventListener('input', function () { f.touched = true; f.msg = ''; hint.hidden = true; f.refresh(); });
      var why = el('div', { class: 'why', role: 'group' }, REASONS.map(function (r) {
        return el('button', { type: 'button', 'aria-pressed': String(draft.motivos.indexOf(r) >= 0), text: r, disabled: canReview ? null : '', onclick: function (ev) {
          var i = draft.motivos.indexOf(r); if (i >= 0) draft.motivos.splice(i, 1); else draft.motivos.push(r);
          ev.currentTarget.setAttribute('aria-pressed', String(i < 0));
          f.touched = true; f.msg = ''; hint.hidden = true; f.refresh();
        } });
      }));
      var whyWrap = el('div', { hidden: '' }, [el('label', { text: 'What’s off? (pick any that apply)' }), why]);
      function btn(v, label) {
        return el('button', { class: 'act', type: 'button', 'data-v': v, text: label, disabled: canReview ? null : '', onclick: function () {
          var noteChanged = ta.value.trim() !== (s.nota || '').trim();
          if (draft.estado === v && !(v === 'ok' && noteChanged)) return;   // already chosen: a second click changes nothing (Accept re-saves an edited note)
          if (v === 'ok' && !ensureName()) return;        // nothing changes until there is a name; the same click works afterwards
          draft.estado = v; f.touched = true; f.msg = ''; hint.hidden = true;
          if (v === 'ok') { commit(); f.refresh(); return; }
          f.refresh(); ta.focus();
        } });
      }
      var seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Decision for ' + p.id }, [btn('ok', 'Accept'), btn('warn', 'Adjust'), btn('out', 'Reject')]);
      var filed = el('div', { class: 'filedrow', hidden: '' }, [el('span', { class: 'filed', text: 'Filed by Claude ✓' }), reopenLink(p)]);
      var send = el('button', { class: 'act focus send', type: 'button', text: 'Send to Claude', disabled: '', onclick: function () { commit(); } });
      var confirmRow = el('span', { class: 'confirm', hidden: '' }, [el('span', { text: 'Clear this decision?' }),
        el('button', { type: 'button', text: 'Yes', onclick: function () { if (!ensureName()) return; confirmRow.hidden = true; draft.estado = ''; draft.motivos = []; f.touched = false; f.msg = ''; save(p, { estado: '', nota: '', motivos: [] }); } }),
        el('button', { type: 'button', text: 'No', onclick: function () { confirmRow.hidden = true; f.refresh(); } })]);
      var clearLink = el('button', { type: 'button', class: 'link', text: 'Clear decision', onclick: function () { clearLink.hidden = true; confirmRow.hidden = false; } });
      var whoIn = el('input', { type: 'text', maxlength: '40', placeholder: 'Your name', id: 'fb-who' }), whoH = el('span', { class: 'hint', hidden: '' });
      whoIn.value = whoInput.value;
      whoIn.addEventListener('input', function () { whoInput.value = whoIn.value; if (whoIn.value.trim()) whoH.hidden = true; });
      whoIn.addEventListener('change', function () { setWho(whoIn.value); });
      var whoRow = el('div', { class: 'fb-who', hidden: whoInput.value.trim() || !canReview ? '' : null }, [el('label', { for: 'fb-who', text: 'Reviewing as' }), whoIn, whoH]);
      var decide = el('div', { class: 'decide' }, [seg, filed, whyWrap, el('label', { for: 'fb-note', text: 'Comment' }), ta, hint, whoRow,
        el('div', { class: 'statusrow' }, [by, status, clearLink, confirmRow])]);
      var i = nav ? nav.indexOf(current) : -1;
      var bar = el('div', { class: 'fb-bar' }, [send,
        el('div', { class: 'fb-nav' }, [
          el('button', { type: 'button', text: '← Previous', disabled: i > 0 ? null : '', onclick: function () { step(-1); } }),
          el('button', { type: 'button', text: 'Next →', disabled: i >= 0 && i < nav.length - 1 ? null : '', onclick: function () { step(1); } })]),
        el('button', { class: 'iconbtn phoneclose', type: 'button', 'aria-label': 'Close', text: '✕', onclick: function () { dlg.close(); } })]);
      info.appendChild(decide); info.appendChild(bar);

      function choosing() { return draft.estado === 'warn' || draft.estado === 'out'; }
      /* something unsent: an Adjust/Reject choice that differs from what is saved, or a typed comment without a choice */
      function isDraft() {
        if (!f.touched) return false;
        var n = ta.value.trim();
        if (choosing()) return !(draft.estado === s.estado && n === (s.nota || '').trim() && sameSet(draft.motivos, s.motivos));
        return !!n && n !== (s.nota || '').trim();
      }
      function complete() { var n = ta.value.trim(); return draft.estado === 'warn' ? !!n : !!(n || draft.motivos.length); }
      /* why the draft cannot be sent yet ('' when it can) */
      function blocker() {
        if (!choosing()) return draft.estado === 'ok' ? 'press Accept again to save your comment, or pick Adjust or Reject' : 'pick Adjust or Reject to send your comment';
        return complete() ? '' : (draft.estado === 'out' ? 'Reject needs a comment or a reason' : 'Adjust needs a comment');
      }
      function showHint() {
        hint.textContent = !choosing() ? (draft.estado === 'ok' ? 'Press Accept again to save your comment, or pick Adjust or Reject' : 'Pick Adjust or Reject to send your comment') : draft.estado === 'warn' ? 'Add a comment so Claude knows what to change' : 'Add a comment or pick a reason';
        hint.hidden = false;
        if (choosing()) ta.focus(); else seg.querySelector('[data-v="warn"]').focus();
      }
      /* send the current choice; auto = sent because the reviewer is leaving the piece (no auto-advance) */
      function commit(auto) {
        if (!ensureName()) return false;
        var choice = draft.estado === 'ok' || draft.estado === '';
        if (!choice && !complete()) { showHint(); return false; }
        f.touched = false;
        save(p, { estado: draft.estado, nota: ta.value.trim(), motivos: choice ? [] : draft.motivos.slice() });
        if (auto) notify('Sending ' + p.id + ' to Claude with your comment…'); else advance(p.id);
        return true;
      }
      /* update in place what a save or a pull can change; nothing else is rebuilt (format stays, videos keep playing, focus stays) */
      function refreshFocus() {
        s = st(p);
        var locked = s.filed && !reopened[p.id];
        if (!f.touched) { draft.estado = s.estado; draft.motivos = s.motivos.slice(); }
        badge.setAttribute('data-state', s.estado); badge.textContent = s.pending ? 'Saving…' : LABEL[s.estado];
        seg.querySelectorAll('.act').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === draft.estado)); });
        why.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(draft.motivos.indexOf(b.textContent) >= 0)); });
        seg.hidden = locked; filed.hidden = !locked;
        whyWrap.hidden = locked || !(data.reasons && (draft.estado === 'warn' || draft.estado === 'out'));
        ta.disabled = !canReview || locked;
        send.hidden = locked || !choosing();
        send.disabled = !canReview || !(isDraft() && complete());
        by.textContent = s.estado && s.who ? LABEL[s.estado] + ' by ' + s.who + '.' : '';
        status.textContent = s.pending ? 'Saving…' : f.msg;
        var canClear = canReview && !locked && !!s.estado && !s.pending;
        if (!canClear) confirmRow.hidden = true;
        clearLink.hidden = !canClear || !confirmRow.hidden;
      }
      /* on phones the three buttons live in the sticky bar; on desktop above the reasons */
      function placeSeg() { if (phone.matches) bar.insertBefore(seg, bar.firstChild); else decide.insertBefore(seg, decide.firstChild); }

      f.ta = ta; f.whoRow = whoRow; f.whoInput = whoIn; f.whoHint = whoH;
      f.isDraft = isDraft; f.blocker = blocker; f.showHint = showHint; f.commit = commit; f.refresh = refreshFocus; f.placeSeg = placeSeg;
      f.snapshot = function () { return { estado: draft.estado, motivos: draft.motivos.slice(), note: ta.value }; };
      fx = f;
      placeSeg(); refreshFocus();
      var box = dlg.querySelector('.fb'); box.textContent = ''; box.appendChild(media); box.appendChild(info);
    }
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () {        // ✕, Esc and backdrop all end here: settle the draft, then drop the modal state
      leaveDraft('close');
      dlg.querySelectorAll('video').forEach(function (v) { v.pause(); });
      current = null; nav = null; fx = null;
      document.body.appendChild(bars);
    });
    document.addEventListener('keydown', function (ev) {
      var a = document.activeElement;
      if (!dlg.open || (a && /TEXTAREA|INPUT/.test(a.tagName))) return;
      if (ev.key === 'ArrowRight') step(1); else if (ev.key === 'ArrowLeft') step(-1);
    });
    var onPhone = function () { if (fx) fx.placeSeg(); };
    if (phone.addEventListener) phone.addEventListener('change', onPhone); else if (phone.addListener) phone.addListener(onPhone);

    function pull() {
      if (!canReview || inflight || (dlg.open && document.activeElement && document.activeElement.id === 'fb-note')) return;
      var myGen = gen;
      Promise.all(data.batches.map(api)).then(function (res) {
        if (myGen !== gen || inflight) return;           // a save happened meanwhile: this snapshot is stale
        var ok = true, last = '';
        res.forEach(function (r, i) {
          if (!(r && r.ok)) { ok = false; return; }
          r.decisiones = r.decisiones || {}; r.respuestas = r.respuestas || {};
          Object.keys(overlay).forEach(function (id) {   // decisions made here: keep ours until the server row is at least as new
            var o = overlay[id]; if (o.batch !== data.batches[i]) return;
            var srv = r.decisiones[id];
            if (srv && srv.t && srv.t >= o.dec.t) delete overlay[id]; else r.decisiones[id] = o.dec;
          });
          remote[data.batches[i]] = r; if (r.last_check > last) last = r.last_check;
        });
        sync.textContent = ok ? 'Connected' + (last ? ' · Claude checked at ' + new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : (res[0] && res[0].error === 'bad_key' ? 'Invalid review link' : 'Not connected');
        render();
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
