/**
 * Backfill Product.search_name cho TOÀN BỘ sản phẩm hiện có.
 * Chạy 1 lần sau khi apply migration add_product_search_name.
 *
 *   pnpm run backfill:search-name
 *
 * - Idempotent: chạy lại nhiều lần ra cùng kết quả (chỉ update khi giá trị đổi).
 * - Không xóa/đụng bất kỳ field nào khác ngoài search_name.
 * - Không để sản phẩm nào còn search_name = null.
 */
import { PrismaClient } from '@prisma/client';
import { removeVietnameseTones } from '../src/common/utils/vietnamese-search.util';

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, name: true, search_name: true },
  });

  console.log(`[backfill] Tìm thấy ${products.length} sản phẩm.`);

  let updated = 0;
  let skipped = 0;

  // Batch nhỏ để không nuốt connection pool trên Railway.
  const BATCH = 50;
  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (p) => {
        const next = removeVietnameseTones(p.name);
        if (p.search_name === next) {
          skipped++;
          return;
        }
        await prisma.product.update({
          where: { id: p.id },
          data: { search_name: next },
        });
        updated++;
      }),
    );
    console.log(`[backfill] Đã xử lý ${Math.min(i + BATCH, products.length)}/${products.length}`);
  }

  console.log(`[backfill] ✅ Hoàn tất — cập nhật ${updated}, bỏ qua (đã đúng) ${skipped}.`);

  const remaining = await prisma.product.count({ where: { search_name: null } });
  console.log(`[backfill] Sản phẩm còn search_name = null: ${remaining} (kỳ vọng 0).`);
}

main()
  .catch((e) => {
    console.error('[backfill] ❌ Lỗi:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
