#!/usr/bin/env node
/**
 * 從 Dropbox 分享連結（或本機資料夾）讀取 15 個商品 .xls，轉成與 update.html 完全相同格式的 data.json。
 * 直接讀原始 Excel 檔（SheetJS），不經過任何文字擷取，所以不會有科學記號、截斷等問題。
 *
 * 用法：
 *   DROPBOX_LINKS="$(cat links.txt)" node scripts/sync-from-dropbox.js <輸出 json 路徑>
 *   node scripts/sync-from-dropbox.js <輸出 json 路徑> --dir <放 15 個 xls 的資料夾>   （本機測試用）
 *
 * DROPBOX_LINKS 格式：每行「編號 空白 網址」，編號 01~15，例如
 *   01 https://www.dropbox.com/scl/fi/xxxx/....xls?rlkey=...&dl=0
 *
 * 任何一個檔案下載失敗、格式不對、讀不到資料，整批中止（不輸出任何檔案）。
 * 明碼 data.json 永遠不要 commit。
 */
const fs = require('fs');
const path = require('path');

// 編號 → 分類名稱（與 repo 現有資料的 cats[].key 完全一致；順序也就是 cats 的順序）
const CATEGORIES = {
  '01': '新版01沙龍美髮',
  '02': '新版02沙龍美髮',
  '03': '新版03日系專櫃',
  '04': '新版04日系開架',
  '05': '新版05日系開架',
  '06': '新版06歐美品牌',
  '07': '新版07韓國品牌',
  '08': '新版08台灣品牌 大嘉行',
  '09': '新版09彩妝 今英',
  '10': '新版10香水',
  '11': '新版11零開頭',
  '12': '新版12美髮器材',
  '13': '新版13內衣襪子',
  '14': '新版14睫毛',
  '15': '新版15泰國品牌',
};
const IDS = Object.keys(CATEGORIES).sort();

const SCI_RE = /^-?\d+(\.\d+)?E[+-]\d+$/i;

function findHeaderRowIndex(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 5); i++) {
    const row = aoa[i].map(c => String(c || '').toLowerCase().trim());
    if (row.includes('description') && row.includes('barcode')) return i;
  }
  return 0;
}

// 條碼 / 編號欄：數字格要是安全的整數；文字格不可是科學記號
function codeToString(v, label, desc, fmt) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || Math.abs(v) >= 1e15) {
      throw new Error(`${label} 不是安全的整數（${v}），商品「${desc}」`);
    }
    const plain = String(v);
    // 數字格若設了「補零」格式（顯示 0095…），保留顯示的樣子
    if (typeof fmt === 'string' && /^\d+$/.test(fmt) && fmt.replace(/^0+/, '') === plain) return fmt;
    return plain;
  }
  const s = String(v);
  if (SCI_RE.test(s.trim())) throw new Error(`${label} 是科學記號（${s}），商品「${desc}」`);
  return s;
}

// 價格欄：維持 update.html 的行為（數字就是數字、空白是 null）；字串嘗試轉數字，轉不了就中止
function priceValue(v, label, desc) {
  // v 是「儲存格顯示的文字」（和現有網站資料、Dropbox 文字擷取一致，例如 11.8125 顯示成 11.81）
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  if (isNaN(n)) throw new Error(`${label} 不是數字（${s}），商品「${desc}」`);
  return n;
}

function parseWorkbook(XLSX, buf, id) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'product');
  if (!sheetName) {
    let best = null;
    for (const n of wb.SheetNames) {
      const ref = wb.Sheets[n]['!ref'];
      if (!ref) continue;
      const rc = XLSX.utils.decode_range(ref).e.r;
      if (!best || rc > best.rc) best = { name: n, rc };
    }
    sheetName = best ? best.name : wb.SheetNames[0];
  }
  const ws = wb.Sheets[sheetName];
  const opt = { header: 1, defval: null, blankrows: false };
  const aoa = XLSX.utils.sheet_to_json(ws, { ...opt, raw: true });   // 原始值
  const fmtAoa = XLSX.utils.sheet_to_json(ws, { ...opt, raw: false }); // 顯示文字
  if (!aoa.length) throw new Error('工作表是空的');
  if (aoa.length !== fmtAoa.length) throw new Error('原始值與顯示值的列數不一致');

  const headerIdx = findHeaderRowIndex(aoa);
  const lower = aoa[headerIdx].map(h => String(h || '').trim().toLowerCase());
  const col = n => lower.indexOf(n);
  const cNote = col('note'), cCode = col('customcode'), cBarcode = col('barcode'),
        cDesc = col('description'), cCost = col('averagecost'),
        cA = col('pricea'), cB = col('priceb'), cC = col('pricec'), cD = col('priced'),
        cSell = col('sellingprice');
  if (cDesc === -1) throw new Error('找不到 DESCRIPTION 欄位');

  const rows = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i];
    const f = fmtAoa[i];
    const desc = r[cDesc];
    if (desc === null || desc === undefined || String(desc).trim() === '') continue;
    const d = String(desc).trim();
    rows.push([
      0, // 稍後填入分類序號
      cNote > -1 ? (f[cNote] ?? '') : '',
      cCode > -1 ? codeToString(r[cCode], 'CUSTOMCODE', d, f[cCode]) : '',
      cBarcode > -1 ? codeToString(r[cBarcode], 'BARCODE', d, f[cBarcode]) : '',
      d,
      cCost > -1 ? priceValue(f[cCost], 'AVERAGECOST', d) : null,
      cA > -1 ? priceValue(f[cA], 'PRICEA', d) : null,
      cB > -1 ? priceValue(f[cB], 'PRICEB', d) : null,
      cC > -1 ? priceValue(f[cC], 'PRICEC', d) : null,
      cD > -1 ? priceValue(f[cD], 'PRICED', d) : null,
      cSell > -1 ? priceValue(f[cSell], 'SELLINGPRICE', d) : null,
    ]);
  }
  if (!rows.length) throw new Error('沒有任何商品列');
  return rows;
}

