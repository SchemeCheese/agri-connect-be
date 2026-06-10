# Agri-Connect — QA Test Plan

Kế hoạch kiểm thử thủ công cho 3 nền tảng: **Backend** (`agri-connect-be`, NestJS), **Web** (`agri-ecommerce1`, Next.js), **Mobile** (`agri-app`, Expo React Native). Backend chạy trên **Railway**; Web/Mobile gọi thẳng Railway (`NEXT_PUBLIC_API_URL` / `EXPO_PUBLIC_API_URL`).

---

## 0. Khởi chạy stack (checklist lệnh)

| Thành phần | Lệnh | Ghi chú |
|---|---|---|
| Backend (local dev) | `cd BE/agri-connect-be && pnpm install && pnpm run start:dev` | Port 3001, hot-reload |
| Backend (deploy) | git push repo nối Railway **hoặc** `railway up` | Mọi đổi BE chỉ "sống" sau deploy |
| Prisma generate | `npx prisma generate` | Sau khi sửa `schema.prisma` |
| Prisma migrate | `npx prisma migrate deploy` | **KHÔNG** dùng `migrate reset` |
| Prisma Studio | `npx prisma studio` | Xem DB trực quan (port 5555) |
| Seed (namespace `seed.`) | `pnpm run seed` | delete-recreate seed.* — idempotent |
| Seed-append (`seed2` + legacy) | `pnpm run seed:append` | upsert tại chỗ — KHÔNG xoá |
| Seed admin | `npx ts-node prisma/seed-admin.ts` | 1 admin duy nhất |
| Liệt kê tài khoản demo | `npx ts-node scripts/list-demo-accounts.ts` | read-only, không lộ mật khẩu |
| Web | `cd FE/agri-ecommerce1 && pnpm install && pnpm run dev` | Port 3000 |
| Web typecheck/build | `npx tsc --noEmit` / `pnpm run build` | |
| Mobile | `cd APP/agri-app/AgriApp && npx expo start -c` | Quét QR bằng Expo Go |
| Mobile typecheck | `npx tsc --noEmit` | |

> ⚠️ Dùng **Prisma local của dự án** (`pnpm`/`npx`). KHÔNG dùng `pnpm dlx prisma db seed` (kéo Prisma phiên bản khác, bỏ qua config `prisma.seed`).

### Tài khoản đăng nhập demo
| Loại | Email | Mật khẩu |
|---|---|---|
| Admin (duy nhất) | `admin@agriconnect.test` | `Admin@123456` |
| Buyer seed | `seed.buyer01@agriconnect.test` … | `Seed@123456` |
| Seller seed | `seed.seller01@agriconnect.test` … | `Seed@123456` |
| Hybrid seed | `seed.hybrid01@agriconnect.test` / `seed2.hybrid01…` | `Seed@123456` |
| Legacy demo | `khach@gmail.com`, `shop1..5@gmail.com` | `123456` |

---

## 1. Auth flow

| # | Ca kiểm thử | Bước | Kết quả mong đợi |
|---|---|---|---|
| A1 | Đăng ký Email + OTP | Đăng ký buyer/seller → nhập OTP từ email | Tạo tài khoản; chưa verify thì **không** đăng nhập được |
| A2 | OTP hard-gate | Đăng nhập tài khoản chưa verify | **403** "OTP verification required" |
| A3 | Đăng nhập buyer-only | Login | Vào trang chủ `/` (buyer) |
| A4 | Đăng nhập seller-only | Login | Vào `/dashboard` (kênh người bán) |
| A5 | Đăng nhập dual (buyer+seller) | Login | Vào trang **mua hàng**, có nút "Chuyển sang Bán hàng" (Header) |
| A6 | Đăng nhập admin | Login `admin@agriconnect.test` | Vào thẳng `/admin/dashboard` |
| A7 | Đổi vai trò | Bấm "Chuyển sang Bán hàng/Mua hàng" | Re-issue JWT `activeRole` mới, đổi workspace |
| A8 | Đăng xuất | Web: Header dropdown / SellerHeader / Admin header (góc phải) | Xoá session, về `/login` |
| A9 | Google (Web/Android/dev build) | Đăng nhập Google | OK |
| A10 | Google (iOS Expo Go) | Bấm nút Google | Hiện thông báo "dùng Email/OTP", **không** mở OAuth lỗi 400 |
| A11 | Mật khẩu sai | Login sai | **401** "Email hoặc mật khẩu không đúng" |

