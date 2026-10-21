// Data layer. Uses Supabase when config.js has keys, otherwise a demo store in localStorage.
(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------------- Demo store ----------------
  const Local = {
    key: 'folio:db',
    read() { try { return JSON.parse(localStorage.getItem(this.key)); } catch (e) { return null; } },
    db() {
      let d = this.read();
      if (!d) { d = seed(); this.save(d); }
      ['companies', 'customers', 'documents', 'payments', 'events', 'items', 'photos'].forEach((k) => { if (!d[k]) d[k] = []; });
      return d;
    },
    save(d) {
      try { localStorage.setItem(this.key, JSON.stringify(d)); }
      catch (e) { throw new Error('Demo storage in this browser is full. Delete some photos, or connect your database to store more.'); }
    },
    reset() { localStorage.removeItem(this.key); },
    async init() { this.db(); return { mode: 'demo', user: { email: 'Demo mode' } }; },
    async list(t) { return clone(this.db()[t] || []); },
    async upsert(t, obj) {
      const d = this.db();
      const arr = d[t];
      const now = new Date().toISOString();
      let row;
      const i = obj.id ? arr.findIndex((x) => x.id === obj.id) : -1;
      if (i >= 0) {
        row = arr[i] = { ...arr[i], ...obj };
      } else {
        row = { ...obj, id: obj.id || uid(), created_at: now };
        if (t === 'documents') row.public_token = row.public_token || token();
        if (t === 'events' && row.seen === undefined) row.seen = false;
        arr.push(row);
      }
      if (t === 'documents') row.updated_at = now;
      this.save(d);
      return clone(row);
    },
    async remove(t, id) {
      const d = this.db();
      d[t] = d[t].filter((x) => x.id !== id);
      if (t === 'companies') {
        const gone = new Set(d.documents.filter((x) => x.company_id === id).map((x) => x.id));
        d.documents = d.documents.filter((x) => !gone.has(x.id));
        d.payments = d.payments.filter((p) => !gone.has(p.document_id));
        d.events = d.events.filter((e) => !gone.has(e.document_id));
        d.photos = d.photos.filter((p) => !gone.has(p.document_id));
        d.items = d.items.filter((it) => it.company_id !== id);
      }
      if (t === 'documents') {
        d.payments = d.payments.filter((p) => p.document_id !== id);
        d.events = d.events.filter((e) => e.document_id !== id);
        d.photos = d.photos.filter((p) => p.document_id !== id);
      }
      if (t === 'customers') d.documents.forEach((x) => { if (x.customer_id === id) x.customer_id = null; });
      this.save(d);
    },
    async getPublic(tok, record = true) {
      const d = this.db();
      const doc = d.documents.find((x) => x.public_token === tok && !x.archived);
      if (!doc) return null;
      if (record && doc.status !== 'draft') {
        const now = new Date().toISOString();
        doc.viewed_at = doc.viewed_at || now;
        doc.view_count = (doc.view_count || 0) + 1;
        const recent = d.events.some((e) => e.document_id === doc.id && e.kind === 'viewed' && Date.now() - Date.parse(e.created_at) < 30 * 60e3);
        if (!recent) d.events.push({ id: uid(), document_id: doc.id, kind: 'viewed', detail: null, seen: false, created_at: now });
        this.save(d);
      }
      const company = d.companies.find((c) => c.id === doc.company_id) || {};
      const photos = doc.show_photos === false ? [] : d.photos.filter((p) => p.document_id === doc.id)
        .sort((a, b) => (a.position || 0) - (b.position || 0)).map((p) => ({ url: p.url, caption: p.caption }));
      return { document: clone(doc), company: clone(company), photos };
    },
    async accept(tok, name) {
      const d = this.db();
      const doc = d.documents.find((x) => x.public_token === tok && x.type === 'estimate' && x.status === 'sent');
      if (!doc) return false;
      const now = new Date().toISOString();
      Object.assign(doc, { status: 'accepted', accepted_at: now, accepted_by: name.slice(0, 120) });
      d.events.push({ id: uid(), document_id: doc.id, kind: 'accepted', detail: doc.accepted_by, seen: false, created_at: now });
      this.save(d);
      return true;
    },
    async send(p) {
      const d = this.db();
      const doc = d.documents.find((x) => x.id === p.document_id);
      if (!doc) throw new Error('Document not found');
      const now = new Date().toISOString();
      doc.sent_at = doc.sent_at || now;
      doc.last_sent_at = now;
      if (doc.status === 'draft') doc.status = 'sent';
      d.events.push({ id: uid(), document_id: doc.id, kind: p.kind === 'reminder' ? 'reminder' : 'sent', detail: p.to, seen: true, created_at: now });
      this.save(d);
      return { ok: true, demo: true };
    },
    // Demo mode keeps photos inside the browser as small images.
    async uploadPhoto(docId, blob) {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      return { path: null, url };
    },
    async removePhotoFile() {},
    onEvent(cb) { window.addEventListener('storage', (e) => { if (e.key === this.key) cb(); }); },
    async signOut() {}
  };

  // ---------------- Supabase ----------------
  const Remote = {
    sb: null,
    async init() {
      // Accept a pasted URL with extra parts (like /rest/v1/ or a trailing slash): keep only https://xxxx.supabase.co
      let url = String(cfg.SUPABASE_URL).trim();
      try { url = new URL(url).origin; } catch (e) { throw new Error('The SUPABASE_URL in config.js is not a valid web address.'); }
      this.sb = window.supabase.createClient(url, String(cfg.SUPABASE_ANON_KEY).trim());
      const { data } = await this.sb.auth.getSession();
      return { mode: 'cloud', user: data.session ? data.session.user : null };
    },
    async signIn(email, password) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    async signUp(email, password) {
      const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw error;
      return data;
    },
    async signOut() { await this.sb.auth.signOut(); },
    async list(t) {
      const { data, error } = await this.sb.from(t).select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
    async upsert(t, obj) {
      const o = { ...obj };
      delete o.owner;
      if (t === 'documents' || t === 'items') o.updated_at = new Date().toISOString();
      const q = o.id ? this.sb.from(t).update(o).eq('id', o.id) : this.sb.from(t).insert(o);
      const { data, error } = await q.select().single();
      if (error) throw error;
      return data;
    },
    async remove(t, id) {
      const { error } = await this.sb.from(t).delete().eq('id', id);
      if (error) throw error;
    },
    async getPublic(tok, record = true) {
      const { data, error } = await this.sb.rpc('get_public_document', { p_token: tok, p_record: record });
      if (error) throw error;
      return data;
    },
    async accept(tok, name) {
      const { data, error } = await this.sb.rpc('accept_estimate', { p_token: tok, p_name: name });
      if (error) throw error;
      return data;
    },
    async send(payload) {
      const { data, error } = await this.sb.functions.invoke('send-document', { body: payload });
      if (error) {
        let msg = error.message;
        try { const b = await error.context.json(); msg = b.error || msg; } catch (e) { /* keep message */ }
        throw new Error(msg);
      }
      if (data && data.error) throw new Error(data.error);
      return data;
    },
    async uploadPhoto(docId, blob) {
      const { data } = await this.sb.auth.getSession();
      if (!data.session) throw new Error('You are signed out. Sign in again.');
      const path = `${data.session.user.id}/${docId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await this.sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error(error.message);
      return { path, url: this.sb.storage.from('photos').getPublicUrl(path).data.publicUrl };
    },
    async removePhotoFile(path) {
      if (path) await this.sb.storage.from('photos').remove([path]);
    },
    onEvent(cb) {
      this.sb.channel('folio-events')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => cb())
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'documents' }, () => cb())
        .subscribe();
    }
  };

  // ---------------- Demo seed ----------------
  function seed() {
    const D = window.Doc;
    const t = D.today();
    const day = (n) => D.addDays(t, n);
    const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    const co = {
      id: uid(), created_at: at(120), name: 'Northline Builders', email: 'office@northlinebuilders.com', phone: '(207) 555-0142',
      website: 'northlinebuilders.com', address: '214 Harbor Street, Suite 2\nPortland, ME 04101', license_no: 'License CB-20418', tax_id: '',
      logo: '', color: '#1F4E46', invoice_prefix: 'INV-', estimate_prefix: 'EST-', next_invoice_no: 5, next_estimate_no: 4,
      tax_rate: 5.5, payment_terms_days: 30, estimate_valid_days: 30,
      default_notes: 'All work performed to local code. Daily cleanup and final debris removal included.',
      default_terms: '50% deposit due on acceptance, balance due on completion. Workmanship guaranteed for one year.',
      payment_instructions: 'Check payable to Northline Builders, or Zelle to office@northlinebuilders.com.',
      use_schedule: true,
      default_schedule: [
        { name: 'Deposit, due on start day', percent: 50, basis: 'all' },
        { name: 'After rough-in', percent: 25, basis: 'all' },
        { name: 'At completion', percent: 25, basis: 'all' }
      ]
    };
    const cust = (name, email, phone, address) => ({ id: uid(), created_at: at(100), name, email, phone, address, notes: '' });
    const customers = [
      cust('John Doe', 'john.doe@example.com', '(207) 555-0110', '12 Bourbon Ave\nFalmouth, ME 04105'),
      cust('Sophie Smith', 'sophie.smith@example.com', '(207) 555-0187', '48 Pine Ridge Rd\nCape Elizabeth, ME 04107'),
      cust('AB Company', 'facilities@abcompany.com', '(207) 555-0133', '900 Commerce Way, Floor 2\nSouth Portland, ME 04106'),
      cust('Jane Doe', 'jane.doe@example.com', '(207) 555-0164', '7 Willow Lane\nScarborough, ME 04074'),
      cust('Alice Jones', 'alice.jones@example.com', '(207) 555-0199', '31 Ocean View Dr\nYarmouth, ME 04096')
    ];
    const [john, sophie, ab, jane, alice] = customers;
    const L = (kind, description, qty, price, taxable = kind === 'Material') => ({ kind, description, qty, price, taxable });
    const mk = (o, c) => {
      const d = {
        id: uid(), public_token: token(), company_id: co.id, customer_id: c.id, customer_name: c.name, customer_email: c.email,
        customer_phone: c.phone, customer_address: c.address, status: 'sent', tax_rate: 5.5, discount_type: 'percent', discount_value: 0,
        notes: co.default_notes, terms: co.default_terms, amount_paid: 0, view_count: 0, archived: false, job_site: c.address, show_photos: true,
        schedule: o.type === 'estimate' ? clone(co.default_schedule) : [],
        created_at: at(o.age), updated_at: at(o.age), sent_at: o.status === 'draft' ? null : at(o.age), viewed_at: null, ...o
      };
      delete d.age;
      d.total = D.totals(d).total;
      return d;
    };

    const inv1 = mk({ age: 52, type: 'invoice', number: 'INV-0001', job_title: 'Sill plate repair', issue_date: day(-52), due_date: day(-22), viewed_at: at(51), view_count: 2,
      items: [L('Labor', 'Replace rotted sill plate and rim joist along east wall', 16, 85), L('Material', 'Pressure-treated lumber, sill seal, fasteners', 1, 640)] }, john);
    inv1.amount_paid = inv1.total;
    const inv2 = mk({ age: 20, type: 'invoice', number: 'INV-0002', job_title: 'Kitchen remodel, phase 1', issue_date: day(-20), due_date: day(10), viewed_at: at(19), view_count: 3, amount_paid: 4000,
      items: [L('Labor', 'Demolition and haul-away of existing cabinets, counters and flooring', 24, 85), L('Subcontract', 'Electrical rough-in by licensed electrician', 1, 1850, false), L('Material', 'Shaker cabinets, white oak, per approved layout', 1, 6400)] }, sophie);
    const inv3 = mk({ age: 45, type: 'invoice', number: 'INV-0003', job_title: 'Office partition walls', issue_date: day(-45), due_date: day(-15),
      items: [L('Service', 'Frame, hang and finish partition walls for three offices', 1, 5200, false), L('Material', 'Steel studs, drywall, compound and trim', 1, 1000)] }, ab);
    const est1 = mk({ age: 9, type: 'estimate', number: 'EST-0001', job_title: 'Primary bathroom remodel', issue_date: day(-9), due_date: day(21), status: 'accepted',
      viewed_at: at(8), view_count: 2, accepted_at: at(5), accepted_by: 'Jane Doe',
      items: [L('Labor', 'Demolition, framing adjustments and waterproofing', 40, 85), L('Material', 'Porcelain tile, schluter trim, setting materials', 1, 2350), L('Subcontract', 'Plumbing: relocate shower valve, set vanity and toilet', 1, 2200, false)] }, jane);
    const inv4 = mk({ age: 3, type: 'invoice', number: 'INV-0004', job_title: 'Primary bathroom remodel, deposit', issue_date: day(-3), due_date: day(27), status: 'draft',
      items: [L('Service', '50% deposit per accepted estimate EST-0001', 1, 4100, false)] }, jane);
    inv4.source_id = est1.id;
    const est2 = mk({ age: 1, type: 'estimate', number: 'EST-0002', job_title: 'Second-floor build-out', issue_date: day(-1), due_date: day(29), viewed_at: at(0.04), view_count: 1,
      items: [L('Labor', 'Layout, framing and drywall for open office and two meeting rooms', 120, 85), L('Material', 'Framing lumber, drywall, insulation and acoustic batts', 1, 7800), L('Subcontract', 'HVAC branch ducts and diffusers', 1, 6400, false)] }, ab);
    const est3 = mk({ age: 0, type: 'estimate', number: 'EST-0003', job_title: 'Deck replacement', issue_date: t, due_date: day(30), status: 'draft',
      items: [L('Labor', 'Remove existing deck and footings; install new helical piers', 32, 85), L('Material', 'Composite decking, PT framing, hidden fasteners, railing', 1, 9200)] }, alice);

    const ev = (doc, kind, daysAgo, seen = true, detail = null) => ({ id: uid(), document_id: doc.id, kind, detail, seen, created_at: at(daysAgo) });
    const item = (name, kind, unit, price, description = '') => ({ id: uid(), created_at: at(60), updated_at: at(60), company_id: null, name, kind, unit, price, description });
    const items = [
      item('Tiled shower niche', 'Service', 'each', 450, 'Frame, waterproof and tile a 12 x 24 in. recessed niche, with a sloped sill and trim edges'),
      item('Carpenter labor', 'Labor', 'hour', 85),
      item('Drywall, hang and finish', 'Service', 'sq ft', 3.25, 'Hang, tape and finish to a level 4 finish, ready for paint'),
      item('Interior painting, walls', 'Service', 'sq ft', 2.5, 'Prime and two finish coats, customer-selected color'),
      item('Dumpster rental, 20 yard', 'Equipment', 'each', 650, 'Delivery, one week on site, haul-away and disposal fees'),
      item('Building permit', 'Permit', 'each', 250, 'Permit filing and inspection fees')
    ];
    return {
      items,
      photos: [],
      companies: [co],
      customers,
      documents: [inv1, inv2, inv3, est1, inv4, est2, est3],
      payments: [
        { id: uid(), document_id: inv1.id, amount: inv1.total, paid_on: day(-30), method: 'Check', reference: '1042', note: '', created_at: at(30) },
        { id: uid(), document_id: inv2.id, amount: 4000, paid_on: day(-18), method: 'Zelle', reference: '', note: 'Deposit', created_at: at(18) }
      ],
      events: [
        ev(inv1, 'sent', 52, true, john.email), ev(inv1, 'viewed', 51), ev(inv1, 'paid', 30, true, String(inv1.total)),
        ev(inv3, 'sent', 45, true, ab.email),
        ev(inv2, 'sent', 20, true, sophie.email), ev(inv2, 'viewed', 19), ev(inv2, 'paid', 18, true, '4000'),
        ev(est1, 'sent', 9, true, jane.email), ev(est1, 'viewed', 8), ev(est1, 'accepted', 5, true, 'Jane Doe'),
        ev(est2, 'sent', 1, true, ab.email), ev(est2, 'viewed', 0.04, false)
      ]
    };
  }

  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  if (configured && !window.supabase) {
    // Keys are set but the Supabase library didn't load: show an error instead of silently using demo mode.
    window.Store = { init: async () => { throw new Error('The Supabase library did not load. Check your internet connection and refresh the page.'); } };
  } else {
    window.Store = configured ? Remote : Local;
  }
})();
