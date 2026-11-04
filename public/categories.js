// Danh sách thể loại và hàm lọc sách. Dùng chung cho index.html và admin.html.
// Các mã đánh dấu "THÊM" được thêm theo dữ liệu thực tế trong Sổ đăng ký cá biệt;
// tên là suy ra từ bảng phân loại Dewey, cần thủ thư xác nhận lại.

const CATEGORIES = [
  { code: "000", name: "TỔNG LOẠI" },
  { code: "004", name: "TIN HỌC" },
  { code: "100", name: "TRIẾT HỌC" },
  { code: "150", name: "TÂM LÝ HỌC" },             // THÊM
  { code: "200", name: "TÔN GIÁO" },
  { code: "300", name: "XÃ HỘI" },
  { code: "322", name: "CHÍNH TRỊ (322)" },        // THÊM
  { code: "324", name: "CHÍNH TRỊ (324)" },        // THÊM
  { code: "335", name: "CHÍNH TRỊ (335)" },        // THÊM
  { code: "340", name: "PHÁP LUẬT" },              // THÊM
  { code: "370", name: "GIÁO DỤC (CHUNG)" },       // THÊM
  { code: "371", name: "GIÁO DỤC" },
  { code: "390", name: "VĂN HÓA" },
  { code: "400", name: "NGÔN NGỮ" },
  { code: "420", name: "TIẾNG ANH" },
  { code: "430", name: "NGOẠI NGỮ KHÁC" },         // THÊM
  { code: "500", name: "KHOA HỌC TỰ NHIÊN" },      // THÊM
  { code: "510", name: "TOÁN HỌC" },
  { code: "530", name: "VẬT LÝ" },
  { code: "540", name: "HÓA HỌC" },
  { code: "570", name: "SINH HỌC" },
  { code: "600", name: "CÔNG NGHỆ" },              // THÊM
  { code: "610", name: "Y HỌC" },                  // THÊM
  { code: "630", name: "NÔNG NGHIỆP" },            // THÊM
  { code: "640", name: "GIA CHÁNH" },              // THÊM
  { code: "700", name: "NGHỆ THUẬT" },             // THÊM
  { code: "780", name: "ÂM NHẠC" },                // THÊM
  { code: "790", name: "GIẢI TRÍ - THỂ THAO" },    // THÊM
  { code: "800", name: "VĂN HỌC" },
  { code: "895", name: "TRUYỆN" },
  { code: "900", name: "LỊCH SỬ - ĐỊA LÝ CHUNG" }, // THÊM
  { code: "910", name: "ĐỊA LÝ" },
  { code: "920", name: "TIỂU SỬ" },                // THÊM
  { code: "950", name: "LỊCH SỬ" }
];

// Đổ danh sách thể loại vào một thẻ <select>.
function fillCategoryOptions(selectEl) {
  CATEGORIES.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.textContent = c.code + " - " + c.name;
    selectEl.appendChild(opt);
  });
}

// Tên thể loại của một mã 3 số, ví dụ "895" -> "TRUYỆN". Mã không có trong danh sách thì trả về chính mã đó.
function categoryName(code) {
  const c = CATEGORIES.find(c => c.code === code);
  return c ? c.name : code;
}

// Các mã thể loại của một sách (mỗi loại bản sách một mã), ví dụ ["895", "800"].
// Sách đã có sẵn b.cats (từ bộ nhớ đệm của trang công khai) thì dùng luôn.
function bookCats(b) {
  if (b.cats) return b.cats;
  const codes = (b.barcodes || []).map(bc => categoryKey(((b.details || {})[bc] || {}).category));
  return [...new Set(codes.filter(Boolean))];
}

