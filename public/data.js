// Shared by index.html, admin.html and profile.html.
// Data lives in Firestore. The pages call the same functions as before.
//
// Firestore layout (PACKED: many books per document, to save reads/writes):
//   meta/school            { name }                    public read, admin write
//   books/chunk_0001       { data: "<JSON string>" }   public read, admin write
//        JSON = { "<bookId>": { name, copies, barcodes: [...], details: { "<barcode>": {reg,author,publisher,year,category} } }, ... }
//   books/chunk_0002 ...   next document, used when chunk_0001 is full
//   borrowers/chunk_0001   { data: "<JSON string>" }   admin only (student names stay private)
//        JSON = { "<bookId>": [ {name,class,barcode,borrowed,due}, ... ], ... }
//        A book's borrowers always sit in the borrowers document with the SAME chunk id as the book.
//
// Rules for placing books:
//   * A new book goes into the first chunk (lowest number) that still has room; a new chunk is created
//     only when none has room.
//   * When an existing book grows (new copy/borrower) and its chunk is full, the WHOLE book moves to the
//     first chunk that has room (or a new one).
//   * Chunks are stored as one JSON string, so Firestore does not create thousands of index entries
//     (the limit is 40,000 per document), and the size is exactly measurable.
//   * Old data (one document per book, ids not starting with "chunk_") is migrated automatically the
//     first time the librarian opens the admin page.
//
// The Firebase config comes from Firebase Hosting itself (/__/firebase/init.js),
// so this file works unchanged for any school's project once it is deployed.

const DEFAULT_SCHOOL_NAME = "Thư viện trường";
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1/";

// Firestore allows 1 MiB per document. New books are placed only while a chunk stays under CHUNK_LIMIT;
// HARD_LIMIT is the last safety check inside the write transaction.
const CHUNK_LIMIT = 900000;
const HARD_LIMIT = 1000000;
const CHUNK_PREFIX = "chunk_";
const TX_CHUNKS = 6; // chunks per transaction (keeps each request well under Firestore's 10 MiB cap)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

// Loads the Firebase SDK, then the project's config from Hosting. Resolves to { db, auth }.
const firebaseReady = (async () => {
  await loadScript(FIREBASE_SDK + "firebase-app-compat.js");
  await Promise.all([
    loadScript(FIREBASE_SDK + "firebase-firestore-compat.js"),
    loadScript(FIREBASE_SDK + "firebase-auth-compat.js")
  ]);
  await loadScript("/__/firebase/init.js");
  return { db: firebase.firestore(), auth: firebase.auth() };
})();

// Resolves to the signed-in user (the librarian) or null. Waits for the saved session to be restored.
async function getCurrentUser() {
  const { auth } = await firebaseReady;
  return new Promise(resolve => {
    const off = auth.onAuthStateChanged(user => { off(); resolve(user); });
  });
}

// ---------- Chunk helpers ----------
const isChunkId = id => id.startsWith(CHUNK_PREFIX);
const chunkNum = id => parseInt(id.slice(CHUNK_PREFIX.length), 10) || 0;
const makeChunkId = n => CHUNK_PREFIX + String(n).padStart(4, "0");
const _enc = new TextEncoder();
const byteLen = s => _enc.encode(s).length;
// Bytes one entry takes inside the chunk JSON:  "id":<value>,
const entryBytes = (id, v) => byteLen(JSON.stringify(v)) + id.length + 4;

// In-memory picture of the library, rebuilt by every loadBooks():
//   { chunks: Map<chunkId, { id, books:{id:doc}, lists:{id:[borrowers]}, b, r }>,
//     where: Map<bookId, chunkId>, hasBorrowers: bool }
// b / r = bytes used in the books / borrowers document of that chunk.
let store = null;

function newChunk(id) { return { id, books: {}, lists: {}, b: 0, r: 0 }; }

function dropEntry(c, id) {
  if (id in c.books) { c.b -= entryBytes(id, c.books[id]); delete c.books[id]; }
  if (id in c.lists) { c.r -= entryBytes(id, c.lists[id]); delete c.lists[id]; }
}

function setEntry(c, id, doc, list) {
  dropEntry(c, id);
  c.books[id] = doc;
  c.lists[id] = list;
  c.b += entryBytes(id, doc);
  c.r += entryBytes(id, list);
}

