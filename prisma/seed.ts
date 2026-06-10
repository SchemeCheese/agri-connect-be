/**
 * ============================================================================
 *  Agri Connect — SEED DỮ LIỆU DEMO (idempotent, an toàn với dữ liệu thật)
 * ============================================================================
 *
 *  TRIẾT LÝ:
 *   - KHÔNG `prisma migrate reset`, KHÔNG xoá toàn bộ bảng.
 *   - Chỉ tạo/xoá các bản ghi mang dấu hiệu SEED:
 *       • User      : email bắt đầu bằng  "seed."        (SEED_EMAIL_PREFIX)
 *       • Product   : name  bắt đầu bằng  "[SEED] "      (SEED_NAME_PREFIX)
 *   - Mọi entity phụ thuộc (Order, Payment, Review, Voucher, Conversation, ...)
 *     đều thuộc về các seed user nói trên ⇒ dữ liệu thật của bạn KHÔNG bị đụng.
 *   - Chạy lại nhiều lần ⇒ "Cleanup Phase" xoá sạch seed cũ rồi tạo lại ⇒ tổng
 *     số bản ghi cuối cùng luôn GIỐNG NHAU, không bao giờ vướng Unique Constraint.
 *
 *  BỎ QUA OTP: mọi seed user có verified_email = true ⇒ login thẳng, không cần
 *  mã OTP. KHÔNG đụng vào auth.service.ts, KHÔNG tắt OTP toàn cục.
 *
 *  ĐĂNG NHẬP DEMO:  seed.buyer01@agriconnect.test  /  Seed@123456
 * ============================================================================
 */

import {
  PrismaClient,
  OrderStatus,
  PaymentStatus,
  PaymentMethod,
  PaymentType,
  DiscountType,
  MessageType,
  QuoteStatus,
  ProductStatus,
  BehaviorAction,
  TargetType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PERSON_NAMES, SHOP_NAMES, PRODUCT_CATALOG } from './seed-data';
import { removeVietnameseTones } from '../src/common/utils/vietnamese-search.util';

const prisma = new PrismaClient();

// ─── Hằng số nhận diện SEED ──────────────────────────────────────────────────
const SEED_EMAIL_PREFIX = 'seed.';
const SEED_NAME_PREFIX = '[SEED] ';
const EMAIL_DOMAIN = '@agriconnect.test';
const SEED_PASSWORD = 'Seed@123456';

const N_BUYERS = 25;
const N_SELLERS = 15;
const N_HYBRIDS = 5; // vừa BUYER vừa SELLER
const N_ORDERS = 80; // đơn hàng "thường" (chưa tính đơn từ thương lượng)
const N_NEGOTIATIONS = 5;

// ─── Danh mục theo yêu cầu (KHÔNG xoá khi cleanup — có thể dùng chung dữ liệu thật) ─
const CATEGORY_NAMES = [
  'Rau củ',
  'Trái cây',
  'Gạo & ngũ cốc',
  'Thịt/Trứng/Sữa',
  'Vật tư nông nghiệp',
] as const;

// Ảnh placeholder dùng chung (deterministic — cycle theo index)
const IMAGE_POOL = [
  'https://images.unsplash.com/photo-1542838132-92c53300491e?w=600&q=80',
  'https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=600&q=80',
  'https://images.unsplash.com/photo-1518843875459-f738682238a6?w=600&q=80',
  'https://images.unsplash.com/photo-1567306226416-28f0efdc88ce?w=600&q=80',
  'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=600&q=80',
];