// Các nhãn thể loại hiện dưới tên sách (tối đa 3, còn lại gộp thành "+n"). Mã không có trong danh sách hiện đúng mã đó.
function categoryBadges(cats) {
  if (!cats || !cats.length) return "";
  const full = c => c + " - " + categoryName(c);
  const chip = (text, title) =>
    `<span class="badge text-bg-light border fw-normal" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
  const shown = cats.slice(0, 3).map(c => chip(categoryName(c), full(c)));
  if (cats.length > 3) shown.push(chip("+" + (cats.length - 3), cats.slice(3).map(full).join(", ")));
  return `<div class="d-flex flex-wrap gap-1">${shown.join("")}</div>`;
}

// Bỏ dấu tiếng Việt để "de men" tìm được "Dế Mèn".
function normalizeText(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

// Đưa mã phân loại thật về mã 3 số:
//   "895.07" -> "895", "371.011(07)" -> "371", "51(07)" -> "510", "8(075)" -> "800".
// Mã không bắt đầu bằng số ("VN", "KĐ403", "Trẻ") trả về "" (không thuộc thể loại nào).
function categoryKey(raw) {
  const m = String(raw || "").trim().match(/^\d+/);
  if (!m) return "";
  const d = m[0];
  return d.length >= 3 ? d.slice(0, 3) : d.padEnd(3, "0");
}

// Sách có ít nhất một bản thuộc thể loại này không?
function hasCategory(book, code) {
  return (book.barcodes || []).some(bc =>
    categoryKey(((book.details || {})[bc] || {}).category) === code);
}

// ---------- Phân trang (dùng chung cho index.html và admin.html) ----------
const PAGE_SIZE = 12;

// Cắt danh sách thành từng trang. Trang quá lớn (ví dụ vừa xóa sách) sẽ tự lùi về trang cuối.
// Trả về { items, page, totalPages }.
function paginate(list, page, size = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(Math.max(1, page | 0), totalPages);
  return { items: list.slice((p - 1) * size, p * size), page: p, totalPages };
}

// Vẽ nút chuyển trang vào thẻ navEl: « Trước, 1 … 4 5 6 … 20, Sau ».
// Hiện tối đa 5 số: trang đầu, trang cuối và trang hiện tại cùng 2 trang kề bên, để vừa màn hình điện thoại. Chỉ có 1 trang thì ẩn nút.
// Bấm vào dấu … để gõ số trang rồi nhấn Enter (Esc hoặc bấm ra ngoài để hủy).
// onChange(số trang mới) được gọi khi bấm.
function renderPager(navEl, page, totalPages, onChange) {
  if (totalPages <= 1) { navEl.innerHTML = ""; return; }

  const nums = new Set([1, totalPages]);
  for (let i = page - 1; i <= page + 1; i++) if (i >= 1 && i <= totalPages) nums.add(i);
  const sorted = [...nums].sort((a, b) => a - b);

  const item = (label, target, cls = "") =>
    `<li class="page-item ${cls}"><button type="button" class="page-link" data-page="${target}">${label}</button></li>`;

  let html = item("&laquo; Trước", page - 1, page === 1 ? "disabled" : "");
  let last = 0;
  for (const n of sorted) {
    if (n - last > 1) html += '<li class="page-item"><button type="button" class="page-link" data-jump title="Nhập số trang">…</button></li>';
    html += item(n, n, n === page ? "active" : "");
    last = n;
  }
  html += item("Sau &raquo;", page + 1, page === totalPages ? "disabled" : "");

  navEl.innerHTML = `<ul class="pagination pagination-sm justify-content-center flex-wrap mb-0">${html}</ul>`;
  navEl.onclick = e => {
    const jump = e.target.closest("button[data-jump]");
    if (jump) {
      showJumpInput(jump.closest("li"), totalPages, onChange, () => renderPager(navEl, page, totalPages, onChange));
      return;
    }
    const btn = e.target.closest("button[data-page]");
    if (!btn || btn.closest(".disabled")) return;
    onChange(Number(btn.dataset.page));
  };
}

// Biến dấu … thành ô nhập số trang. Enter = đi tới trang đó (số quá lớn thì lấy trang cuối);
// Esc, bỏ trống hoặc bấm ra ngoài = hủy và vẽ lại các nút như cũ.
function showJumpInput(li, totalPages, onChange, restore) {
  li.innerHTML = `<input type="number" class="form-control form-control-sm" min="1" max="${totalPages}" ` +
    `placeholder="1-${totalPages}" aria-label="Nhập số trang" style="width:5.5rem">`;
  const input = li.firstChild;
  input.focus();
  let done = false;
  const finish = go => {
    if (done) return; // tránh chạy hai lần (Enter rồi blur)
    done = true;
    const n = parseInt(input.value, 10);
    if (go && n >= 1) onChange(Math.min(n, totalPages)); else restore();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(false));
}

// Lọc theo tên (query) và thể loại (cat). cat rỗng = tất cả.
function filterBooks(books, query, cat) {
  const q = normalizeText(String(query).trim());
  return books.filter(b =>
    normalizeText(b.name).includes(q) && (!cat || hasCategory(b, cat)));
}