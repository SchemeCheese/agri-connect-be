# Agri-Connect — Swagger API Testing Guide (Bảo vệ tốt nghiệp)

Hướng dẫn test thủ công backend qua **Swagger UI** để demo: ổn định, RBAC (BUYER/SELLER/ADMIN), và các luồng nghiệp vụ lõi.

- **Swagger UI (local):** `http://localhost:3001/api-docs`
- **Swagger UI (Railway):** `https://agri-connect-be-production.up.railway.app/api-docs` *(prod cần `ENABLE_SWAGGER=true`)*
- **OpenAPI JSON:** `…/api-docs-json`

### Tài khoản demo (mật khẩu xem cột)
| Vai trò | Email | Mật khẩu |
|---|---|---|
| ADMIN | `admin@agriconnect.test` | `Admin@123456` |
| SELLER | `seed.seller01@agriconnect.test` | `Seed@123456` |
| BUYER | `seed.buyer01@agriconnect.test` | `Seed@123456` |
| Hybrid (mua+bán) | `seed.hybrid01@agriconnect.test` | `Seed@123456` |
| Legacy | `khach@gmail.com` / `shop2@gmail.com` | `123456` |

### Bảng mã trạng thái HTTP dùng trong guide
| Code | Ý nghĩa |
|---|---|
| 200 OK | Đọc/cập nhật thành công |
| 201 Created | Tạo mới thành công (POST) |
| 400 Bad Request | Sai dữ liệu / vi phạm ràng buộc (vd review trùng, hết hàng) |
| 401 Unauthorized | Thiếu/sai token, sai mật khẩu |
| 403 Forbidden | Sai vai trò (RBAC) / không sở hữu tài nguyên (IDOR) |
| 404 Not Found | Không tồn tại |
| 429 Too Many Requests | Vượt rate-limit |

---

## 1. Initial Setup & Authentication

### 1.1 Lấy `access_token`
1. Mở `/api-docs` → nhóm **Auth** → `POST /auth/login` → **Try it out**.
2. Dán body theo vai trò cần test, bấm **Execute**:
```json
{ "email": "seed.buyer01@agriconnect.test", "password": "Seed@123456" }
```
3. Trong Response (200/201), copy giá trị `access_token`.
   - Nếu là tài khoản dual-role → response có `requiresRoleSelection: true` + `tempToken` (không có access_token). Dùng tài khoản đơn-vai-trò ở trên cho gọn khi demo.

### 1.2 Authorize (bơm token vào Swagger)
1. Bấm nút **Authorize** 🔒 (góc trên-phải).
2. Ở dòng `access-token (http, Bearer)` → dán **chỉ token** (KHÔNG kèm chữ "Bearer") → **Authorize** → **Close**.
3. Mọi request protected (có ổ khóa 🔒) sẽ tự gắn header `Authorization: Bearer <token>`.
4. Đổi vai trò: bấm **Authorize** → **Logout** → login tài khoản khác → dán token mới.

> 💡 `persistAuthorization` đang bật → reload trang vẫn giữ token.

---

## 2. BUYER Flow (dùng token BUYER)

### 2.1 Browse & Search — `GET /products/search`
| Method | Endpoint | Auth |
|---|---|---|
| GET | `/products/search?q=ca&page=1&limit=12` | Public |

- Test **insensitive**: `q=ca`, `q=CA`, `q=Cà` → đều khớp "Cà chua bi Đà Lạt", "Cà rốt Đà Lạt"…
- Test **pagination**: đổi `page=2` → trả trang kế.
- **Expected 200 OK**, shape:
```json
{ "items": [ { "id": "...", "name": "Cà rốt Đà Lạt", "price": 25000, "unit": "kg", "seller_id": "...", "images": ["https://..."] } ],
  "total": 8, "page": 1, "totalPages": 1 }
```
> 📌 Ghi lại 1 `id` (product) và `seller_id` để dùng cho Checkout (2.2).

### 2.2 Checkout — `POST /orders/checkout` 🔒 (BUYER)
> Payload dạng **nhóm theo shop** (`seller_orders`). `payment_method`: `COD` | `MOMO` | `QR_CODE` | `ZALOPAY`. `price` = giá tại thời điểm mua.
```json
{
  "shipping_address": "12 Nguyễn Huệ, Quận 1, TP.HCM",
  "payment_method": "COD",
  "note": "Giao giờ hành chính",
  "seller_orders": [
    {
      "seller_id": "<SELLER_ID lấy từ 2.1>",
      "items": [
        { "product_id": "<PRODUCT_ID lấy từ 2.1>", "quantity": 2, "price": 25000 }
      ]
    }
  ]
}
```
- **Expected 201 Created** — trả Order (PENDING). Tồn kho sản phẩm **bị trừ ngay** (atomic).
- Test hết hàng: đặt `quantity` > tồn kho → **400 Bad Request** `"Product out of stock"`.
- MoMo: đổi `payment_method: "MOMO"` → 201; sau đó tạo link ở `POST /payments/momo/create`.
> 📌 Ghi lại `order.id` để dùng cho 2.3–2.6.