// Pool sản phẩm theo từng danh mục: { name, price (VND), unit }
// Giá hợp lý thị trường VN, từ 15.000đ đến 2.000.000đ.
type ProdTpl = { name: string; price: number; unit: string };
const PRODUCT_POOL: Record<string, ProdTpl[]> = {
  'Rau củ': [
    { name: 'Cải ngọt hữu cơ', price: 22000, unit: 'kg' },
    { name: 'Rau muống sạch', price: 15000, unit: 'bó' },
    { name: 'Cà chua bi Đà Lạt', price: 45000, unit: 'kg' },
    { name: 'Cà rốt Đà Lạt', price: 25000, unit: 'kg' },
    { name: 'Súp lơ xanh', price: 55000, unit: 'kg' },
    { name: 'Khoai tây vàng', price: 35000, unit: 'kg' },
    { name: 'Dưa leo baby', price: 30000, unit: 'kg' },
    { name: 'Bí đỏ hồ lô', price: 28000, unit: 'kg' },
    { name: 'Ớt chuông đỏ', price: 70000, unit: 'kg' },
    { name: 'Hành lá', price: 40000, unit: 'kg' },
  ],
  'Trái cây': [
    { name: 'Xoài cát Hòa Lộc', price: 95000, unit: 'kg' },
    { name: 'Sầu riêng Ri6', price: 180000, unit: 'kg' },
    { name: 'Bơ sáp 034', price: 80000, unit: 'kg' },
    { name: 'Dâu tây Đà Lạt', price: 120000, unit: 'kg' },
    { name: 'Cam sành miền Tây', price: 30000, unit: 'kg' },
    { name: 'Bưởi da xanh', price: 45000, unit: 'kg' },
    { name: 'Thanh long ruột đỏ', price: 40000, unit: 'kg' },
    { name: 'Nhãn lồng Hưng Yên', price: 60000, unit: 'kg' },
    { name: 'Vải thiều Lục Ngạn', price: 55000, unit: 'kg' },
    { name: 'Nho đen không hạt', price: 150000, unit: 'kg' },
  ],
  'Gạo & ngũ cốc': [
    { name: 'Gạo ST25 túi 5kg', price: 180000, unit: 'túi' },
    { name: 'Gạo lứt đỏ Điện Biên', price: 50000, unit: 'kg' },
    { name: 'Yến mạch nguyên hạt', price: 90000, unit: 'kg' },
    { name: 'Đậu xanh tách vỏ', price: 48000, unit: 'kg' },
    { name: 'Đậu đen xanh lòng', price: 45000, unit: 'kg' },
    { name: 'Mè đen rang', price: 65000, unit: 'kg' },
    { name: 'Hạt sen khô', price: 220000, unit: 'kg' },
    { name: 'Ngô ngọt (bắp)', price: 15000, unit: 'kg' },
    { name: 'Gạo nếp cái hoa vàng', price: 40000, unit: 'kg' },
    { name: 'Hạt Quinoa diêm mạch', price: 250000, unit: 'kg' },
  ],
  'Thịt/Trứng/Sữa': [
    { name: 'Trứng gà ta vỉ 10', price: 35000, unit: 'vỉ' },
    { name: 'Trứng vịt vỉ 10', price: 38000, unit: 'vỉ' },
    { name: 'Thịt heo sạch ba chỉ', price: 140000, unit: 'kg' },
    { name: 'Gà ta thả vườn', price: 130000, unit: 'kg' },
    { name: 'Sữa bò tươi thanh trùng', price: 35000, unit: 'lít' },
    { name: 'Trứng cút lộn', price: 25000, unit: 'chục' },
    { name: 'Sữa dê tươi', price: 60000, unit: 'lít' },
    { name: 'Thịt bò bắp', price: 280000, unit: 'kg' },
    { name: 'Cá lóc đồng', price: 90000, unit: 'kg' },
    { name: 'Gà ác nguyên con', price: 110000, unit: 'con' },
  ],
  'Vật tư nông nghiệp': [
    { name: 'Phân bón hữu cơ bao 25kg', price: 250000, unit: 'bao' },
    { name: 'Hạt giống rau cải gói', price: 18000, unit: 'gói' },
    { name: 'Phân trùn quế bao 20kg', price: 120000, unit: 'bao' },
    { name: 'Lưới che nắng cuộn 50m', price: 320000, unit: 'cuộn' },
    { name: 'Thuốc trừ sâu sinh học', price: 85000, unit: 'chai' },
    { name: 'Màng phủ nông nghiệp cuộn', price: 400000, unit: 'cuộn' },
    { name: 'Giá thể trồng cây bao 50L', price: 95000, unit: 'bao' },
    { name: 'Bình phun tay 16L', price: 280000, unit: 'cái' },
    { name: 'Máy phun thuốc động cơ', price: 2000000, unit: 'cái' },
    { name: 'Dây buộc cây cuộn', price: 35000, unit: 'cuộn' },
  ],
};