---

## 2. Buyer — Order / Checkout flow

| # | Ca kiểm thử | Bước | Kết quả mong đợi |
|---|---|---|---|
| B1 | Thêm giỏ + checkout COD | Add → checkout COD | Tạo Order PENDING; **tồn kho trừ ngay** (atomic) |
| B2 | Checkout MoMo | Chọn MoMo → trang MoMo | Order PENDING + Payment UNPAID; IPN PAID → Payment PAID |
| B3 | Hết hàng | Checkout khi `stock < qty` | **400** "Product out of stock", không tạo đơn |
| B4 | Áp voucher | Nhập voucher hợp lệ | Giảm giá đúng; `used_count` tăng |
| B5 | Hủy đơn (buyer) | PENDING → Hủy | Order CANCELLED; **tồn kho hoàn lại đúng 1 lần** |
| B6 | Xác nhận nhận hàng | SHIPPING → "Đã nhận" | Order COMPLETED |
| B7 | Đánh giá | COMPLETED → đánh giá | Tạo review |
| B8 | Đánh giá trùng | Đánh giá lần 2 cùng đơn | **400** "Bạn đã đánh giá đơn hàng này rồi" (DB `@@unique`) + UI toast |
| B9 | Mở khiếu nại | Đơn SHIPPING/COMPLETED → "Gửi khiếu nại" + ảnh | Tạo Dispute (OPEN), order ISSUE_REPORTED, **KHÔNG** tự hoàn tiền |
| B10 | Tự huỷ MoMo quá hạn | Để đơn MoMo UNPAID > timeout | Cron auto-CANCELLED + **hoàn kho** |

---

## 3. Seller — Management

| # | Ca kiểm thử | Bước | Kết quả mong đợi |
|---|---|---|---|
| S1 | Tạo sản phẩm | Nhập tên/giá/tồn kho + ảnh | Sản phẩm ACTIVE; tồn kho lưu đúng |
| S2 | Hết kho tự ẩn | Checkout làm tồn kho về 0 | Sản phẩm → OUT_OF_STOCK, `is_active=false` |
| S3 | Xác nhận / giao đơn | PENDING→CONFIRMED→SHIPPING | Trạng thái cập nhật + emit realtime |
| S4 | Hủy đơn (seller) | PENDING/CONFIRMED → Hủy | CANCELLED + **hoàn kho 1 lần** + email buyer |
| S5 | Gửi bằng chứng khiếu nại | Đơn tranh chấp → "Gửi bằng chứng giải trình" + ảnh | Dispute → UNDER_ADMIN_REVIEW; seller **không** thấy nút quyết định refund |
| S6 | "Xác nhận thất lạc" | Bấm nút | **Escalate Admin** (không tự refund, không tự đóng FAILED) |
| S7 | Voucher shop | Tạo voucher PERCENT/FIXED | Áp đúng theo `min_order_value`/`max_discount` |
| S8 | Doanh thu | Xem dashboard | Tổng đơn + doanh thu (đơn COMPLETED) đúng |

---

## 4. Admin — Dispute Adjudication & Governance

