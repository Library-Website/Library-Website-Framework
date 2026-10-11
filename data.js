// Shared by index.html and admin.html.
// Everything is stored in the browser (localStorage) for now.
// Later, replace loadBooks() and saveBooks() with Firestore calls; the pages don't need to change.

const DEFAULT_SCHOOL_NAME = "Thư viện Nguyễn Thượng Hiền";
const STORAGE_KEY = "library_books_v1";
const SCHOOL_KEY = "library_school_name_v1";

// Book shape: { id, name, copies, borrowers: [{ name, class, due }] }
// "Còn sách" (available) simply means copies > 0.
const SAMPLE_BOOKS = [
  { id: "b1", name: "Dế Mèn phiêu lưu ký", copies: 3, borrowers: [
    { name: "Nguyễn Văn An", class: "10A1", due: "2026-10-20" }
  ]},
  { id: "b2", name: "Số đỏ", copies: 0, borrowers: [
    { name: "Trần Thị Bình", class: "11A3", due: "2026-10-15" },
    { name: "Lê Minh Châu", class: "11A2", due: "2026-10-18" }
  ]},
  { id: "b3", name: "Tắt đèn", copies: 2, borrowers: [] },
  { id: "b4", name: "Nhà giả kim", copies: 1, borrowers: [] },
  { id: "b5", name: "Đắc nhân tâm", copies: 0, borrowers: [
    { name: "Phạm Quốc Dũng", class: "12A5", due: "2026-10-25" }
  ]},
  { id: "b6", name: "Giải tích 1", copies: 5, borrowers: [] }
];

async function loadBooks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to sample data */ }
  await saveBooks(SAMPLE_BOOKS);
  return JSON.parse(JSON.stringify(SAMPLE_BOOKS));
}

async function saveBooks(books) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
}

async function loadSchoolName() {
  try {
    const name = localStorage.getItem(SCHOOL_KEY);
    if (name) return name;
  } catch (e) { /* use default */ }
  return DEFAULT_SCHOOL_NAME;
}

async function saveSchoolName(name) {
  localStorage.setItem(SCHOOL_KEY, name);
}

function newBookId() {
  return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}