const REVIEW_COMMENTS = [
  'Hàng đóng gói cẩn thận, nông sản tươi ngon. Sẽ ủng hộ shop dài dài!',
  'Giao nhanh, sản phẩm đúng mô tả, rất hài lòng.',
  'Rau củ tươi, không dập nát. Shop tư vấn nhiệt tình.',
  'Chất lượng tốt, giá hợp lý, đóng gói chắc chắn.',
  'Mua lần 2 rồi, vẫn ngon như lần đầu. Recommend!',
  'Sản phẩm sạch, an toàn cho gia đình. Cảm ơn shop.',
];
const SELLER_REPLIES = [
  'Cảm ơn anh/chị đã tin tưởng shop ạ! Hẹn gặp lại đơn sau ❤️',
  'Shop cảm ơn đánh giá 5 sao của mình nhé!',
  'Rất vui khi sản phẩm làm hài lòng anh/chị ạ.',
];

const ADDRESSES = [
  '12 Nguyễn Huệ, Quận 1, TP.HCM',
  '45 Lê Lợi, Hải Châu, Đà Nẵng',
  '88 Trần Phú, Ba Đình, Hà Nội',
  '23 Hùng Vương, Ninh Kiều, Cần Thơ',
  '7 Hai Bà Trưng, TP. Đà Lạt, Lâm Đồng',
];

// helper: số 2 chữ số  -> "01", "02", ...
const pad = (n: number) => String(n).padStart(2, '0');
const pick = <T,>(arr: T[], i: number) => arr[i % arr.length];

