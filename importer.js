// Reads estimate and invoice PDFs from Skynova and pulls out the customer, number,
// dates, line items, notes and totals. It works from where each piece of text sits
// on the page, so it copes with long task lists, wrapped lines and several pages.
(function () {
  'use strict';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFJS;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER; res(window.pdfjsLib); };
      s.onerror = () => rej(new Error('The PDF reader did not load. Check your internet connection and try again.'));
      document.head.appendChild(s);
    });
  }

  // ---- Text with positions, grouped into lines and cells ----
  async function readLines(file) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const lines = [];
    let yOff = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const frags = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
        const [, , c, d, e, f] = it.transform;
        return { str: it.str, x: e, y: yOff + (vp.height - f), w: it.width, size: Math.hypot(c, d) || 10, page: p };
      }).sort((a, b) => a.y - b.y || a.x - b.x);
      for (const fr of frags) {
        const ln = lines[lines.length - 1];
        if (ln && ln.page === p && Math.abs(ln.y - fr.y) <= Math.max(2.5, fr.size * 0.35)) ln.frags.push(fr);
        else lines.push({ y: fr.y, page: p, frags: [fr] });
      }
      yOff += vp.height + 40;
    }
    lines.forEach((l) => {
      l.frags.sort((a, b) => a.x - b.x);
      l.size = Math.max(...l.frags.map((f) => f.size));
      // Cells: runs of text separated by a wide gap, i.e. separate columns on the page.
      l.cells = [];
      l.frags.forEach((f) => {
        const c = l.cells[l.cells.length - 1];
        if (c && f.x - c.right < Math.max(6, f.size * 1.1)) {
          c.text += (f.x - c.right > f.size * 0.2 && !/\s$/.test(c.text) && !/^\s/.test(f.str) ? ' ' : '') + f.str;
          c.right = f.x + f.w;
        } else l.cells.push({ text: f.str, x: f.x, right: f.x + f.w, size: f.size });
      });
      l.cells.forEach((c) => { c.text = c.text.replace(/\s+/g, ' ').trim(); });
      l.cells = l.cells.filter((c) => c.text);
      l.text = l.cells.map((c) => c.text).join('   ');
    });
    return lines.filter((l) => l.cells.length);
  }

  // ---- Values ----
  const MONEY_RE = /^\(?-?\s*[$€£]?\s*-?\s*\d{1,3}(?:[,\s]?\d{3})*(?:\.\d{1,2})?\)?$/;
  function money(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/\s?(USD|usd)$/, '');
    if (!MONEY_RE.test(t)) return null;
    const n = parseFloat(t.replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : (/^\(|-/.test(t) ? -n : n);
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  function date(s) {
    if (!s) return '';
    const t = String(s).trim();
    let m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[1])}-${pad(m[2])}`; }
    m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
    m = t.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(m[1])}`;
    return '';
  }
  const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
  const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

  // "Label value", "Label: value", a value in the next cell, or just below the label.
  function findLabel(lines, re, opts = {}) {
    for (const l of lines) {
      for (let i = 0; i < l.cells.length; i++) {
        const c = l.cells[i];
        const m = c.text.match(re);
        if (!m || m.index > 0) continue;
        if (opts.not && opts.not.test(c.text)) continue;
        const rest = c.text.slice(m[0].length).replace(/^[\s:#.]+/, '').trim();
        if (rest) return { value: rest, line: l, cell: c };
        const next = l.cells[i + 1];
        if (next) return { value: next.text, line: l, cell: c };
        const below = lines.find((b) => b.y > l.y && b.y - l.y < l.size * 2.6 && b.cells.some((bc) => Math.abs(bc.x - c.x) < 30));
        if (below) return { value: below.cells.find((bc) => Math.abs(bc.x - c.x) < 30).text, line: l, cell: c };
      }
    }
    return null;
  }
  // A totals label with its number at the end of the same line.
  function findAmount(lines, re, after) {
    for (const l of lines) {
      if (after != null && l.y < after) continue;
      const idx = l.cells.findIndex((c) => re.test(c.text));
      if (idx < 0) continue;
      const vals = l.cells.slice(idx + 1).map((c) => money(c.text)).filter((v) => v != null);
      if (vals.length) return { value: vals[vals.length - 1] };
      const inline = l.cells[idx].text.replace(re, '').replace(/[^\d.,$()-]/g, ' ').trim().split(/\s+/).pop();
      if (money(inline) != null) return { value: money(inline) };
    }
    return null;
  }

  // ---- The table of line items ----
  const COLS = [
    ['item', /^(item|product|service|type)s?$/i],
    ['desc', /^(description|details|item description|work description)$/i],
    ['price', /^(unit price|unit cost|price|rate|cost)$/i],
    ['qty', /^(quantity|qty|hours|hrs|units)$/i],
    ['amount', /^(amount|line total|total)$/i]
  ];
  function findHeader(lines) {
    for (const l of lines) {
      const cols = {};
      l.cells.forEach((c) => { const hit = COLS.find(([, re]) => re.test(c.text)); if (hit && !cols[hit[0]]) cols[hit[0]] = c; });
      if ((cols.desc || cols.item) && cols.amount) return { line: l, cols };
    }
    return null;
  }
  const STOP_RE = /^(sub\s*-?total|total|notes?|terms|tax|sales tax|discount|amount paid|paid|payments?|balance|amount due|thank you)/i;

  function parseItems(lines, header) {
    const { cols } = header;
    const colList = Object.entries(cols).map(([k, c]) => ({ key: k, c, num: ['price', 'qty', 'amount'].includes(k) }));
    const textCols = colList.filter((x) => !x.num);
    const descLeft = cols.desc ? cols.desc.x - 6 : (cols.item ? cols.item.x : 0);
    const numLeft = Math.min(...colList.filter((x) => x.num).map((x) => x.c.x)) - 8;
    const rows = [];
    let stopY = null;
    for (const l of lines) {
      if (l.y <= header.line.y) continue;
      if (findHeader([l])) continue; // header repeated on a later page
      if (l.cells.some((c) => STOP_RE.test(c.text) && (c.x > numLeft - 120 || /^notes?|terms/i.test(c.text)))) { stopY = l.y; break; }
      const cells = { item: '', desc: '', price: null, qty: null, amount: null };
      l.cells.forEach((c) => {
        if (money(c.text) != null && c.x >= numLeft - 20) {
          const best = colList.filter((x) => x.num).sort((a, b) => Math.abs(c.right - a.c.right) - Math.abs(c.right - b.c.right))[0];
          if (best && cells[best.key] == null) cells[best.key] = money(c.text);
          else if (best) cells.amount = money(c.text);
        } else {
          let key = 'desc';
          if (textCols.length > 1) key = textCols.slice().sort((a, b) => Math.abs(c.x - a.c.x) - Math.abs(c.x - b.c.x))[0].key;
          else if (textCols.length === 1) key = textCols[0].key;
          if (c.x < descLeft && cols.item && cols.desc) key = 'item';
          cells[key] = (cells[key] ? cells[key] + ' ' : '') + c.text;
        }
      });
      const hasNumbers = cells.amount != null || cells.price != null;
      const textCells = l.cells.filter((c) => money(c.text) == null && c.x >= descLeft);
      const seg = { text: (cells.desc || (hasNumbers ? '' : cells.item)).trim(), right: Math.max(0, ...textCells.map((c) => c.right)), x: Math.min(...textCells.map((c) => c.x), 1e9), y: l.y };
      if (hasNumbers) rows.push({ item: cells.item.trim(), price: cells.price, qty: cells.qty, amount: cells.amount, segs: [seg] });
      else if (rows.length && seg.text) rows[rows.length - 1].segs.push(seg);
      else if (!rows.length && cells.desc) rows.push({ item: cells.item.trim(), price: null, qty: null, amount: null, segs: [seg] });
    }
    // Rebuild each description. The PDF wraps a line only when the next word doesn't fit,
    // so a line is joined to the one before it only when that line was full and this one
    // looks like its leftover end; every other line break (each task) is kept.
    const maxRight = Math.max(0, ...rows.flatMap((r) => r.segs.filter((g) => g.text).map((g) => g.right)));
    rows.forEach((r) => {
      let out = '';
      r.segs.filter((g) => g.text).forEach((g, i, arr) => {
        if (!i) { out = g.text; return; }
        const prev = arr[i - 1];
        const charW = (prev.right - prev.x) / Math.max(prev.text.length, 1);
        const firstWord = g.text.split(/\s+/)[0];
        const noRoom = prev.right + charW * (firstWord.length + 1) > maxRight - charW * 0.5;
        const leftover = /^[a-z(&,]/.test(g.text) || g.text.split(/\s+/).length <= 2;
        const wrapped = noRoom && leftover && !/[.:!?]$/.test(prev.text) && g.y - prev.y < 22;
        out += (wrapped ? ' ' : '\n') + g.text;
      });
      r.desc = out;
    });
    return { rows, stopY };
  }

  const KIND_MAP = [
    [/^(days?|hours?|hrs?|labou?r|install(ation)?|time)$/i, 'Labor'],
    [/^(materials?|products?|parts?|supplies|goods)$/i, 'Material'],
    [/^(expenses?|travel|mileage|fees?)$/i, 'Expense'],
    [/^(equipment|rental)$/i, 'Equipment'],
    [/^(sub(contract(or)?)?)$/i, 'Subcontract'],
    [/^(permits?)$/i, 'Permit'],
    [/^(services?)$/i, 'Service']
  ];
  const UNIT_MAP = { day: 'day', days: 'day', hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour' };
  function toLine(r) {
    let price = r.price, qty = r.qty, amount = r.amount;
    // Folio's Qty is the count (normally 1) and Rate is the price. If the count was typed in the
    // price box (e.g. 1.00 x 16800.00), put each number where it belongs.
    if (price != null && qty != null && amount != null && qty > price && Math.abs(price * qty - amount) < 0.01 && Number.isInteger(price) && price <= 20 && qty > 20) { const t = price; price = qty; qty = t; }
    if (qty == null && price != null && amount != null && Math.abs(price) > 0) qty = Math.round((amount / price) * 1000) / 1000;
    if (qty == null) qty = 1;
    if (price == null && amount != null) price = qty ? Math.round((amount / qty) * 100) / 100 : amount;
    if (amount == null) amount = Math.round(price * qty * 100) / 100;
    const item = (r.item || '').trim();
    const kindHit = KIND_MAP.find(([re]) => re.test(item));
    let desc = r.desc || '';
    if (item && !kindHit) desc = desc ? `${item}\n${desc}` : item;
    // Optional items: marked "(Optional)" / "Optional:" or entered with quantity 0.
    const optional = /\(optional\)|^optional\s*:/i.test(desc) || (qty === 0 && price > 0);
    if (optional) desc = desc.replace(/^optional\s*:\s*/i, '').replace(/\s*\(optional\)/ig, '').replace(/[ \t]+\n/g, '\n').trim();
    return { kind: kindHit ? kindHit[1] : 'Service', description: desc, qty, price: price || 0, unit: UNIT_MAP[item.toLowerCase()] || '', _amount: amount, _optional: optional, _picked: optional && qty > 0 };
  }

  // ---- Customer ----
  function splitCustomer(out) {
    const email = (out.find((t) => EMAIL_RE.test(t)) || '').match(EMAIL_RE);
    const phone = (out.find((t) => PHONE_RE.test(t) && !EMAIL_RE.test(t)) || '').match(PHONE_RE);
    const rest = out.filter((t) => !EMAIL_RE.test(t) && !(PHONE_RE.test(t) && t.replace(PHONE_RE, '').replace(/[^a-z]/gi, '').length < 4));
    return { name: rest[0] || '', address: rest.slice(1).join('\n'), email: email ? email[0] : '', phone: phone ? phone[0].trim() : '' };
  }
  // Skynova has no "To" label: the left column above the table holds your company first, then the customer.
  function customerByBlocks(lines, header) {
    const left = Math.min(...lines.map((l) => l.cells[0].x));
    const top = lines.filter((l) => l.page === 1 && (!header || l.y < header.line.y));
    const blocks = [];
    let lastY = null;
    top.forEach((l) => {
      const c = l.cells.find((x) => Math.abs(x.x - left) < 20);
      if (!c || /^(from|invoice|estimate|date|due|item)\b/i.test(c.text)) return;
      if (lastY == null || l.y - lastY > l.size * 2.2) blocks.push([]);
      blocks[blocks.length - 1].push(c.text);
      lastY = l.y;
    });
    const b = blocks.length > 1 ? blocks[1] : null;
    return b && b.length ? splitCustomer(b) : null;
  }
  function parseCustomer(lines, header) {
    const re = /^(bill(ed)?\s+to|to|client|customer|prepared for|ship to|sold to)\b\s*:?/i;
    const lab = findLabel(lines, re, { not: /^total/i });
    if (!lab) return customerByBlocks(lines, header);
    const startX = lab.cell.x;
    const out = [];
    const same = lab.cell.text.replace(re, '').trim();
    if (same) out.push(same);
    let lastY = lab.line.y;
    for (const l of lines) {
      if (l.y <= lab.line.y) continue;
      if (header && l.y >= header.line.y) break;
      if (l.y - lastY > l.size * 2.4) break;
      const c = l.cells.find((x) => Math.abs(x.x - startX) < 28);
      if (!c) continue;
      if (/^(from|invoice|estimate|quote|date|due|terms|po\b|p\.o\.)/i.test(c.text)) break;
      out.push(c.text);
      lastY = l.y;
    }
    return out.length ? splitCustomer(out) : customerByBlocks(lines, header);
  }

  // ---- Notes: every line kept as written, wrapped sentences rejoined ----
  function parseNotes(lines, afterY, rightLimit) {
    const NOTE_RE = /^(notes?|terms|comments?|memo)\b\s*:?/i;
    const lab = lines.find((l) => (afterY == null || l.y >= afterY - 2) && l.cells.some((c) => NOTE_RE.test(c.text) && c.x < rightLimit));
    if (!lab) return '';
    const cell = lab.cells.find((c) => NOTE_RE.test(c.text));
    const out = [];
    const same = cell.text.replace(NOTE_RE, '').trim();
    if (same) out.push(same);
    let lastY = lab.y;
    for (const l of lines) {
      if (l.y <= lab.y) continue;
      if (l.y - lastY > l.size * 3) break;
      const parts = l.cells.filter((c) => c.x < rightLimit - 10);
      if (!parts.length) continue;
      if (/^(thank you|page \d)/i.test(parts[0].text) && out.length) break;
      const text = parts.map((c) => c.text).join(' ');
      if (out.length && /^[a-z(&,]/.test(text)) out[out.length - 1] += ' ' + text; else out.push(text);
      lastY = l.y;
    }
    return out.join('\n').replace(/[ \t]+/g, ' ').trim();
  }

  async function parsePdf(file) {
    const warnings = [];
    let lines;
    try { lines = await readLines(file); } catch (e) { return { ok: false, error: e.message || 'This PDF could not be read.' }; }
    if (!lines.length) return { ok: false, error: 'No text found. This PDF may be a scanned image.' };
    const all = lines.map((l) => l.text).join('\n');

    // Type from the big title ("Estimate", "E S T I M A T E", "INVOICE"); Skynova says "Invoice #" on both.
    const squash = (t) => t.replace(/\s+/g, '');
    const title = lines.flatMap((l) => l.cells).filter((c) => /^(estimate|quote|quotation|invoice|bid|proposal)$/i.test(squash(c.text))).sort((a, b) => b.size - a.size)[0];
    const titleType = title ? (/invoice/i.test(squash(title.text)) ? 'invoice' : 'estimate') : null;
    let type = titleType || (/\b(estimate|quote|quotation)\s*#/i.test(all) ? 'estimate' : 'invoice');

    const num = findLabel(lines, /^(invoice|estimate|quote|quotation|proposal|bid)?\s*(#|no\.?|number)\s*:?/i);
    const number = num ? num.value.replace(/^#/, '').split(/\s{2,}/)[0].trim() : '';
    if (!titleType && num && /estimate|quote|proposal|bid/i.test(num.cell.text)) type = 'estimate';
    const issue = findLabel(lines, /^((invoice|estimate|quote|issue|bill)\s+)?date\b\s*:?/i, { not: /due|expir|valid/i });
    const due = findLabel(lines, /^(due date|payment due|due|valid until|expiry date|expiration date|expires|valid through)\b\s*:?/i);

    const header = findHeader(lines);
    let items = [];
    let stopY = null;
    if (header) {
      const parsed = parseItems(lines, header);
      stopY = parsed.stopY;
      items = parsed.rows.filter((r) => r.amount != null || r.price != null).map(toLine);
    }
    if (!items.length) warnings.push('No line items found');

    const after = stopY != null ? stopY - 2 : null;
    const sub = findAmount(lines, /^sub\s*-?total\b/i, after);
    const disc = findAmount(lines, /^discount\b/i, after);
    const tax = findAmount(lines, /^((sales\s+)?tax|vat|gst|hst)\b/i, after);
    const total = findAmount(lines, /^(total|grand total|estimate total|invoice total)\b(?!\s*paid)/i, after);
    const paid = findAmount(lines, /^(amount paid|paid|payments?|payment received|deposit received)\b/i, after);
    const balance = findAmount(lines, /^(balance due|balance|amount due)\b/i, after);

    const customer = parseCustomer(lines, header);
    if (!customer || !customer.name) warnings.push('Customer not found');
    if (!number) warnings.push('Number not found');

    const rightLimit = header && header.cols.price ? header.cols.price.x : 330;
    const notes = parseNotes(lines, stopY, rightLimit);

    const lineSum = Math.round(items.reduce((s, it) => s + it._amount, 0) * 100) / 100;
    const subtotal = sub ? sub.value : lineSum;
    const discount = disc ? Math.abs(disc.value) : 0;
    const taxAmt = tax ? tax.value : 0;
    const taxRate = taxAmt && subtotal - discount > 0 ? Math.round((taxAmt / (subtotal - discount)) * 100000) / 1000 : 0;
    const grand = total ? total.value : Math.round((subtotal - discount + taxAmt) * 100) / 100;
    if (items.length && Math.abs(lineSum - subtotal) > 0.05) warnings.push(`Line items add up to ${lineSum.toFixed(2)}, the PDF says ${subtotal.toFixed(2)}`);

    let amountPaid = paid ? Math.abs(paid.value) : 0;
    if (!paid && balance && type === 'invoice') amountPaid = Math.max(0, Math.round((grand - balance.value) * 100) / 100);

    items.forEach((it) => {
      if (it._optional && type === 'estimate') { it.option = 'addon'; it.selected = !!it._picked; if (!(it.qty > 0)) it.qty = 1; }
      delete it._amount; delete it._optional; delete it._picked;
    });
    // Skynova estimates carry a "due date" equal to the issue date; leave "valid until" empty instead.
    const issueDate = date(issue && issue.value);
    let dueDate = date(due && due.value);
    if (type === 'estimate' && dueDate && dueDate <= issueDate) dueDate = '';
    return {
      ok: true, warnings, type, number, issue_date: issueDate, due_date: dueDate,
      customer: customer || { name: '', address: '', email: '', phone: '' },
      items, notes, discount, tax_rate: taxRate, total: grand, amount_paid: type === 'invoice' ? amountPaid : 0
    };
  }

  window.FolioImport = { parsePdf, loadPdfJs };
})();
