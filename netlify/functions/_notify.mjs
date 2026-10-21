import ExcelJS from 'exceljs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n) { return String(n).padStart(2, '0'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function r2(n) { return Math.round(n * 100) / 100; }
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function brandById(cfg, id) {
  const b = (cfg.brands || []).find((x) => x.id === id);
  return b || { id, name: id || '(unknown)', group: 'internal' };
}

function mondayOfWeek(weekStr) {
  const [y, w] = weekStr.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const mon = new Date(jan4.getTime());
  mon.setUTCDate(jan4.getUTCDate() - day + 1 + (w - 1) * 7);
  return mon;
}
function weekRangeLabel(weekStr) {
  const mon = mondayOfWeek(weekStr);
  const sun = new Date(mon.getTime()); sun.setUTCDate(mon.getUTCDate() + 6);
  const f = (d) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return `${f(mon)} \u2013 ${f(sun)}`;
}
function weekLabel(weekStr) { return 'Week ' + weekStr.split('-W')[1]; }

// ---- Style constants — dark header row and red title echo the reference
// workbook and the app's own look (Alimentastic red, #D6001C). ----
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 11 };
const BASE_FONT = { name: 'Arial', size: 11 };
const BOLD_FONT = { name: 'Arial', size: 11, bold: true };
const TITLE_FONT = { bold: true, color: { argb: 'FFD6001C' }, name: 'Arial', size: 14 };
const MUTED_FONT = { italic: true, color: { argb: 'FF6B6B6B' }, name: 'Arial', size: 10 };

function styleHeaderRow(row) {
  row.eachCell((c) => { c.fill = HEADER_FILL; c.font = HEADER_FONT; c.alignment = { vertical: 'middle' }; });
  row.height = 22;
}

const COLS = [
  { header: 'Date', width: 12 },
  { header: 'Employee', width: 26 },
  { header: 'Employee Type', width: 14 },
  { header: 'Brand / Project', width: 22 },
  { header: 'Hours', width: 9 },
  { header: 'Task', width: 18 },
  { header: 'Notes', width: 32 },
  { header: 'BMD Hours (Day)', width: 16 },
  { header: 'Difference to BMD', width: 16 }
];

function addAboutSheet(wb, team) {
  const ws = wb.addWorksheet('About');
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 90;
  const title = ws.addRow(['Brand Time', `${team} hours report \u2014 Alimentastic GmbH`]);
  title.getCell(1).font = TITLE_FONT;
  title.getCell(2).font = BOLD_FONT;
  ws.addRow([]);
  const rows = [
    ['Purpose', 'Allocation of employee hours to brands, so REPLOID-facing work can be measured against its share of the retainer.'],
    ['Who', `Every member of the ${team} team, logged individually.`],
    ['Granularity', 'One row per employee, day and brand/project.'],
    ['Unassignable hours', 'Recorded under Team & planning, Admin & reporting, Recruiting & onboarding or Learning & development rather than a brand.'],
    ['BMD reconciliation', 'Each employee also enters the day\u2019s total hours as logged in BMD (the \u201cBMD Hours (Day)\u201d column). The Difference column should read 0.'],
    ['Evaluation sheet', 'Sums hours automatically per brand and per week.'],
    ['Note', 'Hours are self-reported by each employee and are not the official working-time record \u2014 BMD remains the system of record.'],
    ['Generated', 'Automatically by Brand Time. This workbook is a report, not a form \u2014 there are no cells to fill in.']
  ];
  rows.forEach(([a, b]) => {
    const r = ws.addRow([a, b]);
    r.getCell(1).font = BOLD_FONT;
    r.getCell(2).font = BASE_FONT;
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  });
}

/* One sheet per week. Returns metadata (+cached brand totals) so the
   Evaluation sheet can both reference these cells by formula and show a
   correct number immediately, without depending on the viewer recalculating. */
