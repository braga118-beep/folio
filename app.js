(function () {
  'use strict';
  const D = window.Doc, Store = window.Store;
  const { esc, money, fmtDate, today, addDays, totals, status, STATUS_LABEL } = D;
  const KINDS = ['Labor', 'Material', 'Service', 'Equipment', 'Subcontract', 'Permit', 'Expense', 'Other'];
  const UNITS = ['each', 'hour', 'day', 'sq ft', 'linear ft', 'sq yd', 'cu yd', 'lot', 'job'];
  const METHODS = ['Check', 'Cash', 'Zelle', 'Venmo', 'PayPal', 'Bank transfer', 'Card', 'Other'];
  const TRACKED = ['status', 'amount_paid', 'sent_at', 'last_sent_at', 'viewed_at', 'view_count', 'accepted_at', 'accepted_by', 'converted_id', 'archived'];

  const S = {
    mode: null, user: null, companies: [], customers: [], documents: [], payments: [], events: [], items: [], photos: [], jobs: [], needsUpgrade: false, needsUpgrade2: false, pendingJob: null, pendingSource: null,
    filter: localStorage.getItem('folio:company') || 'all', known: new Set(), list: {}, started: false, pendingCustomer: null
  };
  // Until upgrade-1.sql is run, leave out the new document fields so saving still works.
  const baseUpsert = Store.upsert.bind(Store);
  Store.upsert = (t, o) => {
    if (S.needsUpgrade && t === 'documents') { o = { ...o }; ['schedule', 'show_photos', 'milestone_index', 'milestone_name'].forEach((k) => delete o[k]); }
    if (S.needsUpgrade2 && t === 'documents') { o = { ...o }; ['job_id', 'contract'].forEach((k) => delete o[k]); }
    if (S.needsUpgrade2 && t === 'companies') { o = { ...o }; ['change_order_prefix', 'next_change_order_no'].forEach((k) => delete o[k]); }
    return baseUpsert(t, o);
  };
  let E = null; // editor state: { doc, isNew, dirty, hash, saveCustomer }

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const go = (h) => { location.hash = h; };
  const company = (id) => S.companies.find((c) => c.id === id);
  const docById = (id) => S.documents.find((d) => d.id === id);
  const typeName = (d) => D.typeName(d);
  const isQuote = (d) => D.isQuote(d);
  const LIST_LABEL = { estimate: 'Estimates', invoice: 'Invoices', change_order: 'Change orders' };
  const JOB_STATUS = { estimating: 'Estimating', active: 'Active', on_hold: 'On hold', completed: 'Completed' };
  const pill = (st) => `<span class="pill ${st}">${STATUS_LABEL[st] || esc(st)}</span>`;
  const firstName = (n) => (n || '').trim().split(/\s+/)[0] || 'there';
  const inScope = (d) => S.filter === 'all' || d.company_id === S.filter;
  const desc = (a, b) => String(b.created_at).localeCompare(String(a.created_at));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const fileName = (d) => `${d.number || typeName(d)} ${d.customer_name || ''}`.trim().replace(/[\\/:*?"<>|]+/g, '');
  function upsertLocal(arr, obj) { const i = arr.findIndex((x) => x.id === obj.id); if (i >= 0) arr[i] = obj; else arr.push(obj); return obj; }
  const counterKey = (type) => (type === 'invoice' ? 'next_invoice_no' : type === 'change_order' ? 'next_change_order_no' : 'next_estimate_no');
  function predictNumber(co, type) {
    if (!co) return '';
    const p = type === 'invoice' ? (co.invoice_prefix ?? 'INV-') : type === 'change_order' ? (co.change_order_prefix ?? 'CO-') : (co.estimate_prefix ?? 'EST-');
    const n = co[counterKey(type)];
    return p + String(n || 1).padStart(4, '0');
  }
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return fmtDate(iso);
  }
  function customerLink(d, preview) {
    const u = new URL('view.html', location.href);
    u.hash = '';
    u.search = '?t=' + d.public_token + (preview ? '&preview=1' : '');
    return u.href;
  }
  function eventText(e) {
    const d = docById(e.document_id);
    if (!d) return '';
    const tn = `${typeName(d).toLowerCase()} ${d.number}`;
    switch (e.kind) {
      case 'viewed': return `${d.customer_name} opened ${tn}`;
      case 'accepted': return `${e.detail || d.customer_name} ${d.type === 'change_order' ? 'approved' : 'accepted'} ${tn}`;
      case 'sent': return `Sent ${tn} to ${e.detail || d.customer_name}`;
      case 'reminder': return `Sent a payment reminder for ${tn}`;
      case 'paid': return `Recorded ${money(e.detail)} payment on ${tn}`;
      default: return `${e.kind} ${tn}`;
    }
  }

  // ---------------- UI primitives ----------------
  function toast(msg, opts = {}) {
    const t = document.createElement('div');
    t.className = 'toast ' + (opts.type || '');
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action;
      b.onclick = () => { t.remove(); opts.onAction(); };
      t.appendChild(b);
    }
    $('#toasts').appendChild(t);
    const ms = opts.ms || 4200;
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 400);
  }

  function modal(html, mount, cls = '') {
    const w = document.createElement('div');
    w.className = 'modal-wrap';
    w.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(w);
    const key = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { w.remove(); document.removeEventListener('keydown', key); };
    document.addEventListener('keydown', key);
    w.addEventListener('mousedown', (e) => { if (e.target === w) close(); });
    $$('[data-close]', w).forEach((b) => (b.onclick = close));
    if (mount) mount(w, close);
    const f = $('input:not([type=hidden]):not([type=checkbox]), textarea, select', w);
    if (f) f.focus();
    return close;
  }

  let menuEl = null;
  function closeMenus() { if (menuEl) menuEl.remove(); menuEl = null; }
  function place(m, anchor) {
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    menuEl = m;
  }
  function openMenu(anchor, items) {
    closeMenus();
    const list = items.filter(Boolean);
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = list.map((it, i) => (it === '-' ? '<hr>' :
      `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`)).join('');
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const it = list[+b.dataset.i];
      closeMenus();
      it.run();
    });
    place(m, anchor);
    const firstBtn = $('button', m);
    if (firstBtn) firstBtn.focus();
  }

  // ---------------- Installable app ----------------
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
  window.addEventListener('appinstalled', () => { installEvt = null; toast('Folio is installed. Open it from your home screen.'); });
  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---------------- Boot ----------------
  async function boot() {
    try {
      const r = await Store.init();
      S.mode = r.mode; S.user = r.user;
    } catch (e) {
      document.body.innerHTML = `<p class="fatal">Folio could not connect to the database. Check the values in config.js. (${esc(e.message)})</p>`;
      return;
    }
    if (S.mode === 'cloud' && !S.user) return renderAuth();
    startApp();
  }

  async function loadAll() {
    const [companies, customers, documents, payments, events] = await Promise.all(
      ['companies', 'customers', 'documents', 'payments', 'events'].map((t) => Store.list(t)));
    // Price book and photos need the database upgrade; keep working without them if it hasn't been run.
    const optional = await Promise.all(['items', 'photos', 'jobs'].map((t) => Store.list(t).then((r) => r, () => null)));
    S.needsUpgrade = optional[0] === null || optional[1] === null;
    S.needsUpgrade2 = optional[2] === null;
    Object.assign(S, { companies, customers, documents, payments, events, items: optional[0] || [], photos: optional[1] || [], jobs: optional[2] || [] });
  }

  async function startApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    try { await loadAll(); } catch (e) { toast('Could not load your data: ' + e.message, { type: 'error', ms: 8000 }); }
    S.events.forEach((e) => S.known.add(e.id));
    if (!S.started) { S.started = true; bindOnce(); Store.onEvent(onRemote); }
    renderChrome();
    route();
  }

  function bindOnce() {
    const v = $('#view');
    v.addEventListener('input', (e) => { if (E) onEdInput(e); });
    v.addEventListener('change', (e) => { if (E) onEdInput(e); });
    v.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !E) return;
      const f = ACTS[b.dataset.act];
      if (f) { e.preventDefault(); e.stopPropagation(); f(b, e); }
    });
    $('#companySwitch').onchange = (e) => { S.filter = e.target.value; localStorage.setItem('folio:company', S.filter); route(); };
    $('#newBtn').onclick = (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, [{ label: 'New estimate', run: () => go('#/new/estimate') }, { label: 'New change order', run: () => pickEstimateForCO() }, { label: 'New invoice', run: () => go('#/new/invoice') }]);
    };
    $('#bell').onclick = (e) => { e.stopPropagation(); openBell(e.currentTarget); };
    $('#moreTab').onclick = (e) => {
      e.stopPropagation();
      if (menuEl) { closeMenus(); return; }
      openMenu(e.currentTarget, [
        { label: 'Change orders', run: () => go('#/change_orders') }, { label: 'Customers', run: () => go('#/customers') },
        { label: 'Price book', run: () => go('#/pricebook') }, { label: 'Companies', run: () => go('#/companies') }, { label: 'Settings', run: () => go('#/settings') }]);
    };
    document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    window.addEventListener('hashchange', route);
    v.addEventListener('keydown', (e) => { if (sug && e.target === sug.el) suggestKey(e); });
    v.addEventListener('focusout', (e) => { if (sug && e.target === sug.el) setTimeout(closeSuggest, 150); });
    window.addEventListener('scroll', () => closeSuggest(), true);
    window.addEventListener('beforeunload', (e) => { if (E && E.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  function renderChrome() {
    const sw = $('#companySwitch');
    if (S.filter !== 'all' && !company(S.filter)) S.filter = 'all';
    sw.innerHTML = `<option value="all">All companies</option>` + S.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sw.value = S.filter;
    $('.switch').hidden = S.companies.length < 2;
    $('#sideFoot').innerHTML = S.mode === 'demo'
      ? `<span class="demo-tag">Demo mode</span><p>Data is saved in this browser only. Connect a backend to sign in anywhere and email customers.</p>`
      : `<p>${esc(S.user && S.user.email)}</p>`;
    renderBell();
    const bn = $('#banner');
    const files = [S.needsUpgrade && 'upgrade-1.sql', S.needsUpgrade2 && 'upgrade-2.sql'].filter(Boolean);
    bn.hidden = !files.length;
    bn.innerHTML = `Folio was updated. Run ${files.map((f) => `<b>${f}</b>`).join(', then ')} in Supabase (SQL Editor) to turn on ${S.needsUpgrade ? 'the price book, payment schedules, photos, ' : ''}jobs and change orders.`;
  }

  function unread() { return S.events.filter((e) => !e.seen && (e.kind === 'viewed' || e.kind === 'accepted') && docById(e.document_id)); }
  function renderBell() {
    const n = unread().length;
    const b = $('#bell .badge');
    b.hidden = !n;
    b.textContent = n > 9 ? '9+' : n;
    $('#bell').setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  }
  function openBell(anchor) {
    if (menuEl && menuEl.classList.contains('bell-panel')) return closeMenus();
    closeMenus();
    const evs = S.events.filter((e) => (e.kind === 'viewed' || e.kind === 'accepted') && docById(e.document_id)).sort(desc).slice(0, 20);
    const m = document.createElement('div');
    m.className = 'menu bell-panel';
    m.innerHTML = `<div class="bp-head"><b>Notifications</b>${evs.some((e) => !e.seen) ? '<button class="link" id="markAll">Mark all as read</button>' : ''}</div>` +
      (evs.length ? evs.map((e) => `<a href="#/doc/${e.document_id}" data-ev="${e.id}" class="bp-item ${e.seen ? '' : 'unread'}"><span>${esc(eventText(e))}</span><span class="sub">${ago(e.created_at)}</span></a>`).join('')
        : '<p class="bp-empty">When a customer opens or accepts something you sent, it shows up here.</p>');
    m.addEventListener('click', (e) => {
      if (e.target.id === 'markAll') { markSeen(unread().map((x) => x.id)); closeMenus(); return; }
      const a = e.target.closest('[data-ev]');
      if (a) { markSeen([a.dataset.ev]); closeMenus(); }
    });
    place(m, anchor);
  }
  async function markSeen(ids) {
    for (const id of ids) {
      const ev = S.events.find((e) => e.id === id);
      if (!ev || ev.seen) continue;
      ev.seen = true;
      try { await Store.upsert('events', { id, seen: true }); } catch (e) { /* non-critical */ }
    }
    renderBell();
  }

  // Live updates: a customer opened or accepted something.
  function onRemote() { clearTimeout(S.rt); S.rt = setTimeout(refresh, 350); }
  async function refresh() {
    try { await loadAll(); } catch (e) { return; }
    const fresh = S.events.filter((e) => !S.known.has(e.id));
    fresh.forEach((e) => S.known.add(e.id));
    fresh.filter((e) => !e.seen && (e.kind === 'viewed' || e.kind === 'accepted')).forEach(notify);
    renderChrome();
    if (E && E.dirty) syncTracked();
    else if (!$('.modal-wrap')) route();
  }
  function notify(e) {
    const text = eventText(e);
    if (!text) return;
    toast(text, { action: 'Open', onAction: () => go('#/doc/' + e.document_id), ms: 8000 });
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(text, { body: 'Folio' });
        n.onclick = () => { window.focus(); go('#/doc/' + e.document_id); };
      } catch (err) { /* ignore */ }
    }
  }

  // ---------------- Auth (cloud mode) ----------------
  function renderAuth() {
    $('#app').hidden = true;
    const a = $('#auth');
    a.hidden = false;
    let mode = 'in';
    const draw = (msg = '', ok = false) => {
      a.innerHTML = `
      <div class="auth-card">
        <div class="brand"><span class="mark"></span>Folio</div>
        <h1>${mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
        <form id="af">
          <label>Email<input type="email" name="email" required autocomplete="email"></label>
          <label>Password<input type="password" name="password" required minlength="6" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}"></label>
          <button class="btn primary wide" type="submit">${mode === 'in' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p class="${ok ? 'ok' : 'err'}">${esc(msg)}</p>
        <p class="sub">${mode === 'in' ? 'No account yet?' : 'Already have an account?'} <button class="link" id="sw">${mode === 'in' ? 'Create one' : 'Sign in'}</button></p>
      </div>`;
      $('#sw').onclick = () => { mode = mode === 'in' ? 'up' : 'in'; draw(); };
      $('#af').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const btn = $('button[type=submit]', e.target);
        btn.disabled = true;
        try {
          if (mode === 'in') {
            S.user = await Store.signIn(f.get('email'), f.get('password'));
            startApp();
          } else {
            const r = await Store.signUp(f.get('email'), f.get('password'));
            if (r.session) { S.user = r.user; startApp(); }
            else { mode = 'in'; draw('Check your email to confirm your account, then sign in.', true); }
          }
        } catch (err) { draw(err.message); }
      };
    };
    draw();
  }

  // ---------------- Router ----------------
  function route() {
    if (E && E.dirty && location.hash !== E.hash) {
      if (!confirm('You have unsaved changes. Leave without saving?')) { history.replaceState(null, '', E.hash); return; }
    }
    E = null;
    closeMenus();
    closeSuggest();
    const [p, a] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    if (!S.companies.length && !['company', 'settings'].includes(p)) { location.replace('#/company/new'); return; }
    const v = $('#view');
    v.className = 'sheet';
    let nav = p;
    if (p === 'doc') { const d = docById(a); nav = d ? d.type + 's' : ''; }
    if (p === 'new') nav = (LIST_LABEL[a] ? a : 'estimate') + 's';
    if (p === 'company') nav = 'companies';
    if (p === 'job') nav = 'jobs';
    $$('[data-nav]').forEach((x) => x.classList.toggle('on', x.dataset.nav === nav));
    $('#moreTab').classList.toggle('on', ['change_orders', 'customers', 'pricebook', 'companies', 'settings'].includes(nav));
    window.scrollTo(0, 0);
    switch (p) {
      case 'dashboard': return vDashboard(v);
      case 'estimates': return vList(v, 'estimate');
      case 'invoices': return vList(v, 'invoice');
      case 'change_orders': return vList(v, 'change_order');
      case 'jobs': return vJobs(v);
      case 'job': return vJob(v, a);
      case 'doc': return vEditor(v, docById(a));
      case 'new': return vEditor(v, null, LIST_LABEL[a] ? a : 'estimate');
      case 'customers': return vCustomers(v);
      case 'companies': return vCompanies(v);
      case 'company': return vCompany(v, a);
      case 'settings': return vSettings(v);
      case 'pricebook': return vPriceBook(v);
      default: location.replace('#/dashboard');
    }
  }

  // ---------------- Overview ----------------
  function vDashboard(v) {
    const docs = S.documents.filter((d) => inScope(d) && !d.archived);
    const inv = docs.filter((d) => d.type === 'invoice');
    const est = docs.filter((d) => d.type === 'estimate');
    const open = inv.filter((d) => !['draft', 'paid'].includes(status(d)));
    const outstanding = open.reduce((s, d) => s + totals(d).balance, 0);
    const overdue = inv.filter((d) => status(d) === 'overdue');
    const overdueSum = overdue.reduce((s, d) => s + totals(d).balance, 0);
    const since = addDays(today(), -30);
    const invIds = new Set(inv.map((d) => d.id));
    const recentPays = S.payments.filter((p) => invIds.has(p.document_id) && p.paid_on >= since);
    const collected = recentPays.reduce((s, p) => s + Number(p.amount), 0);
    const pending = est.filter((d) => ['sent', 'viewed'].includes(status(d)));
    const pendingSum = pending.reduce((s, d) => s + totals(d).total, 0);
    const attention = [
      ...overdue.map((d) => ({ d, why: `overdue since ${fmtDate(d.due_date)}` })),
      ...est.filter((d) => status(d) === 'viewed').map((d) => ({ d, why: 'opened, waiting for approval' })),
      ...est.filter((d) => d.status === 'accepted').map((d) => ({ d, why: 'accepted, ready to invoice' })),
      ...docs.filter((d) => status(d) === 'draft').map((d) => ({ d, why: 'draft, not sent yet' }))
    ].slice(0, 8);
    const acts = S.events.filter((e) => { const d = docById(e.document_id); return d && inScope(d); }).sort(desc).slice(0, 10);
    const co = S.filter !== 'all' ? company(S.filter) : (S.companies.length === 1 ? S.companies[0] : null);

    v.innerHTML = `
      <div class="head">
        <div><h1>Overview</h1><p class="sub">${co ? esc(co.name) : 'All companies'}</p></div>
        <div class="head-actions"><a class="btn" href="#/new/estimate">New estimate</a><a class="btn primary" href="#/new/invoice">New invoice</a></div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="l">Outstanding</div><div class="v">${money(outstanding)}</div><div class="sub">${plural(open.length, 'open invoice')}</div></div>
        <div class="metric ${overdue.length ? 'warn' : ''}"><div class="l">Overdue</div><div class="v">${money(overdueSum)}</div><div class="sub">${plural(overdue.length, 'invoice')}</div></div>
        <div class="metric"><div class="l">Collected in the last 30 days</div><div class="v">${money(collected)}</div><div class="sub">${plural(recentPays.length, 'payment')}</div></div>
        <div class="metric"><div class="l">Estimates awaiting approval</div><div class="v">${money(pendingSum)}</div><div class="sub">${plural(pending.length, 'estimate')}</div></div>
      </div>
      <div class="two">
        <section>
          <h2>Needs attention</h2>
          ${attention.length ? `<ul class="rows">${attention.map(({ d, why }) => `
            <li><a href="#/doc/${d.id}">
              <span class="who"><b>${esc(d.customer_name)}</b><span class="sub">${typeName(d)} ${esc(d.number)}, ${why}</span></span>
              <span class="num">${money(d.type === 'invoice' ? totals(d).balance : totals(d).total)}</span>
            </a></li>`).join('')}</ul>` : '<p class="empty">Nothing needs your attention right now.</p>'}
        </section>
        <section>
          <h2>Recent activity</h2>
          ${acts.length ? `<ul class="feed">${acts.map((e) => `
            <li class="k-${e.kind}"><a href="#/doc/${e.document_id}">${esc(eventText(e))}</a><span class="sub">${ago(e.created_at)}</span></li>`).join('')}</ul>`
        : '<p class="empty">Activity shows up here once you send estimates and invoices.</p>'}
        </section>
      </div>`;
  }

  // ---------------- Lists ----------------
  function presetRange(p) {
    const t = today(), y = +t.slice(0, 4);
    if (p === 'month') return [t.slice(0, 8) + '01', t];
    if (p === '30') return [addDays(t, -30), t];
    if (p === 'year') return [y + '-01-01', y + '-12-31'];
    if (p === 'lastyear') return [(y - 1) + '-01-01', (y - 1) + '-12-31'];
    return ['', ''];
  }

  function vList(v, type) {
    const inv = type === 'invoice';
    const st = S.list[type] || (S.list[type] = { preset: 'all', from: '', to: '', customer: '', status: '', q: '', view: localStorage.getItem('folio:view:' + type) || 'list' });
    const canBoard = type !== 'invoice';
    if (!canBoard) st.view = 'list';
    const statuses = inv ? ['draft', 'sent', 'viewed', 'partial', 'overdue', 'paid'] : ['draft', 'sent', 'viewed', 'accepted', 'converted', 'expired', 'declined'];
    const noun = type === 'change_order' ? 'change order' : type;
    const names = [...new Set(S.documents.filter((d) => d.type === type && inScope(d)).map((d) => d.customer_name).filter(Boolean))].sort();
    v.innerHTML = `
      <div class="head"><h1>${LIST_LABEL[type]}</h1><div class="head-actions">${canBoard ? `<div class="seg" role="group" aria-label="View"><button data-view="list" class="${st.view === 'list' ? 'on' : ''}" aria-pressed="${st.view === 'list'}">List</button><button data-view="board" class="${st.view === 'board' ? 'on' : ''}" aria-pressed="${st.view === 'board'}">Pipeline</button></div>` : ''}${type === 'change_order' ? '<button class="btn primary" id="newCO">New change order</button>' : `<a class="btn primary" href="#/new/${type}">New ${type}</a>`}</div></div>
      <div class="filters">
        <input type="search" id="fq" placeholder="Search by customer, number or job" value="${esc(st.q)}" aria-label="Search">
        <select id="fpreset" aria-label="Date range">${[['all', 'All dates'], ['month', 'This month'], ['30', 'Last 30 days'], ['year', 'This year'], ['lastyear', 'Last year'], ['custom', 'Custom range']]
        .map(([k, l]) => `<option value="${k}" ${st.preset === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="range" ${st.preset === 'custom' ? '' : 'hidden'}><input type="date" id="ffrom" value="${st.from}" aria-label="From"><span class="sub">to</span><input type="date" id="fto" value="${st.to}" aria-label="To"></span>
        <select id="fcust" aria-label="Customer"><option value="">All customers</option>${names.map((n) => `<option value="${esc(n)}" ${st.customer === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <select id="fstatus" aria-label="Status"><option value="">All statuses</option>${statuses.map((s) => `<option value="${s}" ${st.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}<option value="archived" ${st.status === 'archived' ? 'selected' : ''}>Archived</option></select>
      </div>
      <div id="listArea"></div>`;

    const draw = () => {
      let rows = S.documents.filter((d) => d.type === type && inScope(d));
      rows = st.status === 'archived' ? rows.filter((d) => d.archived) : rows.filter((d) => !d.archived);
      if (st.from) rows = rows.filter((d) => (d.issue_date || '') >= st.from);
      if (st.to) rows = rows.filter((d) => (d.issue_date || '') <= st.to);
      if (st.customer) rows = rows.filter((d) => d.customer_name === st.customer);
      if (st.status && st.status !== 'archived') rows = rows.filter((d) => status(d) === st.status);
      if (st.q) { const q = st.q.toLowerCase(); rows = rows.filter((d) => [d.number, d.customer_name, d.job_title].join(' ').toLowerCase().includes(q)); }
      rows.sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || '') || (b.number || '').localeCompare(a.number || ''));
      const any = S.documents.some((d) => d.type === type && inScope(d));
      if (st.view === 'board') { $('#listArea').innerHTML = boardHTML(rows, type); return; }
      $('#listArea').innerHTML = '<div class="tbl-wrap"><table class="tbl" id="tbl"></table></div>';
      const cols = inv ? 8 : 7;
      const sumT = rows.reduce((s, d) => s + totals(d).total, 0);
      const sumB = rows.reduce((s, d) => s + Math.max(totals(d).balance, 0), 0);
      $('#tbl').innerHTML = `
        <thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>${inv ? 'Due' : 'Valid until'}</th><th class="n">Total</th>${inv ? '<th class="n">Balance</th>' : ''}<th>Status</th><th><span class="vh">Actions</span></th></tr></thead>
        <tbody>${rows.map((d) => {
          const t = totals(d);
          return `<tr data-id="${d.id}">
            <td class="docno">${esc(d.number)}</td>
            <td><div>${esc(d.customer_name)}</div>${d.job_title ? `<div class="sub">${esc(d.job_title)}</div>` : ''}</td>
            <td>${fmtDate(d.issue_date)}</td><td>${fmtDate(d.due_date)}</td>
            <td class="n num">${money(t.total)}</td>${inv ? `<td class="n num">${money(t.balance)}</td>` : ''}
            <td>${pill(status(d))}</td>
            <td class="n"><button class="dots" data-menu="${d.id}" aria-label="Actions for ${esc(d.number)}">•••</button></td>
          </tr>`;
        }).join('') || `<tr class="none"><td colspan="${cols}">${any ? `No ${noun}s match these filters.` : type === 'change_order' ? 'No change orders yet. Create one from an accepted estimate or a job.' : `No ${noun}s yet. <a href="#/new/${type}">Create your first ${noun}</a>.`}</td></tr>`}</tbody>
        ${rows.length ? `<tfoot><tr><td colspan="4">${plural(rows.length, noun)}</td><td class="n num">${money(sumT)}</td>${inv ? `<td class="n num">${money(sumB)}</td>` : ''}<td colspan="2"></td></tr></tfoot>` : ''}`;
    };

    if ($('#newCO')) $('#newCO').onclick = () => pickEstimateForCO();
    $('#fq').oninput = (e) => { st.q = e.target.value; draw(); };
    $('#fpreset').onchange = (e) => {
      st.preset = e.target.value;
      $('.range', v).hidden = st.preset !== 'custom';
      if (st.preset !== 'custom') [st.from, st.to] = presetRange(st.preset);
      draw();
    };
    $('#ffrom').onchange = (e) => { st.from = e.target.value; draw(); };
    $('#fto').onchange = (e) => { st.to = e.target.value; draw(); };
    $('#fcust').onchange = (e) => { st.customer = e.target.value; draw(); };
    $('#fstatus').onchange = (e) => { st.status = e.target.value; draw(); };
    $$('[data-view]', v).forEach((b) => (b.onclick = () => {
      st.view = b.dataset.view;
      localStorage.setItem('folio:view:' + type, st.view);
      $$('[data-view]', v).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
      $('#fstatus').hidden = st.view === 'board';
      draw();
    }));
    $('#fstatus').hidden = st.view === 'board';
    const area = $('#listArea');
    area.onclick = (e) => {
      const m = e.target.closest('[data-menu]');
      if (m) { e.stopPropagation(); openMenu(m, docMenu(docById(m.dataset.menu))); return; }
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-id], .card[data-id]');
      if (tr) go('#/doc/' + tr.dataset.id);
    };
    bindBoardDrag(area, draw);
    draw();
  }

  // ---------------- Pipeline board (estimates and change orders) ----------------
  const FOLLOW_UP_DAYS = 3;
  const BOARD_COLS = [
    { key: 'draft', label: 'Draft', hint: 'Not sent yet' },
    { key: 'sent', label: 'Sent', hint: 'Waiting for the customer to open it' },
    { key: 'viewed', label: 'Viewed', hint: 'Opened, not decided yet' },
    { key: 'accepted', label: 'Accepted', hint: 'Ready to invoice', drop: true },
    { key: 'converted', label: 'Invoiced', hint: 'Work billed', drop: true },
    { key: 'lost', label: 'Declined', hint: 'Declined or expired', drop: true }
  ];
  function boardKey(d) {
    const st = status(d);
    if (st === 'declined' || st === 'expired') return 'lost';
    if (st === 'accepted' && S.documents.some((x) => x.type === 'invoice' && x.source_id === d.id)) return 'converted';
    return st;
  }
  const daysSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : 0);
  function lastViewed(d) {
    const ev = S.events.filter((e) => e.document_id === d.id && e.kind === 'viewed').sort(desc)[0];
    return (ev && ev.created_at) || d.viewed_at;
  }
  function cardTag(d, key) {
    const sent = d.last_sent_at || d.sent_at;
    if ((key === 'sent' || key === 'viewed') && daysSince(sent) >= FOLLOW_UP_DAYS) {
      return `<span class="tag follow">Follow up, sent ${ago(sent)}</span>`;
    }
    if (key === 'viewed') return `<span class="tag seen">Opened ${ago(lastViewed(d))}</span>`;
    if (key === 'sent') return `<span class="tag">Sent ${ago(sent)}</span>`;
    if (key === 'draft') return `<span class="tag">Created ${ago(d.created_at)}</span>`;
    if (key === 'accepted' || key === 'converted') return d.accepted_at ? `<span class="tag ok">Accepted ${fmtDate(d.accepted_at)}</span>` : '';
    return `<span class="tag">${STATUS_LABEL[status(d)]}</span>`;
  }

  function boardHTML(rows, type) {
    const noun = type === 'change_order' ? 'change orders' : 'estimates';
    const groups = Object.fromEntries(BOARD_COLS.map((c) => [c.key, []]));
    rows.forEach((d) => { const k = boardKey(d); (groups[k] || groups.lost).push(d); });
    const follow = rows.filter((d) => ['sent', 'viewed'].includes(boardKey(d)) && daysSince(d.last_sent_at || d.sent_at) >= FOLLOW_UP_DAYS).length;
    return `
      ${follow ? `<p class="board-note">${plural(follow, type === 'change_order' ? 'change order' : 'estimate')} sent more than ${FOLLOW_UP_DAYS} days ago without a decision. A quick call often closes the deal.</p>` : ''}
      <div class="board" id="board">${BOARD_COLS.map((c) => {
        const list = groups[c.key];
        const sum = list.reduce((s, d) => s + totals(d).total, 0);
        return `
        <section class="col" data-col="${c.key}" ${c.drop ? 'data-drop="1"' : ''}>
          <header class="col-head"><div><b>${c.label}</b><span class="count">${list.length}</span></div><span class="num sub">${money(sum)}</span></header>
          <div class="col-body">${list.map((d) => `
            <article class="card ${daysSince(d.last_sent_at || d.sent_at) >= FOLLOW_UP_DAYS && ['sent', 'viewed'].includes(c.key) ? 'is-follow' : ''}" draggable="true" data-id="${d.id}" tabindex="0">
              <div class="card-top"><span class="docno">${esc(d.number)}</span><button class="dots" data-menu="${d.id}" aria-label="Actions for ${esc(d.number)}">•••</button></div>
              <b class="card-name">${esc(d.customer_name)}</b>
              ${d.job_title ? `<div class="sub card-job">${esc(d.job_title)}</div>` : ''}
              <div class="card-foot"><span class="num">${money(totals(d).total)}</span>${cardTag(d, c.key)}</div>
            </article>`).join('') || `<p class="col-empty">${c.hint || 'Nothing here'}</p>`}</div>
        </section>`;
      }).join('')}</div>
      <p class="sub board-help">Drag a card to <b>Accepted</b>, <b>Invoiced</b> or <b>Declined</b> to update it, or use the ••• menu on a card. Cards move to Sent and Viewed on their own when you send ${noun} and customers open them.</p>`;
  }

  function bindBoardDrag(area, redraw) {
    let dragId = null;
    area.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.card[data-id]');
      if (!card) return;
      dragId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    area.addEventListener('dragend', () => { $$('.card.dragging, .col.drop-ok', area).forEach((x) => x.classList.remove('dragging', 'drop-ok')); dragId = null; });
    area.addEventListener('dragover', (e) => {
      const col = e.target.closest('.col[data-drop]');
      if (!col || !dragId) return;
      e.preventDefault();
      $$('.col.drop-ok', area).forEach((x) => { if (x !== col) x.classList.remove('drop-ok'); });
      col.classList.add('drop-ok');
    });
    area.addEventListener('dragleave', (e) => { const col = e.target.closest('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop-ok'); });
    area.addEventListener('drop', async (e) => {
      const col = e.target.closest('.col[data-drop]');
      if (!col || !dragId) return;
      e.preventDefault();
      const d = docById(dragId);
      const to = col.dataset.col;
      const from = boardKey(d);
      col.classList.remove('drop-ok');
      if (!d || to === from) return;
      if (to === 'accepted') await setEstimate(d, 'accepted', true);
      else if (to === 'lost') await setEstimate(d, 'declined', true);
      else if (to === 'converted') {
        if (!['accepted', 'converted'].includes(d.status) && !confirm(`${d.number} hasn't been accepted yet. Create the invoice anyway?`)) return;
        if ((d.schedule || []).length) { go('#/doc/' + d.id); toast('This estimate has a payment schedule. Use Create invoice next to each payment.'); return; }
        await convert(d);
        return;
      }
      redraw();
    });
  }

  function docMenu(d) {
    const inv = d.type === 'invoice';
    const open = isQuote(d) && !['accepted', 'converted', 'declined'].includes(d.status);
    return [
      { label: 'Edit', run: () => go('#/doc/' + d.id) },
      { label: 'Preview', run: () => preview(d) },
      { label: 'Duplicate', run: () => duplicate(d) },
      { label: d.sent_at ? 'Send again' : 'Send', run: () => sendModal(d, 'send') },
      inv && d.sent_at && totals(d).balance > 0 ? { label: 'Send payment reminder', run: () => sendModal(d, 'reminder') } : null,
      inv ? { label: 'Record payment', run: () => paymentModal(d) } : null,
      !inv && d.status !== 'converted' ? { label: d.type === 'change_order' ? 'Create invoice' : 'Convert to invoice', run: () => convert(d) } : null,
      d.type === 'estimate' && ['accepted', 'converted'].includes(d.status) && !S.needsUpgrade2 ? { label: 'New change order', run: () => startChangeOrder(d) } : null,
      d.job_id && jobById(d.job_id) ? { label: 'Open job', run: () => go('#/job/' + d.job_id) } : null,
      open ? { label: 'Mark as accepted', run: () => setEstimate(d, 'accepted') } : null,
      open ? { label: 'Mark as declined', run: () => setEstimate(d, 'declined') } : null,
      { label: 'Copy customer link', run: () => copyLink(d) },
      { label: 'Download PDF', run: () => download(d, 'pdf') },
      { label: 'Download JPEG', run: () => download(d, 'jpeg') },
      '-',
      { label: d.archived ? 'Restore from archive' : 'Archive', run: () => archive(d) },
      { label: 'Delete', danger: true, run: () => del(d) }
    ];
  }

  // ---------------- Document actions ----------------
  function docFields(d) {
    const o = {};
    ['company_id', 'job_id', 'customer_id', 'customer_name', 'customer_email', 'customer_phone', 'customer_address', 'job_title', 'job_site',
      'tax_rate', 'discount_type', 'discount_value', 'notes', 'terms', 'total', 'show_photos'].forEach((k) => (o[k] = d[k] ?? null));
    o.show_photos = o.show_photos !== false;
    o.items = clone(d.items || []);
    return o;
  }
  async function bumpCounter(d) {
    const co = company(d.company_id);
    if (!co) return;
    const key = counterKey(d.type);
    const updated = await Store.upsert('companies', { id: co.id, [key]: (Number(co[key]) || 1) + 1 });
    upsertLocal(S.companies, updated);
  }
  async function createDoc(obj) {
    const saved = await Store.upsert('documents', obj);
    upsertLocal(S.documents, saved);
    await bumpCounter(saved);
    return saved;
  }
  function afterDocChange(id) {
    if (E && E.doc.id === id) {
      if (E.dirty) syncTracked();
      else { E.doc = clone(docById(id)); drawEditor(); }
    } else route();
  }
  function syncTracked() {
    if (!E || !E.doc.id) return;
    const fresh = docById(E.doc.id);
    if (!fresh) return;
    TRACKED.forEach((k) => (E.doc[k] = fresh[k]));
    const rail = $('#rail');
    if (rail) rail.innerHTML = railHTML();
    updateTotals();
  }

  async function duplicate(d) {
    const co = company(d.company_id);
    const copy = {
      ...docFields(d), type: d.type, status: 'draft', number: predictNumber(co, d.type), issue_date: today(),
      due_date: addDays(today(), d.type === 'invoice' ? (co.payment_terms_days ?? 30) : (co.estimate_valid_days ?? 30)), amount_paid: 0,
      schedule: d.type === 'estimate' ? clone(d.schedule || []) : []
    };
    try {
      const saved = await createDoc(copy);
      toast(`Duplicated as ${saved.number}`);
      if (E) E.dirty = false;
      go('#/doc/' + saved.id);
    } catch (e) { toast('Could not duplicate: ' + e.message, { type: 'error' }); }
  }

  // Only the lines the customer is paying for, without the option markers.
  const includedItems = (d) => (d.items || []).filter(D.included).map((it) => { const x = clone(it); delete x.option; delete x.group; delete x.selected; return x; });

  async function convert(d) {
    if (d.converted_id && docById(d.converted_id)) return go('#/doc/' + d.converted_id);
    const co = company(d.company_id);
    const inv = {
      ...docFields(d), type: 'invoice', status: 'draft', number: predictNumber(co, 'invoice'), issue_date: today(),
      due_date: addDays(today(), co.payment_terms_days ?? 30), source_id: d.id, amount_paid: 0, terms: co.default_terms || d.terms || '',
      items: includedItems(d), schedule: [],
      notes: d.type === 'change_order' ? `Change order ${d.number}${d.notes ? '\n' + d.notes : ''}` : d.notes
    };
    try {
      const saved = await createDoc(inv);
      const est = await Store.upsert('documents', { id: d.id, status: 'converted', converted_id: saved.id });
      upsertLocal(S.documents, est);
      if (E) E.dirty = false;
      toast(`Invoice ${saved.number} created from ${typeName(d).toLowerCase()} ${d.number}`);
      go('#/doc/' + saved.id);
    } catch (e) { toast('Could not convert: ' + e.message, { type: 'error' }); }
  }

  async function setEstimate(d, st, fromBoard) {
    const patch = { id: d.id, status: st };
    if (st === 'accepted') { patch.accepted_at = new Date().toISOString(); patch.accepted_by = d.customer_name; }
    try {
      const saved = await Store.upsert('documents', patch);
      upsertLocal(S.documents, saved);
      toast(`${typeName(d)} ${d.number} marked as ${st}`);
      if (!fromBoard) afterDocChange(d.id);
    } catch (e) { toast('Could not update: ' + e.message, { type: 'error' }); }
  }

  async function archive(d) {
    const saved = await Store.upsert('documents', { id: d.id, archived: !d.archived });
    upsertLocal(S.documents, saved);
    toast(saved.archived ? `${typeName(d)} ${d.number} archived` : `${typeName(d)} ${d.number} restored`);
    afterDocChange(d.id);
  }

  async function del(d) {
    if (!confirm(`Delete ${typeName(d).toLowerCase()} ${d.number}? Its payments and activity are deleted too. This can't be undone.`)) return;
    try {
      for (const p of photosFor(d.id)) { try { await Store.removePhotoFile(p.path); } catch (e) { /* keep going */ } }
      await Store.remove('documents', d.id);
      S.photos = S.photos.filter((p) => p.document_id !== d.id);
      S.documents = S.documents.filter((x) => x.id !== d.id);
      S.payments = S.payments.filter((p) => p.document_id !== d.id);
      S.events = S.events.filter((e) => e.document_id !== d.id);
      toast(`${typeName(d)} ${d.number} deleted`);
      if (E) { E.dirty = false; go('#/' + d.type + 's'); } else route();
    } catch (e) { toast('Could not delete: ' + e.message, { type: 'error' }); }
  }

  function copyLink(d) {
    if (!d.public_token) return toast('Save this document first to get its customer link.', { type: 'error' });
    const link = customerLink(d);
    const done = () => toast(d.status === 'draft' ? 'Link copied. Views are tracked once the document is sent.' : 'Customer link copied');
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => prompt('Copy this link:', link));
    else prompt('Copy this link:', link);
  }

  async function download(d, fmt) {
    toast(fmt === 'pdf' ? 'Preparing PDF' : 'Preparing image', { ms: 1600 });
    try {
      const args = [d, company(d.company_id), photosFor(d.id)];
      if (fmt === 'pdf') {
        (await D.toPdf(...args)).save(fileName(d) + '.pdf');
      } else {
        const a = document.createElement('a');
        a.href = await D.toJpeg(...args);
        a.download = fileName(d) + '.jpg';
        a.click();
      }
    } catch (e) { console.error(e); toast('Could not create the file: ' + e.message, { type: 'error' }); }
  }

  function preview(d) {
    modal(`
      <div class="pv-head"><h2>${typeName(d)} ${esc(d.number)}</h2>
        <div class="btn-row"><button class="btn" id="pvPdf">Download PDF</button><button class="btn" id="pvJpg">Download JPEG</button><button class="btn" data-close>Close</button></div></div>
      <p class="sub">Exactly as it prints and downloads, page by page.</p>
      <div class="pv-body pv-pages"><p class="sub">Laying out pages</p></div>`, async (w) => {
      $('#pvPdf', w).onclick = () => download(d, 'pdf');
      try {
        const pages = await D.buildPages(d, company(d.company_id), photosFor(d.id));
        const body = $('.pv-body', w);
        body.innerHTML = pages.map((pg) => `<div class="pv-page">${pg}</div>`).join('');
        const fit = () => { const s = Math.min(1, (body.clientWidth - 2) / 816); $$('.pv-page', w).forEach((el) => { el.style.setProperty('--s', s); }); };
        fit();
        window.addEventListener('resize', fit);
      } catch (e) { $('.pv-body', w).innerHTML = `<p class="err">${esc(e.message)}</p>`; }
      $('#pvJpg', w).onclick = () => download(d, 'jpeg');
    }, 'wide');
  }

  // Folio's own email sending (Resend) is off unless config.js sets USE_EMAIL_FUNCTION: true.
  const useEmailFunction = () => S.mode === 'cloud' && !!(window.APP_CONFIG || {}).USE_EMAIL_FUNCTION;

  async function markSent(d, kind, to) {
    const now = new Date().toISOString();
    const patch = { id: d.id, last_sent_at: now, sent_at: d.sent_at || now };
    if (d.status === 'draft') patch.status = 'sent';
    if (!d.customer_email && to) patch.customer_email = to;
    const saved = await Store.upsert('documents', patch);
    upsertLocal(S.documents, saved);
    if (E && E.doc.id === d.id && patch.customer_email) E.doc.customer_email = to;
    const ev = await Store.upsert('events', { document_id: d.id, kind: kind === 'reminder' ? 'reminder' : 'sent', detail: to || null, seen: true });
    S.events.push(ev); S.known.add(ev.id);
  }

  function sendModal(d, kind) {
    const co = company(d.company_id) || {};
    const t = totals(d);
    const tn = typeName(d);
    const hi = `Hi ${firstName(d.customer_name)},`;
    const link = customerLink(d);
    const own = !useEmailFunction();
    const subject = kind === 'reminder' ? `Reminder: invoice ${d.number} from ${co.name}` : `${tn} ${d.number} from ${co.name}`;
    const linkLine = own ? 'using this link:\n' + link : 'using the link below.';
    let msg;
    if (kind === 'reminder') {
      msg = `${hi}\n\nThis is a friendly reminder that invoice ${d.number} for ${money(t.balance)} ${d.due_date && d.due_date < today() ? 'was' : 'is'} due on ${fmtDate(d.due_date)}.\n\nYou can view the invoice online ${linkLine}\n\nThank you,\n${co.name}`;
    } else if (d.type === 'change_order') {
      const ch = t.total >= 0 ? `adds ${money(t.total)} to` : `takes ${money(-t.total)} off`;
      msg = `${hi}\n\nAs discussed, here is change order ${d.number}${d.job_title ? ' for ' + d.job_title.toLowerCase() : ''}. It ${ch} the contract.\n\nYou can review and approve it online ${linkLine}\n\nThank you,\n${co.name}`;
    } else if (d.type === 'estimate') {
      msg = `${hi}\n\nThank you for the opportunity. Your estimate${d.job_title ? ' for ' + d.job_title.toLowerCase() : ''} is ready, with a total of ${money(t.total)}.\n\nYou can review and accept it online ${linkLine}\n\nBest regards,\n${co.name}`;
    } else {
      msg = `${hi}\n\nPlease find invoice ${d.number} for ${money(t.balance)}${d.due_date ? ', due ' + fmtDate(d.due_date) : ''}.\n\nYou can view and download the invoice online ${linkLine}\n\nThank you for your business,\n${co.name}`;
    }
    const verb = kind === 'reminder' ? 'Send reminder' : `Send ${tn.toLowerCase()}`;
    const title = kind === 'reminder' ? 'Send payment reminder' : `Send ${tn.toLowerCase()} ${esc(d.number)}`;

    const actions = own ? `
      <div class="send-opts">
        <button class="btn primary" data-via="gmail">Open in Gmail</button>
        <button class="btn" data-via="mail">Open my email app</button>
        <button class="btn" data-via="sms">Text message</button>
        <button class="btn" data-via="copy">Copy message</button>
      </div>
      <p class="sub">Folio fills in the email for you. Review it and press send in your email. Folio marks the ${tn.toLowerCase()} as sent and notifies you when your customer opens the link.</p>`
      : `<label class="check"><input type="checkbox" id="sAtt" checked> Attach a PDF copy</label>
      <div class="m-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sGo">${verb}</button></div>`;

    modal(`
      <h2>${title}</h2>
      <label>To<input id="sTo" type="email" value="${esc(d.customer_email)}" placeholder="customer@example.com"></label>
      <label>Subject<input id="sSub" value="${esc(subject)}"></label>
      <label>Message<textarea id="sMsg" rows="11">${esc(msg)}</textarea></label>
      ${S.mode === 'demo' ? '<p class="note">Demo mode: the document is marked as sent, and you can open the customer page to test view notifications.</p>' : ''}
      ${actions}`, (w, close) => {
      const val = (id) => $(id, w).value.trim();
      const finish = async (to, label) => {
        try {
          await markSent(d, kind, to);
          close();
          renderChrome();
          toast(label, S.mode === 'demo' ? { action: 'Open customer page', onAction: () => window.open(link, '_blank'), ms: 9000 } : {});
          afterDocChange(d.id);
        } catch (e) { toast('Could not update the status: ' + e.message, { type: 'error' }); }
      };

      if (own) {
        $$('[data-via]', w).forEach((b) => (b.onclick = async () => {
          const via = b.dataset.via;
          const to = val('#sTo'), sub = val('#sSub'), body = $('#sMsg', w).value;
          if (via !== 'copy' && via !== 'sms' && !/^\S+@\S+\.\S+$/.test(to)) { toast('Enter a valid email address.', { type: 'error' }); return; }
          const enc = encodeURIComponent;
          if (via === 'gmail') {
            window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(sub)}&body=${enc(body)}`, '_blank');
          } else if (via === 'mail') {
            window.location.href = `mailto:${enc(to)}?subject=${enc(sub)}&body=${enc(body)}`;
          } else if (via === 'sms') {
            const phone = (d.customer_phone || '').replace(/[^\d+]/g, '');
            const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
            window.location.href = `sms:${phone}${ios ? '&' : '?'}body=${enc(body)}`;
          } else {
            const text = `${sub}\n\n${body}`;
            try { await navigator.clipboard.writeText(text); } catch (e) { prompt('Copy this message:', text); }
          }
          const done = { gmail: 'Gmail opened', mail: 'Email app opened', sms: 'Text message opened', copy: 'Message copied' }[via];
          await finish(to, `${done}. ${tn} ${d.number} marked as sent.`);
        }));
        return;
      }

      $('#sGo', w).onclick = async () => {
        const to = val('#sTo');
        if (!/^\S+@\S+\.\S+$/.test(to)) { toast('Enter a valid email address.', { type: 'error' }); return; }
        const b = $('#sGo', w);
        b.disabled = true; b.textContent = 'Sending';
        try {
          let pdf_base64 = null;
          if ($('#sAtt', w).checked) {
            const pdf = await D.toPdf(d, co, photosFor(d.id));
            pdf_base64 = pdf.output('datauristring').split(',')[1];
          }
          await Store.send({ document_id: d.id, to, subject: val('#sSub'), message: $('#sMsg', w).value, kind, pdf_base64, filename: fileName(d) + '.pdf' });
          if (!d.customer_email) {
            const saved = await Store.upsert('documents', { id: d.id, customer_email: to });
            upsertLocal(S.documents, saved);
            if (E && E.doc.id === d.id) E.doc.customer_email = to;
          }
          await loadAll();
          S.events.forEach((e) => S.known.add(e.id));
          close();
          renderChrome();
          toast(`${kind === 'reminder' ? 'Reminder' : tn} sent to ${to}`);
          afterDocChange(d.id);
        } catch (e) {
          toast('Could not send: ' + e.message, { type: 'error', ms: 8000 });
          b.disabled = false; b.textContent = verb;
        }
      };
    });
  }

  function paymentModal(d) {
    const t = totals(d);
    modal(`
      <h2>Record payment</h2>
      <p class="sub">Invoice ${esc(d.number)} for ${esc(d.customer_name)}. Balance due ${money(t.balance)}.</p>
      <div class="grid2">
        <label>Amount<input id="pAmt" type="number" step="0.01" min="0" value="${Math.max(t.balance, 0).toFixed(2)}"></label>
        <label>Date received<input id="pDate" type="date" value="${today()}"></label>
        <label>Method<select id="pMethod">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
        <label>Reference<input id="pRef" placeholder="Check number or transaction ID"></label>
      </div>
      <label>Note<input id="pNote" placeholder="Optional"></label>
      <div class="m-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pGo">Record payment</button></div>`, (w, close) => {
      $('#pGo', w).onclick = async () => {
        const amount = D.round2(parseFloat($('#pAmt', w).value));
        if (!(amount > 0)) { toast('Enter an amount greater than zero.', { type: 'error' }); return; }
        $('#pGo', w).disabled = true;
        try {
          const p = await Store.upsert('payments', { document_id: d.id, amount, paid_on: $('#pDate', w).value || today(), method: $('#pMethod', w).value, reference: $('#pRef', w).value, note: $('#pNote', w).value });
          S.payments.push(p);
          await syncPaid(d.id);
          const ev = await Store.upsert('events', { document_id: d.id, kind: 'paid', detail: String(amount), seen: true });
          S.events.push(ev); S.known.add(ev.id);
          close();
          toast(`Payment of ${money(amount)} recorded`);
          afterDocChange(d.id);
        } catch (e) { toast('Could not record payment: ' + e.message, { type: 'error' }); $('#pGo', w).disabled = false; }
      };
    });
  }
  async function syncPaid(docId) {
    const d = docById(docId);
    const sum = D.round2(S.payments.filter((x) => x.document_id === docId).reduce((s, x) => s + Number(x.amount), 0));
    const patch = { id: docId, amount_paid: sum };
    if (d && d.status === 'draft' && sum > 0) patch.status = 'sent';
    const saved = await Store.upsert('documents', patch);
    upsertLocal(S.documents, saved);
  }

  // ---------------- Editor ----------------
  function newDoc(type) {
    const co = (S.filter !== 'all' && company(S.filter)) || S.companies[0];
    const d = {
      type, status: 'draft', company_id: co.id, customer_id: null, number: predictNumber(co, type),
      issue_date: today(), due_date: addDays(today(), type === 'invoice' ? (co.payment_terms_days ?? 30) : (co.estimate_valid_days ?? 30)),
      customer_name: '', customer_email: '', customer_phone: '', customer_address: '', job_title: '', job_site: '',
      items: [{ kind: 'Labor', description: '', qty: 1, price: 0, }],
      tax_rate: Number(co.tax_rate) || 0, discount_type: 'percent', discount_value: 0,
      notes: co.default_notes || '', terms: co.default_terms || '', amount_paid: 0, show_photos: true,
      schedule: type === 'estimate' && co.use_schedule ? clone(co.default_schedule || []) : []
    };
    const c = S.pendingCustomer && S.customers.find((x) => x.id === S.pendingCustomer);
    S.pendingCustomer = null;
    if (c) Object.assign(d, { customer_id: c.id, customer_name: c.name, customer_email: c.email || '', customer_phone: c.phone || '', customer_address: c.address || '', job_site: c.address || '' });
    // Started from a job or an estimate: carry the customer, job and project over.
    const src = S.pendingSource && docById(S.pendingSource);
    const job = jobById(S.pendingJob || (src && src.job_id));
    S.pendingSource = null; S.pendingJob = null;
    const from = src || (job && S.documents.find((x) => x.job_id === job.id));
    if (from) {
      ['company_id', 'customer_id', 'customer_name', 'customer_email', 'customer_phone', 'customer_address', 'job_title', 'job_site', 'tax_rate'].forEach((k) => (d[k] = from[k]));
      const fco = company(from.company_id);
      if (fco) d.number = predictNumber(fco, type);
    }
    if (job) { d.job_id = job.id; d.job_title = d.job_title || job.name; d.job_site = d.job_site || job.address || ''; }
    if (type === 'change_order') {
      d.items = [{ kind: 'Labor', description: '', qty: 1, price: 0 }];
      d.notes = ''; d.schedule = [];
      if (src) d.source_id = src.id;
    }
    return d;
  }

  function vEditor(v, doc, type) {
    v.classList.add('desk');
    if (!doc && !type) {
      v.innerHTML = '<p class="empty">This document was deleted or doesn\'t exist. <a href="#/dashboard">Go to overview</a></p>';
      return;
    }
    E = doc ? { doc: clone(doc), isNew: false, dirty: false } : { doc: newDoc(type), isNew: true, dirty: false, saveCustomer: true };
    E.saveCustomer = E.saveCustomer ?? false;
    E.doc.items = E.doc.items || [];
    E.hash = location.hash;
    drawEditor();
    if (doc) {
      const ids = S.events.filter((e) => e.document_id === doc.id && !e.seen).map((e) => e.id);
      if (ids.length) markSeen(ids);
    }
  }

  function autosize(el) {
    if (el.classList.contains('desc')) return fitDesc(el);
    el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px';
  }
  // Description boxes: grow to fit the text, never hide text, and keep any height the user drags them to.
  function fitDesc(el) {
    const keep = el.offsetHeight;
    el.style.minHeight = '0px';
    el.style.height = 'auto';
    const need = el.scrollHeight + 2;
    el.style.minHeight = need + 'px';
    el.style.height = Math.max(need, keep) + 'px';
  }
  function autosizeAll() { $$('#view textarea.ghost, #view textarea.desc').forEach(autosize); }
  // Remember a dragged height so it survives adding or removing lines.
  document.addEventListener('pointerup', () => {
    if (!E) return;
    $$('#itemRows textarea.desc').forEach((el) => {
      const tr = el.closest('tr[data-i]');
      const it = tr && E.doc.items[+tr.dataset.i];
      if (it && Math.abs((it.h || 0) - el.offsetHeight) > 2 && el.style.height !== el.style.minHeight) it.h = el.offsetHeight;
    });
  });

  function drawEditor() {
    const v = $('#view');
    const d = E.doc, co = company(d.company_id) || {}, inv = d.type === 'invoice';
    const tn = typeName(d);
    const val = (k) => esc(d[k] ?? '');
    v.innerHTML = `
      <div class="ed-top">
        <a class="back" href="${d.job_id && jobById(d.job_id) ? '#/job/' + d.job_id : '#/' + d.type + 's'}">${d.job_id && jobById(d.job_id) ? esc(jobById(d.job_id).name) : LIST_LABEL[d.type]}</a>
        <div class="ed-title"><h1>${E.isNew ? 'New ' + tn.toLowerCase() : `${tn} ${esc(d.number)}`}</h1>${E.isNew ? '' : pill(status(d))}</div>
        <div class="ed-actions">
          <button class="btn" data-act="preview">Preview</button>
          <button class="btn" data-act="download">Download</button>
          <button class="btn" data-act="send">${d.sent_at ? 'Send again' : 'Send'}</button>
          ${inv ? '<button class="btn" data-act="pay">Record payment</button>'
        : (d.schedule || []).length ? '<button class="btn" data-act="nextms">Invoice next payment</button>'
        : `<button class="btn" data-act="convert">${d.converted_id ? 'Open invoice' : d.type === 'change_order' ? 'Create invoice' : 'Convert to invoice'}</button>`}
          ${E.isNew ? '' : '<button class="btn icon" data-act="more" aria-label="More actions">•••</button>'}
          <button class="btn primary" data-act="save">${E.dirty ? 'Save changes' : 'Save'}</button>
        </div>
      </div>
      <div class="ed-grid">
        <div class="ed-main">
        <form class="paper edit" style="--brand:${esc(co.color || '#1F4E46')}" onsubmit="return false" autocomplete="off">
          <div class="p-band"></div>
          <header class="p-head">
            <div class="p-from">
              ${co.logo ? `<img class="p-logo" src="${co.logo}" alt="">` : ''}
              ${S.companies.length > 1
        ? `<select class="ghost p-co co-pick" data-f="company_id" aria-label="Company">${S.companies.map((c) => `<option value="${c.id}" ${c.id === d.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
        : `<div class="p-co">${esc(co.name || '')}</div>`}
              <div class="p-lines">${D.companyLines(co)}</div>
              <a class="tiny" href="#/company/${co.id}">Edit company details</a>
            </div>
            <div class="p-title">
              <div class="p-type">${tn}</div>
              <dl class="p-meta">
                <dt><label for="fNum">Number</label></dt><dd><input id="fNum" class="ghost r" data-f="number" value="${val('number')}"></dd>
                <dt><label for="fIss">Issued</label></dt><dd><input id="fIss" class="ghost r" type="date" data-f="issue_date" value="${val('issue_date')}"></dd>
                <dt><label for="fDue">${inv ? 'Due' : 'Valid until'}</label></dt><dd><input id="fDue" class="ghost r" type="date" data-f="due_date" value="${val('due_date')}"></dd>
              </dl>
            </div>
          </header>
          <section class="p-parties">
            <div class="stack">
              <div class="p-h"><span>${inv ? 'Bill to' : 'Prepared for'}</span>
                <select class="mini" id="custPick" aria-label="Choose a saved customer"><option value="">Saved customers</option>${S.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="__new">New customer</option></select>
              </div>
              <input class="ghost p-strong" data-f="customer_name" placeholder="Customer name" value="${val('customer_name')}" aria-label="Customer name">
              <textarea class="ghost" data-f="customer_address" rows="1" placeholder="Address" aria-label="Customer address">${val('customer_address')}</textarea>
              <input class="ghost" data-f="customer_phone" type="tel" placeholder="Phone" value="${val('customer_phone')}" aria-label="Customer phone">
              <input class="ghost" data-f="customer_email" type="email" placeholder="Email" value="${val('customer_email')}" aria-label="Customer email">
              ${!d.customer_id ? `<label class="check small"><input type="checkbox" id="saveCust" ${E.saveCustomer ? 'checked' : ''}> Save to customers</label>` : ''}
            </div>
            <div class="stack">
              <div class="p-h"><span>Project</span>${S.needsUpgrade2 ? '' : `<select class="mini" id="jobPick" aria-label="Job">${jobOptions(d)}</select>`}</div>
              <input class="ghost p-strong" data-f="job_title" placeholder="Job, e.g. Kitchen remodel" value="${val('job_title')}" aria-label="Job title">
              <textarea class="ghost" data-f="job_site" rows="1" placeholder="Job site address" aria-label="Job site address">${val('job_site')}</textarea>
              ${d.customer_address && d.job_site !== d.customer_address ? '<button type="button" class="link small" data-act="sameaddr">Same as customer address</button>' : ''}
              ${d.type === 'change_order' ? `<p class="co-ref">${d.contract && d.contract.ref ? `Changes to estimate <b>${esc(d.contract.ref)}</b>` : 'Not linked to an estimate'}</p>` : ''}
            </div>
          </section>
          <table class="p-items edit-items">
            <thead><tr><th>Description</th><th class="p-num">Rate</th><th class="p-num">Qty</th><th class="p-num">Amount</th><th><span class="vh">Remove</span></th></tr></thead>
            <tbody id="itemRows">${itemRows()}</tbody>
          </table>
          <div class="line-btns"><button type="button" class="btn subtle" data-act="addline">Add line item</button><button type="button" class="btn subtle" data-act="pbpick">Add from price book</button>${d.type === 'estimate' ? '<span class="sub opt-hint">Set a line to <b>Optional add-on</b> or <b>Choice</b> to let your customer pick on their estimate page.</span>' : ''}</div>
          <p class="sched-warn" id="optWarn"></p>
          <section class="p-bottom">
            <div class="p-notes stack">
              <div class="p-h">Notes</div>
              <textarea class="ghost" data-f="notes" rows="2" placeholder="Scope details, exclusions, schedule" aria-label="Notes">${val('notes')}</textarea>
              <div class="p-h">Terms</div>
              <textarea class="ghost" data-f="terms" rows="2" placeholder="Payment terms, warranty" aria-label="Terms">${val('terms')}</textarea>
            </div>
            <div class="p-totals">
              <div class="tr"><span>Subtotal</span><span id="tSub"></span></div>
              <div class="tr"><span class="inl">Discount
                <input class="ghost xs r" data-f="discount_value" type="number" step="0.01" min="0" value="${Number(d.discount_value) || 0}" aria-label="Discount">
                <select class="ghost xs" data-f="discount_type" aria-label="Discount type"><option value="percent" ${d.discount_type !== 'amount' ? 'selected' : ''}>%</option><option value="amount" ${d.discount_type === 'amount' ? 'selected' : ''}>$</option></select></span><span id="tDisc"></span></div>
              <div class="tr"><span class="inl">Tax
                <input class="ghost xs r" data-f="tax_rate" type="number" step="0.001" min="0" value="${Number(d.tax_rate) || 0}" aria-label="Tax rate percent">%</span><span id="tTax"></span></div>
              ${inv ? '<div class="tr total"><span>Total</span><span id="tTotal"></span></div><div class="tr"><span>Paid</span><span id="tPaid"></span></div>' : ''}
              <div class="tr due"><span>${inv ? 'Balance due' : d.type === 'change_order' ? 'Change order total' : 'Estimate total'}</span><span id="tBal"></span></div>
            </div>
          </section>
          ${d.type === 'estimate' ? `<section class="p-sched edit-sched" id="schedBox">${schedHTML()}</section>` : ''}
        </form>
        <section class="ph-box" id="photoBox">${photosHTML()}</section>
        </div>
        <aside class="rail" id="rail">${railHTML()}</aside>
      </div>`;
    autosizeAll();
    updateTotals();
  }

  function itemRows() {
    const items = E.doc.items;
    if (!items.length) return '<tr class="none"><td colspan="5">No line items yet.</td></tr>';
    return items.map((it, i) => `
      <tr data-i="${i}">
        <td>
          <div class="li-top"><select class="ghost kind" data-k="kind" aria-label="Line type">${KINDS.map((k) => `<option ${k === it.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>${E.doc.type === 'estimate' ? `<select class="ghost opt-pick ${it.option ? 'on' : ''}" data-k="option" aria-label="Required or optional">${[['', 'Included'], ['addon', 'Optional add-on'], ['choice', 'Choice']].map(([v, l]) => `<option value="${v}" ${(it.option || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}<span class="grow"></span><button type="button" class="link tiny-link" data-act="pbsave" data-i="${i}">Save to price book</button></div>
          <textarea class="desc" data-k="description" rows="2" placeholder="Describe the work or material" aria-label="Description"${it.h ? ` style="height:${Number(it.h)}px"` : ''}>${esc(it.description)}</textarea>
          ${it.option ? `<div class="li-opt">${it.option === 'choice' ? `<input class="ghost grp" data-k="group" value="${esc(it.group || '')}" placeholder="Choice group, e.g. Countertop" aria-label="Choice group">` : ''}<label class="check small"><input type="checkbox" data-k="selected" ${it.selected ? 'checked' : ''}> ${it.option === 'choice' ? 'Selected by default' : 'Included by default'}</label></div>` : ''}
        </td>
        <td class="p-num"><input class="ghost r rate" type="number" step="0.01" ${E.doc.type === 'change_order' ? '' : 'min="0"'} data-k="price" value="${it.price ?? ''}" aria-label="Rate"><input class="ghost r unit" data-k="unit" list="unitList" placeholder="unit" value="${esc(it.unit || '')}" aria-label="Unit, for example hour or sq ft"></td>
        <td class="p-num"><input class="ghost r qty" type="number" step="any" min="0" data-k="qty" value="${it.qty ?? ''}" aria-label="Quantity"></td>
        <td class="p-num amt ${D.included(it) ? '' : 'off'}" data-amt="${i}"></td>
        <td class="p-num"><button type="button" class="x" data-act="rmline" data-i="${i}" aria-label="Remove line">×</button></td>
      </tr>`).join('');
  }

  function updateTotals() {
    if (!E || !$('#tSub')) return;
    const t = totals(E.doc);
    const set = (id, txt) => { const el = $('#' + id); if (el) el.textContent = txt; };
    set('tSub', money(t.subtotal));
    set('tDisc', t.discount ? '−' + money(t.discount) : money(0));
    set('tTax', money(t.tax));
    set('tTotal', money(t.total));
    set('tPaid', t.paid ? '−' + money(t.paid) : money(0));
    set('tBal', money(E.doc.type === 'invoice' ? t.balance : t.total));
    E.doc.items.forEach((it, i) => {
      const el = $(`[data-amt="${i}"]`);
      if (el) { el.textContent = money((Number(it.qty) || 0) * (Number(it.price) || 0)); el.classList.toggle('off', !D.included(it)); }
    });
    const ow = $('#optWarn');
    if (ow) {
      const groups = [...new Set(E.doc.items.filter((x) => x.option === 'choice').map((x) => x.group || ''))];
      const bad = groups.filter((g) => !E.doc.items.some((x) => x.option === 'choice' && (x.group || '') === g && x.selected));
      ow.textContent = bad.length ? `Pick a default for ${bad.map((g) => '"' + (g || 'Choice') + '"').join(', ')}. Customers can still change it.` : '';
    }
    if ((E.doc.schedule || []).length) {
      D.scheduleAmounts(E.doc).forEach((m, i) => { const el = $(`[data-samt="${i}"]`); if (el) el.textContent = money(m.amount); });
      const w = $('#schedWarn'); if (w) w.textContent = D.scheduleCheck(E.doc);
    }
  }

  function markDirty() {
    if (!E) return;
    E.dirty = true;
    const b = $('[data-act="save"]');
    if (b) b.textContent = 'Save changes';
  }

  function onEdInput(ev) {
    const el = ev.target;
    if (!el.isConnected) return; // ignore late events from a field that was just redrawn
    if (el.id === 'custPick') { if (ev.type === 'change') pickCustomer(el.value); return; }
    if (el.id === 'saveCust') { E.saveCustomer = el.checked; return; }
    if (el.id === 'jobPick') {
      if (ev.type !== 'change') return;
      const j = jobById(el.value);
      E.doc.job_id = j ? j.id : null;
      if (j) { if (!E.doc.job_title) E.doc.job_title = j.name; if (!E.doc.job_site) E.doc.job_site = j.address || ''; }
      markDirty(); drawEditor(); return;
    }
    if (el.id === 'phIn' || el.id === 'phCam') { if (ev.type === 'change') { const files = [...el.files]; el.value = ''; uploadPhotos(files); } return; }
    if (el.dataset.pc) { if (ev.type === 'change') savePhotoCaption(el.dataset.pc, el.value); return; }
    const sr = el.closest('tr[data-si]');
    if (el.dataset.sk && sr) {
      const m = E.doc.schedule[+sr.dataset.si];
      editMilestone(m, el.dataset.sk, el.value, sr);
      markDirty(); updateTotals();
      return;
    }
    const tr = el.closest('tr[data-i]');
    if (el.dataset.k && tr) {
      const it = E.doc.items[+tr.dataset.i];
      const k = el.dataset.k;
      it[k] = el.type === 'checkbox' ? el.checked : (k === 'qty' || k === 'price' ? parseFloat(el.value) || 0 : el.value);
      if (k === 'option' && ev.type === 'change') {
        if (!it.option) { delete it.group; delete it.selected; }
        else if (it.option === 'addon') it.selected = false;
        else {
          it.group = it.group || lastGroup() || 'Option 1';
          it.selected = !E.doc.items.some((x) => x !== it && x.option === 'choice' && x.group === it.group && x.selected);
        }
        markDirty(); redrawLines(); return;
      }
      if (k === 'selected' && it.option === 'choice' && it.selected) {
        E.doc.items.forEach((x) => { if (x !== it && x.option === 'choice' && (x.group || '') === (it.group || '')) x.selected = false; });
        markDirty(); redrawLines(); return;
      }
      if (k === 'selected') { markDirty(); redrawLines(); return; }
      if (el.tagName === 'TEXTAREA') autosize(el);
      if (el.classList.contains('desc') && ev.type === 'input') showSuggest(el);
    } else if (el.dataset.f) {
      const f = el.dataset.f;
      if (f === 'company_id') { if (ev.type === 'change') changeCompany(el.value); return; }
      E.doc[f] = el.type === 'checkbox' ? el.checked : ['discount_value', 'tax_rate'].includes(f) ? parseFloat(el.value) || 0 : el.value;
      if (el.tagName === 'TEXTAREA') autosize(el);
    } else return;
    markDirty();
    updateTotals();
  }

  function pickCustomer(id) {
    const d = E.doc;
    if (id === '__new') {
      Object.assign(d, { customer_id: null, customer_name: '', customer_email: '', customer_phone: '', customer_address: '' });
      E.saveCustomer = true;
    } else if (id) {
      const c = S.customers.find((x) => x.id === id);
      if (!c) return;
      Object.assign(d, { customer_id: c.id, customer_name: c.name, customer_email: c.email || '', customer_phone: c.phone || '', customer_address: c.address || '' });
      if (!d.job_site) d.job_site = c.address || '';
    } else return;
    markDirty();
    drawEditor();
    if (id === '__new') $('[data-f="customer_name"]').focus();
  }

  function changeCompany(id) {
    const co = company(id);
    if (!co) return;
    E.doc.company_id = id;
    if (E.isNew) {
      E.doc.number = predictNumber(co, E.doc.type);
      E.doc.tax_rate = Number(co.tax_rate) || 0;
      E.doc.notes = co.default_notes || E.doc.notes;
      E.doc.terms = co.default_terms || E.doc.terms;
    }
    markDirty();
    drawEditor();
  }

  async function saveDoc(silent) {
    const d = E.doc;
    if (!d.company_id) { toast('Choose a company first.', { type: 'error' }); return false; }
    if (!String(d.customer_name || '').trim()) {
      toast('Add the customer name before saving.', { type: 'error' });
      const f = $('[data-f="customer_name"]'); if (f) f.focus();
      return false;
    }
    const btn = $('[data-act="save"]');
    if (btn) btn.disabled = true;
    try {
      if (!d.customer_id && E.saveCustomer) {
        const c = await Store.upsert('customers', { name: d.customer_name.trim(), email: d.customer_email || '', phone: d.customer_phone || '', address: d.customer_address || '', notes: '' });
        upsertLocal(S.customers, c);
        d.customer_id = c.id;
      }
      if (!S.needsUpgrade2) {
        if (!d.job_id || !jobById(d.job_id)) {
          const j = await Store.upsert('jobs', { company_id: d.company_id, customer_id: d.customer_id || null, name: (d.job_title || '').trim() || `${d.customer_name.trim()} project`,
            address: d.job_site || d.customer_address || '', status: d.type === 'invoice' ? 'active' : 'estimating', notes: '' });
          upsertLocal(S.jobs, j);
          d.job_id = j.id;
        }
        if (d.type === 'change_order') d.contract = contractFor(d);
      }
      d.total = totals(d).total;
      const wasNew = !d.id;
      const saved = await Store.upsert('documents', d);
      upsertLocal(S.documents, saved);
      if (wasNew) await bumpCounter(saved);
      E.doc = clone(saved); E.isNew = false; E.dirty = false; E.saveCustomer = false;
      if (wasNew) { history.replaceState(null, '', '#/doc/' + saved.id); E.hash = location.hash; }
      drawEditor();
      if (!silent) toast(`${typeName(saved)} ${saved.number} saved`);
      return true;
    } catch (e) {
      console.error(e);
      toast('Could not save: ' + e.message, { type: 'error', ms: 8000 });
      if (btn) btn.disabled = false;
      return false;
    }
  }
  async function ensureSaved() { return (E.isNew || E.dirty) ? saveDoc(true) : true; }

  const ACTS = {
    newco: async () => { if (await ensureSaved()) startChangeOrder(docById(E.doc.id)); },
    pbpick: () => pickItemsModal(),
    pbsave: (b) => {
      const it = E.doc.items[+b.dataset.i];
      const [first, ...rest] = String(it.description || '').split('\n');
      itemModal(null, { name: first.trim(), description: rest.join('\n').trim(), kind: it.kind, price: it.price, unit: it.unit || '', company_id: null });
    },
    addsched: () => {
      E.doc.schedule = E.doc.schedule || [];
      const used = E.doc.schedule.reduce((s, m) => s + (m.basis === 'all' && !isFixedM(m) ? Number(m.percent) || 0 : 0), 0);
      E.doc.schedule.push({ name: '', percent: Math.max(0, 100 - used), basis: 'all' });
      markDirty(); redrawSched();
    },
    rmsched: (b) => { E.doc.schedule.splice(+b.dataset.i, 1); markDirty(); redrawSched(); },
    scheddefault: () => {
      const co = company(E.doc.company_id) || {};
      E.doc.schedule = (co.default_schedule || []).length ? clone(co.default_schedule) : clone(PRESETS.b.list);
      markDirty(); redrawSched();
    },
    schedclear: () => { E.doc.schedule = []; markDirty(); redrawSched(); },
    msinvoice: async (b) => { if (await ensureSaved()) milestoneInvoice(docById(E.doc.id), +b.dataset.i); },
    nextms: async () => {
      if (!(await ensureSaved())) return;
      const d = docById(E.doc.id);
      const i = D.scheduleAmounts(d).findIndex((m, idx) => !milestoneInv(d.id, idx));
      if (i < 0) { toast('Every payment in the schedule already has an invoice.'); return; }
      milestoneInvoice(d, i);
    },
    phdel: (b) => deletePhoto(b.dataset.id),
    phdl: (b) => downloadPhoto(b.dataset.id),
    phzip: () => downloadAllPhotos(),
    save: () => saveDoc(),
    addline: () => {
      E.doc.items.push({ kind: 'Labor', description: '', qty: 1, price: 0, });
      markDirty();
      $('#itemRows').innerHTML = itemRows();
      autosizeAll(); updateTotals();
      const tas = $$('#itemRows textarea');
      if (tas.length) tas[tas.length - 1].focus();
    },
    rmline: (b) => {
      E.doc.items.splice(+b.dataset.i, 1);
      markDirty();
      $('#itemRows').innerHTML = itemRows();
      autosizeAll(); updateTotals();
    },
    sameaddr: () => {
      E.doc.job_site = E.doc.customer_address;
      const f = $('[data-f="job_site"]'); f.value = E.doc.job_site; autosize(f);
      markDirty();
    },
    preview: () => preview(E.doc),
    download: (b) => openMenu(b, [{ label: 'Download PDF', run: () => download(E.doc, 'pdf') }, { label: 'Download JPEG', run: () => download(E.doc, 'jpeg') }]),
    send: async () => { if (await ensureSaved()) sendModal(docById(E.doc.id), 'send'); },
    remind: async () => { if (await ensureSaved()) sendModal(docById(E.doc.id), 'reminder'); },
    pay: async () => { if (await ensureSaved()) paymentModal(docById(E.doc.id)); },
    convert: async () => { if (await ensureSaved()) convert(docById(E.doc.id)); },
    more: (b) => openMenu(b, docMenu(docById(E.doc.id)).filter((x) => !x || x === '-' || !['Edit', 'Preview', 'Download PDF', 'Download JPEG', 'Record payment', 'Convert to invoice', 'Send', 'Send again'].includes(x.label))),
    copylink: () => copyLink(E.doc),
    openlink: () => window.open(customerLink(E.doc, true), '_blank'),
    delpay: async (b) => {
      if (!confirm('Remove this payment?')) return;
      try {
        await Store.remove('payments', b.dataset.id);
        S.payments = S.payments.filter((p) => p.id !== b.dataset.id);
        await syncPaid(E.doc.id);
        toast('Payment removed');
        afterDocChange(E.doc.id);
      } catch (e) { toast('Could not remove payment: ' + e.message, { type: 'error' }); }
    }
  };

  function railHTML() {
    const d = E.doc;
    if (E.isNew) {
      return `<div class="rail-box"><h3>Before you send</h3><p class="sub">Add the customer and line items, then save. Saving creates a private link to this ${typeName(d).toLowerCase()} that you can email to your customer.</p></div>`;
    }
    const t = totals(d), st = status(d), inv = d.type === 'invoice';
    const pays = S.payments.filter((p) => p.document_id === d.id).sort((a, b) => (b.paid_on || '').localeCompare(a.paid_on || ''));
    const evs = S.events.filter((e) => e.document_id === d.id).sort(desc);
    const src = d.source_id && docById(d.source_id);
    const conv = d.converted_id && docById(d.converted_id);
    const views = d.view_count ? `Opened ${plural(d.view_count, 'time')}` : (d.sent_at ? 'Not opened yet' : 'Not sent yet');
    return `
      <div class="rail-box summary">
        <div class="row-sb">${pill(st)}<span class="sub">${views}</span></div>
        <div class="big num">${money(inv ? t.balance : t.total)}</div>
        <div class="sub">${inv ? (t.total > 0 && t.balance <= 0 ? 'Paid in full' : 'Balance due' + (d.due_date ? ' by ' + fmtDate(d.due_date) : '')) : d.type === 'change_order' ? 'Change order total' : 'Estimate total'}</div>
        ${d.viewed_at ? `<p class="sub">First opened ${fmtDate(d.viewed_at)}</p>` : ''}
        ${d.accepted_at ? `<p class="ok">${d.type === 'change_order' ? 'Approved' : 'Accepted'}${d.accepted_by ? ' by ' + esc(d.accepted_by) : ''} on ${fmtDate(d.accepted_at)}</p>` : ''}
        ${d.job_id && jobById(d.job_id) ? `<p class="sub">Job: <a href="#/job/${d.job_id}">${esc(jobById(d.job_id).name)}</a></p>` : ''}
        ${src ? `<p class="sub">${d.type === 'change_order' ? 'Changes to' : 'Created from'} <a href="#/doc/${src.id}">${typeName(src).toLowerCase()} ${esc(src.number)}</a></p>` : ''}
        ${conv ? `<p class="sub">Converted to <a href="#/doc/${conv.id}">invoice ${esc(conv.number)}</a></p>` : ''}
        ${inv && d.sent_at && t.balance > 0 ? '<button class="btn wide" data-act="remind">Send payment reminder</button>' : ''}
      </div>
      ${d.type === 'estimate' && (d.schedule || []).length ? scheduleRail(d) : ''}
      ${d.type === 'change_order' ? contractRail(d) : ''}
      ${d.type === 'estimate' && ['accepted', 'converted'].includes(d.status) && !S.needsUpgrade2 ? '<div class="rail-box"><h3>Extra work?</h3><p class="sub">Add work or credits after the estimate is accepted. The customer approves the change order online.</p><button class="btn wide" data-act="newco">New change order</button></div>' : ''}
      <div class="rail-box">
        <h3>Customer link</h3>
        <p class="sub">Your customer can view${inv ? '' : d.type === 'change_order' ? ' and approve' : ' and accept'} this ${typeName(d).toLowerCase()} online. You're notified when they open it.</p>
        <div class="btn-row"><button class="btn" data-act="copylink">Copy link</button><button class="btn" data-act="openlink">Open as customer</button></div>
      </div>
      ${inv ? `<div class="rail-box">
        <div class="row-sb"><h3>Payments</h3><button class="link" data-act="pay">Record payment</button></div>
        ${pays.length ? `<ul class="pays">${pays.map((p) => `
          <li><div><b class="num">${money(p.amount)}</b><span class="sub">${fmtDate(p.paid_on)}${p.method ? ', ' + esc(p.method) : ''}${p.reference ? ' #' + esc(p.reference) : ''}</span></div>
          <button class="x" data-act="delpay" data-id="${p.id}" aria-label="Remove payment">×</button></li>`).join('')}</ul>` : '<p class="sub">No payments recorded yet.</p>'}
      </div>` : ''}
      <div class="rail-box">
        <h3>Activity</h3>
        ${evs.length ? `<ul class="feed small">${evs.map((e) => `<li class="k-${e.kind}"><span>${esc(eventText(e))}</span><span class="sub">${ago(e.created_at)}</span></li>`).join('')}</ul>` : '<p class="sub">Nothing yet.</p>'}
      </div>`;
  }

  // ---------------- Payment schedules ----------------
  const PRESETS = {
    a: { label: '50% start, 50% completion', list: [
      { name: 'Deposit, due on start day', percent: 50, basis: 'all' },
      { name: 'Balance at completion', percent: 50, basis: 'all' }] },
    b: { label: '50 / 25 / 25', list: [
      { name: 'Deposit, due on start day', percent: 50, basis: 'all' },
      { name: 'After rough-in', percent: 25, basis: 'all' },
      { name: 'At completion', percent: 25, basis: 'all' }] },
    d: { label: '$500 booking deposit, then 50 / 50', list: [
      { name: 'Booking deposit', mode: 'amount', amount: 500, basis: 'all' },
      { name: 'On start day', percent: 50, basis: 'all' },
      { name: 'At completion', percent: 50, basis: 'all' }] },
    c: { label: 'Materials upfront, labor 50 / 25 / 25', list: [
      { name: 'Materials, due before ordering', percent: 100, basis: 'materials' },
      { name: 'Labor deposit, on start day', percent: 50, basis: 'labor' },
      { name: 'After rough-in', percent: 25, basis: 'labor' },
      { name: 'At completion', percent: 25, basis: 'labor' }] }
  };
  const isFixedM = (m) => m.mode === 'amount';
  const valueOf = (m) => (isFixedM(m) ? Number(m.amount) || 0 : Number(m.percent) || 0);
  const modeOptions = (m) => `<option value="percent" ${isFixedM(m) ? '' : 'selected'}>%</option><option value="amount" ${isFixedM(m) ? 'selected' : ''}>$</option>`;
  // Apply an edit to a milestone: field is name, basis, value or mode. Switching mode keeps the typed number.
  function editMilestone(m, field, raw, row) {
    if (field === 'value') { const v = parseFloat(raw) || 0; if (isFixedM(m)) m.amount = v; else m.percent = v; }
    else if (field === 'mode') {
      m.mode = raw;
      const v = parseFloat(row.querySelector('[data-sk="value"], [data-ck="value"]').value) || 0;
      if (raw === 'amount') m.amount = v; else m.percent = v;
    } else m[field] = raw;
  }
  const basisOptions = (sel) => Object.entries(D.BASIS_LABEL).map(([k, l]) => `<option value="${k}" ${k === (sel || 'all') ? 'selected' : ''}>${l}</option>`).join('');

  function schedHTML() {
    const d = E.doc;
    const s = d.schedule || [];
    const co = company(d.company_id) || {};
    if (!s.length) {
      return `<div class="p-h"><span>Payment schedule</span></div>
        <p class="sched-empty">No payment schedule on this estimate. <button type="button" class="link small" data-act="scheddefault">${(co.default_schedule || []).length ? 'Add your company schedule' : 'Add a schedule'}</button></p>`;
    }
    return `
      <div class="p-h"><span>Payment schedule</span><span class="sched-tools"><button type="button" class="link small" data-act="scheddefault">Reset to company schedule</button><button type="button" class="link small" data-act="schedclear">Remove</button></span></div>
      <table class="p-items edit-sched-t">
        <thead><tr><th>Milestone</th><th>Applies to</th><th class="p-num">Percent or $</th><th class="p-num">Amount</th><th><span class="vh">Remove</span></th></tr></thead>
        <tbody>${s.map((m, i) => `
          <tr data-si="${i}">
            <td><input class="ghost" data-sk="name" value="${esc(m.name)}" placeholder="e.g. Deposit, due on start day" aria-label="Milestone name"></td>
            <td><select class="ghost" data-sk="basis" aria-label="Applies to">${basisOptions(m.basis)}</select></td>
            <td class="p-num"><span class="valcell"><input class="ghost r pct" type="number" step="0.01" min="0" data-sk="value" value="${valueOf(m)}" aria-label="Percent or dollar amount"><select class="ghost xs" data-sk="mode" aria-label="Percent or fixed dollar amount">${modeOptions(m)}</select></span></td>
            <td class="p-num" data-samt="${i}"></td>
            <td class="p-num"><button type="button" class="x" data-act="rmsched" data-i="${i}" aria-label="Remove milestone">×</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="sched-foot"><button type="button" class="btn subtle" data-act="addsched">Add milestone</button><span class="sched-warn" id="schedWarn"></span></div>`;
  }
  function redrawSched() { const b = $('#schedBox'); if (b) b.innerHTML = schedHTML(); updateTotals(); }

  const milestoneInv = (estId, i) => S.documents.find((x) => x.type === 'invoice' && x.source_id === estId && Number(x.milestone_index) === i);

  function scheduleRail(d) {
    const rows = D.scheduleAmounts(d);
    return `<div class="rail-box">
      <h3>Payment schedule</h3>
      <ul class="ms">${rows.map((m, i) => {
        const inv = milestoneInv(d.id, i);
        return `<li>
          <div><b>${esc(m.name || 'Payment ' + (i + 1))}</b><span class="sub">${esc(D.shareLabel(m))}, ${money(m.amount)}</span></div>
          ${inv ? `<a class="ms-inv" href="#/doc/${inv.id}">${esc(inv.number)} ${pill(status(inv))}</a>` : `<button class="btn" data-act="msinvoice" data-i="${i}">Create invoice</button>`}
        </li>`;
      }).join('')}</ul>
      ${E.dirty ? '<p class="sub">Save your changes before creating invoices.</p>' : ''}
    </div>`;
  }

  async function milestoneInvoice(est, i) {
    const m = D.scheduleAmounts(est)[i];
    if (!m) return;
    const existing = milestoneInv(est.id, i);
    if (existing) return go('#/doc/' + existing.id);
    if (!(m.amount > 0)) { toast('This payment works out to $0. Check the line items and percentages.', { type: 'error' }); return; }
    const co = company(est.company_id) || {};
    const of = m.basis === 'all' ? 'the total' : D.BASIS_LABEL[m.basis].toLowerCase();
    const taxNote = totals(est).tax ? ', tax included' : '';
    const inv = {
      ...docFields(est), type: 'invoice', status: 'draft', number: predictNumber(co, 'invoice'), issue_date: today(), due_date: today(),
      items: [{ kind: 'Service', description: `${m.name || 'Payment ' + (i + 1)}\n${m.mode === 'amount' ? 'Fixed payment' : `${D.num(m.percent)}% of ${m.afterFixed ? (m.basis === 'all' ? 'the balance after fixed payments' : of + ' after fixed payments') : of}`} for estimate ${est.number}${est.job_title ? ', ' + est.job_title : ''}${m.mode === 'amount' ? '' : taxNote}`, qty: 1, price: m.amount }],
      tax_rate: 0, discount_type: 'percent', discount_value: 0, notes: '', terms: co.default_terms || '', amount_paid: 0, total: m.amount,
      source_id: est.id, milestone_index: i, milestone_name: m.name || '', show_photos: false, schedule: []
    };
    try {
      const saved = await createDoc(inv);
      if (E) E.dirty = false;
      toast(`Invoice ${saved.number} created for ${m.name || 'payment ' + (i + 1)}`);
      go('#/doc/' + saved.id);
    } catch (e) { toast('Could not create the invoice: ' + e.message, { type: 'error', ms: 8000 }); }
  }

  // Company form: default schedule editor
  function companySchedule(c) {
    let sched = clone(c.default_schedule || []);
    const box = $('#coSched');
    const draw = () => {
      box.innerHTML = sched.length ? sched.map((m, i) => `
        <tr data-ci="${i}">
          <td><input data-ck="name" value="${esc(m.name)}" placeholder="e.g. Deposit, due on start day" aria-label="Milestone name"></td>
          <td><select data-ck="basis" aria-label="Applies to">${basisOptions(m.basis)}</select></td>
          <td class="n"><span class="valcell"><input data-ck="value" type="number" step="0.01" min="0" value="${valueOf(m)}" aria-label="Percent or dollar amount" class="pct-in"><select data-ck="mode" aria-label="Percent or fixed dollar amount" class="mode-in">${modeOptions(m)}</select></span></td>
          <td class="n"><button type="button" class="x" data-crm="${i}" aria-label="Remove milestone">×</button></td>
        </tr>`).join('') : '<tr class="none"><td colspan="4">No milestones yet. Pick a quick start or add one.</td></tr>';
      warn();
    };
    const warn = () => { $('#coSchedWarn').textContent = D.scheduleCheck({ schedule: sched, items: [] }, true); };
    const onEdit = (e) => {
      const tr = e.target.closest('tr[data-ci]');
      if (!tr || !e.target.dataset.ck) return;
      const k = e.target.dataset.ck;
      editMilestone(sched[+tr.dataset.ci], k, e.target.value, tr);
      warn();
    };
    box.addEventListener('input', onEdit);
    box.addEventListener('change', onEdit);
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-crm]'); if (b) { sched.splice(+b.dataset.crm, 1); draw(); } });
    $('#coSchedAdd').onclick = () => { sched.push({ name: '', percent: 0, basis: 'all' }); draw(); };
    $$('[data-preset]').forEach((b) => (b.onclick = () => { sched = clone(PRESETS[b.dataset.preset].list); draw(); }));
    draw();
    return () => sched.filter((m) => m.name || valueOf(m));
  }

  // ---------------- Price book ----------------
  const itemsFor = (companyId) => S.items.filter((it) => !it.company_id || it.company_id === companyId);
  const unitText = (it) => (it.unit ? ' / ' + esc(it.unit) : '');

  function vPriceBook(v) {
    if (S.needsUpgrade) {
      v.innerHTML = '<div class="head"><h1>Price book</h1></div><p class="lead">Run <b>upgrade-1.sql</b> in Supabase (SQL Editor) to turn on the price book.</p>';
      return;
    }
    v.innerHTML = `
      <div class="head">
        <div><h1>Price book</h1><p class="lead">Save the work and materials you price often. In any estimate or invoice, start typing in a description to pull them in.</p></div>
        <button class="btn primary" id="addItem">Add item</button>
      </div>
      <div class="filters">
        <input type="search" id="pq" placeholder="Search the price book" aria-label="Search">
        <select id="pk" aria-label="Type"><option value="">All types</option>${KINDS.map((k) => `<option>${k}</option>`).join('')}</select>
      </div>
      <div class="tbl-wrap"><table class="tbl" id="ptbl"></table></div>`;
    const multi = S.companies.length > 1;
    const draw = () => {
      const q = $('#pq').value.trim().toLowerCase(), k = $('#pk').value;
      const list = S.items.filter((it) => (!k || it.kind === k) && (!q || [it.name, it.description].join(' ').toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));
      $('#ptbl').innerHTML = `
        <thead><tr><th>Item</th><th>Type</th>${multi ? '<th>Company</th>' : ''}<th class="n">Rate</th></tr></thead>
        <tbody>${list.map((it) => `
          <tr data-id="${it.id}">
            <td><b>${esc(it.name)}</b>${it.description ? `<div class="sub clamp">${esc(it.description)}</div>` : ''}</td>
            <td>${esc(it.kind || '')}</td>
            ${multi ? `<td class="sub">${it.company_id ? esc((company(it.company_id) || {}).name || '') : 'All companies'}</td>` : ''}
            <td class="n num">${money(it.price)}${unitText(it)}</td>
          </tr>`).join('') || `<tr class="none"><td colspan="4">${S.items.length ? 'No items match your search.' : 'Your price book is empty. Add your first item, for example "Tiled shower niche".'}</td></tr>`}</tbody>`;
    };
    $('#pq').oninput = draw;
    $('#pk').onchange = draw;
    $('#addItem').onclick = () => itemModal(null, null, draw);
    $('#ptbl').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) itemModal(S.items.find((x) => x.id === tr.dataset.id), null, draw); };
    draw();
  }

  function itemModal(item, prefill, onDone) {
    if (S.needsUpgrade) { toast('Run upgrade-1.sql in Supabase first to use the price book.', { type: 'error' }); return; }
    const x = item || prefill || { name: '', kind: 'Labor', unit: '', price: 0, description: '', company_id: null };
    modal(`
      <h2>${item ? 'Edit price book item' : 'Add to price book'}</h2>
      <label>Name<input id="iName" value="${esc(x.name)}" placeholder="e.g. Tiled shower niche"></label>
      <div class="grid3">
        <label>Type<select id="iKind">${KINDS.map((k) => `<option ${k === x.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label>Rate<input id="iPrice" type="number" step="0.01" min="0" value="${Number(x.price) || 0}"></label>
        <label>Unit<input id="iUnit" list="unitList" value="${esc(x.unit || '')}" placeholder="each, hour, sq ft"></label>
      </div>
      <label>Description<span class="hint">Shown under the name on the estimate or invoice. Leave empty to show the name only.</span><textarea id="iDesc" rows="4">${esc(x.description || '')}</textarea></label>
      ${S.companies.length > 1 ? `<label>Available for<select id="iCo"><option value="">All companies</option>${S.companies.map((c) => `<option value="${c.id}" ${c.id === x.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      <div class="m-actions">
        ${item ? '<button class="btn danger" id="iDel">Delete</button><span class="grow"></span>' : ''}
        <button class="btn" data-close>Cancel</button><button class="btn primary" id="iSave">${item ? 'Save changes' : 'Save item'}</button>
      </div>`, (w, close) => {
      $('#iSave', w).onclick = async () => {
        const name = $('#iName', w).value.trim();
        if (!name) { toast('Enter a name for the item.', { type: 'error' }); return; }
        const obj = { name, kind: $('#iKind', w).value, price: D.round2(parseFloat($('#iPrice', w).value) || 0), unit: $('#iUnit', w).value.trim(),
          description: $('#iDesc', w).value.trim(), company_id: $('#iCo', w) ? ($('#iCo', w).value || null) : null };
        if (item) obj.id = item.id;
        try {
          const saved = await Store.upsert('items', obj);
          upsertLocal(S.items, saved);
          close();
          toast(item ? `${saved.name} updated` : `${saved.name} saved to your price book`);
          if (onDone) onDone();
        } catch (e) { toast('Could not save: ' + e.message, { type: 'error' }); }
      };
      if (item) {
        $('#iDel', w).onclick = async () => {
          if (!confirm(`Delete "${item.name}" from your price book? Estimates and invoices that already use it are not changed.`)) return;
          await Store.remove('items', item.id);
          S.items = S.items.filter((y) => y.id !== item.id);
          close(); toast('Item deleted');
          if (onDone) onDone();
        };
      }
    });
  }

  function lineFromItem(item) {
    return { kind: item.kind || 'Service', description: item.name + (item.description ? '\n' + item.description : ''), qty: 1, price: Number(item.price) || 0, unit: item.unit || '' };
  }
  function redrawLines() { $('#itemRows').innerHTML = itemRows(); autosizeAll(); updateTotals(); }

  function pickItemsModal() {
    const pool = itemsFor(E.doc.company_id).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!pool.length) { itemModal(null); return; }
    modal(`
      <h2>Add from price book</h2>
      <input type="search" id="pkQ" placeholder="Search" aria-label="Search the price book">
      <div class="pick-list" id="pkList"></div>
      <div class="m-actions"><span class="sub grow" id="pkCount">Nothing selected</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="pkGo">Add to ${typeName(E.doc).toLowerCase()}</button></div>`, (w, close) => {
      const sel = new Set();
      const draw = () => {
        const q = $('#pkQ', w).value.trim().toLowerCase();
        $('#pkList', w).innerHTML = pool.filter((it) => !q || [it.name, it.description].join(' ').toLowerCase().includes(q)).map((it) => `
          <label class="pick"><input type="checkbox" value="${it.id}" ${sel.has(it.id) ? 'checked' : ''}>
            <span class="who"><b>${esc(it.name)}</b>${it.description ? `<span class="sub clamp">${esc(it.description)}</span>` : ''}</span>
            <span class="num">${money(it.price)}${unitText(it)}</span></label>`).join('') || '<p class="sub">No items match.</p>';
      };
      $('#pkQ', w).oninput = draw;
      $('#pkList', w).onchange = (e) => {
        if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value);
        $('#pkCount', w).textContent = sel.size ? plural(sel.size, 'item') + ' selected' : 'Nothing selected';
      };
      $('#pkGo', w).onclick = () => {
        if (!sel.size) { toast('Tick the items you want to add.', { type: 'error' }); return; }
        const lines = E.doc.items;
        if (lines.length === 1 && !String(lines[0].description || '').trim() && !(Number(lines[0].price) > 0)) lines.pop();
        pool.filter((it) => sel.has(it.id)).forEach((it) => lines.push(lineFromItem(it)));
        markDirty(); redrawLines(); close();
        toast(`${plural(sel.size, 'item')} added`);
      };
      draw();
    }, 'pick-modal');
  }

  // Suggestions while typing a description
  let sug = null;
  function closeSuggest() { if (sug) { sug.box.remove(); sug = null; } }
  function showSuggest(el) {
    const q = el.value.trim().toLowerCase();
    if (!q || q.length < 2 || el.value.includes('\n') || q.length > 60) return closeSuggest();
    const words = q.split(/\s+/);
    const list = itemsFor(E.doc.company_id)
      .filter((it) => { const hay = (it.name + ' ' + (it.description || '')).toLowerCase(); return words.every((w) => hay.includes(w)); })
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
    closeSuggest();
    if (!list.length) return;
    const box = document.createElement('div');
    box.className = 'suggest';
    box.setAttribute('role', 'listbox');
    box.innerHTML = '<div class="sg-head">From your price book</div>' + list.map((it, i) => `
      <button type="button" role="option" data-sg="${i}" class="${i === 0 ? 'on' : ''}">
        <span class="who"><b>${esc(it.name)}</b>${it.description ? `<span class="sub">${esc(it.description.split('\n')[0])}</span>` : ''}</span>
        <span class="num">${money(it.price)}${unitText(it)}</span>
      </button>`).join('');
    document.body.appendChild(box);
    const r = el.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 340) - 8)) + 'px';
    box.style.width = Math.min(Math.max(r.width, 340), innerWidth - 16) + 'px';
    box.style.top = (r.bottom + 4) + 'px';
    if (r.bottom + 4 + box.offsetHeight > innerHeight - 8) box.style.top = Math.max(8, r.top - box.offsetHeight - 4) + 'px';
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-sg]');
      if (b) applyItem(el, list[+b.dataset.sg]);
    });
    sug = { el, list, idx: 0, box };
  }
  function suggestKey(e) {
    const btns = $$('[data-sg]', sug.box);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sug.idx = (sug.idx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('on', i === sug.idx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      applyItem(sug.el, sug.list[sug.idx]);
    } else if (e.key === 'Escape' || e.key === 'Tab') closeSuggest();
  }
  function applyItem(el, item) {
    const tr = el.closest('tr[data-i]');
    const line = E.doc.items[+tr.dataset.i];
    const qty = Number(line.qty) > 0 ? line.qty : 1;
    Object.assign(line, lineFromItem(item), { qty });
    closeSuggest(); markDirty(); redrawLines();
  }

  // ---------------- Photos ----------------
  const photosFor = (docId) => S.photos.filter((p) => p.document_id === docId).sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.created_at).localeCompare(String(b.created_at)));

  function photosHTML() {
    const d = E.doc;
    if (S.needsUpgrade) return '<h3>Photos</h3><p class="sub">Run upgrade-1.sql in Supabase to turn on photos.</p>';
    const ph = d.id ? photosFor(d.id) : [];
    return `
      <div class="ph-head">
        <div><h3>Photos</h3><p class="sub">${ph.length ? plural(ph.length, 'photo') : 'Add photos of the job site or the scope of work. On a phone, you can use the camera.'}</p></div>
        <div class="btn-row">
          <label class="btn">Add photos<input type="file" id="phIn" accept="image/*" multiple class="vh"></label>
          <label class="btn cam">Take photo<input type="file" id="phCam" accept="image/*" capture="environment" class="vh"></label>
          ${ph.length ? '<button type="button" class="btn" data-act="phzip">Download all</button>' : ''}
        </div>
      </div>
      ${ph.length ? `<label class="check small"><input type="checkbox" data-f="show_photos" ${d.show_photos !== false ? 'checked' : ''}> Show photos to the customer, on their page and in the PDF</label>` : ''}
      <p class="sub" id="phStatus" aria-live="polite"></p>
      <div class="ph-grid">${ph.map((p, i) => `
        <figure>
          <a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(p.caption || 'Photo ' + (i + 1))}" loading="lazy"></a>
          <input class="ghost cap" data-pc="${p.id}" value="${esc(p.caption || '')}" placeholder="Add a caption" aria-label="Caption for photo ${i + 1}">
          <div class="ph-act"><button type="button" class="link small" data-act="phdl" data-id="${p.id}">Download</button><button type="button" class="link small danger" data-act="phdel" data-id="${p.id}">Delete</button></div>
        </figure>`).join('')}</div>`;
  }
  function refreshPhotos() { const b = $('#photoBox'); if (b) b.innerHTML = photosHTML(); }

  function resizeImage(file, max, q) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res({ blob: b, width: w, height: h }) : rej(new Error('The photo could not be processed.'))), 'image/jpeg', q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`${file.name} could not be opened. Try a JPEG or PNG photo.`)); };
      img.src = url;
    });
  }

  async function uploadPhotos(files) {
    if (!files.length) return;
    if (!(await ensureSaved())) return;
    const docId = E.doc.id;
    let pos = photosFor(docId).reduce((m, p) => Math.max(m, (p.position || 0) + 1), 0);
    let ok = 0, lastErr = '';
    const status = (t) => { const s = $('#phStatus'); if (s) s.textContent = t; };
    for (let n = 0; n < files.length; n++) {
      status(`Uploading ${n + 1} of ${files.length}`);
      try {
        const demo = S.mode === 'demo';
        const { blob, width, height } = await resizeImage(files[n], demo ? 1000 : 1800, demo ? 0.72 : 0.82);
        const { path, url } = await Store.uploadPhoto(docId, blob);
        const row = await Store.upsert('photos', { document_id: docId, path, url, caption: '', position: pos++, width, height });
        S.photos.push(row);
      } catch (e) { console.error(e); lastErr = e.message; continue; }
      ok++;
    }
    if (E && E.doc.id === docId) refreshPhotos();
    if (ok) toast(`${plural(ok, 'photo')} added`);
    if (lastErr) toast(`${plural(files.length - ok, 'photo')} could not be added: ${lastErr}`, { type: 'error', ms: 9000 });
  }

  async function savePhotoCaption(id, caption) {
    try {
      const saved = await Store.upsert('photos', { id, caption: caption.trim() });
      upsertLocal(S.photos, saved);
    } catch (e) { toast('Could not save the caption: ' + e.message, { type: 'error' }); }
  }

  async function deletePhoto(id) {
    const p = S.photos.find((x) => x.id === id);
    if (!p || !confirm('Delete this photo? This can\'t be undone.')) return;
    try {
      await Store.removePhotoFile(p.path);
      await Store.remove('photos', id);
      S.photos = S.photos.filter((x) => x.id !== id);
      refreshPhotos();
      toast('Photo deleted');
    } catch (e) { toast('Could not delete the photo: ' + e.message, { type: 'error' }); }
  }

  async function fetchBlob(url) { const r = await fetch(url); if (!r.ok) throw new Error('The photo could not be downloaded.'); return r.blob(); }
  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }
  async function downloadPhoto(id) {
    const list = photosFor(E.doc.id);
    const i = list.findIndex((p) => p.id === id);
    try { saveBlob(await fetchBlob(list[i].url), `${fileName(E.doc)} photo ${i + 1}.jpg`); }
    catch (e) { toast(e.message, { type: 'error' }); }
  }
  async function downloadAllPhotos() {
    const list = photosFor(E.doc.id);
    if (!list.length) return;
    toast(`Preparing ${plural(list.length, 'photo')}`, { ms: 2000 });
    try {
      if (!window.JSZip) {
        for (let i = 0; i < list.length; i++) saveBlob(await fetchBlob(list[i].url), `${fileName(E.doc)} photo ${i + 1}.jpg`);
        return;
      }
      const zip = new window.JSZip();
      for (let i = 0; i < list.length; i++) {
        const cap = (list[i].caption || '').replace(/[\\/:*?"<>|]+/g, '').slice(0, 40).trim();
        zip.file(`${String(i + 1).padStart(2, '0')}${cap ? ' ' + cap : ''}.jpg`, await fetchBlob(list[i].url));
      }
      saveBlob(await zip.generateAsync({ type: 'blob' }), `${fileName(E.doc)} photos.zip`);
    } catch (e) { toast('Could not download the photos: ' + e.message, { type: 'error' }); }
  }

  // ---------------- Jobs ----------------
  const jobById = (id) => id && S.jobs.find((j) => j.id === id);
  const jobDocs = (jobId) => S.documents.filter((d) => d.job_id === jobId && !d.archived);
  const lastGroup = () => { const g = E.doc.items.filter((x) => x.option === 'choice').map((x) => x.group).filter(Boolean); return g[g.length - 1]; };

  function jobOptions(d) {
    const mine = S.jobs.filter((j) => j.company_id === d.company_id && (!d.customer_id || !j.customer_id || j.customer_id === d.customer_id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const cur = jobById(d.job_id);
    if (cur && !mine.includes(cur)) mine.unshift(cur);
    return `<option value="">${d.id && !cur ? 'No job' : 'New job'}</option>` + mine.map((j) => `<option value="${j.id}" ${j.id === d.job_id ? 'selected' : ''}>${esc(j.name)}</option>`).join('');
  }

  // Money picture of a job: contract = accepted estimate(s) + approved change orders.
  function jobMoney(jobId) {
    const docs = jobDocs(jobId);
    const accepted = (d) => ['accepted', 'converted'].includes(d.status);
    const est = docs.filter((d) => d.type === 'estimate');
    const base = est.filter(accepted).reduce((s, d) => s + totals(d).total, 0);
    const quoted = est.filter((d) => !accepted(d) && d.status !== 'declined').reduce((s, d) => s + totals(d).total, 0);
    const cos = docs.filter((d) => d.type === 'change_order' && accepted(d)).reduce((s, d) => s + totals(d).total, 0);
    const invs = docs.filter((d) => d.type === 'invoice' && d.status !== 'draft');
    const invoiced = invs.reduce((s, d) => s + totals(d).total, 0);
    const paid = docs.filter((d) => d.type === 'invoice').reduce((s, d) => s + totals(d).paid, 0);
    // Jobs billed without an estimate: the invoices are the contract.
    const contract = D.round2(base || cos ? base + cos : invoiced);
    return { base, quoted, cos: D.round2(cos), contract, invoiced: D.round2(invoiced), paid: D.round2(paid), owed: D.round2(invoiced - paid), toInvoice: D.round2(contract - invoiced) };
  }

  // Snapshot shown on a change order: the original estimate and earlier approved changes.
  function contractFor(co) {
    const src = docById(co.source_id) || S.documents.find((d) => d.job_id === co.job_id && d.type === 'estimate' && ['accepted', 'converted'].includes(d.status));
    const prior = S.documents.filter((d) => d.type === 'change_order' && d.id !== co.id && d.job_id && d.job_id === co.job_id && ['accepted', 'converted'].includes(d.status)
      && (!co.created_at || String(d.created_at) < String(co.created_at)));
    return { original: src ? totals(src).total : 0, prior: D.round2(prior.reduce((s, d) => s + totals(d).total, 0)), ref: src ? src.number : '' };
  }
  function contractRail(d) {
    const c = d.contract || contractFor(d);
    const t = totals(d).total;
    return `<div class="rail-box"><h3>Contract</h3>
      <div class="kv"><span>Original${c.ref ? ' (' + esc(c.ref) + ')' : ''}</span><b class="num">${money(c.original)}</b></div>
      ${c.prior ? `<div class="kv"><span>Previous change orders</span><b class="num">${money(c.prior)}</b></div>` : ''}
      <div class="kv"><span>This change order</span><b class="num">${money(t)}</b></div>
      <div class="kv total"><span>New contract total</span><b class="num">${money(D.round2(c.original + c.prior + t))}</b></div>
      <p class="sub">Updated each time you save.</p></div>`;
  }

  function startChangeOrder(est) {
    if (S.needsUpgrade2) { toast('Run upgrade-2.sql in Supabase first to use change orders.', { type: 'error' }); return; }
    if (E) E.dirty = false;
    S.pendingSource = est.id;
    go('#/new/change_order');
  }
  function pickEstimateForCO() {
    if (S.needsUpgrade2) { toast('Run upgrade-2.sql in Supabase first to use change orders.', { type: 'error' }); return; }
    const list = S.documents.filter((d) => d.type === 'estimate' && !d.archived && inScope(d))
      .sort((a, b) => (['accepted', 'converted'].includes(b.status) - ['accepted', 'converted'].includes(a.status)) || String(b.issue_date).localeCompare(String(a.issue_date)));
    if (!list.length) { toast('Create an estimate first. Change orders add to an existing estimate.', { type: 'error' }); return; }
    modal(`<h2>New change order</h2><p class="sub">Which estimate does this change?</p>
      <div class="pick-list">${list.map((d) => `<button type="button" class="pick" data-est="${d.id}"><span class="who"><b>${esc(d.number)} ${esc(d.customer_name)}</b><span class="sub">${esc(d.job_title || '')}</span></span>${pill(status(d))}</button>`).join('')}</div>
      <div class="m-actions"><button class="btn" data-close>Cancel</button></div>`, (w, close) => {
      $$('[data-est]', w).forEach((b) => (b.onclick = () => { close(); startChangeOrder(docById(b.dataset.est)); }));
    }, 'pick-modal');
  }

  function vJobs(v) {
    if (S.needsUpgrade2) { v.innerHTML = '<div class="head"><h1>Jobs</h1></div><p class="lead">Run <b>upgrade-2.sql</b> in Supabase (SQL Editor) to turn on jobs and change orders.</p>'; return; }
    const st = S.list.jobs || (S.list.jobs = { status: 'open', q: '' });
    const loose = S.documents.filter((d) => !d.job_id && !d.archived).length;
    v.innerHTML = `
      <div class="head">
        <div><h1>Jobs</h1><p class="lead">Each job keeps its estimate, change orders, invoices, payments and photos together.</p></div>
        <div class="head-actions"><a class="btn" href="#/new/estimate">New estimate</a></div>
      </div>
      ${loose ? `<div class="note-box"><span>${plural(loose, 'document')} ${loose === 1 ? 'isn\'t' : 'aren\'t'} part of a job yet, from before jobs existed.</span><button class="btn" id="organize">Group them into jobs</button></div>` : ''}
      <div class="filters">
        <input type="search" id="jq" placeholder="Search jobs or customers" value="${esc(st.q)}" aria-label="Search jobs">
        <select id="js" aria-label="Status"><option value="open" ${st.status === 'open' ? 'selected' : ''}>Open jobs</option><option value="" ${!st.status ? 'selected' : ''}>All jobs</option>${Object.entries(JOB_STATUS).map(([k, l]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="tbl-wrap"><table class="tbl" id="jtbl"></table></div>`;
    const draw = () => {
      let list = S.jobs.filter((j) => S.filter === 'all' || j.company_id === S.filter);
      if (st.status === 'open') list = list.filter((j) => j.status !== 'completed');
      else if (st.status) list = list.filter((j) => j.status === st.status);
      const custName = (j) => { const c = S.customers.find((x) => x.id === j.customer_id); const d = jobDocs(j.id)[0]; return (c && c.name) || (d && d.customer_name) || ''; };
      if (st.q) { const q = st.q.toLowerCase(); list = list.filter((j) => (j.name + ' ' + custName(j)).toLowerCase().includes(q)); }
      list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      $('#jtbl').innerHTML = `
        <thead><tr><th>Job</th><th>Status</th><th class="n">Contract</th><th class="n">Invoiced</th><th class="n">Paid</th><th class="n">Owed now</th></tr></thead>
        <tbody>${list.map((j) => { const m = jobMoney(j.id); return `
          <tr data-id="${j.id}">
            <td><b>${esc(j.name)}</b><div class="sub">${esc(custName(j))}</div></td>
            <td><span class="pill job-${j.status}">${JOB_STATUS[j.status] || esc(j.status)}</span></td>
            <td class="n num">${m.contract ? money(m.contract) : m.quoted ? `<span class="sub">${money(m.quoted)} quoted</span>` : '–'}</td>
            <td class="n num">${m.invoiced ? money(m.invoiced) : '–'}</td>
            <td class="n num">${m.paid ? money(m.paid) : '–'}</td>
            <td class="n num">${m.owed > 0 ? money(m.owed) : '–'}</td>
          </tr>`; }).join('') || `<tr class="none"><td colspan="6">${S.jobs.length ? 'No jobs match.' : 'No jobs yet. A job is created automatically when you save a new estimate or invoice.'}</td></tr>`}</tbody>`;
    };
    $('#jq').oninput = (e) => { st.q = e.target.value; draw(); };
    $('#js').onchange = (e) => { st.status = e.target.value; draw(); };
    $('#jtbl').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) go('#/job/' + tr.dataset.id); };
    if ($('#organize')) $('#organize').onclick = (e) => organizeJobs(e.currentTarget);
    draw();
  }

  // One-time: put documents created before jobs existed into jobs (an estimate and everything made from it).
  async function organizeJobs(btn) {
    btn.disabled = true;
    try {
      const loose = S.documents.filter((d) => !d.job_id);
      const root = (d) => { let x = d; const seen = new Set(); while (x.source_id && docById(x.source_id) && !seen.has(x.id)) { seen.add(x.id); x = docById(x.source_id); } return x; };
      const groups = new Map();
      loose.forEach((d) => { const r = root(d); if (!groups.has(r.id)) groups.set(r.id, { r, docs: [] }); groups.get(r.id).docs.push(d); });
      let made = 0;
      for (const { r, docs } of groups.values()) {
        const jobId = r.job_id || (await (async () => {
          const paid = docs.some((d) => d.type === 'invoice') && docs.filter((d) => d.type === 'invoice').every((d) => status(d) === 'paid');
          const j = await Store.upsert('jobs', { company_id: r.company_id, customer_id: r.customer_id || null, name: r.job_title || `${r.customer_name} project`, address: r.job_site || r.customer_address || '',
            status: paid ? 'completed' : (r.type === 'invoice' || ['accepted', 'converted'].includes(r.status)) ? 'active' : 'estimating', notes: '' });
          upsertLocal(S.jobs, j); made++; return j.id;
        })());
        for (const d of docs) { const saved = await Store.upsert('documents', { id: d.id, job_id: jobId }); upsertLocal(S.documents, saved); }
      }
      toast(`${plural(made, 'job')} created`);
      route();
    } catch (e) { toast('Could not group the documents: ' + e.message, { type: 'error' }); btn.disabled = false; }
  }

  function vJob(v, id) {
    const j = jobById(id);
    if (!j) { v.innerHTML = '<p class="empty">This job was deleted or doesn\'t exist. <a href="#/jobs">See all jobs</a></p>'; return; }
    const docs = jobDocs(j.id).sort((a, b) => String(a.issue_date).localeCompare(String(b.issue_date)) || String(a.created_at).localeCompare(String(b.created_at)));
    const m = jobMoney(j.id);
    const cust = S.customers.find((c) => c.id === j.customer_id) || {};
    const anyDoc = docs[0] || {};
    const pays = S.payments.filter((p) => docs.some((d) => d.id === p.document_id)).sort((a, b) => String(b.paid_on).localeCompare(String(a.paid_on)));
    const evs = S.events.filter((e) => docs.some((d) => d.id === e.document_id)).sort(desc).slice(0, 12);
    const photos = docs.flatMap((d) => photosFor(d.id).map((p) => ({ ...p, doc: d })));
    const hasEstimate = docs.some((d) => d.type === 'estimate' && ['accepted', 'converted'].includes(d.status));
    const sec = (title, inner, extra = '') => `<section class="job-sec"><div class="row-sb"><h2>${title}</h2>${extra}</div>${inner}</section>`;
    v.innerHTML = `
      <div class="head">
        <div><a class="back" href="#/jobs">Jobs</a>
          <input class="job-name" id="jName" value="${esc(j.name)}" aria-label="Job name">
          <p class="sub">${esc(cust.name || anyDoc.customer_name || '')}${j.address ? ', ' + esc(j.address.split('\n').join(', ')) : ''}</p></div>
        <div class="head-actions">
          <select id="jStatus" class="status-sel" aria-label="Job status">${Object.entries(JOB_STATUS).map(([k, l]) => `<option value="${k}" ${j.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn" id="jNew">New for this job</button>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="l">Contract</div><div class="v">${money(m.contract)}</div><div class="sub">${m.cos ? `includes ${money(m.cos)} in change orders` : m.quoted ? `${money(m.quoted)} quoted, not accepted yet` : 'from accepted estimates'}</div></div>
        <div class="metric"><div class="l">Invoiced</div><div class="v">${money(m.invoiced)}</div><div class="sub">${m.toInvoice > 0 ? `${money(m.toInvoice)} left to invoice` : 'fully invoiced'}</div></div>
        <div class="metric"><div class="l">Paid</div><div class="v">${money(m.paid)}</div><div class="sub">${plural(pays.length, 'payment')}</div></div>
        <div class="metric ${m.owed > 0 ? 'warn-soft' : ''}"><div class="l">Owed now</div><div class="v">${money(Math.max(m.owed, 0))}</div><div class="sub">on sent invoices</div></div>
      </div>
      <div class="job-grid">
        <div>
          ${sec('Documents', docs.length ? `<table class="tbl" id="jdocs"><thead><tr><th>Document</th><th>Date</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>${docs.map((d) => `
            <tr data-id="${d.id}"><td><b>${typeName(d)} ${esc(d.number)}</b>${d.milestone_name ? `<div class="sub">${esc(d.milestone_name)}</div>` : d.type === 'change_order' && d.notes ? `<div class="sub clamp">${esc(d.notes)}</div>` : ''}</td>
            <td>${fmtDate(d.issue_date)}</td><td class="n num">${money(d.type === 'invoice' ? totals(d).total : totals(d).total)}</td><td>${pill(status(d))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No documents yet.</p>')}
          ${sec('Photos', photos.length ? `<div class="ph-grid">${photos.map((p) => `<figure><a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(p.caption || 'Job photo')}" loading="lazy"></a><figcaption class="sub">${esc(p.caption || '')}${p.caption ? ', ' : ''}${esc(p.doc.number)}</figcaption></figure>`).join('')}</div>` : '<p class="sub">Photos added to this job\'s estimates, change orders and invoices show up here.</p>',
            photos.length ? '<button class="btn" id="jZip">Download all photos</button>' : '')}
        </div>
        <div>
          ${sec('Notes', `<textarea id="jNotes" class="job-notes" rows="5" placeholder="Private notes: gate code, selections, permit number…">${esc(j.notes || '')}</textarea><p class="sub" id="jSaved"></p>`)}
          ${sec('Payments', pays.length ? `<ul class="pays">${pays.map((p) => { const d = docById(p.document_id); return `<li><div><b class="num">${money(p.amount)}</b><span class="sub">${fmtDate(p.paid_on)}${p.method ? ', ' + esc(p.method) : ''}, ${esc(d ? d.number : '')}</span></div></li>`; }).join('')}</ul>` : '<p class="sub">No payments yet.</p>')}
          ${sec('Activity', evs.length ? `<ul class="feed small">${evs.map((e) => `<li class="k-${e.kind}"><a href="#/doc/${e.document_id}">${esc(eventText(e))}</a><span class="sub">${ago(e.created_at)}</span></li>`).join('')}</ul>` : '<p class="sub">Nothing yet.</p>')}
          <button class="btn danger" id="jDel">Delete job</button>
        </div>
      </div>`;

    const save = async (patch) => { const saved = await Store.upsert('jobs', { id: j.id, ...patch }); upsertLocal(S.jobs, saved); Object.assign(j, saved); };
    $('#jName').onchange = async (e) => { const name = e.target.value.trim(); if (!name) { e.target.value = j.name; return; } await save({ name }); toast('Job renamed'); };
    $('#jStatus').onchange = async (e) => { await save({ status: e.target.value }); toast(`Job marked ${JOB_STATUS[e.target.value].toLowerCase()}`); };
    $('#jNotes').onchange = async (e) => { await save({ notes: e.target.value }); $('#jSaved').textContent = 'Notes saved'; };
    if ($('#jdocs')) $('#jdocs').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) go('#/doc/' + tr.dataset.id); };
    $('#jNew').onclick = (e) => {
      e.stopPropagation();
      const est = docs.filter((d) => d.type === 'estimate').pop();
      const accepted = docs.filter((d) => d.type === 'estimate' && ['accepted', 'converted'].includes(d.status)).pop();
      openMenu(e.currentTarget, [
        { label: 'New estimate', run: () => { S.pendingJob = j.id; go('#/new/estimate'); } },
        hasEstimate || est ? { label: 'New change order', run: () => startChangeOrder(accepted || est) } : null,
        { label: 'New invoice', run: () => { S.pendingJob = j.id; go('#/new/invoice'); } }
      ]);
    };
    if ($('#jZip')) $('#jZip').onclick = async () => {
      if (!window.JSZip) { toast('The zip library did not load. Refresh and try again.', { type: 'error' }); return; }
      toast(`Preparing ${plural(photos.length, 'photo')}`, { ms: 2000 });
      try {
        const zip = new window.JSZip();
        for (let i = 0; i < photos.length; i++) zip.file(`${safeName(photos[i].doc.number)}/${String(i + 1).padStart(2, '0')}${photos[i].caption ? ' ' + safeName(photos[i].caption) : ''}.jpg`, await fetchBlob(photos[i].url));
        saveBlob(await zip.generateAsync({ type: 'blob' }), `${safeName(j.name)} photos.zip`);
      } catch (err) { toast('Could not download the photos: ' + err.message, { type: 'error' }); }
    };
    $('#jDel').onclick = async () => {
      if (!confirm(`Delete the job "${j.name}"? Its estimates, change orders and invoices are kept; they just won't be grouped anymore.`)) return;
      await Store.remove('jobs', j.id);
      S.jobs = S.jobs.filter((x) => x.id !== j.id);
      S.documents.forEach((d) => { if (d.job_id === j.id) d.job_id = null; });
      toast('Job deleted'); go('#/jobs');
    };
  }

  // ---------------- Customers ----------------
  function vCustomers(v) {
    v.innerHTML = `
      <div class="head"><h1>Customers</h1><button class="btn primary" id="addCust">Add customer</button></div>
      <div class="filters"><input type="search" id="cq" placeholder="Search customers" aria-label="Search customers"></div>
      <div class="tbl-wrap"><table class="tbl" id="ctbl"></table></div>`;
    const draw = (q) => {
      const list = S.customers.filter((c) => !q || [c.name, c.email, c.phone].join(' ').toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
      $('#ctbl').innerHTML = `
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="n">Documents</th><th class="n">Balance owed</th></tr></thead>
        <tbody>${list.map((c) => {
          const docs = S.documents.filter((d) => d.customer_id === c.id && !d.archived);
          const owed = docs.filter((d) => d.type === 'invoice' && status(d) !== 'draft').reduce((s, d) => s + Math.max(totals(d).balance, 0), 0);
          return `<tr data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.address ? `<div class="sub">${esc(c.address.split('\n')[0])}</div>` : ''}</td>
            <td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td><td class="n num">${docs.length}</td><td class="n num">${owed ? money(owed) : '–'}</td></tr>`;
        }).join('') || `<tr class="none"><td colspan="5">${S.customers.length ? 'No customers match your search.' : 'No customers yet. Customers are saved here when you create an estimate or invoice, or you can add one now.'}</td></tr>`}</tbody>`;
    };
    draw('');
    $('#cq').oninput = (e) => draw(e.target.value.toLowerCase());
    $('#addCust').onclick = () => customerModal(null);
    $('#ctbl').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) customerModal(S.customers.find((c) => c.id === tr.dataset.id)); };
  }

  function customerModal(c) {
    const x = c || { name: '', email: '', phone: '', address: '', notes: '' };
    modal(`
      <h2>${c ? esc(c.name) : 'Add customer'}</h2>
      <label>Name<input id="cName" value="${esc(x.name)}" placeholder="Person or company name"></label>
      <div class="grid2"><label>Phone<input id="cPhone" type="tel" value="${esc(x.phone)}"></label><label>Email<input id="cEmail" type="email" value="${esc(x.email)}"></label></div>
      <label>Address<textarea id="cAddr" rows="3">${esc(x.address)}</textarea></label>
      <label>Private notes<textarea id="cNotes" rows="2" placeholder="Only you see these">${esc(x.notes)}</textarea></label>
      <div class="m-actions">
        ${c ? '<button class="btn danger" id="cDel">Delete</button><span class="grow"></span><button class="btn" id="cEst">New estimate</button><button class="btn" id="cInv">New invoice</button>' : '<button class="btn" data-close>Cancel</button>'}
        <button class="btn primary" id="cSave">Save customer</button>
      </div>`, (w, close) => {
      const save = async () => {
        const name = $('#cName', w).value.trim();
        if (!name) { toast('Enter the customer name.', { type: 'error' }); return null; }
        const obj = { name, phone: $('#cPhone', w).value.trim(), email: $('#cEmail', w).value.trim(), address: $('#cAddr', w).value.trim(), notes: $('#cNotes', w).value.trim() };
        if (c) obj.id = c.id;
        try {
          const saved = await Store.upsert('customers', obj);
          upsertLocal(S.customers, saved);
          return saved;
        } catch (e) { toast('Could not save: ' + e.message, { type: 'error' }); return null; }
      };
      $('#cSave', w).onclick = async () => { if (await save()) { close(); toast('Customer saved'); route(); } };
      if (c) {
        const start = async (type) => { const s = await save(); if (!s) return; close(); S.pendingCustomer = s.id; go('#/new/' + type); };
        $('#cEst', w).onclick = () => start('estimate');
        $('#cInv', w).onclick = () => start('invoice');
        $('#cDel', w).onclick = async () => {
          if (!confirm(`Delete ${c.name}? Their existing estimates and invoices are kept.`)) return;
          await Store.remove('customers', c.id);
          S.customers = S.customers.filter((y) => y.id !== c.id);
          S.documents.forEach((d) => { if (d.customer_id === c.id) d.customer_id = null; });
          close(); toast('Customer deleted'); route();
        };
      }
    });
  }

  // ---------------- Companies ----------------
  function vCompanies(v) {
    v.innerHTML = `
      <div class="head"><h1>Companies</h1><a class="btn primary" href="#/company/new">Add company</a></div>
      <p class="lead">Each company has its own logo, contact details, numbering and defaults. You pick the company when you create an estimate or invoice.</p>
      <div class="co-list">${S.companies.map((c) => `
        <a class="co-row" href="#/company/${c.id}">
          <span class="co-logo" style="--brand:${esc(c.color || '#1F4E46')}">${c.logo ? `<img src="${c.logo}" alt="">` : esc((c.name || '?')[0])}</span>
          <span class="who"><b>${esc(c.name)}</b><span class="sub">${esc((c.address || '').split('\n').join(', '))}</span></span>
          <span class="sub">${plural(S.documents.filter((d) => d.company_id === c.id).length, 'document')}</span>
        </a>`).join('')}</div>`;
  }

  function readLogo(file) {
    return new Promise((res, rej) => {
      if (file.size > 5e6) return rej(new Error('Choose an image under 5 MB.'));
      if (file.type === 'image/svg+xml') {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error('That file could not be read.'));
        return r.readAsDataURL(file);
      }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, 600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        res(cv.toDataURL('image/png'));
      };
      img.onerror = () => rej(new Error('That file could not be read as an image.'));
      img.src = url;
    });
  }

  function vCompany(v, id) {
    const existing = company(id);
    const first = !S.companies.length;
    const c = existing ? { ...existing } : {
      name: '', email: '', phone: '', address: '', website: '', license_no: '', tax_id: '', logo: '', color: '#1F4E46',
      invoice_prefix: 'INV-', estimate_prefix: 'EST-', next_invoice_no: 1, next_estimate_no: 1, tax_rate: 0,
      payment_terms_days: 30, estimate_valid_days: 30, default_notes: '', default_terms: '', payment_instructions: '', use_schedule: false, default_schedule: [], change_order_prefix: 'CO-', next_change_order_no: 1
    };
    const f = (name, label, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(c[name] ?? '')}" ${extra}></label>`;
    const ta = (name, label, hint = '') => `<label>${label}${hint ? `<span class="hint">${hint}</span>` : ''}<textarea name="${name}" rows="3">${esc(c[name] ?? '')}</textarea></label>`;
    v.innerHTML = `
      <div class="head">
        <div>${first ? '' : '<a class="back" href="#/companies">Companies</a>'}
          <h1>${first ? 'Set up your company' : existing ? esc(c.name) : 'Add company'}</h1>
          ${first ? '<p class="lead">These details appear on every estimate and invoice. You can add more companies later.</p>' : ''}</div>
        <div class="head-actions">${existing ? '<button class="btn danger" id="coDel">Delete</button>' : ''}<button class="btn primary" id="coSave">Save company</button></div>
      </div>
      <form class="co-form" id="coForm" onsubmit="return false">
        <section>
          <h2>Brand</h2>
          <div class="logo-field">
            <div class="logo-box" id="logoBox"></div>
            <div><div class="btn-row"><label class="btn">Upload logo<input type="file" id="logoIn" accept="image/png,image/jpeg,image/svg+xml,image/webp" class="vh"></label><button type="button" class="btn" id="logoRm">Remove</button></div>
            <p class="sub">A PNG or SVG with a transparent background looks best.</p></div>
          </div>
          <div class="grid2">
            ${f('name', 'Company name', 'text', 'required')}
            <label>Accent color<span class="color-row"><input type="color" name="color" value="${esc(c.color || '#1F4E46')}"><span class="sub">Used for the document title, table rule and balance due.</span></span></label>
          </div>
        </section>
        <section>
          <h2>Contact details</h2>
          <div class="grid2">${f('phone', 'Phone', 'tel')}${f('email', 'Email', 'email')}${f('website', 'Website')}${f('license_no', 'License number')}${f('tax_id', 'Tax ID')}</div>
          ${ta('address', 'Address')}
        </section>
        <section>
          <h2>Numbering</h2>
          <div class="grid4">${f('estimate_prefix', 'Estimate prefix')}${f('next_estimate_no', 'Next estimate number', 'number', 'min="1"')}${f('invoice_prefix', 'Invoice prefix')}${f('next_invoice_no', 'Next invoice number', 'number', 'min="1"')}${S.needsUpgrade2 ? '' : f('change_order_prefix', 'Change order prefix') + f('next_change_order_no', 'Next change order number', 'number', 'min="1"')}</div>
        </section>
        <section>
          <h2>Defaults for new documents</h2>
          <div class="grid3">${f('tax_rate', 'Sales tax %', 'number', 'step="0.001" min="0"')}${f('payment_terms_days', 'Invoice due after (days)', 'number', 'min="0"')}${f('estimate_valid_days', 'Estimates valid for (days)', 'number', 'min="0"')}</div>
          ${ta('default_notes', 'Notes')}
          ${ta('default_terms', 'Terms')}
          ${ta('payment_instructions', 'How to pay', 'Shown on invoices, for example your Zelle email or check mailing address.')}
        </section>
        <section>
          <h2>Deposits and payment schedule</h2>
          <p class="sub">Split each job into payments at milestones. Each payment is either a fixed dollar amount (pick <b>$</b>), such as a $500 booking deposit, or a percentage (pick <b>%</b>) of the whole job, of labor and services only, or of materials only. Fixed amounts come off the top, and percentages split what's left.</p>
          <label class="check"><input type="checkbox" id="useSched" ${c.use_schedule ? 'checked' : ''}> Require a deposit: add this schedule to every new estimate</label>
          <div class="presets"><span class="sub">Quick start:</span>${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="btn subtle" data-preset="${k}">${p.label}</button>`).join('')}</div>
          <div class="tbl-wrap"><table class="tbl sched-tbl"><thead><tr><th>Milestone</th><th>Applies to</th><th class="n">Percent or $</th><th><span class="vh">Remove</span></th></tr></thead><tbody id="coSched"></tbody></table></div>
          <div class="sched-foot"><button type="button" class="btn subtle" id="coSchedAdd">Add milestone</button><span class="sched-warn" id="coSchedWarn"></span></div>
          <p class="sub">You can still change the schedule on any estimate. When a milestone is reached, open the estimate and click <b>Create invoice</b> next to that payment.</p>
        </section>
      </form>`;

    let logo = c.logo || '';
    const getSched = companySchedule(c);
    const drawLogo = () => {
      $('#logoBox').innerHTML = logo ? `<img src="${logo}" alt="Company logo">` : '<span class="sub">No logo</span>';
      $('#logoRm').hidden = !logo;
    };
    drawLogo();
    $('#logoIn').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { logo = await readLogo(file); drawLogo(); } catch (err) { toast(err.message, { type: 'error' }); }
    };
    $('#logoRm').onclick = () => { logo = ''; drawLogo(); };
    $('#coSave').onclick = async () => {
      const form = $('#coForm');
      const fd = new FormData(form);
      const obj = {};
      for (const [k, val] of fd.entries()) if (k) obj[k] = typeof val === 'string' ? val.trim() : val;
      if (!obj.name) { toast('Enter the company name.', { type: 'error' }); form.elements.name.focus(); return; }
      ['next_invoice_no', 'next_estimate_no', 'next_change_order_no', 'payment_terms_days', 'estimate_valid_days'].forEach((k) => { if (k in obj) obj[k] = parseInt(obj[k], 10) || 0; });
      if ('next_change_order_no' in obj) obj.next_change_order_no = Math.max(1, obj.next_change_order_no);
      obj.next_invoice_no = Math.max(1, obj.next_invoice_no);
      obj.next_estimate_no = Math.max(1, obj.next_estimate_no);
      obj.tax_rate = parseFloat(obj.tax_rate) || 0;
      obj.logo = logo;
      if (!S.needsUpgrade) {
        obj.use_schedule = $('#useSched').checked;
        obj.default_schedule = getSched();
        const w = D.scheduleCheck({ schedule: obj.default_schedule, items: [] }, true);
        if (obj.use_schedule && !obj.default_schedule.length) { toast('Add at least one milestone, or untick "Require a deposit".', { type: 'error' }); return; }
        if (w && !confirm(w + ' Save anyway?')) return;
      }
      if (existing) obj.id = existing.id;
      try {
        const saved = await Store.upsert('companies', obj);
        upsertLocal(S.companies, saved);
        renderChrome();
        toast('Company saved');
        go(first ? '#/dashboard' : '#/companies');
      } catch (e) { toast('Could not save: ' + e.message, { type: 'error' }); }
    };
    if (existing) {
      $('#coDel').onclick = async () => {
        const n = S.documents.filter((d) => d.company_id === existing.id).length;
        if (!confirm(`Delete ${existing.name}?${n ? ` Its ${plural(n, 'document')} will be deleted too.` : ''} This can't be undone.`)) return;
        try {
          await Store.remove('companies', existing.id);
          await loadAll();
          renderChrome();
          toast('Company deleted');
          go('#/companies');
        } catch (e) { toast('Could not delete: ' + e.message, { type: 'error' }); }
      };
    }
  }

  // ---------------- Backup ----------------
  function toCSV(rows) {
    const cols = [];
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (k !== 'logo' && !cols.includes(k)) cols.push(k); }));
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  }
  const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

  async function fullBackup(btn) {
    const status = (t) => { const el = $('#backupStatus'); if (el) el.textContent = t; };
    if (!window.JSZip) { toast('The zip library did not load. Check your internet connection and refresh.', { type: 'error' }); return; }
    btn.disabled = true;
    try {
      status('Collecting your data');
      await loadAll();
      const zip = new window.JSZip();
      const stamp = today();
      const tables = { companies: S.companies, customers: S.customers, jobs: S.jobs, documents: S.documents, payments: S.payments, events: S.events, items: S.items, photos: S.photos };
      Object.entries(tables).forEach(([name, rows]) => {
        zip.file(`data/${name}.json`, JSON.stringify(rows, null, 2));
        zip.file(`data/${name}.csv`, toCSV(rows));
      });

      for (const c of S.companies) {
        if (!c.logo) continue;
        try { const blob = await (await fetch(c.logo)).blob(); zip.file(`logos/${safeName(c.name) || c.id}.${/svg/.test(blob.type) ? 'svg' : 'png'}`, blob); } catch (e) { /* skip */ }
      }

      const failed = [];
      const ph = S.photos.slice();
      for (let i = 0; i < ph.length; i++) {
        status(`Downloading photo ${i + 1} of ${ph.length}`);
        const d = docById(ph[i].document_id);
        const folder = d ? safeName(`${d.number} ${d.customer_name || ''}`) : 'Unlinked';
        const n = String((ph[i].position || 0) + 1).padStart(2, '0');
        try { zip.file(`photos/${folder}/${n}${ph[i].caption ? ' ' + safeName(ph[i].caption) : ''} ${ph[i].id.slice(0, 6)}.jpg`, await fetchBlob(ph[i].url)); }
        catch (e) { failed.push(ph[i].url); }
      }

      status('Copying the website files');
      const site = ['index.html', 'view.html', 'app.js', 'render.js', 'data.js', 'styles.css', 'config.js'];
      for (const f of site) {
        try { const r = await fetch(f, { cache: 'no-store' }); if (r.ok) zip.file(`site/${f}`, await r.text()); } catch (e) { /* skip */ }
      }

      const counts = Object.entries(tables).map(([k, v]) => `  ${k}: ${v.length}`).join('\n');
      zip.file('README.txt', `Folio backup, ${stamp}
Account: ${S.mode === 'demo' ? 'demo mode (this browser)' : (S.user && S.user.email) || ''}

What's inside
- data/   Every table as .csv (opens in Excel or Google Sheets) and .json (complete, for restoring).
${counts}
- photos/ Project photos, one folder per estimate or invoice.
- logos/  Company logos.
- site/   The website files as they were live on this date (config.js included).
${failed.length ? `\n${failed.length} photo(s) could not be downloaded:\n${failed.join('\n')}\n` : ''}
To put the website back: upload the files in site/ to your GitHub repository.
The database structure is in supabase/schema.sql and supabase/upgrade-1.sql from the original Folio download.
`);

      status('Creating the zip file');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      saveBlob(blob, `Folio backup ${stamp}.zip`);
      status(`Backup downloaded: ${plural(S.documents.length, 'document')}, ${plural(S.photos.length, 'photo')}${failed.length ? `, ${failed.length} photo(s) skipped` : ''}.`);
      toast('Backup downloaded');
    } catch (e) {
      console.error(e);
      status('');
      toast('The backup could not be created: ' + e.message, { type: 'error', ms: 9000 });
    }
    btn.disabled = false;
  }

  // ---------------- Settings ----------------
  function vSettings(v) {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const notif = {
      granted: '<p class="ok">Desktop notifications are on.</p>',
      denied: '<p class="sub">Notifications are blocked for this site. You can allow them in your browser\'s site settings.</p>',
      unsupported: '<p class="sub">This browser doesn\'t support desktop notifications.</p>',
      default: '<button class="btn" id="askNotif">Turn on desktop notifications</button>'
    }[perm];
    v.innerHTML = `
      <div class="head"><h1>Settings</h1></div>
      <section class="set">
        <h2>Account</h2>
        ${S.mode === 'demo'
        ? `<p>You're in demo mode. Everything is stored in this browser and no email is sent. To sign in from any device and email customers, connect your own database and email service using the steps in README.md.</p>
             <button class="btn danger" id="resetDemo">Reset demo data</button>`
        : `<p>Signed in as <b>${esc(S.user.email)}</b></p><button class="btn" id="signOut">Sign out</button>`}
      </section>
      <section class="set">
        <h2>Notifications</h2>
        <p class="sub">Folio shows a notification when a customer opens or accepts an estimate or invoice, as long as Folio is open in a browser tab. Desktop notifications also appear when the tab is in the background.</p>
        ${notif}
      </section>
      <section class="set">
        <h2>Folio app on your phone and tablet</h2>
        ${isInstalled() ? '<p class="ok">You are using the installed Folio app on this device.</p>'
        : installEvt ? '<p class="sub">Install Folio on this device. It gets its own icon, opens full screen like a regular app, and can use your camera for job photos.</p><button class="btn primary" id="installBtn">Install Folio</button>'
        : isIOS() ? '<p class="sub">To install on iPhone or iPad: open this page in <b>Safari</b>, tap the <b>Share</b> button (the square with an arrow), then <b>Add to Home Screen</b>, then <b>Add</b>.</p>'
        : '<p class="sub">On an Android phone or tablet: open this page in <b>Chrome</b>, tap the <b>⋮</b> menu, then <b>Install app</b> (or <b>Add to Home screen</b>). On a computer, use the install icon at the right end of Chrome\'s address bar.</p>'}
      </section>
      <section class="set">
        <h2>Backup</h2>
        <p class="sub">Download everything in one zip file: all companies, customers, estimates, invoices, payments, price book and activity (as spreadsheet-friendly CSV files and as JSON), every project photo sorted into a folder per document, your logos, and a copy of the website files. Keep it somewhere safe, like an external drive or cloud storage. Once a month is a good habit.</p>
        <button class="btn primary" id="backupBtn">Download full backup</button>
        <p class="sub" id="backupStatus" aria-live="polite"></p>
      </section>`;
    $('#backupBtn').onclick = (e) => fullBackup(e.currentTarget);
    if ($('#installBtn')) $('#installBtn').onclick = async () => { const e = installEvt; if (!e) return; e.prompt(); await e.userChoice; installEvt = null; vSettings(v); };
    const ask = $('#askNotif');
    if (ask) ask.onclick = async () => { await Notification.requestPermission(); vSettings(v); };
    const reset = $('#resetDemo');
    if (reset) reset.onclick = () => { if (confirm('Erase all demo data and start over with the sample data?')) { Store.reset(); location.hash = ''; location.reload(); } };
    const out = $('#signOut');
    if (out) out.onclick = async () => { await Store.signOut(); location.hash = ''; location.reload(); };
  }

  boot();
})();