function isExcelBuffer(buf) {
  if (buf.length < 1000) return false;
  const ole = buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0; // .xls
  const zip = buf[0] === 0x50 && buf[1] === 0x4B; // .xlsx
  return ole || zip;
}

function directUrl(u) {
  const url = new URL(u);
  url.searchParams.set('dl', '1');
  return url.toString();
}

function parseLinks(text) {
  const map = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{2})\s+(https:\/\/\S+)$/);
    if (m) map[m[1]] = m[2];
  }
  const missing = IDS.filter(id => !map[id]);
  if (missing.length) throw new Error('DROPBOX_LINKS 缺少編號：' + missing.join(', '));
  return map;
}

async function download(url, id) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(directUrl(url), { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isExcelBuffer(buf)) throw new Error('下載到的不是 Excel 檔（可能連結失效或需要登入），大小 ' + buf.length);
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`第 ${id} 號檔案下載失敗：${lastErr.message}`);
}

function loadLocal(dir) {
  const files = fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f));
  const out = {};
  for (const id of IDS) {
    const hits = files.filter(f => f.includes('新版' + id));
    if (hits.length !== 1) throw new Error(`資料夾裡「新版${id}」的檔案找到 ${hits.length} 個`);
    out[id] = fs.readFileSync(path.join(dir, hits[0]));
  }
  return out;
}

async function build(buffers, XLSX) {
  const cats = [], rows = [], report = [];
  for (const id of IDS) {
    try {
      const catRows = parseWorkbook(XLSX, buffers[id], id);
      const catIdx = cats.length;
      cats.push({ name: CATEGORIES[id], key: CATEGORIES[id] });
      for (const r of catRows) { r[0] = catIdx; rows.push(r); }
      report.push({ id, rows: catRows.length });
    } catch (e) {
      throw new Error(`第 ${id} 號（${CATEGORIES[id]}）解析失敗：${e.message}`);
    }
  }
  return { cats, rows, report };
}

async function main() {
  const args = process.argv.slice(2);
  const out = args[0];
  const dirIdx = args.indexOf('--dir');
  if (!out) { console.error('用法：node scripts/sync-from-dropbox.js <輸出json> [--dir <資料夾>]'); process.exit(1); }
  const XLSX = require('xlsx');

  let buffers = {};
  if (dirIdx > -1) {
    buffers = loadLocal(args[dirIdx + 1]);
  } else {
    const links = parseLinks(process.env.DROPBOX_LINKS);
    for (const id of IDS) buffers[id] = await download(links[id], id);
  }

  const { cats, rows, report } = await build(buffers, XLSX);

  // 防呆：總筆數比上一版少太多，多半是檔案壞掉或抓到半份
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.meta.json'), 'utf8'));
    if (meta.rows && rows.length < meta.rows * 0.6) {
      throw new Error(`商品總數 ${rows.length} 比上一版 ${meta.rows} 少超過四成，疑似資料不完整，已中止`);
    }
  } catch (e) {
    if (String(e.message).includes('已中止')) throw e;
  }

  fs.writeFileSync(out, JSON.stringify({ cats, rows }));
  console.log(`已轉換 ${report.length} 個檔案，共 ${rows.length} 筆商品，${cats.length} 個分類`);
  for (const r of report) console.log(`  ✓ ${r.id} ${CATEGORIES[r.id]} ${r.rows} 筆`);
}

if (require.main === module) {
  main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}

module.exports = { build, parseWorkbook, parseLinks, CATEGORIES, IDS };