### 2.3 View My Orders — `GET /orders/my-orders` 🔒 (BUYER)
- **Expected 200 OK** — mảng đơn của buyer hiện tại. Tìm đơn vừa tạo (status `PENDING`).

### 2.4 Cancel Order — `PATCH /orders/:id/cancel-by-buyer` 🔒 (BUYER)
| Method | Endpoint | Body |
|---|---|---|
| PATCH | `/orders/<ORDER_ID>/cancel-by-buyer` | *(không cần body)* |

- **Expected 200 OK** — order → `CANCELLED`, **tồn kho được hoàn lại** (kiểm bằng `GET /products/search` thấy stock tăng lại).
- Test **idempotency**: gọi lại lần 2 → **400 Bad Request** (chỉ hủy khi `PENDING`) → chứng minh **không hoàn kho 2 lần**.

### 2.5 Report Issue / Dispute — `POST /disputes/order/:orderId` 🔒 (BUYER)
> Chỉ áp dụng cho đơn đang `SHIPPING` / `ISSUE_REPORTED` / `COMPLETED`. (Để demo: nhờ SELLER đưa 1 đơn lên SHIPPING trước — xem 3.2.)
```json
{
  "reason": "Hàng giao thiếu 1kg và bị dập, không đúng mô tả.",
  "images": [
    "https://images.unsplash.com/photo-1583663848850-46af132dc08e?w=600",
    "https://images.unsplash.com/photo-1561136594-7f68413baa99?w=600"
  ],
  "video": null
}
```
- **Expected 201 Created** — tạo Dispute (`PENDING_SELLER_RESPONSE`), đơn → `ISSUE_REPORTED`. **Hệ thống KHÔNG tự hoàn tiền** (chờ Admin phân xử).
- Test IDOR: mở dispute cho `orderId` của buyer khác → **403 Forbidden**.

### 2.6 Create Review — `POST /reviews` 🔒 (BUYER)
> Chỉ đánh giá được đơn `COMPLETED` của chính mình.
```json
{
  "order_id": "<ORDER_ID đã COMPLETED>",
  "product_id": "<PRODUCT_ID>",
  "rating": 5,
  "comment": "Hàng tươi, đóng gói kỹ, giao nhanh!",
  "image_urls": ["https://images.unsplash.com/photo-1542838132-92c53300491e?w=600"]
}
```
- Lần 1 → **201 Created**.
- **Lần 2 (cùng order_id) → 400 Bad Request** `"Bạn đã đánh giá đơn hàng này rồi."` — chứng minh ràng buộc DB `@@unique([order_id, reviewer_id])`.
- Đánh giá đơn chưa COMPLETED → **400 Bad Request**.

---

## 3. SELLER Flow (dùng token SELLER — login `seed.seller01@…`)

### 3.1 View Seller Orders — `GET /orders/seller-orders` 🔒 (SELLER)
- **Expected 200 OK** — đơn shop nhận được. Ghi lại 1 `order.id` đang `PENDING`.

### 3.2 Update Order Status (PENDING → CONFIRMED → SHIPPING)
| Bước | Method | Endpoint | Body | Expected |
|---|---|---|---|---|
| Xác nhận | PATCH | `/orders/<ORDER_ID>/confirm` | *(không)* | 200 OK — `CONFIRMED` |
| Giao hàng | PATCH | `/orders/<ORDER_ID>/ship` | *(không)* | 200 OK — `SHIPPING` |

> Sau bước SHIPPING, buyer có thể mở dispute (2.5).

### 3.3 Respond to Dispute — `PATCH /disputes/:id/respond` 🔒 (SELLER)
> Lấy `dispute.id` từ `GET /disputes/mine` (token SELLER).
```json
{
  "explanation": "Shop đã đóng gói đủ 2kg và niêm phong. Gửi kèm ảnh cân + video đóng hàng.",
  "images": [
    "https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600"
  ],
  "video": null
}
```
- **Expected 200 OK** — dispute → `UNDER_ADMIN_REVIEW`. Seller **KHÔNG** thấy nút quyết định refund (chỉ Admin).
- Test IDOR: respond dispute của shop khác → **403 Forbidden**.

### 3.4 Manage Products
> Route quản lý sản phẩm của seller là **`/seller/products/...`** (không phải `/products/:id`).

**Cập nhật sản phẩm — `PATCH /seller/products/:id` 🔒 (SELLER)**
```json
{ "reference_price": 28000, "stock_quantity": 150 }
```
- **Expected 200 OK** — cập nhật giá/tồn kho.

