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
  links: [],             // 算金額：撿貨單品名 → POS 商品的對照（[{q, k, n}]，存在 pickrules/main，大家共用）
  calcOpen: null,        // 算金額視窗裡正在選商品的那一項
  curId: null,
  tab: 'draft',
  unsub: [],
  confirmDel: null,
  pendingImgs: [],
  needRender: false,
  editKept: null,        // 正在改「留了幾個」的那一列
  noteOpen: false,       // 備註框是不是手動打開
  closed: false,         // 按「暫存」後先把編輯區收起來
  idle: false            // 剛進撿貨單分頁：還沒選任何客人
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
        <input id="pkCust" type="text" placeholder="幫誰留貨？搜尋姓名、暱稱、電話或會員號碼" autocomplete="off">
        <span id="pkGrade"></span>
        <button type="button" class="pk-custx" id="pkCustX" title="清除，改選別的客人" aria-label="清除客人" style="display:none">✕</button>
      </div>
      <div class="cust-dropdown" id="pkCustDrop"></div>
      <datalist id="pkCustList"></datalist>
    </div>
    <div class="pk-people" id="pkPeople"></div>
    <div class="pk-locs" id="pkLocs"></div>

    <div class="pk-card">
      <h4><span>撿貨清單</span><span class="pk-h4r"><button type="button" class="pk-notebtn" id="pkCalcBtn" title="用 POS 的價錢算這張單的金額">$ 算金額</button><button type="button" class="pk-notebtn" id="pkNoteBtn">✎ 備註</button><label class="pk-switch"><input type="checkbox" id="pkShowPrice">顯示金額</label></span></h4>
      <!-- 加入商品：單筆和大量合在同一格，放在清單最上面 -->
      <form class="pk-add pk-addtop" id="pkAddForm">
        <span class="pk-addplus" aria-hidden="true">＋</span>
        <textarea class="pk-in" id="pkAddIn" rows="1" placeholder="加入商品：黑炫風 *25，或貼上一整串／截圖" autocomplete="off"></textarea>
        <label class="pk-b pk-photo" for="pkPhoto" title="選照片">照片</label>
        <input id="pkPhoto" type="file" accept="image/*" multiple style="display:none">
        <button class="pk-b pri" type="submit">加入</button>
      </form>
      <div class="pk-addextra" id="pkAddExtra" style="display:none">
        <div class="pk-thumbs" id="pkThumbs"></div>
        <div class="pk-row"><button class="pk-b" id="pkOcr" type="button" style="display:none">辨識照片文字</button><span class="pk-hint" id="pkOcrNote"></span></div>
      </div>
      <ul class="pk-list" id="pkMain"></ul>
      <div class="pk-sep" id="pkPreSep" style="display:none">預訂</div>
      <ul class="pk-list" id="pkPre"></ul>
      <div class="pk-sep wait" id="pkWaitSep" style="display:none">等到貨</div>
      <ul class="pk-list" id="pkWait"></ul>
      <p class="pk-hint" hidden>加入商品：按 Enter 或「加入」，Shift+Enter 換行；貼上好幾行會一次整理加入。數量可以寫 *3、x3、+3、留3、5pcs。點號碼切換：一般 → 預訂 → 等到貨 → 一般（預訂、等到貨會移到最下面）。數量可以清空不填。按住 ⠿ 拖曳調整順序。點圓圈＝全部已留，長按（或按右鍵）圓圈可改留幾個。</p>
      <div class="pk-notewrap" id="pkNoteWrap" style="display:none">   <!-- 備註：平常藏起來，按標題列的「✎ 備註」才打開 -->
        <label class="pk-note-lbl" for="pkNote">備註</label>
        <textarea class="pk-in pk-note" id="pkNote" rows="2" placeholder="例如：週五來拿、要開發票…（輸出時會放在最下面）"></textarea>
      </div>
    </div>

    <div class="pk-card" id="pkRulesCard" style="display:none">   <!-- 簡化詞庫：先隱藏，功能照常運作 -->
      <h4><span>簡化詞庫</span><button class="pk-b" id="pkApplyRules" type="button" style="font-size:12px;padding:4px 10px">套用到這張單</button></h4>
      <p class="pk-hint">在清單裡刪掉的字會記下來，同一個字刪 2 次就自動學會，之後匯入時自動刪掉。3 台電腦共用。</p>
      <div class="pk-rules" id="pkRules"></div>
      <form class="pk-add" id="pkRuleForm"><input class="pk-in" id="pkRuleIn" placeholder="新增要自動刪掉的字，例如：【現貨】" autocomplete="off"><button class="pk-b" type="submit">加入</button></form>
    </div>

    <div class="pk-bar">
      <div class="sum" id="pkSum"></div>
      <button class="pk-b pk-delb" id="pkDel" type="button" style="display:none">刪除</button>
      <button class="pk-b" id="pkSave" type="button">暫存</button>
      <button class="pk-b" id="pkDone" type="button">完成</button>
      <button class="pk-b pri" id="pkOut" type="button">快速複製</button>
    </div>
  </div>
</div>
<div class="pk-scrim" id="pkOutSheet" style="display:none"><div class="pk-sheet" role="dialog" aria-label="輸出文字">
  <h3>輸出文字 <button class="pk-b" type="button" data-pkclose>關閉</button></h3>
  <pre class="pk-out" id="pkOutText"></pre>
  <div class="pk-row"><button class="pk-b pri" id="pkCopy" type="button">全部複製</button><span class="pk-hint" id="pkCopyNote"></span></div>
</div></div>
<div class="pk-scrim" id="pkCalcSheet" style="display:none"><div class="pk-sheet pk-calc" role="dialog" aria-label="算金額">
  <h3>算金額 <button class="pk-b" type="button" data-pkcclose>關閉</button></h3>
  <div id="pkCalcBody"></div>
</div></div>
<div class="pk-scrim" id="pkPeopleSheet" style="display:none"><div class="pk-sheet pk-pdlg" role="dialog" aria-label="新增一位">
  <h3 id="pkPdTitle">新增一位</h3>
  <div id="pkPdBody"></div>
  <p class="pk-cwarn" id="pkPdErr" style="text-align:left"></p>
  <div class="pk-row" style="justify-content:flex-end"><button class="pk-b" type="button" data-pdcancel="1">取消</button><button class="pk-b pri" type="button" data-pdok="1">確定</button></div>