function addWeekSheet(wb, cfg, weekStr, rowsForWeek, team) {
  const name = weekLabel(weekStr).slice(0, 31);
  const ws = wb.addWorksheet(name);
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  ws.mergeCells(1, 1, 1, 9);
  ws.getCell(1, 1).value = `${team} \u2014 ${weekLabel(weekStr)} \u2014 ${weekRangeLabel(weekStr)}`;
  ws.getCell(1, 1).font = TITLE_FONT;
  ws.mergeCells(2, 1, 2, 9);
  ws.getCell(2, 1).value = 'Generated automatically by Brand Time \u2014 not a form to fill in.';
  ws.getCell(2, 1).font = MUTED_FONT;

  const flat = [];
  rowsForWeek.forEach((rec) => {
    const days = (rec.doc && rec.doc.days) || {};
    Object.keys(days).sort().forEach((k) => {
      if (!DATE_RE.test(k)) return;
      const d = days[k] || {};
      const worked = Number(d.worked) || 0;
      (d.rows || []).forEach((row) => {
        const b = brandById(cfg, row.b);
        flat.push({
          date: k, employee: rec.email || '(unknown)', type: 'Internal', brand: b.name,
          hours: Number(row.h) || 0, task: row.t || '', notes: row.n || '', bmd: worked
        });
      });
    });
  });

  const headerRowIdx = 4;
  const headerRow = ws.getRow(headerRowIdx);
  COLS.forEach((c, i) => { headerRow.getCell(i + 1).value = c.header; });
  styleHeaderRow(headerRow);
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];

  const firstDataRow = headerRowIdx + 1;
  const lastDataRow = firstDataRow + Math.max(flat.length, 1) - 1;

  // Per person+day totals, needed for the Difference formula's cached result.
  const groupSum = {};
  flat.forEach((f) => {
    const key = f.employee + '||' + f.date;
    groupSum[key] = (groupSum[key] || 0) + f.hours;
  });

  const brandTotals = new Map();
  flat.forEach((f, i) => {
    const rowNum = firstDataRow + i;
    const r = ws.getRow(rowNum);
    r.getCell(1).value = new Date(f.date + 'T00:00:00Z');
    r.getCell(1).numFmt = 'dd.mm.yyyy';
    r.getCell(2).value = f.employee;
    r.getCell(3).value = f.type;
    r.getCell(4).value = f.brand;
    r.getCell(5).value = f.hours;
    r.getCell(5).numFmt = '0.00';
    r.getCell(6).value = f.task;
    r.getCell(7).value = f.notes;
    r.getCell(8).value = f.bmd;
    r.getCell(8).numFmt = '0.00';
    const diff = r2(groupSum[f.employee + '||' + f.date] - f.bmd);
    r.getCell(9).value = {
      formula: `IF(OR(B${rowNum}="",H${rowNum}=""),"",SUMIFS($E$${firstDataRow}:$E$${lastDataRow},$B$${firstDataRow}:$B$${lastDataRow},B${rowNum},$A$${firstDataRow}:$A$${lastDataRow},A${rowNum})-H${rowNum})`,
      result: diff
    };
    r.getCell(9).numFmt = '0.00';
    r.eachCell((c) => { if (!c.font || c.font === BASE_FONT) c.font = BASE_FONT; });
    brandTotals.set(f.brand, (brandTotals.get(f.brand) || 0) + f.hours); // exact; rounded only when written
  });
  if (!flat.length) {
    ws.getRow(firstDataRow).getCell(1).value = 'No entries for this week.';
    ws.getRow(firstDataRow).getCell(1).font = MUTED_FONT;
  }

  const weekTotal = flat.reduce((s, f) => s + f.hours, 0); // exact; rounded only when written
  ws.getCell(3, 4).value = 'Total hours';
  ws.getCell(3, 4).font = BOLD_FONT;
  ws.getCell(3, 5).value = flat.length
    ? { formula: `SUM(E${firstDataRow}:E${lastDataRow})`, result: r2(weekTotal) }
    : 0;
  ws.getCell(3, 5).font = BOLD_FONT;
  ws.getCell(3, 5).numFmt = '0.00';

  return {
    sheetName: name, firstDataRow, lastDataRow: flat.length ? lastDataRow : firstDataRow - 1,
    brandCol: 'D', hoursCol: 'E', brandTotals, weekTotal
  };
}

