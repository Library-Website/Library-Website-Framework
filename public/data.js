// Shared by index.html, admin.html and profile.html.
// Data lives in Firestore. The pages call the same functions as before.
//
// Firestore layout:
//   meta/school        { name }                 public read, admin write
//   books/{id}         { name, copies }         public read, admin write
//   borrowers/{id}     { list: [{name,class,due}] }   admin only (student names stay private)
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
// Book shape: { id, name, copies, borrowers: [{ name, class, due }] }
// Visitors get books without borrowers; the signed-in librarian gets the borrowers too.
async function loadBooks() {
  try {
    const { db } = await firebaseReady;
    const snap = await db.collection("books").get();
    const books = snap.docs.map(d => ({
      id: d.id,
      name: d.data().name || "",
      copies: Number(d.data().copies) || 0,
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
  batch.set(db.collection("books").doc(book.id), { name: book.name, copies: book.copies });
  batch.set(db.collection("borrowers").doc(book.id), { list: book.borrowers || [] });
  await batch.commit();
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
    ops.push(b => b.set(db.collection("books").doc(book.id), { name: book.name, copies: book.copies }));
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

function newBookId() {
  return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}