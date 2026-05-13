import { Injectable } from '@nestjs/common';
import { ToolResult } from './types';

export interface GetPlatformPolicyInput {
  topic:
    | 'order_process'
    | 'payment_methods'
    | 'negotiation_process'
    | 'shipping'
    | 'return_policy'
    | 'seller_registration'
    | 'buyer_guide';
}

const PLATFORM_POLICIES: Record<GetPlatformPolicyInput['topic'], string> = {
  order_process: `
**Quy trình đặt hàng trên Agri-Connect:**
1. Tìm kiếm sản phẩm và chọn sản phẩm muốn mua
2. Nếu sản phẩm hỗ trợ thương lượng → click "Thương lượng giá" để chat với seller
3. Thống nhất giá → Seller tạo báo giá (NEGOTIATION_QUOTE) → Buyer xác nhận
4. Đặt hàng: nhập địa chỉ giao hàng, chọn phương thức thanh toán
5. Seller xác nhận đơn (trạng thái: CONFIRMED)
6. Seller giao hàng (trạng thái: SHIPPING)
7. Buyer xác nhận đã nhận hàng (trạng thái: COMPLETED)

**Lưu ý:** Buyer có 3 ngày từ khi hàng được gửi để báo sự cố nếu chưa nhận được hàng.
  `.trim(),

  payment_methods: `
**Phương thức thanh toán Agri-Connect:**

1. **COD (Tiền mặt khi nhận hàng):**
   - Thanh toán khi nhận hàng, không cần thanh toán trước
   - Phù hợp cho đơn hàng nội địa, tin tưởng lẫn nhau

2. **QR Code ngân hàng:**
   - Chuyển khoản qua QR code
   - Cần upload ảnh chứng minh thanh toán
   - Xử lý trong 1-2 giờ làm việc

3. **MoMo:**
   - Thanh toán qua ví điện tử MoMo
   - Nhanh chóng, xác nhận tức thì

4. **ZaloPay:**
   - Thanh toán qua ví ZaloPay
   - Hỗ trợ liên kết tài khoản ngân hàng

**Lưu ý:** Với đơn có thương lượng, giá thanh toán là giá đã thống nhất (negotiated_price), không phải reference_price.
  `.trim(),

  negotiation_process: `
**Quy trình thương lượng giá trên Agri-Connect:**

1. **Điều kiện thương lượng:**
   - Sản phẩm phải bật tính năng thương lượng (seller cấu hình min_negotiation_qty)
   - Số lượng mua phải ≥ min_negotiation_qty của sản phẩm

2. **Bắt đầu thương lượng:**
   - Buyer click "Chat ngay" trên trang sản phẩm
   - Nhập số lượng và giá đề xuất
   - Tin nhắn hệ thống tự động được tạo

3. **Seller phản hồi:**
   - Seller tạo báo giá chính thức (Negotiation Quote Card)
   - Bao gồm: giá, số lượng, đơn vị

4. **Buyer phản hồi:**
   - **ACCEPTED**: Tạo đơn hàng với giá đã thỏa thuận
   - **REJECTED**: Quay về thương lượng tiếp

5. **Lưu ý quan trọng:**
   - Chỉ có thể có 1 quote PENDING tại 1 thời điểm
   - Buyer không thể đặt hàng khi có quote PENDING
   - Sau khi accepted, giá được ghi nhận là negotiated_price trong đơn hàng
  `.trim(),

  shipping: `
**Chính sách vận chuyển Agri-Connect:**

- **Đơn vị vận chuyển:** Seller tự sắp xếp (không có đơn vị vận chuyển tích hợp trong phiên bản hiện tại)
- **Phí vận chuyển:** Thỏa thuận trực tiếp giữa buyer và seller trong quá trình đặt hàng
- **Địa chỉ giao hàng:** Buyer nhập địa chỉ khi đặt hàng
- **Tracking:** Seller cập nhật mã vận đơn sau khi giao hàng

**Báo sự cố:**
- Sau khi đơn chuyển sang SHIPPING, buyer có 3 ngày để báo chưa nhận hàng
- Trạng thái: ISSUE_REPORTED → Admin xử lý
- Sau 3 ngày không báo, đơn tự động hoàn thành (COMPLETED)

**Khuyến nghị:**
- Nên thương lượng bao gồm phí vận chuyển trong giá hoặc thống nhất riêng trước khi đặt
- Xác nhận địa chỉ và số điện thoại liên hệ chính xác
  `.trim(),

  return_policy: `
**Chính sách đổi trả Agri-Connect:**

**Điều kiện:**
- Hàng nhận được khác với mô tả (sai loại, sai khối lượng)
- Hàng bị hỏng, hư hỏng khi nhận
- Phải báo sự cố trong vòng 3 ngày kể từ khi đơn chuyển SHIPPING

**Quy trình:**
1. Buyer báo sự cố: đơn hàng → "Báo sự cố" → mô tả vấn đề
2. Đơn chuyển sang ISSUE_REPORTED
3. Admin/Support xem xét và xử lý
4. Hoàn tiền (nếu được chấp nhận): chuyển khoản trong 3-5 ngày làm việc

**Lưu ý:**
- Nông sản là hàng tươi sống, cần kiểm tra ngay khi nhận
- Chụp ảnh bằng chứng nếu hàng không đúng
- Không hỗ trợ trả hàng với lý do thay đổi ý định
  `.trim(),

  seller_registration: `
**Hướng dẫn đăng ký Seller trên Agri-Connect:**

1. **Tạo tài khoản:**
   - Đăng ký tài khoản với email hợp lệ
   - Xác thực email (OTP gửi qua email)

2. **Thiết lập shop:**
   - Cập nhật Profile: tên shop, địa chỉ, mô tả
   - Upload ảnh bìa và banner (tùy chọn)

3. **Đăng sản phẩm:**
   - Tên, mô tả, danh mục
   - Giá tham chiếu (reference_price) — giá hiển thị ban đầu
   - Số lượng và đơn vị (kg, thùng, bó, ...)
   - Khu vực giao hàng, chứng nhận (VietGAP, Organic, ...)
   - Cấu hình thương lượng: bật/tắt, số lượng tối thiểu

4. **Quản lý đơn hàng:**
   - Xác nhận đơn (PENDING → CONFIRMED)
   - Cập nhật trạng thái giao hàng (CONFIRMED → SHIPPING + tracking code)

5. **Khuyến nghị:**
   - Phản hồi tin nhắn nhanh để tăng điểm uy tín
   - Duy trì tỷ lệ hoàn thành đơn cao
  `.trim(),

  buyer_guide: `
**Hướng dẫn mua hàng trên Agri-Connect:**

1. **Tìm kiếm sản phẩm:**
   - Dùng thanh tìm kiếm hoặc duyệt theo danh mục
   - Lọc theo giá, vùng, chứng nhận

2. **Xem thông tin sản phẩm:**
   - Giá tham chiếu (có thể thương lượng nếu sản phẩm hỗ trợ)
   - Số lượng còn hàng
   - Vùng xuất xứ, chứng nhận chất lượng

3. **Mua ngay hoặc thương lượng:**
   - Mua ngay: chọn số lượng → đặt hàng với reference_price
   - Thương lượng: click "Chat ngay" → đề xuất giá và số lượng

4. **Thanh toán và nhận hàng:**
   - Chọn phương thức thanh toán phù hợp
   - Theo dõi đơn hàng qua trạng thái
   - Xác nhận nhận hàng sau khi kiểm tra

5. **Đánh giá:**
   - Sau khi đơn COMPLETED, để lại đánh giá cho seller
   - Giúp cộng đồng mua sắm an toàn hơn
  `.trim(),
};

@Injectable()
export class PlatformFaqTool {
  getPlatformPolicy(input: GetPlatformPolicyInput): ToolResult<{ topic: string; content: string }> {
    const content = PLATFORM_POLICIES[input.topic];
    if (!content) {
      return { success: false, error: `Chủ đề "${input.topic}" không tồn tại` };
    }
    return { success: true, data: { topic: input.topic, content } };
  }
}