// ════════════════════════════════════════════════════════════════════════════
//  CLEANUP PHASE — xoá mọi bản ghi SEED theo thứ tự an toàn FK
// ════════════════════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('🧹 [Cleanup] Đang xoá dữ liệu SEED cũ (giữ nguyên dữ liệu thật)...');

  const seedUsers = await prisma.user.findMany({
    where: { email: { startsWith: SEED_EMAIL_PREFIX } },
    select: { id: true },
  });
  const userIds = seedUsers.map((u) => u.id);

  // Bắt thêm các product mang prefix [SEED] kể cả nếu chủ sở hữu không còn là seed user
  const seedProducts = await prisma.product.findMany({
    where: {
      OR: [{ seller_id: { in: userIds } }, { name: { startsWith: SEED_NAME_PREFIX } }],
    },
    select: { id: true },
  });
  const productIds = seedProducts.map((p) => p.id);

  if (userIds.length === 0 && productIds.length === 0) {
    console.log('🧹 [Cleanup] Không tìm thấy dữ liệu SEED — bỏ qua.');
    return;
  }

  const orders = await prisma.order.findMany({
    where: { OR: [{ buyer_id: { in: userIds } }, { seller_id: { in: userIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  const convs = await prisma.conversation.findMany({
    where: { OR: [{ user1_id: { in: userIds } }, { user2_id: { in: userIds } }] },
    select: { id: true },
  });
  const convIds = convs.map((c) => c.id);

  const vouchers = await prisma.voucher.findMany({
    where: { seller_id: { in: userIds } },
    select: { id: true },
  });
  const voucherIds = vouchers.map((v) => v.id);

  // Thứ tự xoá: lá -> gốc (tránh FK violation vì schema phần lớn KHÔNG cascade)
  await prisma.review.deleteMany({ where: { order_id: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { order_id: { in: orderIds } } });
  await prisma.orderItem.deleteMany({
    where: { OR: [{ order_id: { in: orderIds } }, { product_id: { in: productIds } }] },
  });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.chatMessage.deleteMany({
    where: {
      OR: [
        { conversation_id: { in: convIds } },
        { sender_id: { in: userIds } },
        { context_product_id: { in: productIds } },
      ],
    },
  });
  await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });

  await prisma.savedVoucher.deleteMany({
    where: { OR: [{ user_id: { in: userIds } }, { voucher_id: { in: voucherIds } }] },
  });
  await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });

  await prisma.checkoutSession.deleteMany({ where: { buyer_id: { in: userIds } } });
  await prisma.productEmbedding.deleteMany({ where: { product_id: { in: productIds } } });
  await prisma.attachment.deleteMany({ where: { target_id: { in: [...productIds, ...userIds] } } });
  await prisma.userBehavior.deleteMany({ where: { user_id: { in: userIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });

  // Các bảng có onDelete: Cascade theo User — vẫn xoá tường minh cho chắc
  await prisma.aISession.deleteMany({ where: { user_id: { in: userIds } } });
  await prisma.recommendationCache.deleteMany({ where: { user_id: { in: userIds } } });
  await prisma.verification.deleteMany({ where: { userId: { in: userIds } } });

  await prisma.profile.deleteMany({ where: { user_id: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(
    `🧹 [Cleanup] Đã xoá: ${userIds.length} users, ${productIds.length} products, ${orderIds.length} orders, ${convIds.length} conversations, ${voucherIds.length} vouchers.`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  SEED PHASE
// ════════════════════════════════════════════════════════════════════════════
async function seed() {
  const counts = {
    users: 0,
    products: 0,
    categories: 0,
    vouchers: 0,
    orders: 0,
    reviews: 0,
    payments: 0,
    conversations: 0,
    messages: 0,
    behaviors: 0,
  };

  // Hash 1 lần — dùng chung cho mọi seed user
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  // ── 1. CATEGORIES (upsert theo name — KHÔNG xoá, có thể dùng chung) ──────────
  console.log('📂 [Seed] Categories...');
  const categories: Record<string, number> = {};
  for (const name of CATEGORY_NAMES) {
    const cat = await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    categories[name] = cat.id;
    counts.categories++;
  }

  // ── 2. USERS ─────────────────────────────────────────────────────────────────
  console.log('👤 [Seed] Users (buyers / sellers / hybrids)...');
  const baseUser = (email: string, full_name: string, isBuyer: boolean, isSeller: boolean) => ({
    email,
    password_hash: passwordHash,
    full_name,
    display_name: full_name,
    provider: 'password',
    is_buyer: isBuyer,
    is_seller: isSeller,
    verified_email: true, // ← bỏ qua OTP, login thẳng
    last_login_at: new Date(),
  });

  // Buyers
  const buyers = await Promise.all(
    Array.from({ length: N_BUYERS }, (_, i) => {
      const n = pad(i + 1);
      return prisma.user.create({
        data: baseUser(`${SEED_EMAIL_PREFIX}buyer${n}${EMAIL_DOMAIN}`, PERSON_NAMES[i % PERSON_NAMES.length], true, false),
      });
    }),
  );

  // Sellers (kèm Profile / shop)
  const sellers = await Promise.all(
    Array.from({ length: N_SELLERS }, (_, i) => {
      const n = pad(i + 1);
      return prisma.user.create({
        data: {
          ...baseUser(`${SEED_EMAIL_PREFIX}seller${n}${EMAIL_DOMAIN}`, PERSON_NAMES[(i + 5) % PERSON_NAMES.length], false, true),
          profile: {
            create: {
              store_name: SHOP_NAMES[i % SHOP_NAMES.length],
              address: pick(ADDRESSES, i),
              description: 'Cửa hàng nông sản sạch, cam kết chất lượng.',
              is_verified: true,
            },
          },
        },
      });
    }),
  );

  // Hybrids (BUYER + SELLER, kèm Profile)
  const hybrids = await Promise.all(
    Array.from({ length: N_HYBRIDS }, (_, i) => {
      const n = pad(i + 1);
      return prisma.user.create({
        data: {
          ...baseUser(`${SEED_EMAIL_PREFIX}hybrid${n}${EMAIL_DOMAIN}`, PERSON_NAMES[(i + 12) % PERSON_NAMES.length], true, true),
          profile: {
            create: {
              store_name: SHOP_NAMES[(i + 6) % SHOP_NAMES.length],
              address: pick(ADDRESSES, i + 2),
              description: 'Vừa mua vừa bán — tài khoản demo lưỡng vai.',
              is_verified: true,
            },
          },
        },
      });
    }),
  );
  counts.users = buyers.length + sellers.length + hybrids.length;

  const sellingUsers = [...sellers, ...hybrids]; // 20 user có thể bán
  const buyingUsers = [...buyers, ...hybrids]; // 30 user có thể mua

  // ── 3. PRODUCTS (5–10 / seller) + Attachment ảnh ─────────────────────────────
  console.log('🥬 [Seed] Products...');
  const productsBySeller: Record<string, { id: string; price: number; name: string; unit: string }[]> = {};
  for (let s = 0; s < sellingUsers.length; s++) {
    const seller = sellingUsers[s];
    const catName = CATEGORY_NAMES[s % CATEGORY_NAMES.length];
    const pool = PRODUCT_CATALOG[catName];
    const nProducts = 5 + (s % 6); // 5..10
    productsBySeller[seller.id] = [];

    for (let p = 0; p < nProducts; p++) {
      const tpl = pool[p % pool.length];
      const stock = 30 + ((s + p) % 20) * 10; // 30..220
      const allowNego = p % 3 === 0; // ~1/3 sản phẩm cho thương lượng
      const product = await prisma.product.create({
        data: {
          name: tpl.name, // KHÔNG còn tiền tố [SEED] — nhận diện seed qua email người bán
          search_name: removeVietnameseTones(tpl.name),
          description: `${tpl.name} — nông sản sạch, cam kết chất lượng.`,
          reference_price: tpl.price,
          stock_quantity: stock,
          unit: tpl.unit,
          location: pick(ADDRESSES, s),
          certification: allowNego ? 'VietGAP' : null,
          min_negotiation_qty: allowNego ? 10 : null,
          category_id: categories[catName],
          seller_id: seller.id,
          is_active: true,
          status: ProductStatus.ACTIVE,
        },
      });
      // 1 ảnh KHỚP tên sản phẩm (Attachment, target_type = PRODUCT)
      await prisma.attachment.create({
        data: {
          url: tpl.image,
          file_type: 'IMAGE',
          target_id: product.id,
          target_type: TargetType.PRODUCT,
        },
      });
      productsBySeller[seller.id].push({ id: product.id, price: tpl.price, name: tpl.name, unit: tpl.unit });
      counts.products++;
    }
  }

  // ── 4. VOUCHERS ──────────────────────────────────────────────────────────────
  // LƯU Ý: schema Voucher yêu cầu seller_id (KHÔNG có voucher "toàn sàn" thực sự).
  // ⇒ "global" SEED-WELCOME-10 được gán cho seller demo đầu tiên.
  console.log('🎟️  [Seed] Vouchers...');
  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 86400_000);

  // "Global-ish" welcome voucher (gắn vào seller demo đầu tiên)
  await prisma.voucher.create({
    data: {
      seller_id: sellingUsers[0].id,
      code: 'SEED-WELCOME-10',
      discount_type: DiscountType.PERCENT,
      discount_value: 10,
      min_order_value: 100000,
      max_discount_amount: 50000,
      valid_from: now,
      valid_to: in30d,
      usage_limit: 1000,
      is_active: true,
    },
  });
  counts.vouchers++;

  // Voucher riêng cho mỗi seller
  for (let s = 0; s < sellingUsers.length; s++) {
    const seller = sellingUsers[s];
    const isPercent = s % 2 === 0;
    await prisma.voucher.create({
      data: {
        seller_id: seller.id,
        code: `SEED-SHOP${pad(s + 1)}`,
        discount_type: isPercent ? DiscountType.PERCENT : DiscountType.FIXED,
        discount_value: isPercent ? 15 : 20000,
        min_order_value: 50000,
        max_discount_amount: isPercent ? 30000 : 20000,
        valid_from: now,
        valid_to: in30d,
        usage_limit: 100,
        is_active: true,
      },
    });
    counts.vouchers++;
  }

  // ── 5. ORDERS + ITEMS + PAYMENTS + REVIEWS ───────────────────────────────────
  console.log('🧾 [Seed] Orders / Payments / Reviews...');
  // Phân bổ trạng thái: nhiều COMPLETED hơn để có review
  const STATUS_CYCLE: OrderStatus[] = [
    OrderStatus.PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPING,
    OrderStatus.COMPLETED,
    OrderStatus.COMPLETED,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ];
  const METHOD_CYCLE: PaymentMethod[] = [
    PaymentMethod.COD,
    PaymentMethod.MOMO,
    PaymentMethod.QR_CODE,
    PaymentMethod.ZALOPAY,
  ];

  for (let i = 0; i < N_ORDERS; i++) {
    const seller = pick(sellingUsers, i);
    let buyer = pick(buyingUsers, i * 3 + 1);
    if (buyer.id === seller.id) buyer = pick(buyingUsers, i * 3 + 2); // tránh tự mua
    if (buyer.id === seller.id) continue;

    const sellerProducts = productsBySeller[seller.id];
    if (!sellerProducts || sellerProducts.length === 0) continue;

    const status = pick(STATUS_CYCLE, i);
    const method = pick(METHOD_CYCLE, i);

    // 1–2 sản phẩm / đơn
    const nItems = 1 + (i % 2);
    const items = Array.from({ length: nItems }, (_, k) => {
      const prod = pick(sellerProducts, i + k);
      const qty = 1 + ((i + k) % 5); // 1..5
      return { product_id: prod.id, quantity: qty, negotiated_price: prod.price };
    });
    const total = items.reduce((sum, it) => sum + it.quantity * it.negotiated_price, 0);

    const createdAt = new Date(now.getTime() - ((i % 30) + 1) * 86400_000); // rải trong 30 ngày
    const shipped =
      status === OrderStatus.SHIPPING || status === OrderStatus.COMPLETED
        ? new Date(createdAt.getTime() + 86400_000)
        : null;

    const order = await prisma.order.create({
      data: {
        buyer_id: buyer.id,
        seller_id: seller.id,
        status,
        payment_method: method,
        final_total_price: total,
        shipping_address: pick(ADDRESSES, i),
        shipped_at: shipped,
        created_at: createdAt,
        note: status === OrderStatus.FAILED ? 'Giao thất bại — khách không nhận máy.' : null,
        order_items: { create: items },
      },
    });
    counts.orders++;

    // Payment: phản ánh trạng thái đơn
    let payStatus: PaymentStatus = PaymentStatus.UNPAID;
    if (status === OrderStatus.COMPLETED) payStatus = PaymentStatus.PAID;
    else if (status === OrderStatus.FAILED) payStatus = PaymentStatus.FAILED;
    else if (method !== PaymentMethod.COD && (status === OrderStatus.SHIPPING || status === OrderStatus.CONFIRMED))
      payStatus = PaymentStatus.PAID; // online đã trả trước
    await prisma.payment.create({
      data: {
        order_id: order.id,
        payer_id: buyer.id,
        amount: total,
        payment_method: method,
        status: payStatus,
        payment_type: PaymentType.PAYMENT,
        transaction_ref: method === PaymentMethod.COD ? null : `SEED-TXN-${pad(i + 1)}`,
        created_at: createdAt,
      },
    });
    counts.payments++;

    // Review cho đơn COMPLETED (4–5 sao)
    if (status === OrderStatus.COMPLETED) {
      const replied = i % 2 === 0;
      await prisma.review.create({
        data: {
          order_id: order.id,
          reviewer_id: buyer.id,
          rating: 4 + (i % 2), // 4 hoặc 5
          comment: pick(REVIEW_COMMENTS, i),
          seller_reply: replied ? pick(SELLER_REPLIES, i) : null,
          seller_replied_at: replied ? new Date(createdAt.getTime() + 2 * 86400_000) : null,
          created_at: new Date(createdAt.getTime() + 2 * 86400_000),
        },
      });
      counts.reviews++;

      // Hành vi PURCHASE (phục vụ recommendations)
      await prisma.userBehavior.create({
        data: {
          user_id: buyer.id,
          action: BehaviorAction.PURCHASE,
          target_id: items[0].product_id,
          weight: 5,
          created_at: createdAt,
        },
      });
      counts.behaviors++;
    }
  }

  // Vài hành vi VIEW_PRODUCT cho buyer (làm recommendations phong phú hơn)
  for (let i = 0; i < buyers.length; i++) {
    const buyer = buyers[i];
    const seller = pick(sellingUsers, i);
    const prod = pick(productsBySeller[seller.id], i);
    if (!prod) continue;
    await prisma.userBehavior.create({
      data: {
        user_id: buyer.id,
        action: BehaviorAction.VIEW_PRODUCT,
        target_id: prod.id,
        weight: 1,
      },
    });
    counts.behaviors++;
  }

  // ── 6. NEGOTIATION THREADS (chat thương lượng → quote ACCEPTED → Order) ───────
  console.log('💬 [Seed] Negotiation threads...');
  for (let t = 0; t < N_NEGOTIATIONS; t++) {
    const seller = sellingUsers[t]; // 5 seller khác nhau
    const buyer = buyers[t]; // 5 buyer khác nhau → cặp (buyer,seller) duy nhất
    const sellerProducts = productsBySeller[seller.id];
    if (!sellerProducts || sellerProducts.length === 0) continue;
    const prod = sellerProducts[0];

    const bulkQty = 20 + t * 5; // mua sỉ
    const quotedUnitPrice = Math.round(prod.price * 0.9); // seller giảm 10%
    const tBase = new Date(now.getTime() - (t + 1) * 3600_000);

    const conv = await prisma.conversation.create({
      data: {
        user1_id: buyer.id,
        user2_id: seller.id,
        created_at: tBase,
        user1_last_read_at: new Date(tBase.getTime() + 5 * 60_000),
        user2_last_read_at: new Date(tBase.getTime() + 5 * 60_000),
      },
    });
    counts.conversations++;

    // (1) Buyer hỏi giá sỉ
    await prisma.chatMessage.create({
      data: {
        conversation_id: conv.id,
        sender_id: buyer.id,
        message_type: MessageType.TEXT,
        message_content: `Shop ơi, mình muốn lấy sỉ ${bulkQty}${prod.unit} ${prod.name}, có giá tốt hơn không ạ?`,
        context_product_id: prod.id,
        client_message_id: `seed-neg-${t}-buyer-ask`,
        created_at: new Date(tBase.getTime() + 1 * 60_000),
      },
    });
    counts.messages++;

    // (2) Seller gửi NEGOTIATION_QUOTE
    const quote = await prisma.chatMessage.create({
      data: {
        conversation_id: conv.id,
        sender_id: seller.id,
        message_type: MessageType.NEGOTIATION_QUOTE,
        message_content: `Báo giá sỉ ${prod.name}: ${quotedUnitPrice.toLocaleString('vi-VN')}đ/${prod.unit} cho ${bulkQty}${prod.unit}.`,
        context_product_id: prod.id,
        quote_product_id: prod.id,
        quote_product_name: prod.name,
        quote_quantity: bulkQty,
        quote_price: quotedUnitPrice,
        proposed_quantity: bulkQty,
        proposed_price: prod.price,
        quote_unit: prod.unit,
        quote_status: QuoteStatus.ACCEPTED, // buyer đã chấp nhận
        client_message_id: `seed-neg-${t}-seller-quote`,
        created_at: new Date(tBase.getTime() + 3 * 60_000),
      },
    });
    counts.messages++;

    // (3) Buyer xác nhận
    await prisma.chatMessage.create({
      data: {
        conversation_id: conv.id,
        sender_id: buyer.id,
        message_type: MessageType.TEXT,
        message_content: 'Ok shop, mình chốt đơn với giá này nhé!',
        client_message_id: `seed-neg-${t}-buyer-accept`,
        created_at: new Date(tBase.getTime() + 4 * 60_000),
      },
    });
    counts.messages++;

    // (4) Order tạo từ quote — liên kết qua negotiation_quote_id
    const negoTotal = bulkQty * quotedUnitPrice;
    const order = await prisma.order.create({
      data: {
        buyer_id: buyer.id,
        seller_id: seller.id,
        status: OrderStatus.CONFIRMED,
        payment_method: PaymentMethod.COD,
        final_total_price: negoTotal,
        shipping_address: pick(ADDRESSES, t),
        negotiation_quote_id: quote.id,
        created_at: new Date(tBase.getTime() + 5 * 60_000),
        order_items: {
          create: { product_id: prod.id, quantity: bulkQty, negotiated_price: quotedUnitPrice },
        },
      },
    });
    counts.orders++;

    await prisma.payment.create({
      data: {
        order_id: order.id,
        payer_id: buyer.id,
        amount: negoTotal,
        payment_method: PaymentMethod.COD,
        status: PaymentStatus.UNPAID,
        payment_type: PaymentType.PAYMENT,
      },
    });
    counts.payments++;
  }

  return counts;
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  // ── Guard môi trường ──
  if (process.env.NODE_ENV === 'production') {
    console.error('⛔ NODE_ENV=production — TỪ CHỐI chạy seed để bảo vệ dữ liệu thật.');
    process.exit(1);
  }

  console.log('🌱 ====== AGRI CONNECT — SEED DEMO DATA ======');
  console.log(`    Mật khẩu mọi tài khoản: ${SEED_PASSWORD}`);

  await cleanup();
  const counts = await seed();

  console.log('\n✅ ====== HOÀN TẤT ======');
  console.log(
    `   👤 Users:         ${counts.users}  (${N_BUYERS} buyers, ${N_SELLERS} sellers, ${N_HYBRIDS} hybrids)`,
  );
  console.log(`   📂 Categories:    ${counts.categories}`);
  console.log(`   🥬 Products:      ${counts.products}`);
  console.log(`   🎟️  Vouchers:      ${counts.vouchers}`);
  console.log(`   🧾 Orders:        ${counts.orders}`);
  console.log(`   💳 Payments:      ${counts.payments}`);
  console.log(`   ⭐ Reviews:       ${counts.reviews}`);
  console.log(`   💬 Conversations: ${counts.conversations}  (${counts.messages} messages)`);
  console.log(`   📊 Behaviors:     ${counts.behaviors}`);
  console.log('\n   🔑 Đăng nhập demo:');
  console.log(`      Buyer : seed.buyer01${EMAIL_DOMAIN}`);
  console.log(`      Seller: seed.seller01${EMAIL_DOMAIN}`);
  console.log(`      Hybrid: seed.hybrid01${EMAIL_DOMAIN}`);
  console.log(`      Mật khẩu: ${SEED_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed thất bại:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
