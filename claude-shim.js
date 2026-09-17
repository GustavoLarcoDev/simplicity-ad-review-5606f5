/* Lets a review page written for the Claude artifact database (window.claude.use('db')) run on the
 * public review website: same calls, but stored in the Google Sheet backend.
 * Usage: <script src="../config.js"></script><script src="../claude-shim.js" data-batch="poocrew"></script>
 * placed BEFORE the page's own script. Supports what the review pages use:
 *   db.doc('decisiones/<id>').set({estado, nota, ...extra})   and   db.collection('decisiones').onSnapshot(cb)
 * Access: the review link carries #k=<key>; without it the page is view-only (use('db') resolves null). */
(function () {
  var CFG = window.REVIEW_CONFIG || {};
  var BATCH = document.currentScript.dataset.batch;
  var KEY_STORE = 'ss-review-key', WHO_STORE = 'ss-review-who', POLL_MS = 20000;

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var m = location.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (m) { store(KEY_STORE, m[1]); history.replaceState(null, '', location.pathname + location.search); }
  var KEY = store(KEY_STORE) || '';
  var canReview = !!(KEY && CFG.endpoint);

  var pending = 0;

  function who() { var el = document.getElementById('who'); return el ? el.value.trim() : (store(WHO_STORE) || ''); }

  function decorate() {
    var tally = document.querySelector('.tally'); if (!tally) return;
    var css = document.createElement('style');
    css.textContent = '.who{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}' +
      '.who input{font:inherit;font-size:13px;width:140px;padding:5px 8px;border-radius:8px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink)}' +
      '.view-only{margin-top:14px;padding:12px 14px;border-radius:12px;border:1.5px solid var(--warn);background:var(--warn-soft);font-size:14px}';
    document.head.appendChild(css);
    if (canReview) {
      var w = document.createElement('span'); w.className = 'who';
      w.innerHTML = '<label for="who">Reviewing as</label><input id="who" type="text" maxlength="40" placeholder="Your name">';
      tally.insertBefore(w, tally.lastElementChild);
      var input = w.querySelector('input'); input.value = store(WHO_STORE) || '';
      input.addEventListener('change', function () { store(WHO_STORE, input.value.trim()); });
    } else {
      var bar = document.createElement('div'); bar.className = 'view-only';
      bar.innerHTML = '<b>View only.</b> To accept, adjust or reject, open the review link Gustavo sent you (it includes a private key).';
      tally.insertAdjacentElement('afterend', bar);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate); else decorate();

  function post(body) {
    body.key = KEY; body.batch = BATCH;
    return fetch(CFG.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (!res || !res.ok) { var e = new Error((res && res.error) || 'save_failed'); e.code = res && res.error === 'bad_key' ? 'invalid_argument' : 'unavailable'; throw e; } return res; });
  }

  var db = {
    doc: function (path) {
      var parts = path.split('/');
      return {
        set: function (payload) {
          if (parts[0] !== 'decisiones') return Promise.reject(new Error('unsupported collection'));
          var extra = {};
          Object.keys(payload).forEach(function (k) { if (['estado', 'nota', 't'].indexOf(k) < 0) extra[k] = payload[k]; });
          pending++;
          return post({ action: 'decision', id: parts[1], estado: payload.estado || '', nota: payload.nota || '', who: who(), extra: extra })
            .then(function () { pending--; }, function (e) { pending--; throw e; });
        }
      };
    },
    collection: function (name) {
      return {
        onSnapshot: function (next, error) {
          var stopped = false;
          function tick() {
            if (stopped || document.visibilityState !== 'visible' && tick.ran) return;
            tick.ran = true;
            fetch(CFG.endpoint + '?key=' + encodeURIComponent(KEY) + '&batch=' + encodeURIComponent(BATCH))
              .then(function (r) { return r.json(); })
              .then(function (data) {
                if (!data || !data.ok) { if (error) error({ code: 'unavailable' }); return; }
                if (pending) return;                       // don't repaint over a save in flight
                var src = name === 'decisiones' ? data.decisiones : (name === 'respuestas' ? data.respuestas : {});
                var docs = Object.keys(src || {}).map(function (id) { var d = src[id]; return { id: id, exists: true, data: function () { return d; } }; });
                next({ docs: docs, size: docs.length, empty: !docs.length });
              })
              .catch(function () { /* transient: next poll retries */ });
          }
          tick();
          var h = setInterval(tick, POLL_MS);
          return function () { stopped = true; clearInterval(h); };
        }
      };
    }
  };

  window.claude = { use: function (name) { return Promise.resolve(name === 'db' && canReview ? db : null); } };
})();
