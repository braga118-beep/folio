// Shared by the app (index.html) and the customer page (view.html).
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (s) => esc(s).replace(/\n/g, '<br>');
  const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
  const num = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  const today = () => isoOf(new Date());
  const addDays = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    return isoOf(new Date(y, m - 1, d + Number(n || 0)));
  };
  const fmtDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function totals(doc) {
    let subtotal = 0;
    (doc.items || []).forEach((it) => {
      const a = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
      subtotal += a;
    });
    subtotal = round2(subtotal);
    const dv = Number(doc.discount_value) || 0;
    let discount = doc.discount_type === 'amount' ? dv : (subtotal * dv) / 100;
    discount = round2(Math.min(Math.max(discount, 0), subtotal));
    const ratio = subtotal ? (subtotal - discount) / subtotal : 0;
    const tax = round2((subtotal * ratio * (Number(doc.tax_rate) || 0)) / 100);
    const total = round2(subtotal - discount + tax);
    const paid = round2(doc.amount_paid);
    return { subtotal, discount, tax, total, paid, balance: round2(total - paid) };
  }

  // ---- Payment schedules ----
  const BASIS_LABEL = { all: 'Whole job', labor: 'Labor and services', materials: 'Materials' };
  // Split the document total into materials and everything else (discount and tax shared proportionally).
  function bases(doc) {
    const t = totals(doc);
    let mat = 0;
    (doc.items || []).forEach((it) => { if (it.kind === 'Material') mat += round2((Number(it.qty) || 0) * (Number(it.price) || 0)); });
    const r = t.subtotal ? t.total / t.subtotal : 0;
    const materials = round2(mat * r);
    return { all: t.total, materials, labor: round2(t.total - materials) };
  }
  function scheduleAmounts(doc) {
    const b = bases(doc);
    const out = (doc.schedule || []).map((m) => {
      const basis = BASIS_LABEL[m.basis] ? m.basis : 'all';
      const percent = Number(m.percent) || 0;
      return { name: m.name || '', basis, percent, amount: round2((b[basis] * percent) / 100) };
    });
    // When a group adds up to 100%, the last milestone absorbs rounding so the amounts match the total exactly.
    Object.keys(BASIS_LABEL).forEach((k) => {
      const idx = out.map((m, i) => (m.basis === k ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return;
      const pct = idx.reduce((s, i) => s + out[i].percent, 0);
      if (Math.abs(pct - 100) < 0.001) {
        const others = idx.slice(0, -1).reduce((s, i) => s + out[i].amount, 0);
        out[idx[idx.length - 1]].amount = round2(b[k] - others);
      }
    });
    return out;
  }
  // Returns a warning when the milestones don't cover the job exactly once, otherwise ''.
  function scheduleCheck(doc, assumeMaterials) {
    const s = doc.schedule || [];
    if (!s.length) return '';
    const sum = (k) => s.filter((m) => (m.basis || 'all') === k).reduce((a, m) => a + (Number(m.percent) || 0), 0);
    const all = sum('all'), lab = sum('labor'), mat = sum('materials');
    const pct = (n) => num(n) + '%';
    if (!lab && !mat) return Math.abs(all - 100) > 0.01 ? `Milestones add up to ${pct(all)}, not 100%.` : '';
    const msgs = [];
    if (Math.abs(all + lab - 100) > 0.01) msgs.push(`labor and services add up to ${pct(all + lab)}`);
    const hasMat = assumeMaterials || bases(doc).materials > 0;
    if (hasMat && Math.abs(all + mat - 100) > 0.01) msgs.push(`materials add up to ${pct(all + mat)}`);
    return msgs.length ? `Check the percentages: ${msgs.join(' and ')}, not 100%.` : '';
  }

  // Display status, derived from the stored status plus dates, views and payments.
  function status(doc) {
    if (doc.type === 'estimate') {
      if (['accepted', 'declined', 'converted'].includes(doc.status)) return doc.status;
      if (doc.status === 'draft') return 'draft';
      if (doc.due_date && doc.due_date < today()) return 'expired';
      return doc.viewed_at ? 'viewed' : 'sent';
    }
    const t = totals(doc);
    if (doc.status === 'draft' && !(t.paid > 0)) return 'draft';
    if (t.total > 0 && t.balance <= 0) return 'paid';
    if (doc.due_date && doc.due_date < today()) return 'overdue';
    if (t.paid > 0) return 'partial';
    return doc.viewed_at ? 'viewed' : 'sent';
  }

  const STATUS_LABEL = {
    draft: 'Draft', sent: 'Sent', viewed: 'Viewed', partial: 'Partially paid', paid: 'Paid',
    overdue: 'Overdue', accepted: 'Accepted', declined: 'Declined', converted: 'Invoiced', expired: 'Expired'
  };

  function companyLines(co) {
    const lines = [];
    if (co.address) lines.push(nl(co.address));
    const contact = [co.phone, co.email].filter(Boolean).map(esc).join('&ensp;');
    if (contact) lines.push(contact);
    const extra = [co.website, co.license_no, co.tax_id].filter(Boolean).map(esc).join('&ensp;');
    if (extra) lines.push(extra);
    return lines.join('<br>');
  }

  // ---- Building blocks shared by the web view and the paged PDF ----
  function parts(doc, company) {
    const co = company || {};
    const t = totals(doc);
    const isInv = doc.type === 'invoice';
    const brand = /^#[0-9a-f]{3,8}$/i.test(co.color || '') ? co.color : '#1F4E46';
    const label = `${isInv ? 'Invoice' : 'Estimate'} ${doc.number || ''}`.trim();

    const customer = [
      doc.customer_name ? `<div class="p-strong">${esc(doc.customer_name)}</div>` : '',
      doc.customer_address ? `<div>${nl(doc.customer_address)}</div>` : '',
      doc.customer_phone ? `<div>${esc(doc.customer_phone)}</div>` : '',
      doc.customer_email ? `<div>${esc(doc.customer_email)}</div>` : ''
    ].join('');
    const project = (doc.job_title || doc.job_site) ? `
      <div>
        <div class="p-h">Project</div>
        ${doc.job_title ? `<div class="p-strong">${esc(doc.job_title)}</div>` : ''}
        ${doc.job_site ? `<div>${nl(doc.job_site)}</div>` : ''}
      </div>` : '<div></div>';

    const head = `
      <header class="p-head">
        <div class="p-from">
          ${co.logo ? `<img class="p-logo" src="${co.logo}" alt="${esc(co.name)}">` : ''}
          <div class="p-co">${esc(co.name || '')}</div>
          <div class="p-lines">${companyLines(co)}</div>
        </div>
        <div class="p-title">
          <div class="p-type">${isInv ? 'Invoice' : 'Estimate'}</div>
          <dl class="p-meta">
            <dt>Number</dt><dd>${esc(doc.number)}</dd>
            <dt>Issued</dt><dd>${fmtDate(doc.issue_date)}</dd>
            ${doc.due_date ? `<dt>${isInv ? 'Due' : 'Valid until'}</dt><dd>${fmtDate(doc.due_date)}</dd>` : ''}
          </dl>
        </div>
      </header>
      <section class="p-parties">
        <div><div class="p-h">${isInv ? 'Bill to' : 'Prepared for'}</div>${customer}</div>
        ${project}
      </section>`;

    const unitLabel = (u) => (/^(each|ea|job|lot)$/i.test(u) ? esc(u) : 'per ' + esc(u));
    const thead = '<thead><tr><th>Description</th><th class="p-num">Rate</th><th class="p-num">Qty</th><th class="p-num">Amount</th></tr></thead>';
    const rows = (doc.items || []).map((it) => `
      <tr>
        <td class="p-desc">${it.kind ? `<div class="p-kind">${esc(it.kind)}</div>` : ''}${nl(it.description)}</td>
        <td class="p-num">${money(it.price)}${it.unit ? `<div class="p-unit">${unitLabel(it.unit)}</div>` : ''}</td>
        <td class="p-num">${num(it.qty)}</td>
        <td class="p-num">${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>
      </tr>`);
    if (!rows.length) rows.push('<tr><td colspan="4" class="p-empty">No line items</td></tr>');

    const notesBlocks = [
      doc.notes ? `<div class="p-h">Notes</div><p>${nl(doc.notes)}</p>` : '',
      isInv && co.payment_instructions ? `<div class="p-h">How to pay</div><p>${nl(co.payment_instructions)}</p>` : '',
      doc.terms ? `<div class="p-h">Terms</div><p>${nl(doc.terms)}</p>` : ''
    ].filter(Boolean);
    const accepted = !isInv && doc.accepted_at ? `
      <div class="p-stamp">Accepted${doc.accepted_by ? ' by ' + esc(doc.accepted_by) : ''} on ${fmtDate(doc.accepted_at)}</div>` : '';
    const totalsHtml = `
      <div class="p-totals">
        <div class="tr"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        ${t.discount ? `<div class="tr"><span>Discount${doc.discount_type === 'percent' ? ' (' + num(doc.discount_value) + '%)' : ''}</span><span>−${money(t.discount)}</span></div>` : ''}
        ${t.tax ? `<div class="tr"><span>Tax (${num(doc.tax_rate)}%)</span><span>${money(t.tax)}</span></div>` : ''}
        ${isInv ? `<div class="tr total"><span>Total</span><span>${money(t.total)}</span></div>` : ''}
        ${isInv && t.paid ? `<div class="tr"><span>Paid</span><span>−${money(t.paid)}</span></div>` : ''}
        <div class="tr due"><span>${isInv ? 'Balance due' : 'Estimate total'}</span><span>${money(isInv ? t.balance : t.total)}</span></div>
        ${accepted}
      </div>`;
    const bottom = `<section class="p-bottom"><div class="p-notes">${notesBlocks.join('')}</div>${totalsHtml}</section>`;

    let sched = null;
    if (!isInv && (doc.schedule || []).length) {
      const list = scheduleAmounts(doc);
      const showBasis = list.some((m) => m.basis !== 'all');
      sched = {
        thead: `<thead><tr><th>Milestone</th>${showBasis ? '<th>Applies to</th>' : ''}<th class="p-num">Share</th><th class="p-num">Amount</th></tr></thead>`,
        rows: list.map((m, i) => `<tr><td>${esc(m.name || 'Payment ' + (i + 1))}</td>${showBasis ? `<td>${BASIS_LABEL[m.basis]}</td>` : ''}<td class="p-num">${num(m.percent)}%</td><td class="p-num">${money(m.amount)}</td></tr>`)
      };
    }
    return { co, brand, label, head, thead, rows, bottom, notesBlocks, totalsHtml, sched };
  }

  const photoSubtitle = (doc, p) => esc(p.label + (doc.job_title ? ', ' + doc.job_title : ''));

  // Web view: the document, then the photos on their own sheet.
  function renderPaper(doc, company, photos) {
    const p = parts(doc, company);
    const sched = p.sched ? `
      <section class="p-sched">
        <div class="p-h">Payment schedule</div>
        <table class="p-items sched">${p.sched.thead}<tbody>${p.sched.rows.join('')}</tbody></table>
      </section>` : '';
    const main = `
    <article class="paper" style="--brand:${p.brand}">
      <div class="p-band"></div>
      ${p.head}
      <table class="p-items">${p.thead}<tbody>${p.rows.join('')}</tbody></table>
      ${p.bottom}
      ${sched}
      <footer class="p-foot"><span>${esc(p.co.name || '')}</span><span>Thank you for your business.</span></footer>
    </article>`;
    if (doc.show_photos === false || !photos || !photos.length) return main;
    return main + `
    <article class="paper photos-paper" style="--brand:${p.brand}">
      <div class="p-band"></div>
      <div class="ph-title"><div class="p-type sm">Project photos</div><div class="p-lines">${photoSubtitle(doc, p)}</div></div>
      <div class="p-grid3">${photos.map((ph, i) => `
        <figure>
          <a href="${esc(ph.url)}" target="_blank" rel="noopener"><img src="${esc(ph.url)}" alt="${esc(ph.caption || 'Project photo ' + (i + 1))}" loading="lazy"></a>
          ${ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : ''}
        </figure>`).join('')}</div>
    </article>`;
  }

  // ---- Paged layout for PDF and JPEG (US Letter, 816 x 1056 px) ----
  const PAGE_H = 1056, PAD_TOP = 52, FOOT_H = 70, CONT_H = 34;
  const BODY_MAX = PAGE_H - PAD_TOP - FOOT_H - CONT_H;

  // Crop photos to a uniform 4:3 so the grid lines up (works around canvas export limits).
  function cropThumb(url) {
    return new Promise((res) => {
      const img = new Image();
      if (!/^data:/.test(url)) img.crossOrigin = 'anonymous';
      img.onload = () => {
        const W = 900, H = 675;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const r = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * r, h = img.naturalHeight * r;
        c.getContext('2d').drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        try { res(c.toDataURL('image/jpeg', 0.86)); } catch (e) { res(url); }
      };
      img.onerror = () => res(url);
      img.src = url;
    });
  }

  async function buildPages(doc, company, photos) {
    const p = parts(doc, company);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const host = document.createElement('div');
    host.className = 'export-host';
    host.innerHTML = `<div class="pg" style="--brand:${p.brand}"><div class="pg-body"></div></div>`;
    document.body.appendChild(host);
    const mz = host.querySelector('.pg-body');
    const H = (html) => { mz.innerHTML = `<div class="blk">${html}</div>`; return mz.firstElementChild.getBoundingClientRect().height; };
    const tableH = (thead, rows, cls) => {
      mz.innerHTML = `<div class="blk"><table class="p-items ${cls || ''}">${thead}<tbody>${rows.join('')}</tbody></table></div>`;
      return { th: mz.querySelector('thead').getBoundingClientRect().height, rh: [...mz.querySelectorAll('tbody > tr')].map((r) => r.getBoundingClientRect().height) };
    };
    const contHead = (text) => `<div class="pg-cont-head"><span class="pg-co">${esc(p.co.name || '')}</span><span>${esc(text)}</span></div>`;

    try {
      const hCont = H(contHead('x'));
      const pages = [];
      let cur;
      const newPage = (first, headText) => {
        cur = { html: [], h: 0, first, cont: false };
        pages.push(cur);
        if (!first) { cur.html.push(contHead(headText || `${p.label}, continued`)); cur.h += hCont; }
      };
      const empty = () => cur.html.length === (cur.first ? 0 : 1);
      const breakPage = () => { cur.cont = true; newPage(false); };
      const add = (html, h) => { if (cur.h + h > BODY_MAX && !empty()) breakPage(); cur.html.push(`<div class="blk">${html}</div>`); cur.h += h; };

      // A table whose rows flow across pages, repeating the column headings.
      const placeTable = (t) => {
        const { th, rh } = tableH(t.thead, t.rows, t.cls);
        const titleH = t.title ? H(t.title) : 0, contTitleH = t.contTitle ? H(t.contTitle) : 0;
        // Short tables (like the payment schedule) move to the next page whole instead of splitting.
        const whole = titleH + th + rh.reduce((a, b) => a + b, 0);
        if (t.keep && whole <= BODY_MAX - hCont && cur.h + whole > BODY_MAX && !empty()) breakPage();
        let i = 0, first = true, seg = [], segTitle = '';
        const flush = () => {
          if (!seg.length) return;
          cur.html.push(`<div class="blk">${segTitle}<table class="p-items ${t.cls || ''}">${t.thead}<tbody>${seg.join('')}</tbody></table></div>`);
          seg = []; first = false;
        };
        while (i < t.rows.length) {
          if (!seg.length) {
            const open = th + (first ? titleH : contTitleH);
            if (cur.h + open + rh[i] > BODY_MAX && !empty()) { breakPage(); continue; }
            segTitle = first ? (t.title || '') : (t.contTitle || '');
            cur.h += open;
          } else if (cur.h + rh[i] > BODY_MAX) { flush(); breakPage(); continue; }
          seg.push(t.rows[i]); cur.h += rh[i]; i++;
        }
        flush();
      };

      newPage(true);
      add(p.head, H(p.head));
      placeTable({ thead: p.thead, rows: p.rows });

      // Notes and totals stay together; very long notes are split into their own blocks.
      const hBottom = H(p.bottom);
      if (hBottom <= BODY_MAX) add(p.bottom, hBottom);
      else {
        const solo = `<section class="p-bottom"><div></div>${p.totalsHtml}</section>`;
        add(solo, H(solo));
        p.notesBlocks.forEach((b) => { const html = `<div class="p-notes pg-notes">${b}</div>`; add(html, H(html)); });
      }

      if (p.sched) {
        placeTable({
          thead: p.sched.thead, rows: p.sched.rows, cls: 'sched', keep: true,
          title: '<div class="p-h pg-sec-title">Payment schedule</div>',
          contTitle: '<div class="p-h">Payment schedule, continued</div>'
        });
      }

      // Photos always start on their own page, 3 across.
      if (doc.show_photos !== false && photos && photos.length) {
        const thumbs = await Promise.all(photos.map((ph) => cropThumb(ph.url)));
        const cells = photos.map((ph, i) => `<figure><img src="${thumbs[i]}" alt=""><figcaption>${esc(ph.caption || '')}</figcaption></figure>`);
        const rows = [];
        for (let i = 0; i < cells.length; i += 3) rows.push(`<div class="pg-grid">${cells.slice(i, i + 3).join('')}</div>`);
        const title = (more) => `<div class="pg-ph-head"><div class="p-type sm">Project photos${more ? ', continued' : ''}</div><div class="p-lines">${photoSubtitle(doc, p)}</div></div>`;
        const tH = H(title(false)), rowH = H(rows[0]);
        cur.cont = false;
        newPage(false, p.label);
        cur.html.push(title(false)); cur.h += tH;
        rows.forEach((r) => {
          if (cur.h + rowH > BODY_MAX) { breakPage(); cur.html[0] = contHead(p.label); cur.html.push(title(true)); cur.h += tH; }
          cur.html.push(r); cur.h += rowH;
        });
      }

      const total = pages.length;
      return pages.map((pg, n) => `
        <div class="pg" style="--brand:${p.brand}">
          <div class="p-band"></div>
          <div class="pg-body">${pg.html.join('')}</div>
          ${pg.cont ? '<div class="pg-cont-note">Continued on next page</div>' : ''}
          <div class="pg-foot"><span>${esc(p.co.name || '')}</span><span>${esc(p.label)}</span><span>Page ${n + 1} of ${total}</span></div>
        </div>`);
    } finally {
      host.remove();
    }
  }

  async function pageCanvas(html) {
    const host = document.createElement('div');
    host.className = 'export-host';
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      await Promise.all([...host.querySelectorAll('img')].map((img) => (img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; }))));
      return await window.html2canvas(host.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: 816, height: 1056 });
    } finally {
      host.remove();
    }
  }

  function needLibs(pdf) {
    if (!window.html2canvas || (pdf && !window.jspdf)) throw new Error('The export library did not load. Check your internet connection and refresh.');
  }

  async function toPdf(doc, company, photos) {
    needLibs(true);
    const pages = await buildPages(doc, company, photos);
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    for (let n = 0; n < pages.length; n++) {
      const c = await pageCanvas(pages[n]);
      if (n) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, pw, ph);
    }
    return pdf;
  }

  // JPEG: the pages stacked top to bottom with a thin gap.
  async function toJpeg(doc, company, photos) {
    needLibs(false);
    const pages = await buildPages(doc, company, photos);
    const canvases = [];
    for (const html of pages) canvases.push(await pageCanvas(html));
    const gap = 32;
    const out = document.createElement('canvas');
    out.width = canvases[0].width;
    out.height = canvases.reduce((s, c) => s + c.height, 0) + gap * (canvases.length - 1);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#E9ECEA'; ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    canvases.forEach((c) => { ctx.drawImage(c, 0, y); y += c.height + gap; });
    return out.toDataURL('image/jpeg', 0.9);
  }

  window.Doc = { esc, nl, money, num, round2, today, addDays, fmtDate, totals, status, STATUS_LABEL, companyLines, renderPaper, buildPages, toPdf, toJpeg, BASIS_LABEL, bases, scheduleAmounts, scheduleCheck };
})();
