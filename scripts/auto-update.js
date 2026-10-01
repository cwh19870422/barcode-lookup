#!/usr/bin/env node
/**
 * Automated product-data converter for 喬大百貨 POS.
 *
 * Mirrors the exact field-mapping logic of update.html's handleFiles()
 * (same header names, same row-building order), but runs headlessly over
 * plain-text TSV dumps of each category's Excel "product" sheet instead of
 * parsing the binary .xls/.xlsx directly. The text dumps are produced by
 * Dropbox's own file-content extraction (mcp__Dropbox__fetch), because this
 * sandbox's outbound network allowlist cannot download the raw Dropbox
 * file bytes directly (dl.dropboxusercontent.com is not on the allowlist).
 *
 * Expected input format per file (what mcp__Dropbox__fetch returns in its
 * "text" field, saved verbatim to a .txt file): one or more sheets, each
 * introduced by a line with NO leading tab (the sheet name), followed by
 * tab-separated rows (every row — including the header row — starts with a
 * leading tab because column A in these workbooks is blank).
 *
 * Usage:
 *   node scripts/auto-update.js <textDir> <outputJsonPath>
 *
 * <textDir>        folder of .txt files, one per category, each containing
 *                   the raw fetch() "text" for that 新版N*.xls file. The
 *                   filename (minus .txt) is used as the category key,
 *                   exactly like update.html uses the uploaded filename.
 * <outputJsonPath> where to write the resulting data.json
 */
const fs = require('fs');
const path = require('path');

function deriveCategoryKey(filename) {
  // unique per source file, kept EXACTLY as the original filename (no _ / space conversion)
  let name = filename.replace(/\.(xls|xlsx|txt)$/i, '');
  return name.trim() || filename;
}

function deriveCategoryLabel(filename) {
  return deriveCategoryKey(filename);
}

// Split a Dropbox-extracted workbook text dump into { name, rows: [ [cell,...], ... ] } sheets.
function splitSheets(text) {
  const lines = text.split('\n');
  const sheets = [];
  let current = null;
  for (const rawLine of lines) {
    if (rawLine === '') continue; // blank separator line
    if (!rawLine.startsWith('\t')) {
      // sheet-name line
      current = { name: rawLine.trim(), rows: [] };
      sheets.push(current);
    } else if (current) {
      current.rows.push(rawLine.split('\t'));
    }
    // a tab-prefixed line before any sheet name is malformed input; ignore it
  }
  return sheets;
}

function pickProductSheet(sheets) {
  let sheet = sheets.find(s => s.name.toLowerCase() === 'product');
  if (!sheet) {
    // fall back to the sheet with the most data rows
    sheet = sheets.reduce((best, s) => (!best || s.rows.length > best.rows.length) ? s : best, null);
  }
  return sheet;
}

function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i].map(c => String(c || '').toLowerCase().trim());
    if (row.includes('description') && row.includes('barcode')) return i;
  }
  return 0;
}