function addEvaluationSheet(wb, cfg, weekMeta) {
  const ws = wb.addWorksheet('Evaluation');
  ws.getCell(1, 1).value = 'Evaluation \u2014 hours per brand and week';
  ws.getCell(1, 1).font = TITLE_FONT;
  ws.getCell(2, 1).value = 'Summed automatically from each week sheet.';
  ws.getCell(2, 1).font = MUTED_FONT;

  const brands = (cfg.brands || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const headerRowIdx = 4;
  const header = ws.getRow(headerRowIdx);
  header.getCell(1).value = 'Brand / Project';
  weekMeta.forEach((wm, i) => { header.getCell(2 + i).value = wm.sheetName; });
  header.getCell(2 + weekMeta.length).value = 'Total';
  styleHeaderRow(header);
  ws.getColumn(1).width = 24;
  weekMeta.forEach((_, i) => { ws.getColumn(2 + i).width = 12; });
  ws.getColumn(2 + weekMeta.length).width = 12;

  brands.forEach((b, ri) => {
    const rowNum = headerRowIdx + 1 + ri;
    const r = ws.getRow(rowNum);
    r.getCell(1).value = b.name;
    r.getCell(1).font = BASE_FONT;
    let rowTotal = 0;
    weekMeta.forEach((wm, ci) => {
      const raw = wm.brandTotals.get(b.name) || 0;
      const val = r2(raw);
      rowTotal += raw;
      const cell = r.getCell(2 + ci);
      cell.value = wm.lastDataRow >= wm.firstDataRow
        ? { formula: `SUMIFS('${wm.sheetName}'!$${wm.hoursCol}$${wm.firstDataRow}:$${wm.hoursCol}$${wm.lastDataRow},'${wm.sheetName}'!$${wm.brandCol}$${wm.firstDataRow}:$${wm.brandCol}$${wm.lastDataRow},$A${rowNum})`, result: val }
        : 0;
      cell.numFmt = '0.00';
      cell.font = BASE_FONT;
    });
    const totalCell = r.getCell(2 + weekMeta.length);
    totalCell.value = {
      formula: `SUM(${colLetter(2)}${rowNum}:${colLetter(1 + weekMeta.length)}${rowNum})`,
      result: r2(rowTotal)
    };
    totalCell.numFmt = '0.00';
    totalCell.font = BOLD_FONT;
  });

  const totalRowIdx = headerRowIdx + 1 + brands.length;
  const totalRow = ws.getRow(totalRowIdx);
  totalRow.getCell(1).value = 'Total';
  totalRow.getCell(1).font = BOLD_FONT;
  for (let c = 2; c <= 2 + weekMeta.length; c++) {
    const colL = colLetter(c);
    let sum = 0;
    if (c - 2 < weekMeta.length) sum = r2(weekMeta[c - 2].weekTotal);
    else weekMeta.forEach((wm) => { sum += wm.weekTotal; });
    sum = r2(sum);
    totalRow.getCell(c).value = { formula: `SUM(${colL}${headerRowIdx + 1}:${colL}${totalRowIdx - 1})`, result: sum };
    totalRow.getCell(c).numFmt = '0.00';
    totalRow.getCell(c).font = BOLD_FONT;
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
}

/* Builds one workbook covering a single week — About + that week's sheet +
   an Evaluation sheet — for the automatic completion email. */
export async function buildWeekWorkbook(cfg, week, rows, team = 'Team') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Brand Time';
  wb.created = new Date();
  addAboutSheet(wb, team);
  const wm = addWeekSheet(wb, cfg, week, rows, team);
  addEvaluationSheet(wb, cfg, [wm]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/* Sends via Resend's HTTP API — no SDK, just fetch. Requires RESEND_API_KEY.
   RESEND_FROM defaults to Resend's shared sandbox sender, which only
   delivers to the address you signed up to Resend with — set a verified
   domain sender for anything else. */
export async function sendWeekEmail({ to, week, buffer, complete, total, team = 'Team' }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set.');
  const from = process.env.RESEND_FROM || 'Brand Time <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: Array.isArray(to) ? to : [to],
      subject: `Brand Time \u2014 ${team} \u2014 week ${week} complete (${complete}/${total})`,
      html: `<p>Everyone in <b>${esc(team)}</b> has submitted week <b>${week}</b>.</p>
             <p>The attached workbook has an About sheet, that week's detail, and an Evaluation sheet summing hours per brand.</p>`,
      attachments: [{
        filename: `brand-time_${String(team).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'}_${week}.xlsx`,
        content: buffer.toString('base64')
      }]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend rejected the email (${res.status}): ${body.slice(0, 200)}`);
  }
}
