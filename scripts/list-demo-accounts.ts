/**
 * ============================================================================
 *  list-demo-accounts.ts — Liệt kê tài khoản DEMO/SEED cho mục đích trình diễn.
 * ============================================================================
 *  CHẠY:  npx ts-node scripts/list-demo-accounts.ts
 *
 *  AN TOÀN TUYỆT ĐỐI:
 *   - KHÔNG bao giờ select / in / log: password_hash, refresh_token_hash,
 *     firebase_uid, OTP, hay bất kỳ token nào.
 *   - Chỉ đọc các field an toàn (id, email, full_name, role flags, trạng thái).
 *   - Cột "Assumed Demo Password" là quy ước SEED đã biết (KHÔNG đọc từ DB) —
 *     chỉ để tiện đăng nhập demo; tài khoản thật luôn là "UNKNOWN (Encrypted)".
 *   - Read-only: script không ghi/sửa/xoá gì.
 * ============================================================================
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Email demo "legacy" (không chứa 'seed'/'demo') — liệt kê tường minh.
const LEGACY_DEMO_EMAILS = [
  'khach@gmail.com',
  'shop1@gmail.com',
  'shop2@gmail.com',
  'shop3@gmail.com',
  'shop4@gmail.com',
  'shop5@gmail.com',
];
// Admin demo do seed-admin.ts khởi tạo.
const SEED_ADMIN_EMAIL = 'admin@agriconnect.test';

// Suy mật khẩu demo theo QUY ƯỚC SEED (không phải dữ liệu DB).
function assumedPassword(email: string): string {
  const e = email.toLowerCase();
  if (e.startsWith('seed.') || e.startsWith('seed2.')) return 'Seed@123456';
  if (e === SEED_ADMIN_EMAIL) return 'Admin@123456'; // seed-admin.ts default
  if (LEGACY_DEMO_EMAILS.includes(e)) return '123456';
  return 'UNKNOWN (Encrypted)';
}

const roleLabel = (u: { is_buyer: boolean; is_seller: boolean; is_admin: boolean }) =>
  [u.is_admin && 'ADMIN', u.is_seller && 'SELLER', u.is_buyer && 'BUYER'].filter(Boolean).join('+') || '—';

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: 'seed', mode: 'insensitive' } },
        { email: { contains: 'demo', mode: 'insensitive' } },
        { email: { in: [...LEGACY_DEMO_EMAILS, SEED_ADMIN_EMAIL] } },
      ],
    },
    // CHỈ field an toàn — TUYỆT ĐỐI không có password_hash / token.
    select: {
      id: true,
      email: true,
      full_name: true,
      is_buyer: true,
      is_seller: true,
      is_admin: true,
      is_active: true,
      verified_email: true,
    },
    orderBy: [{ is_admin: 'desc' }, { email: 'asc' }],
  });

  if (users.length === 0) {
    console.log('Không tìm thấy tài khoản demo/seed nào. Hãy chạy seed trước.');
    await prisma.$disconnect();
    return;
  }

  const rows = users.map((u) => ({
    Email: u.email,
    'Họ tên': u.full_name,
    'Vai trò': roleLabel(u),
    'Active': u.is_active ? '✓' : '✗ (khóa)',
    'Verified': u.verified_email ? '✓' : '✗',
    'Assumed Demo Password': assumedPassword(u.email),
  }));

  console.log(`\n🔐 DANH SÁCH ${users.length} TÀI KHOẢN DEMO/SEED (read-only — không lộ mật khẩu thật)\n`);
  console.table(rows);
  console.log(
    '\n⚠️  "Assumed Demo Password" là quy ước seed (KHÔNG đọc từ DB). ' +
      'Tài khoản thật = "UNKNOWN (Encrypted)". Mật khẩu lưu dạng bcrypt, không thể & không nên truy xuất.\n',
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌ list-demo-accounts thất bại:', e);
  await prisma.$disconnect();
  process.exit(1);
});
