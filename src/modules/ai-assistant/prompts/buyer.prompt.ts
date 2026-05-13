/**
 * Buyer-specific FAQ responses — served from static cache, no LLM call needed.
 * Key: normalized keyword. Value: pre-written answer.
 * ~40% of FAQ requests hit this before reaching the LLM.
 */
export const BUYER_FAQ_CACHE: Record<string, string> = {
  'đặt hàng':
    '**Quy trình đặt hàng trên Agri-Connect:**\n1. Tìm sản phẩm → thêm vào giỏ hàng\n2. Chọn phương thức thanh toán (COD, QR, MoMo, ZaloPay)\n3. Nhập địa chỉ giao hàng\n4. Xác nhận đơn hàng → chờ seller xác nhận\n\nBạn có muốn tôi giúp tìm sản phẩm cụ thể không?',

  'thương lượng':
    '**Cách thương lượng giá trên Agri-Connect:**\n1. Mở trang sản phẩm có biểu tượng 🤝 (cho phép thương lượng)\n2. Nhấn "Thương lượng giá" → nhập số lượng và giá đề xuất\n3. Seller sẽ phản hồi báo giá trong cuộc trò chuyện\n4. Chấp nhận báo giá → hệ thống tự tạo đơn hàng\n\n💡 Mẹo: thương lượng số lượng lớn thường được giá tốt hơn.',

  'thanh toán':
    '**Phương thức thanh toán:**\n- **COD**: thanh toán khi nhận hàng\n- **QR Code**: chuyển khoản ngân hàng qua QR\n- **MoMo / ZaloPay**: ví điện tử\n\nSau khi đặt hàng, bạn có 24 giờ để xác nhận thanh toán online.',

  'hủy đơn':
    '**Hủy đơn hàng:**\nBạn có thể hủy đơn khi trạng thái còn là **PENDING** (chờ seller xác nhận). Sau khi seller xác nhận (CONFIRMED), cần liên hệ trực tiếp với seller để thỏa thuận.\n\nVào "Đơn hàng của tôi" → chọn đơn → nhấn "Hủy đơn".',

  'giao hàng':
    '**Thông tin giao hàng:**\nGiao hàng do seller và buyer thỏa thuận trực tiếp. Seller cung cấp mã tracking sau khi giao hàng. Nếu sau 7 ngày chưa nhận được hàng, bạn có thể báo sự cố.',

  'đánh giá':
    '**Đánh giá sản phẩm:**\nSau khi đơn hàng hoàn thành (COMPLETED), bạn có thể đánh giá sản phẩm và seller. Đánh giá giúp cộng đồng và ảnh hưởng đến điểm uy tín của seller.',
};
