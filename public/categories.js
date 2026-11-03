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

// Lọc theo tên (query) và thể loại (cat). cat rỗng = tất cả.
function filterBooks(books, query, cat) {
  const q = normalizeText(String(query).trim());
  return books.filter(b =>
    normalizeText(b.name).includes(q) && (!cat || hasCategory(b, cat)));
}