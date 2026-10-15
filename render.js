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
    let subtotal = 0, taxableSub = 0;
    (doc.items || []).forEach((it) => {
      const a = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
      subtotal += a;
      if (it.taxable !== false) taxableSub += a;
    });
    subtotal = round2(subtotal);
    const dv = Number(doc.discount_value) || 0;
    let discount = doc.discount_type === 'amount' ? dv : (subtotal * dv) / 100;
    discount = round2(Math.min(Math.max(discount, 0), subtotal));
    const ratio = subtotal ? (subtotal - discount) / subtotal : 0;
    const tax = round2((taxableSub * ratio * (Number(doc.tax_rate) || 0)) / 100);
    const total = round2(subtotal - discount + tax);
    const paid = round2(doc.amount_paid);
    return { subtotal, discount, tax, total, paid, balance: round2(total - paid) };
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

  function renderPaper(doc, company) {
    const co = company || {};
    const t = totals(doc);
    const isInv = doc.type === 'invoice';
    const brand = /^#[0-9a-f]{3,8}$/i.test(co.color || '') ? co.color : '#1F4E46';

    const rows = (doc.items || []).map((it) => `
      <tr>
        <td class="p-desc">${it.kind ? `<div class="p-kind">${esc(it.kind)}</div>` : ''}${nl(it.description)}</td>
        <td class="p-num">${num(it.qty)}</td>
        <td class="p-num">${money(it.price)}</td>
        <td class="p-num">${money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>
      </tr>`).join('');

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

    const notes = [
      doc.notes ? `<div class="p-h">Notes</div><p>${nl(doc.notes)}</p>` : '',
      isInv && co.payment_instructions ? `<div class="p-h">How to pay</div><p>${nl(co.payment_instructions)}</p>` : '',
      doc.terms ? `<div class="p-h">Terms</div><p>${nl(doc.terms)}</p>` : ''
    ].join('');

    const accepted = !isInv && doc.accepted_at ? `
      <div class="p-stamp">Accepted${doc.accepted_by ? ' by ' + esc(doc.accepted_by) : ''} on ${fmtDate(doc.accepted_at)}</div>` : '';

    return `
    <article class="paper" style="--brand:${brand}">
      <div class="p-band"></div>
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
      </section>
      <table class="p-items">
        <thead><tr><th>Description</th><th class="p-num">Qty</th><th class="p-num">Rate</th><th class="p-num">Amount</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="p-empty">No line items</td></tr>'}</tbody>
      </table>
      <section class="p-bottom">
        <div class="p-notes">${notes}</div>
        <div class="p-totals">
          <div class="tr"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
          ${t.discount ? `<div class="tr"><span>Discount${doc.discount_type === 'percent' ? ' (' + num(doc.discount_value) + '%)' : ''}</span><span>−${money(t.discount)}</span></div>` : ''}
          ${t.tax ? `<div class="tr"><span>Tax (${num(doc.tax_rate)}%)</span><span>${money(t.tax)}</span></div>` : ''}
          ${isInv ? `<div class="tr total"><span>Total</span><span>${money(t.total)}</span></div>` : ''}
          ${isInv && t.paid ? `<div class="tr"><span>Paid</span><span>−${money(t.paid)}</span></div>` : ''}
          <div class="tr due"><span>${isInv ? 'Balance due' : 'Estimate total'}</span><span>${money(isInv ? t.balance : t.total)}</span></div>
          ${accepted}
        </div>
      </section>
      <footer class="p-foot"><span>${esc(co.name || '')}</span><span>Thank you for your business.</span></footer>
    </article>`;
  }

  // ---- Export (needs html2canvas + jsPDF loaded on the page) ----
  async function exportCanvas(html) {
    if (!window.html2canvas) throw new Error('The export library did not load. Check your internet connection.');
    const host = document.createElement('div');
    host.className = 'export-host';
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await Promise.all([...host.querySelectorAll('img')].map((img) =>
        img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; })));
      return await window.html2canvas(host.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    } finally {
      host.remove();
    }
  }

  async function toPdf(html) {
    if (!window.jspdf) throw new Error('The PDF library did not load. Check your internet connection.');
    const canvas = await exportCanvas(html);
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const sliceH = Math.floor((canvas.width * ph) / pw);
    let y = 0;
    while (y < canvas.height) {
      const h = Math.min(sliceH, canvas.height - y);
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, h);
      ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (y > 0) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pw, (h * pw) / canvas.width);
      y += h;
    }
    return pdf;
  }

  async function toJpeg(html) {
    const canvas = await exportCanvas(html);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  window.Doc = { esc, nl, money, num, round2, today, addDays, fmtDate, totals, status, STATUS_LABEL, companyLines, renderPaper, toPdf, toJpeg };
})();
