/* Simplicity Software · ad review page logic (GitHub Pages + Google Apps Script backend).
 * Needs window.REVIEW_CONFIG = {endpoint} (config.js) and <body data-batch="K">.
 * Access: the review link carries #k=<key>; it is kept in this browser (localStorage) afterwards. */
(function () {
  var CFG = window.REVIEW_CONFIG || {};
  var BATCH = document.body.dataset.batch;
  var KEY_STORE = 'ss-review-key', WHO_STORE = 'ss-review-who';
  var POLL_MS = 20000;

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  var m = location.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (m) { store(KEY_STORE, m[1]); history.replaceState(null, '', location.pathname + location.search); }
  var KEY = store(KEY_STORE) || '';
  var canReview = !!(KEY && CFG.endpoint);

  // Notes ("Good to know")
  var NOTES = window.__NOTES__ || {};
  document.querySelectorAll('.notes-slot').forEach(function (slot) {
    var list = NOTES[slot.dataset.notes];
    if (!list || !list.length) return;
    var t = document.createElement('div'); t.className = 'notes-title'; t.textContent = 'Good to know';
    var ul = document.createElement('ul'); ul.className = 'notes';
    list.forEach(function (n) { var li = document.createElement('li'); li.textContent = n; ul.appendChild(li); });
    slot.appendChild(t); slot.appendChild(ul);
  });

  var pieces = Array.prototype.slice.call(document.querySelectorAll('.piece'));
  var state = {}, queues = {};
  var sync = document.getElementById('sync');

  // Reviewer name + access status in the sticky bar
  var tally = document.querySelector('.tally');
  var whoWrap = document.createElement('span'); whoWrap.className = 'who';
  if (canReview) {
    whoWrap.innerHTML = '<label for="who">Reviewing as</label><input id="who" type="text" maxlength="40" placeholder="Your name">';
    tally.insertBefore(whoWrap, tally.querySelector('.sync'));
    var whoInput = whoWrap.querySelector('input');
    whoInput.value = store(WHO_STORE) || '';
    whoInput.addEventListener('change', function () { store(WHO_STORE, whoInput.value.trim()); });
  } else {
    var bar = document.createElement('div'); bar.className = 'feedback-bar';
    bar.innerHTML = '<p><b>View only.</b> To approve, adjust or reject, open the review link Gustavo sent you (it includes a private key).</p>';
    tally.insertAdjacentElement('afterend', bar);
  }

  pieces.forEach(function (p) {
    var id = p.dataset.id;
    var d = document.createElement('div'); d.className = 'decide';
    d.innerHTML =
      '<div class="seg" role="group" aria-label="Decision for ' + id + '">' +
        '<button type="button" data-v="ok" aria-pressed="false">Approve</button>' +
        '<button type="button" data-v="warn" aria-pressed="false">Adjust</button>' +
        '<button type="button" data-v="out" aria-pressed="false">Reject</button>' +
      '</div>' +
      '<label for="nota-' + id + '">Comment (for Adjust, say what to change; for Reject, say why)</label>' +
      '<textarea id="nota-' + id + '" placeholder="E.g. bigger headline, different background color, change the line…"></textarea>' +
      '<div class="saved" id="saved-' + id + '"></div>';
    p.querySelector('.info').appendChild(d);
    var ta = d.querySelector('textarea');
    if (!canReview) {
      d.querySelectorAll('button, textarea').forEach(function (el) { el.disabled = true; });
      return;
    }
    d.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var cur = state[id] || {};
        var v = cur.estado === b.dataset.v ? '' : b.dataset.v;
        commit(id, { estado: v, nota: ta.value });
      });
    });
    var timer = null;
    ta.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { commit(id, { estado: (state[id] || {}).estado || '', nota: ta.value }); }, 1200);
    });
  });

  function paint(id) {
    var p = document.querySelector('.piece[data-id="' + id + '"]'); if (!p) return;
    var s = state[id] || {};
    p.dataset.state = s.estado || '';
    p.querySelectorAll('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === s.estado)); });
    var ta = p.querySelector('textarea');
    if (ta && document.activeElement !== ta && typeof s.nota === 'string') ta.value = s.nota;
    var saved = document.getElementById('saved-' + id);
    if (saved && s.who && s.estado && !saved.dataset.busy) saved.textContent = 'Marked by ' + s.who + '.';
    count();
  }

  function sayClaude(id, d) {
    var p = document.querySelector('.piece[data-id="' + id + '"]'); if (!p) return;
    var slot = p.querySelector('.claude-slot'); if (!slot) return;
    slot.textContent = '';
    var box = document.createElement('div'); box.className = 'claude-say'; box.dataset.tipo = d.tipo || '';
    var k = document.createElement('span'); k.className = 'k';
    var labels = { rehecha: 'Claude remade it', final: 'Approved · saved to Posts', descartada: 'Rejected · deleted' };
    k.textContent = labels[d.tipo] || 'Claude';
    var msg = document.createElement('span'); msg.textContent = d.mensaje || '';
    box.appendChild(k); box.appendChild(msg); slot.appendChild(box);
    if (d.tipo === 'descartada') {
      var shots = p.querySelector('.shots');
      if (shots && !shots.querySelector('.gone')) {
        shots.textContent = '';
        var g = document.createElement('div'); g.className = 'gone'; g.textContent = 'Deleted'; shots.appendChild(g);
      }
    }
    var row = p.querySelector('.id-row'), ver = row && row.querySelector('.ver');
    if (row && d.version && d.version > 1) {
      if (!ver) { ver = document.createElement('span'); ver.className = 'ver'; row.insertBefore(ver, row.children[1] || null); }
      ver.textContent = 'v' + d.version;
    }
  }

  function count() {
    var c = { ok: 0, warn: 0, out: 0, none: 0 };
    pieces.forEach(function (p) { var e = (state[p.dataset.id] || {}).estado; c[e || 'none']++; });
    ['ok', 'warn', 'out', 'none'].forEach(function (k) { var el = document.getElementById('n-' + k); if (el) el.textContent = c[k]; });
  }

  function commit(id, body) {
    var who = (document.getElementById('who') || {}).value || '';
    who = who.trim();
    state[id] = { estado: body.estado, nota: body.nota, who: who };
    paint(id);
    var saved = document.getElementById('saved-' + id);
    saved.dataset.busy = '1';
    saved.textContent = 'Saving…';
    queues[id] = (queues[id] || Promise.resolve()).then(function () {
      return fetch(CFG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: KEY, action: 'decision', batch: BATCH, id: id, estado: body.estado, nota: body.nota, who: who })
      }).then(function (r) { return r.json(); });
    }).then(function (res) {
      delete saved.dataset.busy;
      if (res && res.ok) { saved.textContent = who ? 'Saved as ' + who + '.' : 'Saved. Add your name above so Claude knows who decided.'; }
      else if (res && res.error === 'bad_key') { saved.textContent = 'This link’s key is not valid. Ask Gustavo for a new review link.'; }
      else { saved.textContent = 'Couldn’t save. Try again.'; }
    }).catch(function () { delete saved.dataset.busy; saved.textContent = 'Couldn’t save. Check your connection and try again.'; });
  }

  function load() {
    if (!canReview) { sync.textContent = 'View only'; return; }
    fetch(CFG.endpoint + '?key=' + encodeURIComponent(KEY) + '&batch=' + encodeURIComponent(BATCH))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) { sync.textContent = data && data.error === 'bad_key' ? 'Invalid review link' : 'Not connected'; return; }
        sync.textContent = 'Connected';
        Object.keys(data.decisiones || {}).forEach(function (id) {
          var busy = Object.keys(queues).length && document.getElementById('saved-' + id) && document.getElementById('saved-' + id).dataset.busy;
          if (!busy) { state[id] = data.decisiones[id]; paint(id); }
        });
        Object.keys(data.respuestas || {}).forEach(function (id) { sayClaude(id, data.respuestas[id]); });
        if (data.last_check) {
          var when = new Date(data.last_check);
          document.getElementById('last-check').textContent = ' · Claude checked at ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
      })
      .catch(function () { sync.textContent = 'Not connected'; });
  }

  count();
  load();
  setInterval(function () { if (document.visibilityState === 'visible') load(); }, POLL_MS);
})();
