/**
 * Nâng 1 tài khoản có sẵn thành ADMIN (idempotent).
 * Dùng: npx ts-node prisma/make-admin.ts <email>
 * Sau khi chạy: đăng xuất & đăng nhập lại để JWT có activeRole=ADMIN.
 *   - Nếu tài khoản chỉ là BUYER → login vào thẳng workspace ADMIN.
 *   - Nếu tài khoản vừa BUYER vừa SELLER → màn chọn vai trò sẽ có thêm ADMIN.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('❌ Thiếu email. Dùng: npx ts-node prisma/make-admin.ts <email>');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`❌ Không tìm thấy tài khoản: ${email}`);
    process.exit(1);
  }
  await prisma.user.update({
    where: { email },
    data: { is_admin: true, verified_email: true },
  });
  console.log(`✅ ${email} đã là ADMIN (is_admin=true, verified_email=true).`);
  console.log('   → Đăng xuất & đăng nhập lại để token có activeRole=ADMIN, rồi vào /admin/dashboard.');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
