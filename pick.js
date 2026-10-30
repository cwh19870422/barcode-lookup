// 撿貨單分頁：幫客戶留貨的清單。資料存在 Firestore（pickslips 集合、pickrules/main 簡化詞庫），3 台電腦即時同步。
// 由 index.html 的 startCloud()/stopCloud() 呼叫 Pick.start()/Pick.stop()。
(function(){
const LOCS = ['準備中','留後面','留中間','留前面','留上面'];
const OCR_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const two = n => String(n).padStart(2, '0');

const S = {
  slips: new Map(),      // id -> slip
  saved: new Set(),      // 已經存上雲端的 id
  rules: [],             // [{w, count, on, muted}]
  curId: null,
  tab: 'draft',
  unsub: [],
  confirmDel: null,
  pendingImgs: [],
  needRender: false,
  closed: false          // 按「暫存」後先把編輯區收起來
};
const cur = () => S.slips.get(S.curId);

// ---------- 版面 ----------
const panel = $('tab-pick');
panel.innerHTML = `
<div class="pk-grid">
  <aside class="pk-side" id="pkSide"></aside>
  <div class="pk-main" id="pkMainWrap">
    <div class="pk-card pk-closed" id="pkClosed"></div>
    <div class="pk-cust">
      <div class="search-box">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <input id="pkCust" type="text" list="pkCustList" placeholder="幫誰留貨？例如：苗栗店" autocomplete="off">
        <span id="pkGrade"></span>
      </div>
      <datalist id="pkCustList"></datalist>
    </div>
    <div class="pk-locs" id="pkLocs"></div>

    <div class="pk-card">
      <h4><span>撿貨清單</span><label class="pk-switch"><input type="checkbox" id="pkShowPrice">顯示金額</label></h4>
      <ul class="pk-list" id="pkMain"></ul>
      <div class="pk-sep" id="pkPreSep" style="display:none">預訂</div>
      <ul class="pk-list" id="pkPre"></ul>
      <form class="pk-add" id="pkAddForm"><input class="pk-in" id="pkAddIn" placeholder="單筆加入，例如：黑炫風 *25" autocomplete="off"><button class="pk-b" type="submit">加入</button></form>
      <p class="pk-hint">點號碼可切換成「預訂」（會移到最下面）。按住 ⠿ 拖曳調整順序。</p>
    </div>

    <div class="pk-card">
      <h4><span>匯入商品</span><span style="font-weight:400">貼文字、貼截圖或選照片</span></h4>
      <textarea class="pk-in" id="pkSrc" placeholder="把一長串文字貼在這裡；截圖可以直接 Ctrl+V 貼上"></textarea>
      <div class="pk-thumbs" id="pkThumbs"></div>
      <div class="pk-row">
        <button class="pk-b pri" id="pkQuick" type="button">快速整理</button>
        <label class="pk-b" for="pkPhoto">選照片</label>
        <input id="pkPhoto" type="file" accept="image/*" multiple style="display:none">
        <button class="pk-b" id="pkOcr" type="button" style="display:none">辨識照片文字</button>
        <span class="pk-hint" id="pkOcrNote"></span>
      </div>
      <p class="pk-hint">照片會先轉成文字放進上面的框，檢查一下錯字，再按「快速整理」。</p>
    </div>

    <div class="pk-card">
      <h4><span>簡化詞庫</span><button class="pk-b" id="pkApplyRules" type="button" style="font-size:12px;padding:4px 10px">套用到這張單</button></h4>
      <p class="pk-hint">在清單裡刪掉的字會記下來，同一個字刪 2 次就自動學會，之後匯入時自動刪掉。3 台電腦共用。</p>
      <div class="pk-rules" id="pkRules"></div>
      <form class="pk-add" id="pkRuleForm"><input class="pk-in" id="pkRuleIn" placeholder="新增要自動刪掉的字，例如：【現貨】" autocomplete="off"><button class="pk-b" type="submit">加入</button></form>
    </div>

    <div class="pk-bar">
      <div class="sum" id="pkSum"></div>
      <button class="pk-b" id="pkSave" type="button">暫存</button>
      <button class="pk-b" id="pkDone" type="button">完成</button>
      <button class="pk-b pri" id="pkOut" type="button">一鍵輸出</button>
    </div>
  </div>
</div>
<div class="pk-scrim" id="pkOutSheet" style="display:none"><div class="pk-sheet" role="dialog" aria-label="輸出文字">
  <h3>輸出文字 <button class="pk-b" type="button" data-pkclose>關閉</button></h3>
  <pre class="pk-out" id="pkOutText"></pre>
  <div class="pk-row"><button class="pk-b pri" id="pkCopy" type="button">全部複製</button><span class="pk-hint" id="pkCopyNote"></span></div>
</div></div>
<div class="pk-toast" id="pkToast" style="display:none"></div>`;

let toastT;
function toast(m){ const t = $('pkToast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', 2600); }

// ---------- 資料 ----------
function newSlip(){ const now = Date.now(); return { id: uid('p'), customer: '', location: '準備中', showPrice: false, status: 'draft', items: [], createdAt: now, updatedAt: now }; }
function mkItem(o){ return { id: uid('i'), name: String(o.name || ''), qty: Math.max(1, parseInt(o.qty) || 1), price: o.price ? Number(o.price) : null, reserved: !!o.reserved, preorder: !!o.preorder }; }
const normals = () => cur().items.filter(i => !i.preorder);
const pres = () => cur().items.filter(i => i.preorder);
const hasContent = s => s && (s.items.length || (s.customer || '').trim());
const canDelete = () => (typeof isBoss === 'function') ? isBoss() : true;

let saveT = null;
function touch(){
  const s = cur(); s.updatedAt = Date.now();
  clearTimeout(saveT); saveT = setTimeout(() => saveNow(s), 600);
  renderSum(); renderSide();
}
async function saveNow(s){
  s = s || cur(); if(!s) return;
  if(!hasContent(s) && !S.saved.has(s.id)) return;
  if(!window.FB || !FB.currentUser()) return;
  try{ await FB.savePickslip(s); S.saved.add(s.id); }
  catch(e){ toast('存檔失敗：' + (e && e.code === 'permission-denied' ? '沒有權限' : (e && e.message || e))); }
}
function saveRules(){ if(window.FB && FB.currentUser()) FB.savePickRules({ words: S.rules }).catch(e => toast('詞庫存檔失敗：' + (e.message || e))); }

// ---------- 簡化詞 ----------
const ruleOf = w => S.rules.find(r => r.w === w);
const activeWords = () => S.rules.filter(r => r.on).map(r => r.w).sort((a, b) => b.length - a.length);
function simplify(name){
  let s = name; for(const w of activeWords()) if(w) s = s.split(w).join(' ');
  return s.replace(/\s+/g, ' ').trim() || name.trim();
}
function removedChunks(a, b){
  if(a === b || !a) return [];
  const n = a.length, m = b.length; if(m >= n || n > 200) return [];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  if(dp[0][0] !== m) return [];   // 有加字或改字就不學
  const out = []; let i = 0, j = 0, buf = '';
  while(i < n){ if(j < m && a[i] === b[j] && dp[i][j] === dp[i+1][j+1] + 1){ if(buf){ out.push(buf); buf = ''; } i++; j++; } else { buf += a[i]; i++; } }
  if(buf) out.push(buf);
  return out.map(c => c.trim()).filter(c => c && c.length <= 20 && !/^\d+$/.test(c));
}
function learn(oldName, newName){
  let changed = false;
  for(const w of removedChunks(oldName, newName)){
    let r = ruleOf(w); if(!r){ r = { w, count: 0, on: false }; S.rules.push(r); }
    if(r.muted) continue;
    r.count++; changed = true;
    if(!r.on && r.count >= 2){ r.on = true; toast('學會了：以後自動刪掉「' + w + '」'); }
  }
  if(changed){ saveRules(); renderRules(); }
}

// ---------- 文字拆解 ----------
const RE_KEPT = /[（(]\s*已留\s*[)）]/g, RE_PRE = /[（(]\s*預[訂定約購]\s*[)）]/g;
function parseItem(s){
  const reserved = RE_KEPT.test(s); RE_KEPT.lastIndex = 0; s = s.replace(RE_KEPT, ' ');
  const preorder = RE_PRE.test(s); RE_PRE.lastIndex = 0; s = s.replace(RE_PRE, ' ');
  s = s.trim().replace(/^(?:\d{1,3}\s*[.、．)）:：]|[-•・●▪]\s*)\s*/, '');
  let qty = 1, price = null, m;
  if((m = s.match(/[*＊×xX]\s*(\d{1,4})\s*[個瓶支盒組件條包入罐片份]?\s*$/))){ qty = +m[1]; s = s.slice(0, m.index); }
  else if((m = s.match(/\s(\d{1,4})\s*[個瓶支盒組件條包罐片份]\s*$/))){ qty = +m[1]; s = s.slice(0, m.index); }
  if((m = s.match(/(?:定價|售價|特價|原價|NT\$?|＄|\$)\s*(\d[\d,]*)\s*元?/i))){ price = +m[1].replace(/,/g, ''); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  else if((m = s.match(/(\d[\d,]*)\s*元/))){ price = +m[1].replace(/,/g, ''); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  const name = simplify(s.replace(/\s+/g, ' ').trim());
  return name ? mkItem({ name, qty, price, reserved, preorder }) : null;
}
function parseText(txt){
  const out = { customer: null, location: null, items: [] };
  for(let line of txt.split(/\r?\n/)){
    line = line.trim(); if(!line) continue;
    if(/^[#＃]/.test(line)){
      const p = line.replace(/^[#＃]+/, '').trim().split(/\s+/);
      if(LOCS.includes(p[0])) out.location = p.shift();
      if(p.join('')) out.customer = p.join(' ');
      continue;
    }
    const marks = line.match(/[*＊×xX]\s*\d+/g) || [];
    const parts = marks.length > 1
      ? (line.match(/.+?[*＊×xX]\s*\d+\s*(?:[（(]\s*已留\s*[)）])?/g) || [line]).map(p => p.replace(/^[、，,;；/／\s]+/, ''))
      : [line];
    for(const p of parts){ const it = parseItem(p); if(it) out.items.push(it); }
  }
  return out;
}
function mergeParsed(r){
  const s = cur();
  if(r.customer && !s.customer){ s.customer = r.customer; $('pkCust').value = r.customer; renderGrade(); }
  if(r.location && LOCS.includes(r.location)){ s.location = r.location; renderLocs(); }
  if(r.items.some(i => i.price)) s.showPrice = true;
  s.items = normals().concat(r.items.filter(i => !i.preorder), pres(), r.items.filter(i => i.preorder));
  touch(); renderItems();
}

// ---------- 輸出 ----------
function buildText(){
  const s = cur();
  const head = ('#' + s.location + ' ' + (s.customer || '')).trim();
  const line = it => `${it.name}${s.showPrice && it.price ? ' 定價' + it.price : ''} *${it.qty}${it.reserved ? '（已留）' : ''}`;
  const n = normals().map((it, i) => `${i + 1}. ${line(it)}`), p = pres().map(it => '（預訂）' + line(it));
  let t = head + '\n\n' + n.join('\n');
  if(p.length) t += (n.length ? '\n\n' : '') + p.join('\n');
  return t;
}

// ---------- 畫面 ----------
function renderSide(){
  const all = Array.from(S.slips.values()).filter(s => hasContent(s) || s.id === S.curId);
  const drafts = all.filter(s => s.status !== 'done'), dones = all.filter(s => s.status === 'done');
  const list = (S.tab === 'done' ? dones : drafts).sort((a, b) => b.updatedAt - a.updatedAt);
  const ts = t => { const d = new Date(t), today = new Date(); const same = d.toDateString() === today.toDateString();
    return (same ? '今天 ' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + two(d.getHours()) + ':' + two(d.getMinutes()); };
  $('pkSide').innerHTML = `
    <button class="pk-new" type="button" data-pk="new">＋ 新撿貨單</button>
    <div class="pk-seg"><button type="button" data-pktab="draft" class="${S.tab === 'draft' ? 'on' : ''}">進行中 ${drafts.filter(hasContent).length}</button><button type="button" data-pktab="done" class="${S.tab === 'done' ? 'on' : ''}">已完成 ${dones.length}</button></div>
    ${list.length ? list.map(s => { const k = s.items.filter(i => i.reserved).length;
      return `<button type="button" class="pk-ord${s.id === S.curId && !S.closed ? ' cur' : ''}" data-pkopen="${s.id}"><span class="t">${esc(s.customer || '（未填客戶）')}<span class="pk-pill">${esc(s.location)}</span>${s.status === 'done' ? '<span class="pk-pill done">已完成</span>' : ''}</span><span class="m">${s.items.length} 項 · 已留 ${k}/${s.items.length} · ${ts(s.updatedAt)}</span></button>`; }).join('')
      : `<div class="pk-empty">${S.tab === 'done' ? '還沒有完成的單' : '沒有進行中的單'}</div>`}
    ${canDelete() && !S.closed && S.slips.has(S.curId) && hasContent(cur()) ? `<button class="pk-b ${S.confirmDel === S.curId ? 'red' : ''}" type="button" data-pk="del">${S.confirmDel === S.curId ? '確定刪除這張單？' : '刪除這張單'}</button>` : ''}
    <p class="pk-hint">單子 3 台電腦即時同步。</p>`;
}
function renderLocs(){
  $('pkLocs').innerHTML = LOCS.map(l => `<button type="button" class="pk-chip${cur().location === l ? ' on' : ''}" data-pkloc="${l}">${l}</button>`).join('');
}
function renderGrade(){
  const name = (cur().customer || '').trim();
  const list = (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
  const c = name && list.find(x => (x.name || '').trim() === name);
  $('pkGrade').innerHTML = c ? `<span class="grade-badge grade-${esc(c.grade || 'A')}">${esc(c.grade || 'A')}</span>` : '';
}
function renderCustList(){
  const list = (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
  const names = new Set();
  Array.from(S.slips.values()).forEach(s => s.customer && names.add(s.customer));
  list.forEach(c => c.name && names.add(c.name));
  $('pkCustList').innerHTML = Array.from(names).map(n => `<option value="${esc(n)}">`).join('');
}
function itemHTML(it, idx){
  const s = cur();
  return `<li class="pk-it${it.reserved ? ' kept' : ''}" data-id="${it.id}">
    <span class="pk-grip" aria-label="拖曳">⠿</span>
    <button type="button" class="pk-sn${it.preorder ? ' pre' : ''}" data-act="pre" title="${it.preorder ? '改回一般' : '改成預訂'}">${it.preorder ? '預訂' : idx}</button>
    <input class="pk-nm" id="pkn-${it.id}" value="${esc(it.name)}" data-f="name" aria-label="品名">
    ${s.showPrice ? `<label class="pk-price">$<input id="pkp-${it.id}" inputmode="numeric" value="${it.price == null ? '' : it.price}" data-f="price" aria-label="金額" placeholder="—"></label>` : ''}
    <div class="qty-stepper"><button type="button" data-act="minus" aria-label="減一">−</button><input class="qty-num" id="pkq-${it.id}" inputmode="numeric" value="${it.qty}" data-f="qty" aria-label="數量"><button type="button" data-act="plus" aria-label="加一">＋</button></div>
    <label class="pk-kp"><input type="checkbox" id="pkk-${it.id}" data-f="reserved" ${it.reserved ? 'checked' : ''} title="已留"><span class="kt">已留</span></label>
    <button type="button" class="pk-del" data-act="del" aria-label="刪除">×</button>
  </li>`;
}
function renderItems(){
  const n = normals(), p = pres();
  $('pkMain').innerHTML = n.map((it, i) => itemHTML(it, i + 1)).join('') || (p.length ? '' : '<li class="pk-empty">還沒有商品。下面貼文字或照片，或用「單筆加入」。</li>');
  $('pkPre').innerHTML = p.map(it => itemHTML(it, 0)).join('');
  $('pkPreSep').style.display = p.length ? 'flex' : 'none';
  $('pkShowPrice').checked = !!cur().showPrice;
  renderSum();
}
function renderSum(){
  const s = cur(); const n = s.items.length, k = s.items.filter(i => i.reserved).length, q = s.items.reduce((a, b) => a + (+b.qty || 0), 0);
  $('pkSum').innerHTML = `<b>${n}</b> 項 · 共 ${q} 件 · 已留 ${k}/${n}${s.status === 'done' ? ' <span class="pk-pill done">已完成</span>' : ''}`;
  $('pkDone').textContent = s.status === 'done' ? '改回進行中' : '完成';
}
function renderRules(){
  const list = S.rules.slice().sort((a, b) => (b.on - a.on) || (b.count - a.count));
  $('pkRules').innerHTML = list.length ? list.map(r => `<span class="pk-rule${r.on ? '' : ' off'}">${esc(r.w)} <span class="c">${r.on ? '自動' : '刪過' + r.count + '次'}</span><button type="button" data-w="${esc(r.w)}" data-act="toggle">${r.on ? '停用' : '啟用'}</button><button type="button" data-w="${esc(r.w)}" data-act="remove">移除</button></span>`).join('') : '<span class="pk-hint">目前還沒有學到的字。</span>';
}
function renderClosed(){
  $('pkMainWrap').classList.toggle('is-closed', S.closed);
  if(!S.closed) return;
  const s = cur();
  $('pkClosed').innerHTML = `<div class="pk-closed-t">✓ 已暫存${s && s.customer ? '「' + esc(s.customer) + '」' : ''}</div>
    <p class="pk-hint">點${window.innerWidth <= 760 ? '上面' : '左邊'}的單子可以繼續編輯，或開一張新的。</p>
    <div class="pk-row" style="justify-content:center"><button class="pk-b" type="button" data-pkreopen>繼續編輯這張</button><button class="pk-b pri" type="button" data-pknew>＋ 新撿貨單</button></div>`;
}
function renderAll(){
  renderClosed();
  $('pkCust').value = cur().customer || '';
  renderGrade(); renderLocs(); renderItems(); renderRules(); renderSide(); renderCustList();
}
function editing(){ const a = document.activeElement; return a && panel.contains(a) && a.matches('input,textarea'); }

// ---------- 雲端同步 ----------
function onSlips(list){
  const seen = new Set();
  list.forEach(s => {
    seen.add(s.id); S.saved.add(s.id);
    if(!Array.isArray(s.items)) s.items = [];
    const local = S.slips.get(s.id);
    if(local && (local.updatedAt || 0) >= (s.updatedAt || 0)) return;   // 自己剛改的比較新，不蓋掉
    S.slips.set(s.id, s);
  });
  for(const id of Array.from(S.slips.keys())) if(S.saved.has(id) && !seen.has(id)){ S.slips.delete(id); S.saved.delete(id); }
  if(!S.slips.has(S.curId)) pickDefault();
  if(editing()) { S.needRender = true; renderSide(); renderSum(); }
  else renderAll();
}
function pickDefault(){
  const d = Array.from(S.slips.values()).filter(s => s.status !== 'done' && hasContent(s)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if(d) S.curId = d.id; else { const n = newSlip(); S.slips.set(n.id, n); S.curId = n.id; }
}
panel.addEventListener('focusout', () => setTimeout(() => { if(S.needRender && !editing()){ S.needRender = false; renderAll(); } }, 0));

const Pick = {
  start(){
    Pick.stop();
    if(!window.FB || !FB.listenPickslips) return;
    S.unsub.push(FB.listenPickslips(onSlips, e => toast('讀取撿貨單失敗：' + (e && e.code === 'permission-denied' ? '沒有權限（Firebase 規則還沒更新？）' : (e.message || e)))));
    S.unsub.push(FB.listenPickRules(r => { S.rules = Array.isArray(r && r.words) ? r.words : []; renderRules(); }, () => {}));
  },
  stop(){ S.unsub.forEach(f => { try{ f(); }catch(e){} }); S.unsub = []; },
  refreshCustomers(){ renderCustList(); renderGrade(); }
};
window.Pick = Pick;

// ---------- 事件 ----------
$('pkSide').addEventListener('click', async e => {
  const t = e.target.closest('[data-pk],[data-pktab],[data-pkopen]'); if(!t) return;
  if(t.dataset.pktab){ S.tab = t.dataset.pktab; S.confirmDel = null; renderSide(); return; }
  if(t.dataset.pkopen){ const old = cur(); if(old && !hasContent(old) && !S.saved.has(old.id)) S.slips.delete(old.id);
    clearTimeout(saveT); if(old && hasContent(old)) saveNow(old);
    S.curId = t.dataset.pkopen; S.closed = false; S.confirmDel = null; renderAll(); return; }
  if(t.dataset.pk === 'new'){ const old = cur(); clearTimeout(saveT); if(old && hasContent(old)) saveNow(old); else if(old && !S.saved.has(old.id)) S.slips.delete(old.id);
    const n = newSlip(); S.slips.set(n.id, n); S.curId = n.id; S.closed = false; S.tab = 'draft'; S.confirmDel = null; renderAll(); $('pkCust').focus(); return; }
  if(t.dataset.pk === 'del'){
    if(S.confirmDel !== S.curId){ S.confirmDel = S.curId; renderSide(); return; }
    const id = S.curId; S.confirmDel = null; clearTimeout(saveT);
    try{ if(S.saved.has(id)) await FB.deletePickslip(id); }catch(err){ toast('刪除失敗：' + (err.message || err)); return; }
    S.slips.delete(id); S.saved.delete(id); S.closed = false; pickDefault(); renderAll(); toast('已刪除');
  }
});
$('pkCust').addEventListener('input', e => { cur().customer = e.target.value; renderGrade(); touch(); });
$('pkLocs').addEventListener('click', e => { const b = e.target.closest('[data-pkloc]'); if(!b) return; cur().location = b.dataset.pkloc; renderLocs(); touch(); });
$('pkShowPrice').addEventListener('change', e => { cur().showPrice = e.target.checked; renderItems(); touch(); });

const findItem = el => { const li = el.closest('.pk-it'); return li && cur().items.find(i => i.id === li.dataset.id); };
[$('pkMain'), $('pkPre')].forEach(L => {
  L.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if(!b) return; const it = findItem(b); if(!it) return;
    const s = cur(), a = b.dataset.act;
    if(a === 'del'){ s.items = s.items.filter(i => i !== it); toast('已刪除「' + it.name + '」'); }
    if(a === 'plus') it.qty++;
    if(a === 'minus') it.qty = Math.max(1, it.qty - 1);
    if(a === 'pre'){ s.items = s.items.filter(i => i !== it); it.preorder = !it.preorder; s.items = it.preorder ? s.items.concat(it) : normals().concat(it, pres()); }
    renderItems(); touch();
  });
  L.addEventListener('input', e => {
    const f = e.target.dataset.f, it = findItem(e.target); if(!it || !f) return;
    if(f === 'name') it.name = e.target.value;
    if(f === 'price'){ const v = e.target.value.replace(/[^\d]/g, ''); it.price = v ? +v : null; }
    if(f === 'qty'){ const v = parseInt(e.target.value); if(v > 0) it.qty = v; }
    if(f === 'reserved'){ it.reserved = e.target.checked; e.target.closest('.pk-it').classList.toggle('kept', it.reserved); }
    touch();
  });
  L.addEventListener('focusin', e => { if(e.target.dataset.f === 'name') e.target.dataset.orig = e.target.value; });
  L.addEventListener('change', e => {
    const it = findItem(e.target); if(!it) return;
    if(e.target.dataset.f === 'name'){ const o = e.target.dataset.orig || '', n = e.target.value.trim();
      if(!n){ it.name = o; e.target.value = o; return; }
      it.name = n; if(o && n !== o) learn(o, n); e.target.dataset.orig = n; }
    if(e.target.dataset.f === 'qty') e.target.value = it.qty;
  });
});
function syncOrder(){
  const ids = [...$('pkMain').children, ...$('pkPre').children].map(li => li.dataset.id).filter(Boolean);
  const map = Object.fromEntries(cur().items.map(i => [i.id, i]));
  cur().items = ids.map(id => map[id]).filter(Boolean);
  renderItems(); touch();
}
if(window.Sortable) [$('pkMain'), $('pkPre')].forEach(L => Sortable.create(L, { handle: '.pk-grip', animation: 150, filter: '.pk-empty', onEnd: syncOrder }));

$('pkAddForm').addEventListener('submit', e => { e.preventDefault(); const v = $('pkAddIn').value.trim(); if(!v) return;
  const r = parseText(v); if(!r.items.length) return; mergeParsed({ items: r.items }); $('pkAddIn').value = ''; });
$('pkQuick').addEventListener('click', () => {
  const t = $('pkSrc').value.trim();
  if(!t){ toast(S.pendingImgs.length ? '先按「辨識照片文字」' : '先貼上文字'); return; }
  const r = parseText(t); if(!r.items.length && !r.customer){ toast('看不出商品，請檢查文字格式'); return; }
  mergeParsed(r); $('pkSrc').value = ''; toast('已加入 ' + r.items.length + ' 項');
});

// ---------- 照片 → 文字（瀏覽器內建辨識，第一次會下載辨識檔，稍等一下）----------
function addImgs(files){
  for(const f of files) if(f.type && f.type.startsWith('image/')) S.pendingImgs.push({ file: f, url: URL.createObjectURL(f) });
  renderThumbs();
}
function renderThumbs(){
  $('pkThumbs').innerHTML = S.pendingImgs.map((p, i) => `<div class="pk-thumb"><img src="${p.url}" alt="待辨識照片"><button type="button" data-rm="${i}" aria-label="移除">×</button></div>`).join('');
  $('pkOcr').style.display = S.pendingImgs.length ? '' : 'none';
}
$('pkThumbs').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if(b){ S.pendingImgs.splice(+b.dataset.rm, 1); renderThumbs(); } });
$('pkPhoto').addEventListener('change', e => { addImgs(e.target.files); e.target.value = ''; });
document.addEventListener('paste', e => {
  if(!panel.classList.contains('active')) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => f.type.startsWith('image/'));
  if(files.length){ e.preventDefault(); addImgs(files); toast('已貼上 ' + files.length + ' 張照片'); }
});
function loadScript(src){ return new Promise((ok, no) => { if(window.Tesseract) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('辨識元件下載失敗，請檢查網路')); document.head.appendChild(s); }); }
$('pkOcr').addEventListener('click', async () => {
  const btn = $('pkOcr'), note = $('pkOcrNote'); btn.disabled = true; btn.innerHTML = '<span class="pk-spin"></span> 辨識中';
  let worker;
  try{
    await loadScript(OCR_URL);
    note.textContent = '準備辨識檔…（第一次比較久）';
    worker = await Tesseract.createWorker(['chi_tra', 'eng'], 1, { logger: m => { if(m.status === 'recognizing text') note.textContent = '辨識中 ' + Math.round(m.progress * 100) + '%'; } });
    const texts = [];
    for(const p of S.pendingImgs){ const { data } = await worker.recognize(p.file); texts.push(data.text); }
    let txt = texts.join('\n')
      .replace(/([㐀-鿿（）（）])[ \t]+(?=[㐀-鿿（）（）])/g, '$1')   // 中文字中間多出來的空白
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    $('pkSrc').value = ($('pkSrc').value.trim() ? $('pkSrc').value.trim() + '\n' : '') + txt;
    S.pendingImgs = []; renderThumbs();
    note.textContent = ''; toast('辨識完成，請檢查文字後按「快速整理」'); $('pkSrc').focus();
  }catch(e){ note.textContent = ''; toast('辨識失敗：' + (e.message || e)); }
  finally{ if(worker) try{ await worker.terminate(); }catch(e){} btn.disabled = false; btn.textContent = '辨識照片文字'; }
});

$('pkRules').addEventListener('click', e => { const b = e.target.closest('[data-w]'); if(!b) return; const r = ruleOf(b.dataset.w); if(!r) return;
  if(b.dataset.act === 'toggle'){ r.on = !r.on; r.muted = !r.on; }
  if(b.dataset.act === 'remove') S.rules = S.rules.filter(x => x !== r);
  saveRules(); renderRules(); });
$('pkRuleForm').addEventListener('submit', e => { e.preventDefault(); const w = $('pkRuleIn').value.trim(); if(!w) return;
  const r = ruleOf(w); if(r){ r.on = true; r.muted = false; } else S.rules.push({ w, count: 0, on: true });
  $('pkRuleIn').value = ''; saveRules(); renderRules(); toast('已加入「' + w + '」'); });
$('pkApplyRules').addEventListener('click', () => { let c = 0; cur().items.forEach(i => { const s = simplify(i.name); if(s !== i.name){ i.name = s; c++; } }); renderItems(); touch(); toast(c ? '簡化了 ' + c + ' 項' : '沒有需要簡化的'); });

$('pkSave').addEventListener('click', async () => { if(!hasContent(cur())){ toast('這張單還是空的'); return; } clearTimeout(saveT); cur().updatedAt = Date.now(); await saveNow(); S.closed = true; S.confirmDel = null; $('pkOutSheet').style.display = 'none'; renderAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('已暫存'); });
$('pkClosed').addEventListener('click', e => {
  if(e.target.closest('[data-pkreopen]')){ S.closed = false; renderAll(); }
  if(e.target.closest('[data-pknew]')) $('pkSide').querySelector('[data-pk="new"]').click();
});
$('pkDone').addEventListener('click', async () => {
  const s = cur(); if(!hasContent(s)){ toast('這張單還是空的'); return; }
  s.status = s.status === 'done' ? 'draft' : 'done'; s.updatedAt = Date.now(); clearTimeout(saveT); await saveNow(s);
  renderSum(); renderSide(); toast(s.status === 'done' ? '已完成，可在左邊「已完成」找到' : '改回進行中');
});
const outSheet = $('pkOutSheet');
$('pkOut').addEventListener('click', () => { $('pkOutText').textContent = buildText(); $('pkCopyNote').textContent = ''; outSheet.style.display = 'flex'; });
outSheet.addEventListener('click', e => { if(e.target === outSheet || e.target.hasAttribute('data-pkclose')) outSheet.style.display = 'none'; });
document.addEventListener('keydown', e => { if(e.key === 'Escape') outSheet.style.display = 'none'; });
$('pkCopy').addEventListener('click', () => {
  const t = buildText();
  const done = () => { $('pkCopyNote').textContent = '已複製'; toast('已複製'); };
  const fallback = () => {
    let ok = false;
    try{ const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); }catch(e){}
    if(ok) return done();
    const r = document.createRange(); r.selectNodeContents($('pkOutText')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    $('pkCopyNote').textContent = '已選取，請按 Ctrl+C 複製';
  };
  try{ navigator.clipboard.writeText(t).then(done, fallback); }catch(e){ fallback(); }
});

// 一開始先放一張空白單，雲端資料到了再換成最近那張
pickDefault(); renderAll();
if(window.FB && FB.currentUser && FB.currentUser()) Pick.start();
})();
