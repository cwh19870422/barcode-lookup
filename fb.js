// Firebase 連線層：登入（Authentication）＋ 客戶、交易紀錄（Firestore）
// 給 next.html / customers-next.html 共用。網頁用的設定碼本來就是公開的，真正的保護在 Firestore 安全規則（firestore.rules）。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore,
  collection, doc, setDoc, deleteDoc, onSnapshot, query, where, getDocs, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBWJXQ2OPxI4-oZZAAjcCq7XFlWHmKh5vg",
  authDomain: "samstore-pos.firebaseapp.com",
  projectId: "samstore-pos",
  storageBucket: "samstore-pos.firebasestorage.app",
  messagingSenderId: "574141177646",
  appId: "1:574141177646:web:67fdd9374be212da7ea4bf"
};

// 登入畫面只輸入密碼；程式依序用這幾個帳號去試，哪個密碼對就是哪個身分
const ACCOUNTS = [
  { email: 'how@samstore.com',   role: 'boss'  },
  { email: 'sam@samstore.com',   role: 'boss'  },
  { email: 'staff@samstore.com', role: 'staff' }
];
const roleOf = email => { const a = ACCOUNTS.find(x => x.email === String(email || '').toLowerCase()); return a ? a.role : null; };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = getFirestore(app);
}
try { await setPersistence(auth, browserLocalPersistence); } catch (e) { /* 記住登入失敗就算了 */ }

const clean = o => JSON.parse(JSON.stringify(o));          // Firestore 不收 undefined
const monthOfIso = iso => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

const FB = {
  roleOf,
  onAuth(cb) {
    return onAuthStateChanged(auth, u => cb(u ? { email: u.email, role: roleOf(u.email) } : null));
  },
  currentUser() { return auth.currentUser ? { email: auth.currentUser.email, role: roleOf(auth.currentUser.email) } : null; },
  async login(password) {
    let blocked = false;
    for (const a of ACCOUNTS) {
      try {
        await signInWithEmailAndPassword(auth, a.email, password);
        return a.role;
      } catch (e) {
        if (e && e.code === 'auth/too-many-requests') { blocked = true; break; }
        if (e && e.code === 'auth/network-request-failed') throw e;
        // 其他（密碼不對）就換下一個帳號試
      }
    }
    const err = new Error(blocked ? 'too-many-requests' : 'wrong-password');
    err.code = blocked ? 'auth/too-many-requests' : 'auth/wrong-password';
    throw err;
  },
  logout() { return signOut(auth); },

  // ---- 客戶 ----
  listenCustomers(cb, onErr) {
    return onSnapshot(collection(db, 'customers'), snap => {
      const list = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
      cb(list);
    }, e => onErr && onErr(e));
  },
  saveCustomer(c) {
    const { id, ...rest } = c;
    const ref = id ? doc(db, 'customers', id) : doc(collection(db, 'customers'));
    return setDoc(ref, clean(rest)).then(() => ref.id);
  },
  deleteCustomer(id) { return deleteDoc(doc(db, 'customers', id)); },
  // 客戶管理頁用：把整份清單寫成目前這樣（新增/修改/刪除一次完成）
  async replaceCustomers(list, existingIds) {
    const keep = new Set();
    let batch = writeBatch(db), n = 0;
    const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(db); n = 0; } };
    for (const c of list) {
      const { id, ...rest } = c;
      const ref = id ? doc(db, 'customers', id) : doc(collection(db, 'customers'));
      keep.add(ref.id);
      batch.set(ref, clean(rest)); if (++n >= 400) await flush();
    }
    for (const id of existingIds || []) { if (!keep.has(id)) { batch.delete(doc(db, 'customers', id)); if (++n >= 400) await flush(); } }
    await flush();
  },

  // ---- 交易紀錄 ----
  listenTxns(sinceMonth, cb, onErr) {
    const q = query(collection(db, 'transactions'), where('month', '>=', sinceMonth));
    return onSnapshot(q, snap => cb(snap.docs.map(d => d.data())), e => onErr && onErr(e));
  },
  async getAllTxns() {
    const snap = await getDocs(collection(db, 'transactions'));
    return snap.docs.map(d => d.data());
  },
  saveTxn(txn) {
    const t = clean(txn); t.month = monthOfIso(t.date);
    return setDoc(doc(db, 'transactions', t.id), t);
  },
  deleteTxn(id) { return deleteDoc(doc(db, 'transactions', id)); },

  // ---- 撿貨單（pickslips）＋ 簡化詞庫（pickrules/main）----
  listenPickslips(cb, onErr) {
    return onSnapshot(collection(db, 'pickslips'), snap => cb(snap.docs.map(d => ({ ...d.data(), id: d.id }))), e => onErr && onErr(e));
  },
  savePickslip(s) {
    const { id, ...rest } = s;
    return setDoc(doc(db, 'pickslips', id), clean(rest));
  },
  deletePickslip(id) { return deleteDoc(doc(db, 'pickslips', id)); },
  listenPickRules(cb, onErr) {
    return onSnapshot(doc(db, 'pickrules', 'main'), d => cb(d.exists() ? d.data() : { words: [] }), e => onErr && onErr(e));
  },
  savePickRules(r) { return setDoc(doc(db, 'pickrules', 'main'), clean(r)); },

  // ---- 暫存訂單（heldOrders）：所有電腦共用 ----
  listenHeld(cb, onErr) {
    return onSnapshot(collection(db, 'heldOrders'), snap => cb(snap.docs.map(d => ({ ...d.data(), id: d.id }))), e => onErr && onErr(e));
  },
  saveHeld(h) {
    const { id, ...rest } = h;
    return setDoc(doc(db, 'heldOrders', id), clean(rest));
  },
  deleteHeld(id) { return deleteDoc(doc(db, 'heldOrders', id)); },

  // ---- 還原備份：只補回雲端沒有的（保留原本的 id），雲端已有的不動 ----
  async restoreMissing(customersList, txnList, onProgress) {
    const ops = [];
    customersList.forEach(c => { if (c && c.id) { const { id, ...rest } = c; ops.push(['customers', id, clean(rest)]); } });
    txnList.forEach(t => { if (t && t.id) { const x = clean(t); if (!x.month && x.date) x.month = monthOfIso(x.date); ops.push(['transactions', x.id, x]); } });
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach(([col, id, data]) => batch.set(doc(db, col, id), data));
      await batch.commit();
      if (onProgress) onProgress(Math.min(ops.length, i + 400), ops.length);
    }
    return ops.length;
  },

  // ---- 一次性：把舊的 customers.json / transactions/*.json 匯入 ----
  async importLegacy(customers, txns, onProgress) {
    const ops = [];
    customers.forEach((c, i) => ops.push(['customers', 'c' + String(i + 1).padStart(4, '0'), clean(c)]));
    txns.forEach(t => { const x = clean(t); x.month = monthOfIso(x.date); ops.push(['transactions', x.id, x]); });
    let done = 0;
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach(([col, id, data]) => batch.set(doc(db, col, id), data));
      await batch.commit();
      done = Math.min(ops.length, i + 400);
      if (onProgress) onProgress(done, ops.length);
    }
    return ops.length;
  }
};

window.FB = FB;
window.__fbResolve && window.__fbResolve(FB);
