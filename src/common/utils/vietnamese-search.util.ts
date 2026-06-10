import type { Prisma } from '@prisma/client';

/**
 * Bỏ dấu tiếng Việt + lowercase để search không phụ thuộc dấu.
 * "Cà chua bi Đà Lạt" → "ca chua bi da lat", "Bơ sáp 034" → "bo sap 034".
 *
 * Dùng Unicode NFD (tách ký tự gốc khỏi dấu thanh) thay vì extension Postgres
 * `unaccent`, nên không cần cài thêm gì ở DB. `đ/Đ` không được NFD tách nên xử tay.
 */
export function removeVietnameseTones(input?: string | null): string {
  if (!input) return '';
  return input
    .normalize('NFD') // tách: à → a + ◌̀
    .replace(/[̀-ͯ]/g, '') // bỏ toàn bộ dấu thanh/dấu mũ
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ') // gộp khoảng trắng thừa
    .trim();
}

/**
 * Query builder DÙNG CHUNG cho autocomplete (GET /search) và trang kết quả
 * (GET /products/search) → hai endpoint luôn trả cùng tập sản phẩm lõi.
 *
 * Ưu tiên khớp TÊN sản phẩm:
 *   - `search_name`: chuỗi tên đã bỏ dấu (lowercase) → khớp "ca chua" với "Cà chua".
 *   - `name`:        fallback insensitive cho sản phẩm chưa backfill search_name.
 * KHÔNG còn match `description` để người tìm "cà chua" không ra phân NPK/khay ươm.
 *
 * Trả về phần điều kiện để spread vào where (caller tự thêm is_active...).
 * Keyword rỗng → trả {} (không lọc).
 */
export function buildProductSearchWhere(keyword?: string | null): Prisma.ProductWhereInput {
  const kw = (keyword ?? '').trim();
  if (!kw) return {};

  const normalized = removeVietnameseTones(kw); // đã lowercase + bỏ dấu

  return {
    OR: [
      // search_name đã lowercase nên contains thường là đủ (không cần insensitive).
      { search_name: { contains: normalized } },
      // Fallback: vẫn khớp tên gốc nếu search_name null (data cũ chưa backfill).
      { name: { contains: kw, mode: 'insensitive' } },
    ],
  };
}