**Nạp thêm kho — `PATCH /seller/products/:id/restock` 🔒 (SELLER)** — body chọn **một trong hai**:
```json
{ "add": 50 }
```
hoặc đặt tồn kho tuyệt đối:
```json
{ "stock": 200 }
```
- **Expected 200 OK** — kho tăng; nếu đang `OUT_OF_STOCK` mà kho > 0 → tự `ACTIVE` lại.
- Gửi body rỗng `{}` → **400 Bad Request** `"Cần truyền stock hoặc add"`.

---

## 4. ADMIN Flow (dùng token ADMIN — login `admin@agriconnect.test`)

### 4.1 View Dashboard — `GET /admin/analytics/dashboard` 🔒 (ADMIN)
- **Expected 200 OK** — metrics:
```json
{ "users": { "total": 88, "buyers": 70, "sellers": 25, "admins": 1 },
  "products": { "active": 270, "total": 275 },
  "orders": { "total": 184, "completed": 60, "byStatus": [ { "status": "COMPLETED", "count": 60 } ] },
  "revenue": 12345000, "pendingShops": 0, "openDisputes": 3 }
```

### 4.2 Resolve Dispute (QUAN TRỌNG) — `POST /admin/disputes/:id/resolve` 🔒 (ADMIN)
> `outcome` ∈ `PENDING|SELLER_FAULT|BUYER_FAULT|SHIPPING_FAULT|INSUFFICIENT_EVIDENCE`
> `action_taken` ∈ `NONE|REFUND_BUYER|RELEASE_PAYMENT_TO_SELLER|PARTIAL_REFUND|CLOSE_WITHOUT_ACTION`
```json
{
  "outcome": "SELLER_FAULT",
  "action_taken": "REFUND_BUYER",
  "admin_notes": "Bằng chứng buyer cho thấy hàng dập; seller không phản bác hợp lý. Hoàn tiền."
}
```
- **Expected 201 Created** — dispute → `RESOLVED`; nếu đơn MoMo đã PAID → `REFUND_PENDING`→`REFUNDED` (gọi refund thật); nếu COD → `RETURNED` + **hoàn kho**. Ghi 1 dòng **AuditLog** (`RESOLVE_DISPUTE`).
- Buyer-thắng thay thế: `action_taken: "RELEASE_PAYMENT_TO_SELLER"` + `outcome: "BUYER_FAULT"` → đơn `COMPLETED`.
- Resolve lại dispute đã xử lý → **400 Bad Request** `"Khiếu nại đã được xử lý trước đó."` (không refund 2 lần).

### 4.3 Manage Shop Trust — `PATCH /admin/shops/:userId/trust-status` 🔒 (ADMIN)
> `:userId` = id của user-seller (lấy từ `GET /admin/users?search=seller`). `trust_status` ∈ `VERIFIED|NORMAL|WARNING|RESTRICTED`.
```json
{ "trust_status": "WARNING" }
```
- **Expected 200 OK** — cập nhật mức tin cậy shop. Đổi sang `RESTRICTED` để demo phạt shop vi phạm.

### 4.4 Security Check — IDOR / Role Spoofing (BẮT BUỘC demo)
1. Bấm **Authorize** → **Logout** → login **BUYER** (`seed.buyer01@…`) → Authorize token BUYER.
2. Gọi các endpoint Admin với token BUYER:
   | Method | Endpoint | Expected |
   |---|---|---|
   | GET | `/admin/analytics/dashboard` | **403 Forbidden** |
   | GET | `/admin/users` | **403 Forbidden** |
   | POST | `/admin/disputes/<id>/resolve` | **403 Forbidden** |
3. Thử **không Authorize** (Logout hẳn) gọi `/orders/my-orders` → **401 Unauthorized**.
4. **Kết luận demo:** RolesGuard chỉ tin `activeRole` ký trong JWT (không tin flag client) → BUYER không thể spoof quyền ADMIN/SELLER.

---

## Phụ lục — Trình tự demo gợi ý (5 phút)
1. **Auth**: login ADMIN → mở `/admin/analytics/dashboard` (200) → cho thấy hệ thống sống.
2. **BUYER**: login buyer → search (insensitive + paginate) → checkout COD (201) → my-orders (200).
3. **SELLER**: login seller → seller-orders → confirm → ship (200×2).
4. **BUYER**: mở dispute kèm ảnh (201) → đơn ISSUE_REPORTED.
5. **SELLER**: respond dispute kèm bằng chứng (200) → UNDER_ADMIN_REVIEW.
6. **ADMIN**: resolve SELLER_FAULT + REFUND_BUYER (201) → refund + AuditLog.
7. **Security**: BUYER token gọi `/admin/*` → **403** (chốt RBAC).
8. **Review**: buyer review đơn COMPLETED (201) → review lại → **400** (chống trùng).

> ⚠️ Lưu ý demo: Backend phải đã **deploy bản mới lên Railway** (hoặc chạy `pnpm run start:dev` local) để có đủ endpoint `/products/search`, `/disputes/*`, `/admin/disputes/:id/resolve`, rate-limit & audit log.
