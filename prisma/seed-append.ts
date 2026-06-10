/**
 * ============================================================================
 *  Agri Connect — SEED APPEND (chỉ THÊM dữ liệu, KHÔNG xoá bất cứ thứ gì)
 * ============================================================================
 *
 *  KHÁC với prisma/seed.ts (vốn xoá-rồi-tạo-lại namespace "seed."), file này:
 *   - KHÔNG có bất kỳ deleteMany / migrate reset nào.
 *   - Dùng namespace MỚI hoàn toàn: "seed2." / "[SEED2] " / "SEED2-..."  ⇒ không
 *     bao giờ đụng tới dữ liệu thật HOẶC dữ liệu seed cũ ("seed." / "[SEED] ").
 *   - Idempotent bằng UPSERT trên khoá xác định (deterministic id / unique key)
 *     ⇒ chạy lại nhiều lần KHÔNG tạo bản ghi trùng, KHÔNG lỗi Unique Constraint.
 *   - Chỉ "create-or-update" các bản ghi mang namespace seed2; tuyệt đối không
 *     chạm vào bản ghi nằm ngoài namespace này.
 *
 *  BỎ QUA OTP cho demo: seed2 user có verified_email = true (chỉ user demo).
 *  KHÔNG đổi auth.service.ts, KHÔNG tắt OTP toàn cục.
 *
 *  Chạy:  pnpm run seed:append   (hoặc  npx ts-node prisma/seed-append.ts)
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
import { CATEGORY_NAMES, PERSON_NAMES, SHOP_NAMES, PRODUCT_CATALOG } from './seed-data';

const prisma = new PrismaClient();

// ─── Namespace MỚI (seed2) ───────────────────────────────────────────────────
const NS = 'seed2'; // dùng cho id tiền tố: seed2-...
const EMAIL_PREFIX = 'seed2.'; // seed2.buyer01@... — NHẬN DIỆN seed qua EMAIL, không qua tên SP
const VOUCHER_PREFIX = 'SEED2'; // marker chỉ ở voucher code, KHÔNG ở tên sản phẩm
const EMAIL_DOMAIN = '@agriconnect.test';
const SEED_PASSWORD = 'Seed@123456';

const N_BUYERS = 15;
const N_SELLERS = 10;
const N_HYBRIDS = 5;
const N_ORDERS = 50; // trong khoảng 40–60
const N_NEGOTIATIONS = 4; // trong khoảng 3–5

// CATEGORY_NAMES + PRODUCT_CATALOG (tên + ảnh khớp) import từ ./seed-data.

const REVIEW_COMMENTS = [
  'Nông sản tươi rói, đóng gói kỹ, ship nhanh. Rất ưng!',
  'Hàng chuẩn như mô tả, shop nhiệt tình tư vấn.',
  'Mua sỉ giá tốt, chất lượng ổn định. Sẽ quay lại.',
  'Đồ sạch, an toàn, gia đình rất thích. Cảm ơn shop nhé.',
  'Giao đúng hẹn, sản phẩm ngon. 5 sao xứng đáng.',
  'Đóng thùng chắc chắn, không móp méo. Recommend!',
];
const SELLER_REPLIES = [
  'Cảm ơn anh/chị nhiều ạ, hẹn gặp lại đơn sau!',
  'Shop rất vui vì mình hài lòng ạ ❤️',
  'Cảm ơn đánh giá 5 sao của mình nha!',
];
const ADDRESSES = [
  '15 Phan Đình Phùng, Quận 3, TP.HCM',
  '102 Bạch Đằng, Hải Châu, Đà Nẵng',
  '9 Tràng Tiền, Hoàn Kiếm, Hà Nội',
  '56 Mậu Thân, Ninh Kiều, Cần Thơ',
  '3 Trần Hưng Đạo, TP. Buôn Ma Thuột, Đắk Lắk',
];

const pad = (n: number) => String(n).padStart(2, '0');
const pick = <T,>(arr: T[], i: number) => arr[i % arr.length];

// Bộ đếm "đã thay đổi" — upsert không phân biệt create/update, nên ta đếm theo
// số bản ghi seed2 tồn tại TRƯỚC để suy ra "mới tạo" so với "đã có".
type Counts = {
  users: number;
  products: number;
  vouchers: number;
  orders: number;
  payments: number;
  reviews: number;
  conversations: number;
  messages: number;
  behaviors: number;
};

async function snapshotSeed2(): Promise<Counts> {
  const [users, products, vouchers, orders, payments, reviews, conversations, messages, behaviors] =
    await Promise.all([
      prisma.user.count({ where: { email: { startsWith: EMAIL_PREFIX } } }),
      prisma.product.count({ where: { id: { startsWith: `${NS}-prod` } } }),
      prisma.voucher.count({ where: { code: { startsWith: VOUCHER_PREFIX } } }),
      prisma.order.count({ where: { id: { startsWith: `${NS}-order` } } }),
      prisma.payment.count({ where: { id: { startsWith: `${NS}-pay` } } }),
      prisma.review.count({ where: { id: { startsWith: `${NS}-rev` } } }),
      prisma.conversation.count({ where: { id: { startsWith: `${NS}-conv` } } }),
      prisma.chatMessage.count({ where: { id: { startsWith: `${NS}-msg` } } }),
      prisma.userBehavior.count({ where: { id: { startsWith: `${NS}-bhv` } } }),
    ]);
  return { users, products, vouchers, orders, payments, reviews, conversations, messages, behaviors };
}

async function globalSnapshot() {
  const [users, products, orders] = await Promise.all([
    prisma.user.count(),
    prisma.product.count(),
    prisma.order.count(),
  ]);
  const seed1 = await prisma.user.count({ where: { email: { startsWith: 'seed.' } } });
  return { users, products, orders, seed1Users: seed1 };
}

// ════════════════════════════════════════════════════════════════════════════
//  APPEND (toàn bộ bằng upsert — không xoá gì)
// ════════════════════════════════════════════════════════════════════════════
async function append() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 86400_000);

  // ── Categories (upsert by unique name — KHÔNG xoá, dùng chung) ───────────────
  const categories: Record<string, number> = {};
  for (const name of CATEGORY_NAMES) {
    const cat = await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
    categories[name] = cat.id;
  }

  // ── Users (upsert by unique email; verified_email = true chỉ cho demo) ───────
  const mkUser = (id: string, email: string, full_name: string, isBuyer: boolean, isSeller: boolean) =>
    prisma.user.upsert({
      where: { email },
      update: { full_name, is_buyer: isBuyer, is_seller: isSeller, verified_email: true },
      create: {
        id,
        email,
        password_hash: passwordHash,
        full_name,
        display_name: full_name,
        provider: 'password',
        is_buyer: isBuyer,
        is_seller: isSeller,
        verified_email: true,
        last_login_at: now,
      },
    });

  const buyers = await Promise.all(
    Array.from({ length: N_BUYERS }, (_, i) => {
      const n = pad(i + 1);
      return mkUser(`${NS}-buyer-${n}`, `${EMAIL_PREFIX}buyer${n}${EMAIL_DOMAIN}`, PERSON_NAMES[i % PERSON_NAMES.length], true, false);
    }),
  );
  const sellers = await Promise.all(
    Array.from({ length: N_SELLERS }, (_, i) => {
      const n = pad(i + 1);
      return mkUser(`${NS}-seller-${n}`, `${EMAIL_PREFIX}seller${n}${EMAIL_DOMAIN}`, PERSON_NAMES[(i + 5) % PERSON_NAMES.length], false, true);
    }),
  );
  const hybrids = await Promise.all(
    Array.from({ length: N_HYBRIDS }, (_, i) => {
      const n = pad(i + 1);
      return mkUser(`${NS}-hybrid-${n}`, `${EMAIL_PREFIX}hybrid${n}${EMAIL_DOMAIN}`, PERSON_NAMES[(i + 12) % PERSON_NAMES.length], true, true);
    }),
  );

  // Profile cho seller + hybrid (upsert by unique user_id)
  const sellingUsers = [...sellers, ...hybrids];
  for (let s = 0; s < sellingUsers.length; s++) {
    const u = sellingUsers[s];
    const shopName = SHOP_NAMES[s % SHOP_NAMES.length];
    await prisma.profile.upsert({
      where: { user_id: u.id },
      update: { store_name: shopName, is_verified: true },
      create: {
        user_id: u.id,
        store_name: shopName,
        address: pick(ADDRESSES, s),
        description: 'Gian hàng nông sản sạch, cam kết chất lượng.',
        is_verified: true,
      },
    });
  }
  const buyingUsers = [...buyers, ...hybrids];

  // ── Products (upsert by deterministic id) + ảnh KHỚP tên ─────────────────────
  // Tên hiển thị KHÔNG còn [SEED2] — idempotent vẫn an toàn vì upsert theo id cố định.
  // update path set LẠI name/description ⇒ chạy lại tự xoá tiền tố cũ ở dữ liệu sẵn có.
  const productsBySeller: Record<string, { id: string; price: number; name: string; unit: string }[]> = {};
  for (let s = 0; s < sellingUsers.length; s++) {
    const seller = sellingUsers[s];
    const catName = CATEGORY_NAMES[s % CATEGORY_NAMES.length];
    const pool = PRODUCT_CATALOG[catName];
    const nProducts = 5 + (s % 4); // 5..8 (đủ phủ id đã tạo từ các lần chạy trước)
    productsBySeller[seller.id] = [];

    for (let p = 0; p < nProducts; p++) {
      const tpl = pool[p % pool.length];
      const pid = `${NS}-prod-${pad(s + 1)}-${pad(p + 1)}`;
      const stock = 40 + ((s + p) % 18) * 10;
      const allowNego = p % 3 === 0;
      await prisma.product.upsert({
        where: { id: pid },
        update: {
          name: tpl.name, // ghi đè tên cũ (gỡ [SEED2])
          description: `${tpl.name} — nông sản sạch, cam kết chất lượng.`,
          reference_price: tpl.price,
          unit: tpl.unit,
          stock_quantity: stock,
          is_active: true,
          status: ProductStatus.ACTIVE,
        },
        create: {
          id: pid,
          name: tpl.name,
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

      // Refresh ảnh KHỚP tên — CHỈ sản phẩm seed-owned (id seed2-prod-*): xoá ảnh cũ
      // (kể cả ảnh generic/mismatch từ lần trước) rồi tạo lại 1 ảnh đúng sản phẩm.
      await prisma.attachment.deleteMany({ where: { target_id: pid, target_type: TargetType.PRODUCT } });
      await prisma.attachment.create({
        data: {
          id: `${NS}-att-${pad(s + 1)}-${pad(p + 1)}-0`,
          url: tpl.image,
          file_type: 'IMAGE',
          target_id: pid,
          target_type: TargetType.PRODUCT,
        },
      });

      productsBySeller[seller.id].push({ id: pid, price: tpl.price, name: tpl.name, unit: tpl.unit });
    }
  }

  const productsTouched = Object.values(productsBySeller).reduce((a, arr) => a + arr.length, 0);
  console.log(`   🥬 Sản phẩm seed2: ${productsTouched} (đã set tên thật + 1 ảnh khớp/sp)`);
  console.log(`   🖼️  Ảnh seed2 refresh: ${productsTouched}`);
  console.log(`   👤 Users seed2 upsert: ${buyers.length + sellers.length + hybrids.length} · 🏪 shops: ${sellingUsers.length}`);

  // ── Vouchers (upsert by unique [seller_id, code]) ────────────────────────────
  // "Global-ish" welcome — gắn seller seed2 đầu tiên (schema không có voucher toàn sàn)
  await prisma.voucher.upsert({
    where: { seller_id_code: { seller_id: sellingUsers[0].id, code: `${VOUCHER_PREFIX}-WELCOME-10` } },
    update: {},
    create: {
      seller_id: sellingUsers[0].id,
      code: `${VOUCHER_PREFIX}-WELCOME-10`,
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
  // Voucher riêng cho 1 phần seller (mỗi seller chỉ số chẵn → "một số seller")
  for (let s = 0; s < sellingUsers.length; s += 2) {
    const seller = sellingUsers[s];
    const code = `${VOUCHER_PREFIX}-SHOP${pad(s + 1)}`;
    await prisma.voucher.upsert({
      where: { seller_id_code: { seller_id: seller.id, code } },
      update: {},
      create: {
        seller_id: seller.id,
        code,
        discount_type: DiscountType.FIXED,
        discount_value: 20000,
        min_order_value: 50000,
        max_discount_amount: 20000,
        valid_from: now,
        valid_to: in30d,
        usage_limit: 100,
        is_active: true,
      },
    });
  }

  // ── Orders + Items + Payments + Reviews (upsert by deterministic id) ─────────
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
    if (buyer.id === seller.id) buyer = pick(buyingUsers, i * 3 + 2);
    if (buyer.id === seller.id) continue;

    const sellerProducts = productsBySeller[seller.id];
    if (!sellerProducts || sellerProducts.length === 0) continue;

    const status = pick(STATUS_CYCLE, i);
    const method = pick(METHOD_CYCLE, i);
    const oid = `${NS}-order-${pad(i + 1)}`;

    const nItems = 1 + (i % 2);
    const items = Array.from({ length: nItems }, (_, k) => {
      const prod = pick(sellerProducts, i + k);
      const qty = 1 + ((i + k) % 5);
      return { id: `${NS}-oi-${pad(i + 1)}-${k}`, product_id: prod.id, quantity: qty, negotiated_price: prod.price };
    });
    const total = items.reduce((sum, it) => sum + it.quantity * it.negotiated_price, 0);
    const createdAt = new Date(now.getTime() - ((i % 30) + 1) * 86400_000);
    const shipped =
      status === OrderStatus.SHIPPING || status === OrderStatus.COMPLETED
        ? new Date(createdAt.getTime() + 86400_000)
        : null;

    // Upsert order TRƯỚC (không nested) để idempotent, rồi upsert từng item.
    await prisma.order.upsert({
      where: { id: oid },
      update: { status, final_total_price: total },
      create: {
        id: oid,
        buyer_id: buyer.id,
        seller_id: seller.id,
        status,
        payment_method: method,
        final_total_price: total,
        shipping_address: pick(ADDRESSES, i),
        shipped_at: shipped,
        created_at: createdAt,
        note: status === OrderStatus.FAILED ? 'Giao thất bại — khách vắng nhà.' : null,
      },
    });
    for (const it of items) {
      await prisma.orderItem.upsert({
        where: { id: it.id },
        update: { quantity: it.quantity, negotiated_price: it.negotiated_price },
        create: {
          id: it.id,
          order_id: oid,
          product_id: it.product_id,
          quantity: it.quantity,
          negotiated_price: it.negotiated_price,
        },
      });
    }

    let payStatus: PaymentStatus = PaymentStatus.UNPAID;
    if (status === OrderStatus.COMPLETED) payStatus = PaymentStatus.PAID;
    else if (status === OrderStatus.FAILED) payStatus = PaymentStatus.FAILED;
    else if (method !== PaymentMethod.COD && (status === OrderStatus.SHIPPING || status === OrderStatus.CONFIRMED))
      payStatus = PaymentStatus.PAID;
    await prisma.payment.upsert({
      where: { id: `${NS}-pay-${pad(i + 1)}` },
      update: { status: payStatus, amount: total },
      create: {
        id: `${NS}-pay-${pad(i + 1)}`,
        order_id: oid,
        payer_id: buyer.id,
        amount: total,
        payment_method: method,
        status: payStatus,
        payment_type: PaymentType.PAYMENT,
        transaction_ref: method === PaymentMethod.COD ? null : `${VOUCHER_PREFIX}-TXN-${pad(i + 1)}`,
        created_at: createdAt,
      },
    });

    if (status === OrderStatus.COMPLETED) {
      const replied = i % 2 === 0;
      await prisma.review.upsert({
        where: { id: `${NS}-rev-${pad(i + 1)}` },
        update: {},
        create: {
          id: `${NS}-rev-${pad(i + 1)}`,
          order_id: oid,
          reviewer_id: buyer.id,
          rating: 4 + (i % 2),
          comment: pick(REVIEW_COMMENTS, i),
          seller_reply: replied ? pick(SELLER_REPLIES, i) : null,
          seller_replied_at: replied ? new Date(createdAt.getTime() + 2 * 86400_000) : null,
          created_at: new Date(createdAt.getTime() + 2 * 86400_000),
        },
      });
      await prisma.userBehavior.upsert({
        where: { id: `${NS}-bhv-pur-${pad(i + 1)}` },
        update: {},
        create: {
          id: `${NS}-bhv-pur-${pad(i + 1)}`,
          user_id: buyer.id,
          action: BehaviorAction.PURCHASE,
          target_id: items[0].product_id,
          weight: 5,
          created_at: createdAt,
        },
      });
    }
  }

  // VIEW_PRODUCT behaviors cho buyer
  for (let i = 0; i < buyers.length; i++) {
    const buyer = buyers[i];
    const seller = pick(sellingUsers, i);
    const prod = pick(productsBySeller[seller.id], i);
    if (!prod) continue;
    await prisma.userBehavior.upsert({
      where: { id: `${NS}-bhv-view-${pad(i + 1)}` },
      update: {},
      create: {
        id: `${NS}-bhv-view-${pad(i + 1)}`,
        user_id: buyer.id,
        action: BehaviorAction.VIEW_PRODUCT,
        target_id: prod.id,
        weight: 1,
      },
    });
  }

  // ── Negotiation threads (upsert by [user1,user2] / deterministic message id) ─
  for (let t = 0; t < N_NEGOTIATIONS; t++) {
    const seller = sellingUsers[t];
    const buyer = buyers[t];
    const sellerProducts = productsBySeller[seller.id];
    if (!sellerProducts || sellerProducts.length === 0) continue;
    const prod = sellerProducts[0];
    const bulkQty = 20 + t * 5;
    const quotedUnitPrice = Math.round(prod.price * 0.9);
    const tBase = new Date(now.getTime() - (t + 1) * 3600_000);

    const conv = await prisma.conversation.upsert({
      where: { user1_id_user2_id: { user1_id: buyer.id, user2_id: seller.id } },
      update: {},
      create: {
        id: `${NS}-conv-${pad(t + 1)}`,
        user1_id: buyer.id,
        user2_id: seller.id,
        created_at: tBase,
        user1_last_read_at: new Date(tBase.getTime() + 5 * 60_000),
        user2_last_read_at: new Date(tBase.getTime() + 5 * 60_000),
      },
    });

    // (1) Buyer hỏi giá sỉ
    await prisma.chatMessage.upsert({
      where: { id: `${NS}-msg-${pad(t + 1)}-ask` },
      update: {},
      create: {
        id: `${NS}-msg-${pad(t + 1)}-ask`,
        conversation_id: conv.id,
        sender_id: buyer.id,
        message_type: MessageType.TEXT,
        message_content: `Shop ơi, em cần lấy sỉ ${bulkQty}${prod.unit} ${prod.name}, có giá tốt hơn không ạ?`,
        context_product_id: prod.id,
        client_message_id: `${NS}-neg-${t}-buyer-ask`,
        created_at: new Date(tBase.getTime() + 1 * 60_000),
      },
    });

    // (2) Seller gửi NEGOTIATION_QUOTE (đã được buyer chấp nhận)
    const quoteId = `${NS}-msg-${pad(t + 1)}-quote`;
    await prisma.chatMessage.upsert({
      where: { id: quoteId },
      update: { quote_status: QuoteStatus.ACCEPTED },
      create: {
        id: quoteId,
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
        quote_status: QuoteStatus.ACCEPTED,
        client_message_id: `${NS}-neg-${t}-seller-quote`,
        created_at: new Date(tBase.getTime() + 3 * 60_000),
      },
    });

    // (3) Buyer xác nhận
    await prisma.chatMessage.upsert({
      where: { id: `${NS}-msg-${pad(t + 1)}-accept` },
      update: {},
      create: {
        id: `${NS}-msg-${pad(t + 1)}-accept`,
        conversation_id: conv.id,
        sender_id: buyer.id,
        message_type: MessageType.TEXT,
        message_content: 'Dạ ok shop, em chốt đơn giá này nhé!',
        client_message_id: `${NS}-neg-${t}-buyer-accept`,
        created_at: new Date(tBase.getTime() + 4 * 60_000),
      },
    });

    // (4) Order tạo từ quote — liên kết qua negotiation_quote_id
    const negoTotal = bulkQty * quotedUnitPrice;
    const negoOid = `${NS}-order-nego-${pad(t + 1)}`;
    await prisma.order.upsert({
      where: { id: negoOid },
      update: { final_total_price: negoTotal },
      create: {
        id: negoOid,
        buyer_id: buyer.id,
        seller_id: seller.id,
        status: OrderStatus.CONFIRMED,
        payment_method: PaymentMethod.COD,
        final_total_price: negoTotal,
        shipping_address: pick(ADDRESSES, t),
        negotiation_quote_id: quoteId,
        created_at: new Date(tBase.getTime() + 5 * 60_000),
      },
    });
    await prisma.orderItem.upsert({
      where: { id: `${NS}-oi-nego-${pad(t + 1)}` },
      update: { quantity: bulkQty, negotiated_price: quotedUnitPrice },
      create: {
        id: `${NS}-oi-nego-${pad(t + 1)}`,
        order_id: negoOid,
        product_id: prod.id,
        quantity: bulkQty,
        negotiated_price: quotedUnitPrice,
      },
    });
    await prisma.payment.upsert({
      where: { id: `${NS}-pay-nego-${pad(t + 1)}` },
      update: { amount: negoTotal },
      create: {
        id: `${NS}-pay-nego-${pad(t + 1)}`,
        order_id: negoOid,
        payer_id: buyer.id,
        amount: negoTotal,
        payment_method: PaymentMethod.COD,
        status: PaymentStatus.UNPAID,
        payment_type: PaymentType.PAYMENT,
      },
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LEGACY DEMO — đảm bảo 6 account cũ + sản phẩm + ảnh luôn tồn tại
// ────────────────────────────────────────────────────────────────────────────
//  Đây là dữ liệu BẠN đã chuẩn bị sẵn (khach@gmail.com + shop1..5, ảnh tự chọn).
//  Idempotent THEO DỮ LIỆU ĐANG CÓ (id ngẫu nhiên cuid) bằng cách:
//    - User     : upsert theo email (unique) — KHÔNG đổi password nếu đã tồn tại.
//    - Profile  : upsert theo user_id (unique).
//    - Category : upsert theo name (unique).
//    - Product  : findFirst theo (seller_id, name) → có thì update, chưa có thì create.
//    - Ảnh      : CHỈ tạo khi product/user được tạo mới ⇒ không nhân đôi ảnh cũ.
//  ⇒ Chạy trên DB hiện tại: chỉ cập nhật, KHÔNG tạo trùng. Trên DB trắng: tạo đủ.
// ════════════════════════════════════════════════════════════════════════════
const LEGACY_PASSWORD = '123456'; // mật khẩu gốc của bộ demo cũ (khác Seed@123456)

const LEGACY_CATEGORIES = ['Trái cây', 'Rau củ', 'Ngũ cốc', 'Gia vị', 'Khác'] as const;

const LEGACY_SHOPS = [
  { userId: 'seller-shop-1', name: 'Nông Trại Cầu Đất', email: 'shop1@gmail.com', avatar: 'https://images.unsplash.com/photo-1605000797499-95a51c5269ae?w=200&h=200&fit=crop', location: 'TP. Đà Lạt, Lâm Đồng', desc: 'Chuyên Dâu tây & Rau củ' },
  { userId: 'seller-shop-2', name: 'Vựa Gạo Miền Tây', email: 'shop2@gmail.com', avatar: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=200&h=200&fit=crop', location: 'TP. Cần Thơ', desc: 'Gạo ngon ST25' },
  { userId: 'seller-shop-3', name: 'Hạt Dinh Dưỡng Organic', email: 'shop3@gmail.com', avatar: 'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=200&h=200&fit=crop', location: 'Bình Phước', desc: 'Hạt điều & Granola' },
  { userId: 'seller-shop-4', name: 'Thảo Mộc Tây Bắc', email: 'shop4@gmail.com', avatar: 'https://images.unsplash.com/photo-1615485925694-a039744c4b69?w=200&h=200&fit=crop', location: 'Sapa, Lào Cai', desc: 'Gia vị & Dược liệu' },
  { userId: 'seller-shop-5', name: 'Nông Sản Miền Núi', email: 'shop5@gmail.com', avatar: 'https://images.unsplash.com/photo-1501004318641-b39e6451bec6?w=200&h=200&fit=crop', location: 'Kon Tum', desc: 'Nông sản sạch miền núi' },
];

type LegacyProd = { id: string; name: string; price: number; category: string; origin: string; shopId: string; stock: number; images: string[]; description: string };
const LEGACY_PRODUCTS: LegacyProd[] = [
  { id: 'tc-1', name: 'Dâu tây Đà Lạt', price: 120000, category: 'Trái cây', origin: 'da-lat', shopId: 'shop-1', stock: 50, images: ['https://images.unsplash.com/photo-1587393855524-087f83d95bc9?q=80&w=920&auto=format&fit=crop', 'https://images.unsplash.com/photo-1622143365323-b6f297a72df3?q=80&w=870&auto=format&fit=crop', 'https://images.unsplash.com/photo-1588165171080-c89acfa5ee83?q=80&w=687&auto=format&fit=crop', 'https://images.unsplash.com/photo-1648141294431-1f1d49becd1a?q=80&w=687&auto=format&fit=crop', 'https://images.unsplash.com/photo-1543156426-0fe5c9dba474?q=80&w=870&auto=format&fit=crop', 'https://images.unsplash.com/photo-1716209290705-7333e99e3434?q=80&w=870&auto=format&fit=crop'], description: 'Dâu tây tươi ngon, đỏ mọng, vị ngọt thanh.' },
  { id: 'tc-2', name: 'Bơ sáp 034', price: 80000, category: 'Trái cây', origin: 'da-lat', shopId: 'shop-1', stock: 100, images: ['https://images.unsplash.com/photo-1653819370651-e5d283ec84aa?q=80&w=1160&auto=format&fit=crop', 'https://images.unsplash.com/photo-1612215047504-a6c07dbe4f7f?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1580823673284-e911e30564b6?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1580823673202-ef0405ae5b52?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1616485828923-2640a1ee48b4?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1691657915865-d7b9a6a54e6f?q=80&w=1374&auto=format&fit=crop', 'https://images.unsplash.com/photo-1741515045437-97682aa96a2d?q=80&w=1740&auto=format&fit=crop'], description: 'Bơ sáp dẻo quánh, béo ngậy, hạt nhỏ. Đặc sản Lâm Đồng.' },
  { id: 'tc-3', name: 'Xoài cát Hòa Lộc', price: 95000, category: 'Trái cây', origin: 'mien-tay', shopId: 'shop-2', stock: 40, images: ['https://images.unsplash.com/photo-1553279768-865429fa0078?w=600&q=80', 'https://images.unsplash.com/photo-1601493700631-2b16ec4b4716?q=80&w=870&auto=format&fit=crop', 'https://images.unsplash.com/photo-1635716279493-d1e30afc25a0?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1582655299221-2b6bff351df0?q=80&w=1162&auto=format&fit=crop', 'https://images.unsplash.com/photo-1669207334420-66d0e3450283?q=80&w=687&auto=format&fit=crop', 'https://images.unsplash.com/photo-1605027990121-cbae9e0642df?q=80&w=1740&auto=format&fit=crop'], description: 'Xoài cát vỏ vàng, thịt ngọt lịm, thơm lừng.' },
  { id: 'tc-4', name: 'Chuối già hương', price: 25000, category: 'Trái cây', origin: 'mien-tay', shopId: 'shop-2', stock: 500, images: ['https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?w=600&q=80', 'https://images.unsplash.com/photo-1528825871115-3581a5387919?q=80&w=830&auto=format&fit=crop', 'https://images.unsplash.com/photo-1587920523737-556db3c49174?q=80&w=870&auto=format&fit=crop', 'https://images.unsplash.com/photo-1676495706102-ca1be8fdf676?q=80&w=1630&auto=format&fit=crop', 'https://images.unsplash.com/photo-1580750587717-115f648f5402?q=80&w=1740&auto=format&fit=crop'], description: 'Chuối già hương chín cây, giàu năng lượng.' },
  { id: 'tc-5', name: 'Dưa hấu đỏ', price: 15000, category: 'Trái cây', origin: 'mien-tay', shopId: 'shop-2', stock: 50, images: ['https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=600&q=80', 'https://images.unsplash.com/photo-1563114773-84221bd62daa?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1622208489373-1fe93e2c6720?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1630081015918-8a21078e5cee?q=80&w=930&auto=format&fit=crop', 'https://images.unsplash.com/photo-1708982553355-794739c6693e?q=80&w=1825&auto=format&fit=crop'], description: 'Dưa hấu giải nhiệt, ruột đỏ cát, ngọt mát.' },
  { id: 'tc-6', name: 'Cam sành vắt nước', price: 30000, category: 'Trái cây', origin: 'mien-tay', shopId: 'shop-2', stock: 200, images: ['https://images.unsplash.com/photo-1611080626919-7cf5a9dbab5b?w=600&q=80', 'https://images.unsplash.com/photo-1597714026720-8f74c62310ba?q=80&w=1740&auto=format&fit=crop', 'https://images.unsplash.com/photo-1547514701-42782101795e?q=80&w=687&auto=format&fit=crop', 'https://images.unsplash.com/photo-1586439702132-55ce0da661dd?q=80&w=928&auto=format&fit=crop', 'https://images.unsplash.com/photo-1605986723344-f60873d873fa?q=80&w=656&auto=format&fit=crop'], description: 'Cam mọng nước, nhiều vitamin C, tốt cho sức khỏe.' },
  { id: 'tc-7', name: 'Nho đen không hạt', price: 150000, category: 'Trái cây', origin: 'nhap-khau', shopId: 'shop-4', stock: 30, images: ['https://images.unsplash.com/photo-1516876319496-d5a849a2e89b?q=80&w=1160'], description: 'Nho đen giòn ngọt, chùm to, không hạt. Nhập khẩu Mỹ.' },
  { id: 'tc-8', name: 'Táo Envy', price: 110000, category: 'Trái cây', origin: 'nhap-khau', shopId: 'shop-4', stock: 40, images: ['https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?w=600&q=80'], description: 'Táo nhập khẩu, giòn tan, vị ngọt đậm.' },
  { id: 'rc-1', name: 'Xà lách thủy canh', price: 50000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 20, images: ['https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=600&q=80'], description: 'Rau sạch thủy canh, an toàn, tươi mát.' },
  { id: 'rc-2', name: 'Cà chua bi', price: 45000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 50, images: ['https://images.unsplash.com/photo-1561136594-7f68413baa99?w=600&q=80'], description: 'Cà chua nhỏ, giòn ngọt, thích hợp ăn sống.' },
  { id: 'rc-3', name: 'Cà rốt Đà Lạt', price: 25000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 100, images: ['https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=600&q=80'], description: 'Cà rốt củ to, màu cam đẹp, ngọt tự nhiên.' },
  { id: 'rc-4', name: 'Súp lơ xanh', price: 55000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 30, images: ['https://images.unsplash.com/photo-1583663848850-46af132dc08e?w=600&q=80'], description: 'Bông cải xanh giàu chất xơ, tốt cho tiêu hóa.' },
  { id: 'rc-5', name: 'Khoai tây vàng', price: 35000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 150, images: ['https://images.unsplash.com/photo-1518977676601-b53f82aba655?w=600&q=80'], description: 'Khoai tây bở, thích hợp nấu canh, chiên.' },
  { id: 'rc-6', name: 'Ớt chuông đỏ', price: 70000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 40, images: ['https://images.unsplash.com/photo-1592548868664-f8b4e4b1cfb7?q=80&w=691'], description: 'Ớt chuông dày cơm, ngọt, không hăng.' },
  { id: 'rc-7', name: 'Dưa leo Baby', price: 30000, category: 'Rau củ', origin: 'mien-tay', shopId: 'shop-2', stock: 100, images: ['https://images.unsplash.com/photo-1449300079323-02e209d9d3a6?w=600&q=80'], description: 'Dưa leo nhỏ, đặc ruột, giòn tan.' },
  { id: 'rc-8', name: 'Hành tây tím', price: 28000, category: 'Rau củ', origin: 'da-lat', shopId: 'shop-1', stock: 80, images: ['https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=600&q=80'], description: 'Hành tây tím, vị hăng nhẹ, làm salad rất ngon.' },
  { id: 'nc-1', name: 'Gạo ST25', price: 180000, category: 'Ngũ cốc', origin: 'mien-tay', shopId: 'shop-2', stock: 500, images: ['https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600&q=80'], description: 'Gạo ngon nhất thế giới, dẻo thơm.' },
  { id: 'nc-2', name: 'Yến mạch nguyên hạt', price: 90000, category: 'Ngũ cốc', origin: 'nhap-khau', shopId: 'shop-3', stock: 50, images: ['https://images.unsplash.com/photo-1614373532018-92a75430a0da?q=80&w=687'], description: 'Yến mạch nhập khẩu, tốt cho tim mạch.' },
  { id: 'nc-3', name: 'Đậu đen xanh lòng', price: 45000, category: 'Ngũ cốc', origin: 'tay-bac', shopId: 'shop-4', stock: 60, images: ['https://images.unsplash.com/photo-1543831113-c823c4a606b6?q=80&w=870'], description: 'Đậu đen hạt nhỏ, nấu chè bở tơi.' },
  { id: 'nc-4', name: 'Ngô ngọt (Bắp)', price: 15000, category: 'Ngũ cốc', origin: 'mien-tay', shopId: 'shop-2', stock: 100, images: ['https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=600&q=80'], description: 'Bắp ngô ngọt, hạt đều, luộc hay nướng đều ngon.' },
  { id: 'nc-5', name: 'Hạt Quinoa (Diêm mạch)', price: 250000, category: 'Ngũ cốc', origin: 'nhap-khau', shopId: 'shop-3', stock: 20, images: ['https://images.unsplash.com/photo-1722882270052-e132567e9f70?q=80&w=808'], description: 'Siêu thực phẩm, giàu protein, thay thế cơm.' },
  { id: 'nc-6', name: 'Gạo lứt đỏ', price: 50000, category: 'Ngũ cốc', origin: 'tay-bac', shopId: 'shop-4', stock: 100, images: ['https://images.unsplash.com/photo-1675150303909-1bb94e33132f?q=80&w=687'], description: 'Gạo lứt đỏ Điện Biên, dẻo, tốt cho người ăn kiêng.' },
  { id: 'gv-1', name: 'Tỏi cô đơn', price: 1200000, category: 'Gia vị', origin: 'mien-tay', shopId: 'shop-5', stock: 10, images: ['https://images.unsplash.com/photo-1620101680127-557e93569b1a?q=80&w=1325'], description: 'Tỏi một nhánh thơm nồng, dược tính cao.' },
  { id: 'gv-2', name: 'Tiêu đen Phú Quốc', price: 220000, category: 'Gia vị', origin: 'mien-tay', shopId: 'shop-5', stock: 50, images: ['https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=600&q=80'], description: 'Hạt tiêu chắc, cay nồng đặc trưng.' },
  { id: 'gv-3', name: 'Ớt bột Hàn Quốc', price: 150000, category: 'Gia vị', origin: 'nhap-khau', shopId: 'shop-5', stock: 30, images: ['https://images.unsplash.com/photo-1568481276363-88d890339390?q=80&w=870'], description: 'Ớt bột làm kim chi, màu đỏ đẹp, cay vừa.' },
  { id: 'gv-4', name: 'Quế thanh', price: 180000, category: 'Gia vị', origin: 'tay-bac', shopId: 'shop-4', stock: 20, images: ['https://images.unsplash.com/photo-1611256243212-48a03787ea01?q=80&w=1754'], description: 'Quế thanh cạo vỏ, thơm ngọt, dùng nấu phở.' },
  { id: 'gv-5', name: 'Gừng sẻ', price: 40000, category: 'Gia vị', origin: 'tay-bac', shopId: 'shop-4', stock: 40, images: ['https://images.unsplash.com/photo-1630623093145-f606591c2546?q=80&w=930'], description: 'Gừng củ nhỏ, cay nồng, ấm bụng.' },
  { id: 'gv-6', name: 'Nghệ tươi', price: 30000, category: 'Gia vị', origin: 'khac', shopId: 'shop-4', stock: 50, images: ['https://images.unsplash.com/photo-1666818398897-381dd5eb9139?q=80&w=1748'], description: 'Nghệ vàng tươi, dùng kho cá hoặc làm đẹp.' },
  { id: 'kh-1', name: 'Mật ong rừng', price: 350000, category: 'Khác', origin: 'tay-bac', shopId: 'shop-4', stock: 20, images: ['https://images.unsplash.com/photo-1642067958024-1a2d9f836920?q=80&w=1788'], description: 'Mật ong nguyên chất, sánh đặc.' },
  { id: 'kh-2', name: 'Trà xanh Thái Nguyên', price: 200000, category: 'Khác', origin: 'tay-bac', shopId: 'shop-4', stock: 60, images: ['https://images.unsplash.com/photo-1641997829221-a7d363722a1b?q=80&w=687'], description: 'Trà búp sao khô, nước xanh, vị chát hậu ngọt.' },
];

async function ensureLegacyDemo() {
  const legacyHash = await bcrypt.hash(LEGACY_PASSWORD, 10);
  let usersCreated = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  let imagesCreated = 0;

  // Categories (upsert by name)
  const cat: Record<string, number> = {};
  for (const name of LEGACY_CATEGORIES) {
    const c = await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
    cat[name] = c.id;
  }

  // Buyer mặc định: khach@gmail.com
  const buyerExisting = await prisma.user.findUnique({ where: { email: 'khach@gmail.com' } });
  const buyer = await prisma.user.upsert({
    where: { email: 'khach@gmail.com' },
    update: { is_buyer: true, verified_email: true }, // KHÔNG đổi password nếu đã có
    create: {
      id: 'buyer-default',
      email: 'khach@gmail.com',
      password_hash: legacyHash,
      full_name: 'Khách Hàng',
      is_buyer: true,
      verified_email: true,
    },
  });
  if (!buyerExisting) usersCreated++;

  // Sellers (shop1..5) + Profile + Avatar
  const shopUserId: Record<string, string> = {};
  for (const shop of LEGACY_SHOPS) {
    const existing = await prisma.user.findUnique({ where: { email: shop.email } });
    const seller = await prisma.user.upsert({
      where: { email: shop.email },
      update: { is_seller: true, verified_email: true }, // giữ nguyên password & is_buyer hiện có
      create: {
        id: shop.userId,
        email: shop.email,
        password_hash: legacyHash,
        full_name: shop.name,
        is_seller: true,
        verified_email: true,
      },
    });
    if (!existing) usersCreated++;
    shopUserId[shop.name] = seller.id;

    // Profile (upsert by user_id)
    await prisma.profile.upsert({
      where: { user_id: seller.id },
      update: {},
      create: { user_id: seller.id, store_name: shop.name, address: shop.location, description: shop.desc, is_verified: true },
    });

    // Avatar — chỉ tạo nếu chưa có ảnh AVATAR cho user này (tránh nhân đôi)
    const avatarCount = await prisma.attachment.count({ where: { target_id: seller.id, target_type: TargetType.AVATAR } });
    if (avatarCount === 0) {
      await prisma.attachment.create({
        data: { url: shop.avatar, file_type: 'IMAGE', target_id: seller.id, target_type: TargetType.AVATAR },
      });
      imagesCreated++;
    }
  }

  // map shopId ("shop-1") → seller user id, qua tên shop
  const shopIdToUserId: Record<string, string> = {
    'shop-1': shopUserId['Nông Trại Cầu Đất'],
    'shop-2': shopUserId['Vựa Gạo Miền Tây'],
    'shop-3': shopUserId['Hạt Dinh Dưỡng Organic'],
    'shop-4': shopUserId['Thảo Mộc Tây Bắc'],
    'shop-5': shopUserId['Nông Sản Miền Núi'],
  };

  // Products: findFirst theo (seller_id, name) — có thì update, chưa có thì create.
  for (const p of LEGACY_PRODUCTS) {
    const sellerId = shopIdToUserId[p.shopId];
    if (!sellerId) continue;
    const existing = await prisma.product.findFirst({ where: { seller_id: sellerId, name: p.name }, select: { id: true } });

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: { reference_price: p.price, stock_quantity: p.stock, is_active: true, status: ProductStatus.ACTIVE },
      });
      productsUpdated++;
      // KHÔNG đụng ảnh của sản phẩm cũ — giữ nguyên ảnh bạn đã chọn.
    } else {
      const created = await prisma.product.create({
        data: {
          id: `legacy-${p.id}`,
          name: p.name,
          description: p.description,
          reference_price: p.price,
          stock_quantity: p.stock,
          unit: 'kg',
          location: p.origin,
          category_id: cat[p.category],
          seller_id: sellerId,
          is_active: true,
          status: ProductStatus.ACTIVE,
        },
      });
      productsCreated++;
      if (p.images.length > 0) {
        await prisma.attachment.createMany({
          data: p.images.map((url) => ({ url, file_type: 'IMAGE', target_id: created.id, target_type: TargetType.PRODUCT })),
        });
        imagesCreated += p.images.length;
      }
    }
  }

  return { usersCreated, productsCreated, productsUpdated, imagesCreated, buyerId: buyer.id };
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_APPEND !== 'true') {
    console.error('⛔ NODE_ENV=production — đặt ALLOW_SEED_APPEND=true nếu thực sự muốn append trên prod.');
    process.exit(1);
  }

  console.log('➕ ====== AGRI CONNECT — SEED APPEND (namespace seed2, KHÔNG xoá) ======');

  const before = await globalSnapshot();
  const s2Before = await snapshotSeed2();
  console.log('\n📊 TRƯỚC khi append (toàn DB):');
  console.log(`   users=${before.users}  products=${before.products}  orders=${before.orders}  (seed. users=${before.seed1Users})`);
  console.log(`   seed2 hiện có: users=${s2Before.users} products=${s2Before.products} orders=${s2Before.orders + 0}`);

  // Đảm bảo bộ demo CŨ (khach@gmail.com + shop1..5 + sản phẩm + ảnh) luôn tồn tại
  console.log('\n🗂️  Đảm bảo bộ demo cũ (legacy: khach@gmail.com + shop1..5)...');
  const legacy = await ensureLegacyDemo();
  console.log(
    `   legacy: users mới=${legacy.usersCreated}, products tạo mới=${legacy.productsCreated}, products cập nhật=${legacy.productsUpdated}, ảnh mới=${legacy.imagesCreated}`,
  );

  await append();

  const after = await globalSnapshot();
  const s2After = await snapshotSeed2();

  const d = (a: number, b: number) => `${b} (${b - a >= 0 ? '+' : ''}${b - a})`;
  console.log('\n✅ ====== APPEND HOÀN TẤT ======');
  console.log('   seed2 namespace (sau append):');
  console.log(`     👤 users:         ${d(s2Before.users, s2After.users)}`);
  console.log(`     🥬 products:      ${d(s2Before.products, s2After.products)}`);
  console.log(`     🎟️  vouchers:      ${d(s2Before.vouchers, s2After.vouchers)}`);
  console.log(`     🧾 orders:        ${d(s2Before.orders, s2After.orders)}`);
  console.log(`     💳 payments:      ${d(s2Before.payments, s2After.payments)}`);
  console.log(`     ⭐ reviews:       ${d(s2Before.reviews, s2After.reviews)}`);
  console.log(`     💬 conversations: ${d(s2Before.conversations, s2After.conversations)} (messages: ${d(s2Before.messages, s2After.messages)})`);
  console.log(`     📊 behaviors:     ${d(s2Before.behaviors, s2After.behaviors)}`);

  console.log('\n📊 TỔNG toàn DB:');
  console.log(`   👤 users:    ${d(before.users, after.users)}`);
  console.log(`   🥬 products: ${d(before.products, after.products)}`);
  console.log(`   🧾 orders:   ${d(before.orders, after.orders)}`);
  console.log(`   (seed. cũ giữ nguyên: ${after.seed1Users} users)`);

  console.log('\n🔑 Đăng nhập demo MỚI (mật khẩu: ' + SEED_PASSWORD + '):');
  console.log(`   Buyer : ${EMAIL_PREFIX}buyer01${EMAIL_DOMAIN}`);
  console.log(`   Seller: ${EMAIL_PREFIX}seller01${EMAIL_DOMAIN}`);
  console.log(`   Hybrid: ${EMAIL_PREFIX}hybrid01${EMAIL_DOMAIN}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed append thất bại:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
