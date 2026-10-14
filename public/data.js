// Shared by index.html, admin.html and profile.html.
// Data lives in Firestore. The pages call the same functions as before.
//
// Firestore layout:
//   meta/school        { name }                 public read, admin write
//   books/{id}         { name, copies, barcodes: ["STK-14989", ...],    public read, admin write
//                        details: { "STK-11273": { reg, author, publisher, year, category } } }
//                        details = per-copy info by barcode: Số ĐKCB, Tác giả, Nhà XB, Năm XB, Phân loại,
//                        so copies of the same title can differ (e.g. two editions).
//   borrowers/{id}     { list: [{name,class,barcode,borrowed,due}] }    admin only (student names stay private)
//   (barcode = "Mã vạch", optional; borrowed/due are "YYYY-MM-DD")
//
// The Firebase config comes from Firebase Hosting itself (/__/firebase/init.js),
// so this file works unchanged for any school's project once it is deployed.

const DEFAULT_SCHOOL_NAME = "Thư viện trường";
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1/";

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

// ---------- Books ----------
// Book shape: { id, name, copies, barcodes: [string], borrowers: [{ name, class, barcode, borrowed, due }] }
// Visitors get books without borrowers; the signed-in librarian gets the borrowers too.
async function loadBooks() {
  try {
    const { db } = await firebaseReady;
    const snap = await db.collection("books").get();
    const books = snap.docs.map(d => ({
      details: {},
      ...d.data(),
      id: d.id,
      name: d.data().name || "",
      copies: Number(d.data().copies) || 0,
      barcodes: Array.isArray(d.data().barcodes) ? d.data().barcodes : [],
      borrowers: []
    }));
    books.sort((a, b) => a.name.localeCompare(b.name, "vi"));

    if (await getCurrentUser()) {
      try {
        const bsnap = await db.collection("borrowers").get();
        const byBook = {};
        bsnap.forEach(d => { byBook[d.id] = d.data().list || []; });
        books.forEach(b => { b.borrowers = byBook[b.id] || []; });
      } catch (e) {
        console.warn("Could not read borrowers (not the librarian account?)", e);
      }
    }
    return books;
  } catch (e) {
    console.error("loadBooks failed", e);
    return [];
  }
}

// Save one book (create or update). Librarian only.
async function saveBook(book) {
  const { db } = await firebaseReady;
  const batch = db.batch();
  batch.set(db.collection("books").doc(book.id), bookDoc(book));
  batch.set(db.collection("borrowers").doc(book.id), { list: book.borrowers || [] });
  await batch.commit();
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

// Delete one book and its borrowers. Librarian only.
async function deleteBook(id) {
  const { db } = await firebaseReady;
  const batch = db.batch();
  batch.delete(db.collection("books").doc(id));
  batch.delete(db.collection("borrowers").doc(id));
  await batch.commit();
}

// Kept for compatibility: saves a whole list (books removed from the list are deleted).
async function saveBooks(books) {
  const { db } = await firebaseReady;
  const existing = await db.collection("books").get();
  const keep = new Set(books.map(b => b.id));
  const ops = [];
  existing.docs.forEach(d => {
    if (!keep.has(d.id)) {
      ops.push(b => b.delete(d.ref));
      ops.push(b => b.delete(db.collection("borrowers").doc(d.id)));
    }
  });
  books.forEach(book => {
    ops.push(b => b.set(db.collection("books").doc(book.id), bookDoc(book)));
    ops.push(b => b.set(db.collection("borrowers").doc(book.id), { list: book.borrowers || [] }));
  });
  for (let i = 0; i < ops.length; i += 400) { // a batch holds at most 500 writes
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
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

  // Write only the changed books (a batch holds at most 500 writes = 2 per book).
  const { db } = await firebaseReady;
  const list = [...changed];
  for (let i = 0; i < list.length; i += 200) {
    const batch = db.batch();
    list.slice(i, i + 200).forEach(b => {
      batch.set(db.collection("books").doc(b.id), bookDoc(b));
      batch.set(db.collection("borrowers").doc(b.id), { list: b.borrowers });
    });
    await batch.commit();
  }
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