function toNum(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// Dropbox's text extraction occasionally renders a long numeric-looking
// barcode/customcode cell in scientific notation (e.g. "4.98834E+12")
// instead of the original digit string. This is an unrecoverable, silent
// data-corruption risk for barcode scanning, so any row whose barcode or
// customcode looks like scientific notation must cause a hard failure for
// that file (never a silently-written bad barcode).
const SCI_NOTATION_RE = /^-?\d+(\.\d+)?E[+-]\d+$/i;
function looksLikeScientificNotation(v) {
  return typeof v === 'string' && SCI_NOTATION_RE.test(v.trim());
}

function convertFolder(inputDir) {
  const allFiles = fs.readdirSync(inputDir).filter(f => /\.txt$/i.test(f));
  const files = allFiles.slice().sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  if (!files.length) {
    throw new Error('沒有找到任何 .txt 檔案於 ' + inputDir);
  }

  let cats = [];
  let rows = [];
  const catIndexMap = {};
  const report = [];

  for (const filename of files) {
    const filePath = path.join(inputDir, filename);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const sheets = splitSheets(text);
      if (!sheets.length) throw new Error('解析不到任何工作表內容');

      const sheet = pickProductSheet(sheets);
      if (!sheet || !sheet.rows.length) throw new Error('工作表是空的');

      const headerIdx = findHeaderRowIndex(sheet.rows);
      const headers = sheet.rows[headerIdx].map(h => String(h || '').trim());
      const lowerHeaders = headers.map(h => h.toLowerCase());
      const col = (name) => lowerHeaders.indexOf(name.toLowerCase());
      const cNote = col('note'), cCode = col('customcode'), cBarcode = col('barcode'),
            cDesc = col('description'), cCost = col('averagecost'),
            cA = lowerHeaders.indexOf('pricea'), cB = lowerHeaders.indexOf('priceb'),
            cC = lowerHeaders.indexOf('pricec'), cD = lowerHeaders.indexOf('priced'),
            cSell = lowerHeaders.indexOf('sellingprice');

      if (cDesc === -1) throw new Error('找不到 DESCRIPTION 欄位，跳過此檔');

      const catKey = deriveCategoryKey(filename);
      const catLabel = deriveCategoryLabel(filename);
      let catIdx;
      if (catIndexMap.hasOwnProperty(catKey)) {
        catIdx = catIndexMap[catKey];
      } else {
        catIdx = cats.length;
        cats.push({ name: catLabel, key: catKey });
        catIndexMap[catKey] = catIdx;
      }

      let rowCount = 0;
      for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
        const r = sheet.rows[i];
        const desc = cDesc > -1 ? r[cDesc] : null;
        if (desc === null || desc === undefined || String(desc).trim() === '') continue;

        const rawCode = cCode > -1 ? r[cCode] : undefined;
        const rawBarcode = cBarcode > -1 ? r[cBarcode] : undefined;
        if (looksLikeScientificNotation(rawCode) || looksLikeScientificNotation(rawBarcode)) {
          throw new Error(
            `條碼/編號被 Dropbox 文字擷取誤轉為科學記號（資料已不可逆失真，整批中止不寫入）：` +
            `商品「${String(desc).trim()}」 CUSTOMCODE=${rawCode} BARCODE=${rawBarcode}`
          );
        }

        rows.push([
          catIdx,
          cNote > -1 ? (r[cNote] ?? '') : '',
          cCode > -1 ? String(r[cCode] ?? '') : '',
          cBarcode > -1 ? String(r[cBarcode] ?? '') : '',
          String(desc).trim(),
          cCost > -1 ? toNum(r[cCost]) : null,
          cA > -1 ? toNum(r[cA]) : null,
          cB > -1 ? toNum(r[cB]) : null,
          cC > -1 ? toNum(r[cC]) : null,
          cD > -1 ? toNum(r[cD]) : null,
          cSell > -1 ? toNum(r[cSell]) : null,
        ]);
        rowCount++;
      }
      report.push({ file: filename, category: catLabel, rows: rowCount, ok: true });
    } catch (err) {
      report.push({ file: filename, ok: false, error: err.message || String(err) });
    }
  }

  const failed = report.filter(r => !r.ok);
  if (failed.length) {
    const msg = failed.map(f => `  ✗ ${f.file}: ${f.error}`).join('\n');
    throw new Error('部分檔案解析失敗，已中止（不產生部分資料）：\n' + msg);
  }

  return { cats, rows, report };
}

function main() {
  const [, , inputDir, outputPath] = process.argv;
  if (!inputDir || !outputPath) {
    console.error('Usage: node scripts/auto-update.js <textDir> <outputJsonPath>');
    process.exit(1);
  }
  const { cats, rows, report } = convertFolder(inputDir);

  const json = JSON.stringify({ cats, rows });
  fs.writeFileSync(outputPath, json);

  console.log(`已轉換 ${report.length} 個檔案，共 ${rows.length} 筆商品，${cats.length} 個分類`);
  for (const r of report) {
    console.log(`  ✓ ${r.file} → 「${r.category}」 ${r.rows} 筆`);
  }
  console.log(`輸出：${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { convertFolder, deriveCategoryKey, deriveCategoryLabel, splitSheets };
