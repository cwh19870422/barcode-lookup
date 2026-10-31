#!/usr/bin/env node
/**
 * 把商品資料加密成「老闆版」與「員工版」兩份檔案，供公開的 GitHub Pages 放置。
 * 沒有鑰匙的人只會拿到亂碼；鑰匙放在 Firebase（登入後才讀得到）。
 *
 * 用法：
 *   JOEDA_BOSS_KEY=<base64> JOEDA_STAFF_KEY=<base64> \
 *   node scripts/encrypt-data.js <明碼 data.json 路徑> <repo 資料夾>
 *
 * 輸出（寫進 <repo 資料夾>）：
 *   data.boss.enc   老闆版（含本錢、A~D 批價）
 *   data.staff.enc  員工版（本錢欄位已移除）
 *   data.meta.json  只有明碼資料的 sha256、筆數、時間；用來判斷資料有沒有變
 *
 * 程式最後一行會印出 CHANGED 或 UNCHANGED（資料沒變就不會寫任何檔案，避免無意義的 commit）。
 * 永遠不要把明碼 data.json / data.json.new commit 進 repo。
 *
 * 資料列格式：[類別序號, 備註, 編號, 條碼, 品名, 本錢(5), 賣A(6), 批B(7), 批C(8), 批D(9), 定價(10)]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COST_IDX = 5;

function die(msg){ console.error('ERROR: ' + msg); process.exit(1); }

const [,, plainPath, repoDir] = process.argv;
if(!plainPath || !repoDir) die('用法：node scripts/encrypt-data.js <明碼 data.json> <repo 資料夾>');
const bossKey = Buffer.from(process.env.JOEDA_BOSS_KEY || '', 'base64');
const staffKey = Buffer.from(process.env.JOEDA_STAFF_KEY || '', 'base64');
if(bossKey.length !== 32) die('JOEDA_BOSS_KEY 必須是 32 bytes 的 base64');
if(staffKey.length !== 32) die('JOEDA_STAFF_KEY 必須是 32 bytes 的 base64');
if(bossKey.equals(staffKey)) die('老闆鑰匙與員工鑰匙不可相同');

const plainText = fs.readFileSync(plainPath, 'utf8');
let data;
try{ data = JSON.parse(plainText); }catch(e){ die('data.json 不是有效的 JSON：' + e.message); }
if(!data || !Array.isArray(data.cats) || !Array.isArray(data.rows) || !data.rows.length) die('data.json 格式不對或沒有商品資料');

const sha = crypto.createHash('sha256').update(plainText).digest('hex');
const metaPath = path.join(repoDir, 'data.meta.json');
const bossPath = path.join(repoDir, 'data.boss.enc');
const staffPath = path.join(repoDir, 'data.staff.enc');

if(fs.existsSync(metaPath) && fs.existsSync(bossPath) && fs.existsSync(staffPath)){
  try{
    const old = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if(old.sha256 === sha){ console.log('資料沒有變動。'); console.log('UNCHANGED'); process.exit(0); }
  }catch(e){ /* meta 壞掉就重新產生 */ }
}

function encrypt(obj, key){
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final(), c.getAuthTag()]); // 密文＋16 bytes 驗證碼（和瀏覽器 WebCrypto 格式相同）
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') });
}

const staffData = { cats: data.cats, rows: data.rows.map(r => { const x = r.slice(); x[COST_IDX] = null; return x; }) };

// 先自我驗證：解得回來、員工版真的沒有本錢，才寫檔
function decrypt(pkgText, key){
  const p = JSON.parse(pkgText); const buf = Buffer.from(p.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}
const bossEnc = encrypt(data, bossKey), staffEnc = encrypt(staffData, staffKey);
const b2 = decrypt(bossEnc, bossKey), s2 = decrypt(staffEnc, staffKey);
if(b2.rows.length !== data.rows.length || s2.rows.length !== data.rows.length) die('自我驗證失敗：筆數不符');
if(s2.rows.some(r => r[COST_IDX] !== null)) die('自我驗證失敗：員工版還有本錢');
try{ decrypt(staffEnc, bossKey); die('自我驗證失敗：老闆鑰匙竟然能解開員工版'); }catch(e){ if(String(e.message).startsWith('ERROR')) throw e; }
try{ decrypt(bossEnc, staffKey); die('自我驗證失敗：員工鑰匙竟然能解開老闆版'); }catch(e){ /* 預期會失敗 */ }

fs.writeFileSync(bossPath, bossEnc);
fs.writeFileSync(staffPath, staffEnc);
fs.writeFileSync(metaPath, JSON.stringify({ sha256: sha, rows: data.rows.length, cats: data.cats.length, updatedAt: new Date().toISOString() }, null, 1) + '\n');
console.log('已寫入 data.boss.enc / data.staff.enc / data.meta.json（' + data.rows.length + ' 筆商品）');
console.log('CHANGED');