| # | Ca kiểm thử | Bước | Kết quả mong đợi |
|---|---|---|---|
| AD1 | Truy cập admin | Non-admin gọi `/admin/*` | **403 Forbidden** (RolesGuard) |
| AD2 | Dashboard | Xem `/admin/dashboard` | Stat cards + biểu đồ đơn theo trạng thái |
| AD3 | Khóa/mở user | Toggle `is_active` | User bị khóa không đăng nhập; **không khóa được admin** |
| AD4 | Duyệt shop | `is_verified=true` | Shop hiển thị dấu xác minh |
| AD5 | Kiểm duyệt SP | Ẩn/hiện sản phẩm | `status` ACTIVE↔INACTIVE |
| AD6 | Xem chi tiết user/SP 360° | Click dòng | Sheet hiện summary (count/aggregate), **không** lộ password |
| AD7 | Phán quyết SELLER_FAULT | `/admin/disputes/:id/resolve` outcome=SELLER_FAULT, action=REFUND_BUYER (MoMo PAID) | Order REFUND_PENDING→REFUNDED; gọi `refundMomoTransaction`; `$transaction` |
| AD8 | Phán quyết COD buyer-thắng | action=REFUND_BUYER (COD) | Order RETURNED + **hoàn kho** |
| AD9 | Phán quyết BUYER_FAULT | action=RELEASE_PAYMENT_TO_SELLER | Order COMPLETED |
| AD10 | Phán quyết lại | Resolve dispute đã RESOLVED | **400** "đã được xử lý" (idempotent, không refund 2 lần) |
| AD11 | Trust status | `/admin/shops/:id/trust-status` | Cập nhật VERIFIED/NORMAL/WARNING/RESTRICTED |

---

## 5. Chat / Negotiation

| # | Ca kiểm thử | Bước | Kết quả mong đợi |
|---|---|---|---|
| C1 | Nhắn tin realtime | 2 phiên buyer↔seller | Socket.IO đẩy tin tức thì, không trùng (dedupe theo id) |
| C2 | Cuộn tin cũ | Cuộn lên / "Tải tin nhắn cũ hơn" | Nạp tin cũ, **giữ nguyên vị trí**, không bị kéo xuống đáy |
| C3 | Auto-scroll | Nhận tin khi đang đọc tin cũ | **Không** kéo xuống; chỉ cuộn khi đang gần đáy hoặc tự gửi |
| C4 | Gửi ảnh | Upload ảnh chat | Hiện ảnh; ảnh hỏng → placeholder, không vỡ layout |
| C5 | Seller gửi báo giá | NEGOTIATION_QUOTE | Card báo giá hiện cho buyer |
| C6 | Buyer chấp nhận quote | Accept | Tạo Order từ quote (`negotiation_quote_id`) |

---

## 6. Đồng bộ Web ↔ Mobile (bắt buộc khớp)

| Hạng mục | Web | Mobile | Yêu cầu khớp |
|---|---|---|---|
| Label `ISSUE_REPORTED` | "Đang tranh chấp" | "Đang tranh chấp" | ✅ Cùng chuỗi |
| Mở khiếu nại | Modal `DisputeFormModal` + upload | Màn `app/dispute/[orderId]` + `expo-image-picker` | Cùng endpoint `POST /disputes/order/:id`, cùng DTO `{reason, images}` |
| Seller gửi bằng chứng | Nút trên seller orders | (qua web) | `PATCH /disputes/:id/respond` |
| Negotiation quote state | PENDING/ACCEPTED/REJECTED, hết hạn | Tương ứng | Buyer không accept quote hết hạn; seller không accept quote của chính mình |
| Điều hướng theo vai trò | admin→/admin, seller→/dashboard, buyer→/ | tab Home/Tổng quan/Quản lý bán; admin dùng web | Dual → workspace mua + nút chuyển |
| Search sản phẩm | `GET /products/search` phân trang | Cùng endpoint | insensitive `contains`, ẩn sản phẩm inactive |
| MoMo | Redirect web kết quả | Mở payUrl ra ngoài; **Expo Go không deeplink-back** (đã document) | Không vỡ luồng web |

**Acceptance tổng:** TS compile sạch cả 3 repo; không lộ dữ liệu nhạy cảm; admin là trọng tài cuối; restock đúng 1 lần; review trùng bị chặn (400).