// Would this book (bB bytes of book data, rB bytes of borrowers) fit in chunk c?
function fits(c, id, bB, rB) {
  const oldB = id in c.books ? entryBytes(id, c.books[id]) : 0;
  const oldR = id in c.lists ? entryBytes(id, c.lists[id]) : 0;
  return c.b - oldB + bB <= CHUNK_LIMIT && c.r - oldR + rB <= CHUNK_LIMIT;
}

// Chooses the chunk for a book: its current chunk if it still fits, otherwise the first chunk (lowest
// number) with room, otherwise a brand-new chunk.
function pickChunk(st, id, bB, rB) {
  const cur = st.where.get(id);
  if (cur) {
    const c = st.chunks.get(cur);
    if (c && fits(c, id, bB, rB)) return c;
  }
  const ordered = [...st.chunks.values()].sort((a, b) => chunkNum(a.id) - chunkNum(b.id));
  for (const c of ordered) {
    if (c.id !== cur && fits(c, id, bB, rB)) return c;
  }
  const next = ordered.length ? chunkNum(ordered[ordered.length - 1].id) + 1 : 1;
  const c = newChunk(makeChunkId(next));
  if (!fits(c, id, bB, rB)) throw new Error("Dữ liệu của sách này quá lớn để lưu vào một tài liệu.");
  st.chunks.set(c.id, c);
  return c;
}

// Puts a book into the in-memory store (choosing its chunk) and reports what moved where.
function placeBook(st, book) {
  const id = book.id;
  const doc = bookDoc(book);
  const list = book.borrowers || [];
  const target = pickChunk(st, id, entryBytes(id, doc), entryBytes(id, list));
  const oldId = st.where.get(id);
  let from = null;
  if (oldId && oldId !== target.id) {
    from = st.chunks.get(oldId) || null;
    if (from) dropEntry(from, id);
  }
  setEntry(target, id, doc, list);
  st.where.set(id, target.id);
  return { id, doc, list, target, from };
}

