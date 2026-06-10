/**
 * Bootstrap tài khoản ADMIN DUY NHẤT của hệ thống (idempotent).
 *
 *  - Tạo (hoặc đảm bảo) đúng 1 admin cố định.
 *  - THU HỒI quyền admin của mọi tài khoản khác ⇒ chỉ tài khoản này có quyền.
 *  - Admin-only (is_buyer=false, is_seller=false) ⇒ đăng nhập vào thẳng workspace ADMIN.
 *
 *  Email / mật khẩu có thể override qua env ADMIN_EMAIL / ADMIN_PASSWORD.
 *  Mặc định:  admin@agriconnect.test  /  Admin@123456
 *
 *  Chạy:  pnpm run seed:admin     (hoặc npx ts-node prisma/seed-admin.ts)
 *  An toàn chạy lại nhiều lần. Nếu admin đã tồn tại từ trước, KHÔNG đổi mật khẩu cũ.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_ADMIN_SEED !== 'true') {
    // Cho phép trên Railway bằng cách đặt ALLOW_ADMIN_SEED=true, hoặc chạy local.
    console.warn('⚠️  NODE_ENV=production — đặt ALLOW_ADMIN_SEED=true nếu muốn chạy trên prod. Bỏ qua.');
    return;
  }

  const email = (process.env.ADMIN_EMAIL || 'admin@agriconnect.test').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Admin@123456';
  const passwordHash = await bcrypt.hash(password, 10);

  // 1) Thu hồi quyền admin của MỌI tài khoản khác (đảm bảo duy nhất).
  const demoted = await prisma.user.updateMany({
    where: { is_admin: true, email: { not: email } },
    data: { is_admin: false },
  });

  // 2) Upsert admin cố định. Tài khoản mới = admin-only. Nếu đã tồn tại: chỉ
  //    bật is_admin/verified/active, KHÔNG ghi đè mật khẩu hiện có.
  const existing = await prisma.user.findUnique({ where: { email } });
  await prisma.user.upsert({
    where: { email },
    update: { is_admin: true, verified_email: true, is_active: true },
    create: {
      email,
      password_hash: passwordHash,
      full_name: 'Quản trị viên',
      display_name: 'Admin',
      provider: 'password',
      is_admin: true,
      is_buyer: false,
      is_seller: false,
      verified_email: true,
      last_login_at: new Date(),
    },
  });

  console.log('✅ ====== ADMIN DUY NHẤT ======');
  console.log(`   Email   : ${email}`);
  if (existing) {
    console.log('   Mật khẩu: (tài khoản đã tồn tại từ trước — GIỮ NGUYÊN mật khẩu cũ)');
  } else {
    console.log(`   Mật khẩu: ${password}`);
  }
  console.log(`   Đã thu hồi quyền admin của ${demoted.count} tài khoản khác.`);
  console.log('   → Đăng nhập tài khoản này sẽ vào thẳng workspace ADMIN (/admin/dashboard).');
}

main()
  .catch((e) => {
    console.error('❌ seed-admin thất bại:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