</div></div>
<div class="pk-toast" id="pkToast" style="display:none"></div>`;

let toastT;
function toast(m){ const t = $('pkToast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', 2600); }

// ---------- 資料 ----------
function newSlip(){ const now = Date.now(); return { id: uid('p'), customer: '', location: '準備中', showPrice: false, status: 'draft', items: [], createdAt: now, updatedAt: now }; }
function mkItem(o){
  const it = { id: uid('i'), name: String(o.name || ''), qty: o.qty === null ? null : Math.max(1, parseInt(o.qty) || 1), price: o.price ? Number(o.price) : null, reserved: false, kept: 0, preorder: !!o.preorder && !o.wait, wait: !!o.wait, tbd: !!(o.preorder && o.tbd) };
  setKept(it, o.kept != null ? o.kept : (o.reserved ? effQ(it) : 0));
  return it;
}
// 已留數量：kept 是留了幾個（0～數量），reserved＝全部留好。舊資料沒有 kept，就照 reserved 換算
// 數量可以空白（qty = null）：留貨計算時當作 1 個
const effQ = it => it.qty || 1;
const kOf = it => it.kept == null ? (it.reserved ? effQ(it) : 0) : Math.min(it.kept, effQ(it));
function setKept(it, n){ it.kept = Math.max(0, Math.min(parseInt(n) || 0, effQ(it))); it.reserved = it.kept >= effQ(it); }
const isPartial = it => { const k = kOf(it); return k > 0 && k < effQ(it); };
// 三組：一般／預訂／等到貨
const normals = () => cur().items.filter(i => !i.preorder && !i.wait);
const pres = () => cur().items.filter(i => i.preorder && !i.wait);
const waits = () => cur().items.filter(i => i.wait);
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
function saveRules(){ if(window.FB && FB.currentUser()) FB.savePickRules({ words: S.rules, links: S.links }).catch(e => toast('詞庫存檔失敗：' + (e.message || e))); }

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
const RE_KEPT = /[（(]\s*已留\s*(\d{0,4})\s*[)）]/g, RE_PRE = /[（(]\s*預[訂定約購]\s*[)）]/g, RE_WAIT = /[（(]\s*等到貨\s*[)）]/g;
function parseItem(s){
  let reserved = false, keptN = null;
  s = s.replace(RE_KEPT, (_, d) => { reserved = true; if(d) keptN = +d; return ' '; });   // （已留）＝全留；（已留1）＝留了 1 個
  const preorder = RE_PRE.test(s); RE_PRE.lastIndex = 0; s = s.replace(RE_PRE, ' ');
  const wait = RE_WAIT.test(s); RE_WAIT.lastIndex = 0; s = s.replace(RE_WAIT, ' ');
  let tbd = false; s = s.replace(/[（(]?\s*數量\s*待確認\s*[)）]?/g, () => { tbd = true; return ' '; });   // 預訂商品：數量待確認
  s = s.trim().replace(/^(?:\d{1,3}\s*[.、．)）:：]|[-•・●▪]\s*)\s*/, '');
  let qty = 1, price = null, m;
  if((m = s.match(/(?:[*＊×xX+＋]|留)\s*(\d{1,4})\s*[個瓶支盒組件條包入罐片份]?\s*$/))){ qty = +m[1]; s = s.slice(0, m.index); }   // *3、x3、+3、留3 都當數量
  else if((m = s.match(/\s(\d{1,4})\s*[個瓶支盒組件條包罐片份]\s*$/))){ qty = +m[1]; s = s.slice(0, m.index); }
  else if((m = s.match(/(?:^|\s)(\d{1,4})\s*(?:pcs?|ｐｃｓ)\.?\s*$/i))){ qty = +m[1]; s = s.slice(0, m.index); }   // 5pcs、5 PCS、5pc 當數量
  if((m = s.match(/(?:定價|售價|特價|原價|NT\$?|＄|\$)\s*(\d[\d,]*)\s*元?/i))){ price = +m[1].replace(/,/g, ''); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  else if((m = s.match(/(\d[\d,]*)\s*元/))){ price = +m[1].replace(/,/g, ''); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  const name = simplify(s.replace(/\s+/g, ' ').trim());
  return name ? mkItem({ name, qty, price, reserved, kept: keptN, preorder, wait, tbd }) : null;
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
    const marks = line.match(/(?:[*＊×xX+＋]|留)\s*\d+/g) || [];
    const parts = marks.length > 1
      ? (line.match(/.+?(?:[*＊×xX+＋]|留)\s*\d+\s*[個瓶支盒組件條包入罐片份]?\s*(?:[（(]\s*已留\s*\d{0,4}\s*[)）])?/g) || [line]).map(p => p.replace(/^[、，,;；/／\s]+/, ''))
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
  if(r.items.length && !s.items.length) s.firstAt = Date.now();
  if(peopleOf(s).length && S.who) r.items.forEach(i => { if(!i.who) i.who = S.who; });   // 分人時，新商品放到目前選的人   // 留貨天數從加進第一筆商品那天開始算
  s.items = normals().concat(r.items.filter(i => !i.preorder && !i.wait), pres(), r.items.filter(i => i.preorder && !i.wait), waits(), r.items.filter(i => i.wait));
  touch(); renderItems();
}

// ---------- 輸出 ----------
const DIVIDER = '————————————';   // 不同人、不同張單之間的分隔線
// 這張單有分人的話，照人分組（沒指定人的放最前面）
const peopleOf = s => Array.isArray(s.people) ? s.people : [];
function whoGroups(s, items){
  const ppl = peopleOf(s); if(!ppl.length) return [{ who: null, items }];
  const g = [{ who: '', items: items.filter(i => !i.who || !ppl.includes(i.who)) }].concat(ppl.map(p => ({ who: p, items: items.filter(i => i.who === p) })));
  return g.filter(x => x.who || x.items.length);
}
function buildText(s){
  s = s || cur();
  const name = (s.customer || '').trim();
  const head = '#' + s.location + (name ? ' （' + name + '）' : '');
  const line = it => it.preorder && it.tbd ? `${it.name}${s.showPrice && it.price ? ' ' + it.price : ''}（數量待確認）` : `${it.name}${s.showPrice && it.price ? ' ' + it.price : ''}${it.qty ? ' *' + it.qty : ''}${it.reserved ? '（已留）' : isPartial(it) ? '（已留' + kOf(it) + '）' : ''}`;
  const block = items => {
    const n = items.filter(i => !i.preorder && !i.wait).map((it, i) => `${i + 1}. ${line(it)}`), p = items.filter(i => i.preorder && !i.wait).map(it => '（預訂）' + line(it)), w = items.filter(i => i.wait).map(it => '（等到貨）' + line(it));
    return [n, p, w].filter(g => g.length).map(g => g.join('\n')).join('\n\n');   // 每一組中間空一行
  };
  const parts = whoGroups(s, s.items).filter(g => g.items.length).map(g => (g.who ? '【' + g.who + '】\n' : '') + block(g.items));
  let t = head + '\n\n' + parts.join('\n' + DIVIDER + '\n');   // 不同人中間一條分隔線
  const note = (s.note || '').trim();
  if(note) t += '\n\n' + note;   // 備註放最下面，上面空一行（不加「備註：」）
  return t;
}

// ---------- 畫面 ----------
// 留貨天數：加進第一筆商品那天算第 1 天（舊的單沒有記錄，就用開單那天）
function keepDays(s){
  const d0 = new Date(s.firstAt || s.createdAt || Date.now()); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(); d1.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((d1 - d0) / 86400000)) + 1;
}
function renderSide(){
  const all = Array.from(S.slips.values()).filter(s => hasContent(s) || (s.id === S.curId && !S.closed));
  const drafts = all.filter(s => s.status !== 'done'), dones = all.filter(s => s.status === 'done');
  const left = s => s.items.filter(i => kOf(i) < effQ(i)).length;   // 還沒留滿的商品數
  // 還有沒撿完的單排最上面，同一組裡越新的越上面
  const list = (S.tab === 'done' ? dones : drafts).sort((a, b) => ((left(b) > 0) - (left(a) > 0)) || (b.updatedAt - a.updatedAt));
  const ts = t => { const d = new Date(t), today = new Date(); const same = d.toDateString() === today.toDateString();
    return (same ? '今天 ' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + two(d.getHours()) + ':' + two(d.getMinutes()); };
  const card = s => { const k = s.items.filter(i => i.reserved).length, n = left(s), ppl = peopleOf(s);
      const tag = !s.items.length ? '' : n ? `<span class="pk-left">${n} 項未撿</span>` : '<span class="pk-left ok">✓ 撿好</span>';
      return `<button type="button" class="pk-ord${n ? ' pending' : ''}${s.id === S.curId && !S.closed ? ' cur' : ''}" data-pkopen="${s.id}"><span class="t"><span class="nm">${esc(s.customer || '（未填客戶）')}</span><span class="tr"><span class="pk-pill">${esc(s.location)}</span>${tag}${s.status === 'done' ? '<span class="pk-pill done">已完成</span>' : ''}</span></span><span class="m"><span>${ppl.length ? esc(ppl.join('、')) + ' · ' : ''}${s.items.length} 項 · 已留 ${k}/${s.items.length}</span>${s.items.length ? '<span class="d">' + keepDays(s) + '天</span>' : ''}</span></button>`; };
  // 進行中：照位置分區，每區標題旁有「全部複製」（同一區每張單一起複製，中間分隔線）
  const body = !list.length ? `<div class="pk-empty">${S.tab === 'done' ? '還沒有完成的單' : '沒有進行中的單'}</div>`
    : S.tab === 'done' ? list.map(card).join('')
    : list.map(card).join('');   // 跟原本一樣一整列：未撿完的排最上面（另一種顏色）
  $('pkSide').innerHTML = `
    <button class="pk-new" type="button" data-pk="new">＋ 新撿貨單</button>
    <div class="pk-seg"><button type="button" data-pktab="draft" class="${S.tab === 'draft' ? 'on' : ''}">進行中 ${drafts.filter(hasContent).length}</button><button type="button" data-pktab="done" class="${S.tab === 'done' ? 'on' : ''}">已完成 ${dones.length}</button></div>
    ${body}
    <p class="pk-hint">單子 3 台電腦即時同步。</p>`;
}
function renderLocs(){
  $('pkLocs').innerHTML = LOCS.map(l => `<button type="button" class="pk-chip${cur().location === l ? ' on' : ''}" data-pkloc="${l}">${l}</button>`).join('');
}
// 這張單的客人：先看選過的客戶 id，沒有的話用名字或暱稱對
function custOf(s){
  s = s || cur(); const list = (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
  if(s.custId){ const c = list.find(x => x.id === s.custId); if(c) return c; }
  const name = (s.customer || '').trim(); if(!name) return null;
  return list.find(x => (x.name || '').trim() === name) || list.find(x => (x.nick || '').trim() === name) || null;
}
function renderGrade(){
  const c = custOf();
  if(typeof renderPeople === 'function' && $('pkPeople')) renderPeople();
  $('pkCustX').style.display = (cur().customer || '').trim() ? '' : 'none';
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
  return `<li class="pk-it${it.reserved ? ' kept' : isPartial(it) ? ' partial' : ''}" data-id="${it.id}">
    <span class="pk-grip" aria-label="拖曳">⠿</span>
    <button type="button" class="pk-sn${it.wait ? ' wait' : it.preorder ? ' pre' : ''}" data-act="pre" title="${it.wait ? '改回一般' : it.preorder ? '改成等到貨' : '改成預訂'}">${it.wait ? '等到貨' : it.preorder ? '預訂' : idx}</button>
    <input class="pk-nm" id="pkn-${it.id}" value="${esc(it.name)}" data-f="name" aria-label="品名">
    ${s.showPrice ? `<label class="pk-price">$<input id="pkp-${it.id}" inputmode="numeric" value="${it.price == null ? '' : it.price}" data-f="price" aria-label="金額" placeholder="—"></label>` : ''}
    ${it.preorder ? `<button type="button" class="pk-tbd${it.tbd ? ' on' : ''}" data-act="tbd" title="${it.tbd ? '改回填數量' : '數量還不確定'}">${it.tbd ? '數量待確認' : '待確認'}</button>` : ''}
    ${it.preorder && it.tbd ? '' : `<div class="qty-stepper"><button type="button" data-act="minus" aria-label="減一">−</button><input class="qty-num" id="pkq-${it.id}" inputmode="numeric" value="${it.qty == null ? '' : it.qty}" data-f="qty" aria-label="數量" placeholder="—"><button type="button" data-act="plus" aria-label="加一">＋</button></div>`}
    ${S.editKept === it.id
      ? `<span class="pk-circ-edit"><input class="pk-kn" id="pkkn-${it.id}" inputmode="numeric" data-f="kept" value="${kOf(it)}" aria-label="已留幾個"><span class="pk-kq">/${effQ(it)}</span></span>`
      : `<button type="button" class="pk-circ${it.reserved ? ' on' : isPartial(it) ? ' half' : ''}" data-act="circ" style="--p:${Math.round(kOf(it) / effQ(it) * 100)}%" title="點一下：全部已留／取消；長按：改留幾個" aria-label="已留 ${kOf(it)}/${effQ(it)}">${it.reserved ? '✓' : isPartial(it) ? `<span>${kOf(it)}/${effQ(it)}</span>` : ''}</button>`}
    <button type="button" class="pk-del" data-act="del" aria-label="刪除">×</button>
  </li>`;
}
function renderPeople(){
  const s = cur(), ppl = peopleOf(s);
  if(S.who && !ppl.includes(S.who)) S.who = ppl[0] || null;
  if(!S.who && ppl.length) S.who = ppl[0];
  $('pkPeople').innerHTML = ppl.length
    ? `<span class="pk-plab">分人：${ppl.map(esc).join('、')}</span><button type="button" class="pk-pchip add" data-padd="1">＋ 新增一位</button>`
    : ((s.customer || '').trim() && s.items.length ? `<button type="button" class="pk-pchip add" data-padd="1" title="這張單臨時要加別人的商品時，才按這裡">＋ 新增一位</button>` : '');   // 一開始都是一個人，先打客人、加商品；要追加別人時才出現
}
function renderItems(){
  const n = normals(), p = pres(), w = waits(), ppl = peopleOf(cur());
  renderPeople();
  $('pkAddForm').style.display = ppl.length ? 'none' : '';   // 分人時，每個人下面各有自己的加入格
  if(!ppl.length) $('pkAddExtra').dataset.who = '';
  if(ppl.length){
    // 分人：每個人一段＝標題、一般商品、預訂、等到貨、自己的加入格；人跟人之間一條粗線
    $('pkMain').innerHTML = whoGroups(cur(), cur().items).map(g => {
      const gn = g.items.filter(i => !i.preorder && !i.wait), gp = g.items.filter(i => i.preorder && !i.wait), gw = g.items.filter(i => i.wait);
      return `<li class="pk-whoh" data-who="${esc(g.who)}"><b>${esc(g.who || '未分人')}</b><span>${g.items.length} 項</span>${g.who ? `<button type="button" data-prn="${esc(g.who)}">改名</button><button type="button" data-prm="${esc(g.who)}">移除</button>` : ''}</li>`
        + gn.map((it, i) => itemHTML(it, i + 1)).join('')
        + (gp.length ? '<li class="pk-sep pk-sep2">預訂</li>' + gp.map(it => itemHTML(it, 0)).join('') : '')
        + (gw.length ? '<li class="pk-sep wait pk-sep2">等到貨</li>' + gw.map(it => itemHTML(it, 0)).join('') : '')
        + (g.who ? `<li class="pk-padd" data-who="${esc(g.who)}"><span class="pk-addplus">＋</span><textarea class="pk-in" rows="1" placeholder="加商品給 ${esc(g.who)}：黑炫風 *25，或貼上一整串" data-padd-in="${esc(g.who)}"></textarea><button type="button" class="pk-b pri" data-padd-go="${esc(g.who)}">加入</button></li>` : '');
    }).join('');
    $('pkPre').innerHTML = ''; $('pkWait').innerHTML = '';
    $('pkPreSep').style.display = 'none'; $('pkWaitSep').style.display = 'none';
  } else {
  $('pkMain').innerHTML = n.map((it, i) => itemHTML(it, i + 1)).join('') || (p.length || w.length ? '' : '<li class="pk-empty">還沒有商品。在上面那一格打商品，或貼上一整串文字、截圖。</li>');
  $('pkPre').innerHTML = p.map(it => itemHTML(it, 0)).join('');
  $('pkPreSep').style.display = p.length ? 'flex' : 'none';
  $('pkWait').innerHTML = w.map(it => itemHTML(it, 0)).join('');
  $('pkWaitSep').style.display = w.length ? 'flex' : 'none';
  }
  $('pkShowPrice').checked = !!cur().showPrice;
  renderSum();
}
function renderSum(){
  const s = cur(); const n = s.items.length, k = s.items.filter(i => i.reserved).length, q = s.items.reduce((a, b) => a + (b.preorder && b.tbd ? 0 : (+b.qty || 0)), 0);
  $('pkSum').innerHTML = `<b>${n}</b> 項 · 共 ${q} 件 · 已留 ${k}/${n}${s.status === 'done' ? ' <span class="pk-pill done">已完成</span>' : ''}`;
  $('pkDone').textContent = s.status === 'done' ? '改回進行中' : '完成';
  $('pkDel').style.display = canDelete() && (hasContent(s) || S.saved.has(s.id)) ? '' : 'none';
}
function renderRules(){
  const list = S.rules.slice().sort((a, b) => (b.on - a.on) || (b.count - a.count));
  $('pkRules').innerHTML = list.length ? list.map(r => `<span class="pk-rule${r.on ? '' : ' off'}">${esc(r.w)} <span class="c">${r.on ? '自動' : '刪過' + r.count + '次'}</span><button type="button" data-w="${esc(r.w)}" data-act="toggle">${r.on ? '停用' : '啟用'}</button><button type="button" data-w="${esc(r.w)}" data-act="remove">移除</button></span>`).join('') : '<span class="pk-hint">目前還沒有學到的字。</span>';
}
function renderClosed(){
  $('pkMainWrap').classList.toggle('is-closed', S.closed);
  if(!S.closed) return;
  const s = cur();
  const where = window.innerWidth <= 760 ? '上面' : '左邊';
  if(S.idle){
    $('pkClosed').innerHTML = `<div class="pk-closed-t" style="color:var(--ink)">請選一位客人</div>
      <p class="pk-hint">點${where}的客人卡片開始撿貨，或開一張新的撿貨單。</p>
      <div class="pk-row" style="justify-content:center"><button class="pk-b pri" type="button" data-pknew>＋ 新撿貨單</button></div>`;
    return;
  }
  $('pkClosed').innerHTML = `<div class="pk-closed-t">✓ 已暫存${s && s.customer ? '「' + esc(s.customer) + '」' : ''}</div>
    <p class="pk-hint">點${window.innerWidth <= 760 ? '上面' : '左邊'}的單子可以繼續編輯，或開一張新的。</p>
    <div class="pk-row" style="justify-content:center"><button class="pk-b" type="button" data-pkreopen>繼續編輯這張</button><button class="pk-b pri" type="button" data-pknew>＋ 新撿貨單</button></div>`;
}
function renderAll(){
  renderClosed();
  $('pkCust').value = cur().customer || '';
  $('pkNote').value = cur().note || '';
  renderNote();
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
// 不選任何客人：放一張空白單當底，編輯區收起來，等使用者點客人或開新單
function pickDefault(){
  const old = cur(); if(old && !hasContent(old) && !S.saved.has(old.id)) S.slips.delete(old.id);
  const n = newSlip(); S.slips.set(n.id, n); S.curId = n.id;
  S.closed = true; S.idle = true; S.confirmDel = null;
}
panel.addEventListener('focusout', () => setTimeout(() => { if(S.needRender && !editing()){ S.needRender = false; renderAll(); } }, 0));

const Pick = {
  start(){
    Pick.stop();
    if(!window.FB || !FB.listenPickslips) return;
    S.unsub.push(FB.listenPickslips(onSlips, e => toast('讀取撿貨單失敗：' + (e && e.code === 'permission-denied' ? '沒有權限（Firebase 規則還沒更新？）' : (e.message || e)))));
    S.unsub.push(FB.listenPickRules(r => { S.rules = Array.isArray(r && r.words) ? r.words : []; S.links = Array.isArray(r && r.links) ? r.links : []; renderRules(); if(calcSheet.style.display !== 'none') renderCalc(); }, () => {}));
  },
  stop(){ S.unsub.forEach(f => { try{ f(); }catch(e){} }); S.unsub = []; },
  refreshCustomers(){ renderCustList(); renderGrade(); }
};
window.Pick = Pick;

// ---------- 事件 ----------
$('pkSide').addEventListener('click', async e => {
  const cl = e.target.closest('[data-pkcopyloc]');
  if(cl){ const l = cl.dataset.pkcopyloc;
    const g = Array.from(S.slips.values()).filter(s => s.status !== 'done' && s.location === l && hasContent(s))
      .sort((a, b) => ((a.items.some(i => kOf(i) < effQ(i)) ? 0 : 1) - (b.items.some(i => kOf(i) < effQ(i)) ? 0 : 1)) || (b.updatedAt - a.updatedAt));
    if(!g.length) return;
    const t = g.map(s => buildText(s)).join('\n' + DIVIDER + '\n');
    if(await copyText(t)) toast(`已複製「${l}」${g.length} 張單`);
    else { $('pkOutText').textContent = t; $('pkCopyNote').textContent = '沒辦法自動複製，請按「全部複製」'; outSheet.style.display = 'flex'; }
    return; }
  const t = e.target.closest('[data-pk],[data-pktab],[data-pkopen]'); if(!t) return;
  if(t.dataset.pktab){ S.tab = t.dataset.pktab; S.confirmDel = null; renderSide(); return; }
  if(t.dataset.pkopen){ const old = cur(); if(old && !hasContent(old) && !S.saved.has(old.id)) S.slips.delete(old.id);
    clearTimeout(saveT); if(old && hasContent(old)) saveNow(old);
    S.curId = t.dataset.pkopen; S.closed = false; S.idle = false; S.noteOpen = false; S.confirmDel = null; renderAll(); return; }
  if(t.dataset.pk === 'new'){ const old = cur(); clearTimeout(saveT); if(old && hasContent(old)) saveNow(old); else if(old && !S.saved.has(old.id)) S.slips.delete(old.id);
    const n = newSlip(); S.slips.set(n.id, n); S.curId = n.id; S.closed = false; S.idle = false; S.noteOpen = false; S.tab = 'draft'; S.confirmDel = null; renderAll(); $('pkCust').focus(); return; }
  if(t.dataset.pk === 'del'){
    if(S.confirmDel !== S.curId){ S.confirmDel = S.curId; renderSide(); return; }
    const id = S.curId; S.confirmDel = null; clearTimeout(saveT);
    try{ if(S.saved.has(id)) await FB.deletePickslip(id); }catch(err){ toast('刪除失敗：' + (err.message || err)); return; }
    S.slips.delete(id); S.saved.delete(id); pickDefault(); renderAll(); toast('已刪除');
  }
});
// 客人：跟打單一樣，可以搜尋姓名、暱稱、電話、會員號碼，點選後帶入客戶資料（等級）
const custDrop = $('pkCustDrop');
let custHi = -1;
function renderCustDrop(){
  const raw = $('pkCust').value.trim(), q = raw.toLowerCase();
  if(!q){ custDrop.classList.remove('open'); custDrop.innerHTML = ''; return; }
  const list = (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
  const hit = (typeof custMatch === 'function' ? list.filter(c => custMatch(c, q)) : list.filter(c => (c.name || '').toLowerCase().includes(q))).slice(0, 8);
  const known = new Set(list.map(c => (c.name || '').trim()));
  const past = [...new Set(Array.from(S.slips.values()).map(x => (x.customer || '').trim()))].filter(n => n && !known.has(n) && n.toLowerCase().includes(q) && n !== raw).slice(0, 3);
  if(!hit.length && !past.length){ custDrop.classList.remove('open'); custDrop.innerHTML = ''; return; }
  const phones = c => (typeof custPhones === 'function' ? custPhones(c) : [c.phone, c.phone2].filter(Boolean).join(' / '));
  custDrop.innerHTML = hit.map(c => `<div class="cust-opt" data-cid="${esc(c.id)}"><div><div class="co-name">${esc(c.name || '')}</div><div class="co-sub">${esc([c.memberNo, phones(c)].filter(Boolean).join(' · '))}</div></div><span class="grade-badge grade-${esc(c.grade || 'A')}">${esc(c.grade || 'A')}</span></div>`).join('')
    + past.map(n => `<div class="cust-opt" data-pname="${esc(n)}"><div><div class="co-name">${esc(n)}</div><div class="co-sub">之前的撿貨單（不在客戶資料裡）</div></div></div>`).join('');
  custHi = -1; custDrop.classList.add('open');
}
function pickCust(opt){
  const s = cur(), list = (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
  if(opt.dataset.cid){ const c = list.find(x => x.id === opt.dataset.cid); if(!c) return; s.customer = c.name || ''; s.custId = c.id; }
  else { s.customer = opt.dataset.pname; s.custId = null; }
  $('pkCust').value = s.customer; custDrop.classList.remove('open'); renderGrade(); touch();
}
$('pkCust').addEventListener('input', e => { cur().customer = e.target.value; cur().custId = null; renderGrade(); renderPeople(); touch(); renderCustDrop(); });
$('pkCust').addEventListener('focus', e => { e.target.select(); renderCustDrop(); });   // 點進去就全選，直接打字就能換客人
$('pkCustX').addEventListener('click', () => { const s = cur(); s.customer = ''; s.custId = null; $('pkCust').value = ''; renderGrade(); touch(); renderSide(); $('pkCust').focus(); });
$('pkCust').addEventListener('keydown', e => {
  const opts = [...custDrop.querySelectorAll('.cust-opt')]; if(!custDrop.classList.contains('open') || !opts.length) return;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); custHi = (custHi + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; opts.forEach((o, i) => o.classList.toggle('hi', i === custHi)); }
  else if(e.key === 'Enter' && !e.isComposing){ e.preventDefault(); pickCust(opts[Math.max(0, custHi)]); }
  else if(e.key === 'Escape') custDrop.classList.remove('open');
});
custDrop.addEventListener('mousedown', e => e.preventDefault());
custDrop.addEventListener('click', e => { const o = e.target.closest('.cust-opt'); if(o) pickCust(o); });
document.addEventListener('click', e => { if(!e.target.closest('.pk-cust')) custDrop.classList.remove('open'); });
$('pkNote').addEventListener('input', e => { cur().note = e.target.value; touch(); $('pkNoteBtn').classList.toggle('has', !!e.target.value.trim()); });
// 備註：有內容或按了「✎ 備註」才顯示；內容清空、離開輸入框就收回去
function noteHas(){ return !!((cur() && cur().note) || '').trim(); }
function renderNote(){
  $('pkNoteWrap').style.display = (S.noteOpen || noteHas()) ? '' : 'none';
  $('pkNoteBtn').classList.toggle('has', noteHas());
}
$('pkNoteBtn').addEventListener('click', () => {
  const shown = $('pkNoteWrap').style.display !== 'none';
  if(shown && !noteHas()){ S.noteOpen = false; renderNote(); return; }
  S.noteOpen = true; renderNote(); $('pkNote').focus();
});
$('pkNote').addEventListener('blur', () => { if(!noteHas()){ S.noteOpen = false; renderNote(); } });
// 分人：同一間公司好幾個人留貨，放在同一張單裡分段
$('pkPeople').addEventListener('click', e => {
  const s = cur();
  const w = e.target.closest('[data-pwho]'); if(w){ S.who = w.dataset.pwho; renderPeople(); return; }
  if(e.target.closest('[data-padd]')) openPeopleDlg('');
});
// 新增一位／改名的視窗（畫在網頁上，不用瀏覽器內建視窗）
// 第一次新增：要填「分組名稱」（原本那些商品是誰的）和「新加的人」；之後只填新加的人
const pdlg = $('pkPeopleSheet');
function openPeopleDlg(old){
  const s = cur(), first = !old && !peopleOf(s).length, cnt = s.items.length;
  S.pEdit = { old, first };
  $('pkPdTitle').textContent = old ? '改名' : '新增一位';
  const fld = (id, lab, ph, v) => `<label class="pk-pdf"><span>${lab}</span><input class="pk-in" id="${id}" placeholder="${ph}" value="${esc(v || '')}" autocomplete="off"></label>`;
  $('pkPdBody').innerHTML = old ? fld('pkPdNew', '新的名字', '例如：曾于芳', old)
    : (first ? fld('pkPdGroup', `分組名稱（原本${cnt ? '這 ' + cnt + ' 項商品' : '的清單'}是誰的）`, '例如：曾于芳', (s.customer || '').trim()) : '') + fld('pkPdNew', '新加的人', '例如：王小美', '');
  $('pkPdErr').textContent = '';
  pdlg.style.display = 'flex';
  const f = $('pkPdNew'); f.focus(); f.select();   // 分組名稱先帶入客人名字，游標直接在「新加的人」
}
function closePeopleDlg(){ pdlg.style.display = 'none'; S.pEdit = null; }
pdlg.addEventListener('click', e => {
  if(e.target === pdlg || e.target.closest('[data-pdcancel]')){ closePeopleDlg(); return; }
  if(e.target.closest('[data-pdok]')) peopleOk();
});
pdlg.addEventListener('keydown', e => {
  if(e.key === 'Escape'){ closePeopleDlg(); return; }
  if(e.key === 'Enter' && !e.isComposing){ e.preventDefault();
    if(e.target.id === 'pkPdGroup'){ $('pkPdNew').focus(); return; }   // 第一格按 Enter 跳到下一格
    peopleOk(); }
});
function peopleOk(){
  const s = cur(), ed = S.pEdit; if(!ed) return;
  const err = m => { $('pkPdErr').textContent = m; };
  const n = ($('pkPdNew').value || '').trim(), g = ed.first ? ($('pkPdGroup').value || '').trim() : '';
  if(ed.first && !g){ err('請填分組名稱'); $('pkPdGroup').focus(); return; }
  if(!n){ err(ed.old ? '請填名字' : '請填新加的人'); $('pkPdNew').focus(); return; }
  const ppl = peopleOf(s).slice();
  if(ed.old){   // 改名
    if(n !== ed.old && ppl.includes(n)){ err('已經有「' + n + '」了'); return; }
    s.people = ppl.map(p => p === ed.old ? n : p); s.items.forEach(i => { if(i.who === ed.old) i.who = n; }); if(S.who === ed.old) S.who = n;
  } else {
    if(ed.first && g === n){ err('分組名稱和新加的人不能一樣'); return; }
    if(ppl.includes(n)){ err('已經有「' + n + '」了'); return; }
    if(ed.first){ ppl.push(g); s.items.forEach(i => { i.who = g; }); }   // 原本的商品都放進第一組
    ppl.push(n); s.people = ppl;
  }
  closePeopleDlg(); S.who = n; touch(); renderItems(); renderSide();
  const box = [...document.querySelectorAll('[data-padd-in]')].find(x => x.dataset.paddIn === n); if(box) box.focus();
}
// 分人時，每個人自己的加入格
function personAdd(who){
  const box = [...document.querySelectorAll('[data-padd-in]')].find(x => x.dataset.paddIn === who); if(!box) return;
  const t = box.value.trim(); if(!t){ box.focus(); return; }
  const r = parseText(t); if(!r.items.length){ toast('看不出商品，請檢查文字格式'); return; }
  r.customer = ''; r.items.forEach(i => { i.who = who; });
  mergeParsed(r);
  if(r.items.length > 1) toast('已加入 ' + r.items.length + ' 項給 ' + who);
  const nb = [...document.querySelectorAll('[data-padd-in]')].find(x => x.dataset.paddIn === who); if(nb) nb.focus();
}
$('pkMain').addEventListener('keydown', e => { const w = e.target.dataset && e.target.dataset.paddIn; if(w != null && e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); personAdd(w); } });
$('pkMain').addEventListener('input', e => { if(e.target.dataset && e.target.dataset.paddIn != null){ e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; } });
$('pkMain').addEventListener('click', e => {
  const s = cur();
  const go = e.target.closest('[data-padd-go]'); if(go){ personAdd(go.dataset.paddGo); return; }
  const rn = e.target.closest('[data-prn]'); if(rn){ openPeopleDlg(rn.dataset.prn); return; }
  const rm = e.target.closest('[data-prm]'); if(rm){ const o = rm.dataset.prm;
    if(!confirm(`把「${o}」移除？他的商品會留在這張單（變成未分人），不會刪掉。`)) return;
    s.people = peopleOf(s).filter(p => p !== o); s.items.forEach(i => { if(i.who === o) i.who = ''; if(!s.people.length) delete i.who; });
    touch(); renderItems(); renderSide(); }
});
$('pkLocs').addEventListener('click', e => { const b = e.target.closest('[data-pkloc]'); if(!b) return; cur().location = b.dataset.pkloc; renderLocs(); touch(); });
$('pkShowPrice').addEventListener('change', e => { cur().showPrice = e.target.checked; renderItems(); touch(); });

const findItem = el => { const li = el.closest('.pk-it'); return li && cur().items.find(i => i.id === li.dataset.id); };
[$('pkMain'), $('pkPre'), $('pkWait')].forEach(L => {
  L.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if(!b) return; const it = findItem(b); if(!it) return;
    const s = cur(), a = b.dataset.act;
    if(a === 'del'){ s.items = s.items.filter(i => i !== it); toast('已刪除「' + it.name + '」'); }
    if(a === 'tbd') it.tbd = !it.tbd;
    if(a === 'who'){ const ppl = peopleOf(s); const i = ppl.indexOf(it.who); it.who = ppl[(i + 1) % ppl.length] || ''; }
    if(a === 'circ'){ if(b._long){ b._long = false; return; } setKept(it, it.reserved ? 0 : effQ(it)); }   // 點圓圈：全部已留／取消
    if(a === 'plus'){ const k = kOf(it); it.qty = (it.qty || 0) + 1; setKept(it, k); }
    if(a === 'minus'){ const k = kOf(it); if(it.qty) it.qty = Math.max(1, it.qty - 1); setKept(it, k); }
    if(a === 'pre'){   // 一般 → 預訂 → 等到貨 → 一般，換組時排到那一組的最後
      s.items = s.items.filter(i => i !== it);
      if(it.wait){ it.wait = false; it.preorder = false; } else if(it.preorder){ it.preorder = false; it.wait = true; } else it.preorder = true;
      const N = normals(), P = pres(), W = waits();
      (it.wait ? W : it.preorder ? P : N).push(it);
      s.items = N.concat(P, W);
    }
    renderItems(); touch();
  });
  L.addEventListener('input', e => {
    const f = e.target.dataset.f, it = findItem(e.target); if(!it || !f) return;
    if(f === 'name') it.name = e.target.value;
    if(f === 'price'){ const v = e.target.value.replace(/[^\d]/g, ''); it.price = v ? +v : null; }
    if(f === 'qty'){ const raw = e.target.value.trim(), v = parseInt(raw), k = kOf(it);
      if(raw === ''){ it.qty = null; setKept(it, k); } else if(v > 0){ it.qty = v; setKept(it, k); } }   // 清空＝數量空白
    if(f === 'reserved'){ setKept(it, e.target.checked ? effQ(it) : 0); renderItems(); }
    if(f === 'kept'){ const v = e.target.value.replace(/[^\d]/g, ''); if(v !== ''){ setKept(it, +v); const li = e.target.closest('.pk-it');
      li.classList.toggle('kept', it.reserved); li.classList.toggle('partial', isPartial(it)); const cb = li.querySelector('[data-f="reserved"]'); if(cb) cb.checked = it.reserved; } }
    touch();
  });
  L.addEventListener('focusin', e => { if(e.target.dataset.f === 'name') e.target.dataset.orig = e.target.value; });
  // 長按（或按右鍵）圓圈：改成輸入「留了幾個」
  let pressT = null;
  const openKeptEdit = (btn) => { const it = findItem(btn); if(!it) return; btn._long = true; S.editKept = it.id; renderItems();
    const inp = $('pkkn-' + it.id); if(inp){ inp.focus(); inp.select(); } };
  L.addEventListener('pointerdown', e => { const btn = e.target.closest('.pk-circ'); if(!btn || e.button > 0) return; clearTimeout(pressT); pressT = setTimeout(() => openKeptEdit(btn), 500); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => L.addEventListener(ev, () => clearTimeout(pressT)));
  L.addEventListener('contextmenu', e => { const btn = e.target.closest('.pk-circ'); if(!btn) return; e.preventDefault(); clearTimeout(pressT); openKeptEdit(btn); });
  L.addEventListener('keydown', e => { if(e.target.dataset.f === 'kept' && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur(); });
  L.addEventListener('focusout', e => { if(e.target.dataset.f === 'kept'){ S.editKept = null; setTimeout(renderItems, 0); } });
  L.addEventListener('change', e => {
    const it = findItem(e.target); if(!it) return;
    if(e.target.dataset.f === 'name'){ const o = e.target.dataset.orig || '', n = e.target.value.trim();
      if(!n){ it.name = o; e.target.value = o; return; }
      it.name = n; if(o && n !== o) learn(o, n); e.target.dataset.orig = n; }
    if(e.target.dataset.f === 'kept') S.editKept = null;
    if(e.target.dataset.f === 'qty' || e.target.dataset.f === 'kept') renderItems();
  });
});
function syncOrder(){
  const map = Object.fromEntries(cur().items.map(i => [i.id, i]));
  if(peopleOf(cur()).length){ let who = ''; [...$('pkMain').children].forEach(li => { if(li.classList.contains('pk-whoh')) who = li.dataset.who || ''; else if(li.dataset.id && map[li.dataset.id]) map[li.dataset.id].who = who; }); }
  const ids = [...$('pkMain').children, ...$('pkPre').children, ...$('pkWait').children].map(li => li.dataset.id).filter(Boolean);
  cur().items = ids.map(id => map[id]).filter(Boolean);
  renderItems(); touch();
}
if(window.Sortable) [$('pkMain'), $('pkPre'), $('pkWait')].forEach(L => Sortable.create(L, { handle: '.pk-grip', animation: 150, draggable: '.pk-it', filter: '.pk-empty', onEnd: syncOrder }));

// 加入商品：一筆或一整串都從這一格加入（一整串會自動拆行、抓客人和位置）
const addIn = $('pkAddIn');
function growAdd(){ addIn.style.height = 'auto'; addIn.style.height = Math.min(addIn.scrollHeight, 260) + 'px'; }
addIn.addEventListener('input', growAdd);
addIn.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); $('pkAddForm').requestSubmit(); } });
$('pkAddForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = addIn.value.trim();
  if(!t){ toast(S.pendingImgs.length ? '先按「辨識照片文字」' : '先打商品，或貼上文字'); return; }
  const r = parseText(t); if(!r.items.length && !r.customer){ toast('看不出商品，請檢查文字格式'); return; }
  mergeParsed(r); addIn.value = ''; growAdd();
  if(r.items.length > 1) toast('已加入 ' + r.items.length + ' 項');
});

// ---------- 照片 → 文字（瀏覽器內建辨識，第一次會下載辨識檔，稍等一下）----------
function addImgs(files){
  for(const f of files) if(f.type && f.type.startsWith('image/')) S.pendingImgs.push({ file: f, url: URL.createObjectURL(f) });
  renderThumbs();
}
function renderThumbs(){
  $('pkThumbs').innerHTML = S.pendingImgs.map((p, i) => `<div class="pk-thumb"><img src="${p.url}" alt="待辨識照片"><button type="button" data-rm="${i}" aria-label="移除">×</button></div>`).join('');
  $('pkOcr').style.display = S.pendingImgs.length ? '' : 'none';
  $('pkAddExtra').style.display = S.pendingImgs.length || $('pkOcrNote').textContent ? '' : 'none';
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
    addIn.value = (addIn.value.trim() ? addIn.value.trim() + '\n' : '') + txt; growAdd();
    S.pendingImgs = []; renderThumbs();
    note.textContent = ''; toast('辨識完成，請檢查文字後按「加入」'); addIn.focus();
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

$('pkSave').addEventListener('click', async () => { if(!hasContent(cur())){ toast('這張單還是空的'); return; } clearTimeout(saveT); cur().updatedAt = Date.now(); await saveNow(); S.closed = true; S.idle = false; S.confirmDel = null; $('pkOutSheet').style.display = 'none'; renderAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('已暫存'); });
$('pkClosed').addEventListener('click', e => {
  if(e.target.closest('[data-pkreopen]')){ S.closed = false; S.idle = false; S.noteOpen = false; renderAll(); }
  if(e.target.closest('[data-pknew]')) $('pkSide').querySelector('[data-pk="new"]').click();
});
$('pkDone').addEventListener('click', async () => {
  const s = cur(); if(!hasContent(s)){ toast('這張單還是空的'); return; }
  s.status = s.status === 'done' ? 'draft' : 'done'; s.updatedAt = Date.now(); clearTimeout(saveT); await saveNow(s);
  renderSum(); renderSide(); toast(s.status === 'done' ? '已完成，可在左邊「已完成」找到' : '改回進行中');
});
const outSheet = $('pkOutSheet');
// 刪除這張撿貨單（老闆帳號才可以刪；會先確認一次）
$('pkDel').addEventListener('click', async () => {
  const s = cur(); if(!s) return;
  if(!confirm(`確定要刪除${(s.customer || '').trim() ? '「' + s.customer.trim() + '」的' : '這張'}撿貨單嗎？刪除後沒辦法復原。`)) return;
  const id = s.id; clearTimeout(saveT);
  try{ if(S.saved.has(id)) await FB.deletePickslip(id); }catch(err){ toast('刪除失敗：' + (err && err.code === 'permission-denied' ? '沒有權限' : (err.message || err))); return; }
  S.slips.delete(id); S.saved.delete(id); pickDefault(); renderAll(); toast('已刪除');
});
// 一鍵輸出：直接複製到剪貼簿，同時把這張單暫存起來、編輯區收起來；複製失敗才打開視窗讓你手動複製
function copyText(t){
  return new Promise(ok => {
    const legacy = () => { let r = false; try{ const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); r = document.execCommand('copy'); ta.remove(); }catch(e){} ok(r); };
    try{ navigator.clipboard.writeText(t).then(() => ok(true), legacy); }catch(e){ legacy(); }
  });
}
$('pkOut').addEventListener('click', async () => {
  const s = cur(); if(!hasContent(s)){ toast('這張單還是空的'); return; }
  const t = buildText();
  const copied = await copyText(t);
  if(copied) toast('已複製，可以直接貼上');
  else { $('pkOutText').textContent = t; $('pkCopyNote').textContent = '沒辦法自動複製，請按「全部複製」'; outSheet.style.display = 'flex'; }
  clearTimeout(saveT); s.updatedAt = Date.now(); await saveNow(s);
  S.closed = true; S.idle = false; S.confirmDel = null; renderAll();
});
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

// ---------- 算金額：用 POS 的價錢算這張單（只算有貨、已留的）----------
const calcSheet = $('pkCalcSheet');
const posRows = () => (typeof rows !== 'undefined' && Array.isArray(rows)) ? rows : [];
const posCusts = () => (typeof customers !== 'undefined' && Array.isArray(customers)) ? customers : [];
// 比對用：全形轉半形、轉小寫、去掉空白和符號
// 香水濃度：英文縮寫換成中文，兩邊才比得起來（淡香水=EDT、淡香精=EDP、香精=Parfum、古龍水=EDC）
const CONC = [[/eau\s*de\s*parfum|\bedp\b/g, '淡香精'], [/eau\s*de\s*toilette|\bedt\b/g, '淡香水'], [/eau\s*de\s*cologne|\bedc\b/g, '古龍水'], [/\bextrait\b|\bparfum\b|\bperfume\b/g, '香精']];
const unify = t => { let v = String(t || '').normalize('NFKC').toLowerCase(); CONC.forEach(([re, w]) => { v = v.replace(re, ' ' + w + ' '); }); return v; };
const concOf = t => /淡香精/.test(t) ? 'edp' : /淡香水/.test(t) ? 'edt' : /古龍水/.test(t) ? 'edc' : /香精/.test(t) ? 'p' : '';
const norm = t => unify(t).replace(/[\s()（）\[\]【】「」#＃*×,，.。、\/\-_~～:：;；!！?？'"+]/g, '');
// 容量：抓出 ml / g / L，換成同一個單位比大小
const volOf = t => { const m = String(t).normalize('NFKC').match(/(\d+(?:\.\d+)?)\s*(ml|毫升|g|克|公克|l|公升)(?![a-z])/i); if(!m) return null; const v = +m[1], u = m[2].toLowerCase(); return (u === 'l' || u === '公升') ? v * 1000 : v; };
// T包（試用瓶／簡裝）：POS 品名寫「T包」或結尾一個「T」；有沒有 T包 要一致
const TEST_RE = /t包|\btester\b|(?:^|\s)t(?=\s|$)/i;
const isT = t => TEST_RE.test(String(t).normalize('NFKC'));
const SIZE_RE = /(?:^|\s)(大|中|小)(?:瓶|罐|支|條|號|容量)?(?=\s|$)/;
// 雙字切片：中文和英數字分開切（「心100ml」不會切出「心1」）
const grams = t => { const g = new Set(); (t.match(/[\u3400-\u9fff]+|[^\u3400-\u9fff]+/g) || []).forEach(seg => { if(seg.length === 1) g.add(seg); for(let i = 0; i < seg.length - 1; i++) g.add(seg.slice(i, i + 2)); }); return g; };
const nums = t => (String(t).normalize('NFKC').match(/\d+(\.\d+)?/g) || []);
let IDX = null, IDXsrc = null;
function index(){
  const R = posRows(); if(IDX && IDXsrc === R && IDX.n === R.length) return IDX;
  const list = [];
  R.forEach(r => { const nm = String(r[4] || '').trim(); if(!nm || nm === '無' || nm === 'X') return;
    const n = norm(nm), t = isT(nm), core = norm(t ? String(nm).normalize('NFKC').replace(new RegExp(TEST_RE.source, 'gi'), ' ') : nm);
    const sz = (String(nm).normalize('NFKC').match(SIZE_RE) || [])[1] || '';
    list.push({ r, n, core, g: grams(core), num: nums(nm), c: concOf(n), v: volOf(nm), t, sz, k: String(r[3] || r[2] || '') }); });
  IDX = { list, n: R.length }; IDXsrc = R; return IDX;
}
const rowKey = x => x.k + '|' + x.n;
function findByLink(l){ return index().list.find(x => x.k === l.k && x.r[4] === l.n) || index().list.find(x => x.k === l.k) || null; }
// 找最像的商品：雙字比對（Dice）＋容量數字要一樣
const guessMemo = new Map();
function guess(name, top){
  const key = (top || 5) + '|' + name, ix = index();
  if(guessMemo.get('@') !== ix) { guessMemo.clear(); guessMemo.set('@', ix); }
  if(guessMemo.has(key)) return guessMemo.get(key);
  const r = guessRaw(name, top); guessMemo.set(key, r); return r;
}
function guessRaw(name, top){
  const sm = String(name).normalize('NFKC').match(SIZE_RE), size = sm ? sm[1] : '';   // 只寫「大／中／小」
  const qt = isT(name);
  let base = String(name).normalize('NFKC');
  if(size) base = base.replace(SIZE_RE, ' ');
  if(qt) base = base.replace(new RegExp(TEST_RE.source, 'gi'), ' ');
  const q = norm(base), qg = grams(q), qn = nums(base), qc = concOf(q);
  if(!q) return [];
  const out = [];
  for(const x of index().list){
    let sc;
    if(x.core === q) sc = 1;
    else { let hit = 0; qg.forEach(g => { if(x.g.has(g)) hit++; }); if(!hit) continue;
      const cover = hit / qg.size, dice = 2 * hit / (qg.size + x.g.size);   // cover：打的字有多少出現在 POS 品名裡
      sc = cover * 0.75 + dice * 0.25;
      if(x.core.includes(q)) sc = Math.max(sc, 0.85 + 0.1 * dice);
      if(qn.length && !qn.every(v => x.num.includes(v))) sc *= 0.55;   // 容量、號碼對不上就大扣分（只寫 100 也算對到 100ml）
    }
    if(qc && x.c && qc !== x.c) sc *= 0.5;   // 淡香水／淡香精／香精 不一樣就大扣分
    if(qt !== x.t) sc *= 0.7;                 // 有寫 T包 就找 T包，沒寫就找一般的
    out.push({ x, sc });
  }
  out.sort((a, b) => b.sc - a.sc);
  // 只寫「大／中／小」：在分數差不多的同款商品裡，照品名的大中小或容量挑一個
  if(size && out.length > 1){
    const fam = out.filter(o => o.sc >= out[0].sc - 0.12);
    let pick = fam.filter(o => o.x.sz === size);
    if(!pick.length){
      const vs = [...new Set(fam.map(o => o.x.v).filter(v => v != null))].sort((a, b) => a - b);
      const want = vs.length < 2 ? null : size === '大' ? vs[vs.length - 1] : size === '小' ? vs[0] : (vs.length % 2 ? vs[(vs.length - 1) / 2] : null);
      pick = want == null ? [] : fam.filter(o => o.x.v === want);
    }
    if(pick.length){ const top0 = out[0].sc; pick.forEach(o => { o.sc = Math.min(0.99, Math.max(top0 + 0.15, top0 >= 0.6 ? 0.86 : 0)); }); out.sort((a, b) => b.sc - a.sc); }
  }
  return out.slice(0, top || 5);
}
// 一項商品對到哪個 POS 商品：記住的 → 很確定的自動對上 → 不確定（要人選）
function matchOf(it){
  const q = norm(it.name);
  const l = S.links.find(v => v.q === q);
  if(l){ const x = findByLink(l); if(x) return { x, how: 'link' }; }
  const g = guess(it.name, 2);
  if(g[0] && g[0].sc >= 0.8 && (!g[1] || g[0].sc - g[1].sc >= 0.1 || g[1].x.n === g[0].x.n)) return { x: g[0].x, how: 'auto' };
  return { x: null, how: 'none', best: g[0] && g[0].sc >= 0.35 ? g[0].x : null };
}
const calcCust = () => custOf();
const gradeNow = () => { const c = calcCust(); return c ? (c.grade || 'A') : (cur().calcGrade || 'A'); };
const GI = { A: 6, B: 7, C: 8, D: 9 };
const priceAt = (x, g) => { const v = parseFloat(String(x.r[GI[g] || 6]).replace(/,/g, '')); return isNaN(v) ? null : v; };
const money = v => (Math.round(v * 10) / 10).toLocaleString('en-US');
function renderCalc(){
  const s = cur(), c = calcCust(), g = gradeNow();
  const body = $('pkCalcBody');
  if(!index().list.length){ body.innerHTML = '<p class="pk-hint">商品資料還沒載入完成，請稍等一下再按一次。</p>'; return; }
  const items = normals().filter(it => kOf(it) > 0);
  const skipped = s.items.length - items.length;
  let total = 0, miss = 0;
  const lines = items.map(it => {
    const m = matchOf(it), q = kOf(it);
    const manual = it.price != null, unit = manual ? it.price : (m.x ? priceAt(m.x, g) : null);
    const ok = unit != null && (manual || m.x);
    if(ok) total += unit * q; else miss++;
    const tag = manual ? `<span class="pk-cm man">手填價錢</span>${m.x ? ' <span class="pk-cm-n">' + esc(m.x.r[4]) + '</span>' : ''}`
      : m.x ? `<span class="pk-cm ok">✓ ${m.how === 'link' ? '已對上' : '自動對上'}</span> <span class="pk-cm-n">${esc(m.x.r[4])}</span>`
      : `<span class="pk-cm q">？ 點這裡選商品</span>${m.best ? ' <span class="pk-cm-n">可能是：' + esc(m.best.r[4]) + '</span>' : ''}`;
    const open = S.calcOpen === it.id;
    let pick = '';
    if(open){
      const qv = S.calcQ || '';
      const cands = candsFor(it, qv);
      pick = `<div class="pk-cpick">
        <input class="pk-in" id="pkCalcQ" placeholder="搜尋 POS 商品（品名、條碼或編號）" value="${esc(qv)}" autocomplete="off">
        <div id="pkCalcOpts">${optsHTML(cands, g)}</div>
        ${S.links.some(v => v.q === norm(it.name)) ? '<button type="button" class="pk-b" data-unlink="1">取消這個對照</button>' : ''}
      </div>`;
    }
    return `<li class="pk-cl${ok ? '' : ' miss'}${open ? ' open' : ''}" data-cid="${it.id}">
      <button type="button" class="pk-crow" data-copen="1">
        <span class="pk-cnm"><span class="nm">${esc(it.name)}</span><span class="sub">${tag}</span></span>
        <span class="pk-cq">${unit == null ? '—' : '$' + money(unit)} × ${q}</span>
        <span class="pk-csub">${ok ? '$' + money(unit * q) : '未算'}</span>
      </button>${pick}</li>`;
  }).join('');
  body.innerHTML = `
    <div class="pk-cgrade">${c ? `<span>${esc(c.name)}</span><span class="grade-badge grade-${esc(g)}">${esc(g)}</span><span class="pk-hint">依客戶資料的會員等級</span>`
      : `<span>${esc((s.customer || '').trim() || '未填客戶')}</span><span class="pk-hint">客戶資料裡找不到，請選等級：</span><span class="pk-cseg">${['A','B','C','D'].map(x => `<button type="button" data-cg="${x}" class="${g === x ? 'on' : ''}">${x}</button>`).join('')}</span>`}</div>
    <p class="pk-hint">只算有貨、已留的商品（只留一部分的照已留的數量算）。有手填價錢的用手填的。點一項可以改對到哪個商品，選過會記住，下次自動對上。</p>
    ${items.length ? `<ul class="pk-clist">${lines}</ul>` : '<p class="pk-hint" style="text-align:center;padding:12px 0">這張單還沒有已留的商品。</p>'}
    <div class="pk-ctotal"><span>${items.length} 項${skipped ? `<span class="pk-hint">（另有 ${skipped} 項未留或預訂，沒算）</span>` : ''}</span><b>總額 $${money(total)}</b></div>
    ${miss ? `<p class="pk-cwarn">還有 ${miss} 項沒對上商品，沒算進總額。</p>` : ''}
    ${items.length && typeof addToCart === 'function' ? `<div class="pk-row" style="justify-content:flex-end"><button class="pk-b pri" type="button" data-toorder="1">轉到打單 →</button></div>` : ''}`;
  if(open()){ const inp = $('pkCalcQ'); if(inp && S.calcFocus){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
  function open(){ return !!S.calcOpen; }
}
function candsFor(it, qv){ return qv.trim() ? searchRows(qv) : guess(it.name, 5).map(v => v.x); }
function optsHTML(cands, g){
  return cands.length ? cands.map(x => `<button type="button" class="pk-copt" data-pick="${esc(rowKey(x))}"><span>${esc(x.r[4])}</span><b>${priceAt(x, g) == null ? '—' : '$' + money(priceAt(x, g))}</b></button>`).join('') : '<p class="pk-hint">找不到，換個關鍵字試試。</p>';
}
function searchRows(qv){
  const toks = qv.trim().split(/\s+/).map(norm).filter(Boolean); if(!toks.length) return [];
  const raw = qv.trim();
  const out = [];
  for(const x of index().list){
    if(x.k === raw || String(x.r[2]) === raw || String(x.r[3]) === raw || toks.every(t => x.n.includes(t))){ out.push(x); if(out.length >= 8) break; }
  }
  return out.length ? out : guess(qv, 8).filter(v => v.sc >= 0.3).map(v => v.x);   // 完全符合的找不到，就列最像的
}
$('pkCalcBtn').addEventListener('click', () => { if(!hasContent(cur())){ toast('這張單還是空的'); return; } S.calcOpen = null; S.calcQ = ''; renderCalc(); calcSheet.style.display = 'flex'; });
calcSheet.addEventListener('click', e => {
  if(e.target === calcSheet || e.target.hasAttribute('data-pkcclose')){ calcSheet.style.display = 'none'; return; }
  const cg = e.target.closest('[data-cg]'); if(cg){ cur().calcGrade = cg.dataset.cg; touch(); renderCalc(); return; }
  if(e.target.closest('[data-toorder]')){ toOrder(); return; }
  const li = e.target.closest('.pk-cl'); if(!li) return;
  const it = cur().items.find(i => i.id === li.dataset.cid); if(!it) return;
  if(e.target.closest('[data-copen]')){ S.calcOpen = S.calcOpen === it.id ? null : it.id; S.calcQ = ''; S.calcFocus = false; renderCalc(); return; }
  const pk = e.target.closest('[data-pick]');
  if(pk){ const x = index().list.find(v => rowKey(v) === pk.dataset.pick); if(!x) return;
    const q = norm(it.name); S.links = S.links.filter(v => v.q !== q); S.links.push({ q, k: x.k, n: x.r[4] });
    saveRules(); S.calcOpen = null; renderCalc(); toast('已記住：' + it.name + ' → ' + x.r[4]); return; }
  if(e.target.closest('[data-unlink]')){ const q = norm(it.name); S.links = S.links.filter(v => v.q !== q); saveRules(); renderCalc(); }
});
// 轉到打單：把算好的商品（有貨、已留）放進打單的出貨清單，客人和等級一起帶過去
function toOrder(){
  const items = normals().filter(it => kOf(it) > 0);
  const lines = items.map(it => ({ it, m: matchOf(it), q: kOf(it) })).filter(l => l.m.x || l.it.price != null);
  const miss = items.length - lines.length;
  if(!lines.length){ toast('沒有對上商品的項目可以轉'); return; }
  if(miss && !confirm(`還有 ${miss} 項沒對上商品，這幾項不會轉過去。要繼續嗎？`)) return;
  if((cart.length || selectedCustomer) && typeof holdCurrentOrder === 'function'){
    if(!confirm('打單畫面現在還有內容，要先把它暫存起來，再轉這張撿貨單嗎？（取消的話不會轉）')) return;
    if(!holdCurrentOrder()) return;
  }
  cart = []; if(typeof currentTxn !== 'undefined') currentTxn = null;
  const c = calcCust();
  if(c) selectCustomer({ ...c }); else { resetOrderCustomerUI(); setPriceMode(gradeNow()); }
  lines.forEach(({ it, m, q }) => {
    if(m.x){ const key = addToCart(m.x.r, q); if(it.price != null){ const ci = cart.find(x => x.key === key); if(ci) ci.unitPrice = it.price; } }
    else cart.push({ key: 'pk-' + it.id, code: '', barcode: '', name: it.name, base: null, qty: q, unitPrice: it.price, note: '' });
  });
  renderCart(); if(typeof updateEditBanner === 'function') updateEditBanner();
  calcSheet.style.display = 'none';
  switchTab('order');
  if(!c) setTimeout(() => alert(`已轉到打單：${lines.length} 項\n客戶資料裡找不到「${(cur().customer || '').trim() || '未填客戶'}」，請在打單畫面選客人（價錢已先用 ${gradeNow()} 級）`), 80);
}
// 搜尋框：只更新下面的選項，不重畫整個視窗（中文輸入法選字時才不會被打斷）
function refreshOpts(inp){
  S.calcQ = inp.value; const it = cur().items.find(i => i.id === S.calcOpen); const box = $('pkCalcOpts');
  if(it && box) box.innerHTML = optsHTML(candsFor(it, S.calcQ), gradeNow());
}
calcSheet.addEventListener('input', e => { if(e.target.id === 'pkCalcQ' && !e.isComposing) refreshOpts(e.target); });
calcSheet.addEventListener('compositionend', e => { if(e.target.id === 'pkCalcQ') refreshOpts(e.target); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') calcSheet.style.display = 'none'; });

// 一開始先放一張空白單，雲端資料到了再換成最近那張
pickDefault(); renderAll();
// 每次點進撿貨單分頁：先存好手上那張，畫面回到「請選一位客人」
const pickTabBtn = document.querySelector('.tab-btn[data-tab="pick"]');
if(pickTabBtn) pickTabBtn.addEventListener('click', () => {
  if(panel.classList.contains('active')) return;   // 已經在撿貨單分頁就不動
  const old = cur(); clearTimeout(saveT); if(old && hasContent(old)) saveNow(old);
  pickDefault(); renderAll();
}, true);
if(window.FB && FB.currentUser && FB.currentUser()) Pick.start();
})();
