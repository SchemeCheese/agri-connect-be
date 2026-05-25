// One-off backfill: every user is a buyer (BUYER role is base, SELLER is additive).
// Fixes RolesGuard 403 on /orders/checkout for accounts where is_buyer was false.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const result = await db.user.updateMany({ where: { is_buyer: false }, data: { is_buyer: true } });
console.log(`Updated ${result.count} users to is_buyer=true`);
const seedAccounts = await db.user.findMany({
  where: { email: { in: ['khach@gmail.com', 'shop2@gmail.com'] } },
  select: { email: true, is_buyer: true, is_seller: true, is_admin: true },
});
console.table(seedAccounts);
await db.$disconnect();