async function commitOps(db, ops) {
  for (let i = 0; i < ops.length; i += 400) { // a batch holds at most 500 writes
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
}

// Applies { id -> value | undefined(=delete) } to the JSON text of a chunk document.
function applyChanges(raw, changes) {
  const obj = raw ? JSON.parse(raw) : {};
  for (const [id, v] of changes) {
    if (v === undefined) delete obj[id]; else obj[id] = v;
  }
  return JSON.stringify(obj);
}

// Writes the touched chunks. Each chunk is re-read inside a transaction and only the changed books are
// applied to it, so a second librarian's edits to other books in the same chunk are never overwritten.
// touched: Map<chunkId, { c, b: Map<bookId, doc|undefined>, r: Map<bookId, list|undefined> }>
async function commitTouched(db, touched) {
  const all = [...touched.values()];
  for (let i = 0; i < all.length; i += TX_CHUNKS) {
    const group = all.slice(i, i + TX_CHUNKS);
    await db.runTransaction(async tx => {
      const items = group.map(t => ({
        t,
        bRef: db.collection("books").doc(t.c.id),
        rRef: db.collection("borrowers").doc(t.c.id)
      }));
      const snaps = await Promise.all(items.map(x => Promise.all([tx.get(x.bRef), tx.get(x.rRef)])));
      items.forEach((x, k) => {
        const [bs, rs] = snaps[k];
        const bTxt = applyChanges(bs.exists ? bs.data().data : "", x.t.b);
        const rTxt = applyChanges(rs.exists ? rs.data().data : "", x.t.r);
        if (byteLen(bTxt) > HARD_LIMIT || byteLen(rTxt) > HARD_LIMIT) {
          throw new Error("Tài liệu dữ liệu đã đầy (có thể do người khác vừa thêm sách). Hãy tải lại trang và thử lại.");
        }
        tx.set(x.bRef, { data: bTxt });
        tx.set(x.rRef, { data: rTxt });
      });
    });
  }
}

function touchSlot(touched, c) {
  if (!touched.has(c.id)) touched.set(c.id, { c, b: new Map(), r: new Map() });
  return touched.get(c.id);
}

// The in-memory store for writing. Loads it if needed. Only the signed-in librarian can write.
async function getStore() {
  if (!store || !store.hasBorrowers) await loadBooks();
  if (!store || !store.hasBorrowers) throw new Error("Chỉ thủ thư đã đăng nhập mới lưu được.");
  return store;
}

// Rebuilds ALL chunks from scratch (first-fit) and removes every other document.
// Used by the one-time migration and by saveBooks().
async function rewriteAll(books, oldBookDocIds, oldBorrowerDocIds) {
  const { db } = await firebaseReady;
  const st = { chunks: new Map(), where: new Map(), hasBorrowers: true };
  books.forEach(b => placeBook(st, b));

  const ops = [];
  for (const c of st.chunks.values()) {
    ops.push(w => w.set(db.collection("books").doc(c.id), { data: JSON.stringify(c.books) }));
    ops.push(w => w.set(db.collection("borrowers").doc(c.id), { data: JSON.stringify(c.lists) }));
  }
  // Deletes come after the writes, so nothing is lost if the process stops half-way.
  oldBookDocIds.filter(id => !st.chunks.has(id)).forEach(id => ops.push(w => w.delete(db.collection("books").doc(id))));
  oldBorrowerDocIds.filter(id => !st.chunks.has(id)).forEach(id => ops.push(w => w.delete(db.collection("borrowers").doc(id))));
  await commitOps(db, ops);
  store = st;
}

// ---------- Books ----------
// Book shape: { id, name, copies, barcodes: [string], details: {...}, borrowers: [{ name, class, barcode, borrowed, due }] }
// Visitors get books without borrowers; the signed-in librarian gets the borrowers too.
const toBook = (id, d, borrowers) => ({
  details: {},
  ...d,
  id,
  name: d.name || "",
  copies: Number(d.copies) || 0,
  barcodes: Array.isArray(d.barcodes) ? d.barcodes : [],
  borrowers: borrowers || []
});

async function loadBooks() {
  try {
    const { db } = await firebaseReady;
    const user = await getCurrentUser();

    const snap = await db.collection("books").get(); // 1 read per chunk
    const borrowerData = new Map();
    let hasBorrowers = false;
    if (user) {
      try {
        const bsnap = await db.collection("borrowers").get();
        bsnap.forEach(d => borrowerData.set(d.id, d.data()));
        hasBorrowers = true;
      } catch (e) {
        console.warn("Could not read borrowers (not the librarian account?)", e);
      }
    }

    const st = { chunks: new Map(), where: new Map(), hasBorrowers };
    const books = [];
    const legacyIds = [];

    snap.forEach(d => {
      const data = d.data();
      if (isChunkId(d.id)) {
        const c = newChunk(d.id);
        let items = {}, lists = {};
        try { items = JSON.parse(data.data || "{}"); } catch (e) { console.error("Bad chunk " + d.id, e); }
        try { lists = JSON.parse((borrowerData.get(d.id) || {}).data || "{}"); } catch (e) { console.error("Bad borrowers chunk " + d.id, e); }
        for (const [bid, doc] of Object.entries(items)) {
          const list = Array.isArray(lists[bid]) ? lists[bid] : [];
          setEntry(c, bid, doc, list);
          st.where.set(bid, c.id);
          books.push(toBook(bid, doc, list));
        }
        st.chunks.set(c.id, c);
      } else {
        // Old format: one document per book. Still shown, and migrated below for the librarian.
        legacyIds.push(d.id);
        books.push(toBook(d.id, data, (borrowerData.get(d.id) || {}).list || []));
      }
    });
    books.sort((a, b) => a.name.localeCompare(b.name, "vi"));

    if (legacyIds.length && hasBorrowers) {
      try {
        await rewriteAll(books, snap.docs.map(d => d.id), [...borrowerData.keys()]);
        return books;
      } catch (e) {
        console.warn("Migration to packed documents failed (will retry next time)", e);
      }
    }
    store = st;
    return books;
  } catch (e) {
    console.error("loadBooks failed", e);
    return [];
  }
}

// Save several books (create or update) in one go. Librarian only.
// Each book stays in its chunk if it still fits; otherwise the whole book moves to the first chunk with room.
async function saveBookList(list) {
  if (!list.length) return;
  const { db } = await firebaseReady;
  const st = await getStore();
  const touched = new Map();
  try {
    for (const book of list) {
      const p = placeBook(st, book);
      if (p.from) {
        const t = touchSlot(touched, p.from);
        t.b.set(p.id, undefined);
        t.r.set(p.id, undefined);
      }
      const t = touchSlot(touched, p.target);
      t.b.set(p.id, p.doc);
      t.r.set(p.id, p.list);
    }
    await commitTouched(db, touched);
  } catch (e) {
    store = null; // the cache may be out of date: reload on next use
    throw e;
  }
}

// Save one book (create or update). Librarian only.
async function saveBook(book) {
  await saveBookList([book]);
}

// Copies left = barcodes minus current borrowers. Books with no barcodes keep the typed-in number.
function copiesLeft(b) {
  const n = (b.barcodes || []).length;
  return n ? Math.max(0, n - (b.borrowers || []).length) : b.copies;
}

// The public part of a book, as stored in the "books" collection.
function bookDoc(b) {
  return { name: b.name, copies: copiesLeft(b), barcodes: b.barcodes || [], details: b.details || {} };
}

// Delete one book and its borrowers. Librarian only. (Its chunk keeps the free space for the next book.)
async function deleteBook(id) {
  const { db } = await firebaseReady;
  const st = await getStore();
  const cid = st.where.get(id);
  try {
    if (!cid) {
      // Not in any chunk: remove an old-format document if one is still around.
      const batch = db.batch();
      batch.delete(db.collection("books").doc(id));
      batch.delete(db.collection("borrowers").doc(id));
      await batch.commit();
      return;
    }
    const touched = new Map();
    const c = st.chunks.get(cid);
    const t = touchSlot(touched, c);
    t.b.set(id, undefined);
    t.r.set(id, undefined);
    await commitTouched(db, touched);
    dropEntry(c, id);
    st.where.delete(id);
  } catch (e) {
    store = null;
    throw e;
  }
}

// Kept for compatibility: saves a whole list (books removed from the list are deleted).
// This repacks everything from scratch.
async function saveBooks(books) {
  const { db } = await firebaseReady;
  const [bs, rs] = await Promise.all([db.collection("books").get(), db.collection("borrowers").get()]);
  await rewriteAll(books, bs.docs.map(d => d.id), rs.docs.map(d => d.id));
}

// ---------- Librarian accounts ----------
// admins/{uid} = { email }. Anyone listed here (or the owner UID in firestore.rules) may edit.

// Makes sure the signed-in librarian appears in the list.
async function registerSelfAsAdmin() {
  const user = await getCurrentUser();
  if (!user) return;
  const { db } = await firebaseReady;
  await db.collection("admins").doc(user.uid).set({ email: user.email }, { merge: true });
}

async function listLibrarians() {
  const { db } = await firebaseReady;
  const snap = await db.collection("admins").get();
  return snap.docs
    .map(d => ({ uid: d.id, email: d.data().email || "" }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

// Creates the login account for a new librarian and gives it edit rights.
// Uses a temporary second Firebase app so the current librarian stays signed in.
async function addLibrarian(email, password) {
  await firebaseReady;
  const temp = firebase.initializeApp(firebase.app().options, "temp-" + Date.now());
  try {
    const tempAuth = temp.auth();
    let cred;
    try {
      cred = await tempAuth.createUserWithEmailAndPassword(email, password);
    } catch (e) {
      if (e.code === "auth/email-already-in-use") {
        // The account exists already: it must be unlocked with its own password.
        cred = await tempAuth.signInWithEmailAndPassword(email, password);
      } else {
        throw e;
      }
    }
    const uid = cred.user.uid;
    await tempAuth.signOut();
    const { db } = await firebaseReady;
    await db.collection("admins").doc(uid).set({ email: email.toLowerCase() });
    return { uid, email };
  } finally {
    await temp.delete();
  }
}

// Changes the password of the signed-in account only. The old password must be correct.
async function changeMyPassword(oldPassword, newPassword) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in");
  const credential = firebase.auth.EmailAuthProvider.credential(user.email, oldPassword);
  await user.reauthenticateWithCredential(credential); // fails if the old password is wrong
  await user.updatePassword(newPassword);
}

// Removes edit rights (the login account itself stays but can no longer change anything).
async function removeLibrarian(uid) {
  const { db } = await firebaseReady;
  await db.collection("admins").doc(uid).delete();
}

// ---------- School name ----------
async function loadSchoolName() {
  try {
    const { db } = await firebaseReady;
    const doc = await db.collection("meta").doc("school").get();
    if (doc.exists && doc.data().name) return doc.data().name;
  } catch (e) { console.error("loadSchoolName failed", e); }
  return DEFAULT_SCHOOL_NAME;
}

async function saveSchoolName(name) {
  const { db } = await firebaseReady;
  await db.collection("meta").doc("school").set({ name });
}

// Imports an Excel file (.xlsx/.xls). "Mã vạch" and "Tựa đề" are required; "Kí hiệu xếp giá", "Tác giả",
// "Nhà XB", "Năm XB" and "Phân loại" are read too when present and saved on each copy.
// The table can start anywhere: the header row is found by searching for those two names.
// Rows with the same title become one book with several barcodes. Titles that already exist get the
// new barcodes added; barcodes already in the library are skipped. Returns { added, updated, skipped }.
// All changed books are written together: only the affected chunk documents are written (2 writes per chunk).
async function importBooksFromExcel(file) {
  if (!window.XLSX) await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
  const sheet = XLSX.read(await file.arrayBuffer()).Sheets;
  const rows = XLSX.utils.sheet_to_json(sheet[Object.keys(sheet)[0]], { header: 1, defval: "" });

  const norm = s => String(s).trim().toLowerCase().normalize("NFC");
  const h = rows.findIndex(r => r.some(c => norm(c) === "mã vạch") && r.some(c => norm(c) === "tựa đề"));
  if (h < 0) throw new Error('Không tìm thấy hàng tiêu đề có "Mã vạch" và "Tựa đề".');
  const col = name => rows[h].findIndex(c => norm(c) === name);
  const cCode = col("mã vạch"), cTitle = col("tựa đề");
  // Optional columns: -1 if the file doesn't have them.
  const cReg = col("kí hiệu xếp giá"), cAuthor = col("tác giả"), cPub = col("nhà xb"), cYear = col("năm xb"), cCat = col("phân loại");
  const cell = (r, i) => i < 0 ? "" : String(r[i]).replace(/\s+/g, " ").trim().normalize("NFC");

  const books = await loadBooks();
  const byTitle = new Map(books.map(b => [norm(b.name), b]));
  const known = new Set(books.flatMap(b => b.barcodes));
  const changed = new Set();
  let added = 0, updated = 0, skipped = 0;

  for (const r of rows.slice(h + 1)) {
    const code = String(r[cCode]).trim();
    const title = String(r[cTitle]).replace(/\s+/g, " ").trim().normalize("NFC");
    if (!code || !title) continue;
    if (known.has(code)) { skipped++; continue; }
    known.add(code);

    let book = byTitle.get(norm(title));
    if (!book) {
      book = { id: newBookId(), name: title, copies: 0, barcodes: [], borrowers: [], details: {} };
      byTitle.set(norm(title), book);
      books.push(book);
      added++;
    } else if (!changed.has(book)) updated++;

    // Everything except the title is stored on this copy (by barcode); empty cells are left out.
    const info = { reg: cell(r, cReg), author: cell(r, cAuthor), publisher: cell(r, cPub), year: cell(r, cYear), category: cell(r, cCat) };
    if (/^\d{1,2}$/.test(info.category)) info.category = info.category.padStart(3, "0"); // Excel drops leading zeros
    book.details[code] = Object.fromEntries(Object.entries(info).filter(([, v]) => v));

    book.barcodes.push(code); // "copies" is recalculated when saving (copiesLeft)
    changed.add(book);
  }

  // Changed books are placed first-fit into the chunks and written once per chunk.
  await saveBookList([...changed]);
  return { added, updated: updated, skipped };
}

// Today's date as YYYY-MM-DD in the local time zone (toISOString would use UTC and can be off by a day).
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Turns pasted text (one barcode per line, or separated by commas/spaces) into a unique list.
function parseBarcodes(text) {
  return [...new Set(String(text || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
}

function newBookId() {
  return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}