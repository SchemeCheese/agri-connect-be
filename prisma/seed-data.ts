/**
 * ============================================================================
 *  Dữ liệu demo dùng chung cho seed.ts và seed-append.ts
 * ============================================================================
 *  - Tên người mua / chủ shop: tên Việt thật.
 *  - Tên cửa hàng: nông trại / vựa / HTX thật.
 *  - PRODUCT_CATALOG: sản phẩm nông sản VN theo danh mục, MỖI sản phẩm gắn 1 ảnh
 *    Unsplash KHỚP với sản phẩm (HTTPS). Nhóm Trái cây/Rau củ/Ngũ cốc dùng URL đã
 *    được kiểm chứng load tốt trong repo; nhóm Thịt-Trứng-Sữa & Vật tư dùng ảnh
 *    cấp danh mục (gần đúng) — có thể thay dễ dàng vì seed refresh ảnh deterministic.
 *  - KHÔNG còn tiền tố [SEED]/[SEED2] trong tên sản phẩm hiển thị.
 * ============================================================================
 */

export const CATEGORY_NAMES = ['Rau củ', 'Trái cây', 'Gạo & ngũ cốc', 'Thịt/Trứng/Sữa', 'Vật tư nông nghiệp'] as const;

// Tên người (buyer + chủ shop). full_name của user luôn là tên người.
export const PERSON_NAMES = [
  'Nguyễn Văn An', 'Trần Minh Khôi', 'Lê Thị Mai', 'Phạm Quốc Dũng', 'Hoàng Kim Chi',
  'Vũ Thị Hồng', 'Đặng Văn Hải', 'Bùi Thị Lan', 'Đỗ Minh Tuấn', 'Ngô Thị Hương',
  'Dương Văn Thành', 'Lý Thị Ngọc', 'Phan Văn Bình', 'Trịnh Thị Thu', 'Hồ Văn Phúc',
  'Mai Thị Yến', 'Cao Văn Lộc', 'Đinh Thị Hoa', 'Tạ Văn Khánh', 'Lương Thị Diệu',
];

// Tên cửa hàng / nông trại (profile.store_name của seller & hybrid).
export const SHOP_NAMES = [
  'Nông trại Cầu Đất', 'Vựa Gạo Miền Tây', 'Hợp tác xã Rau Sạch Đà Lạt', 'Trang trại Trứng Gà Ba Vì',
  'Nhà vườn Xoài Cát Hòa Lộc', 'Vật tư Nông nghiệp An Phú', 'Nông sản Sạch Tây Nguyên',
  'Vườn Trái Cây Nhiệt Đới', 'Trại Cá Đồng Tháp', 'Hợp tác xã Ngũ Cốc Vàng',
  'Nông trại Hữu Cơ Xanh', 'Vựa Nông Sản Chợ Lớn',
];

export type SeedProduct = { name: string; price: number; unit: string; image: string };

const U = (id: string) => `https://images.unsplash.com/photo-${id}?w=600&q=80&auto=format&fit=crop`;

export const PRODUCT_CATALOG: Record<string, SeedProduct[]> = {
  'Trái cây': [
    { name: 'Dâu tây Đà Lạt', price: 120000, unit: 'kg', image: U('1587393855524-087f83d95bc9') },
    { name: 'Bơ sáp 034', price: 80000, unit: 'kg', image: U('1653819370651-e5d283ec84aa') },
    { name: 'Xoài cát Hòa Lộc', price: 95000, unit: 'kg', image: U('1553279768-865429fa0078') },
    { name: 'Cam sành Vĩnh Long', price: 30000, unit: 'kg', image: U('1611080626919-7cf5a9dbab5b') },
    { name: 'Chuối già hương', price: 25000, unit: 'kg', image: U('1571771894821-ce9b6c11b08e') },
    { name: 'Dưa hấu Long An', price: 15000, unit: 'kg', image: U('1587049352846-4a222e784d38') },
  ],
  'Rau củ': [
    { name: 'Xà lách thủy canh', price: 50000, unit: 'kg', image: U('1622206151226-18ca2c9ab4a1') },
    { name: 'Cà chua bi Đà Lạt', price: 45000, unit: 'kg', image: U('1561136594-7f68413baa99') },
    { name: 'Cà rốt Đà Lạt', price: 25000, unit: 'kg', image: U('1598170845058-32b9d6a5da37') },
    { name: 'Khoai tây vàng', price: 35000, unit: 'kg', image: U('1518977676601-b53f82aba655') },
    { name: 'Súp lơ xanh', price: 55000, unit: 'kg', image: U('1583663848850-46af132dc08e') },
    { name: 'Dưa leo baby', price: 30000, unit: 'kg', image: U('1449300079323-02e209d9d3a6') },
  ],
  'Gạo & ngũ cốc': [
    { name: 'Gạo ST25 Sóc Trăng', price: 180000, unit: 'túi', image: U('1586201375761-83865001e31c') },
    { name: 'Gạo lứt đỏ Điện Biên', price: 50000, unit: 'kg', image: U('1675150303909-1bb94e33132f') },
    { name: 'Bắp ngọt', price: 15000, unit: 'kg', image: U('1551754655-cd27e38d2076') },
    { name: 'Đậu đen xanh lòng', price: 45000, unit: 'kg', image: U('1543831113-c823c4a606b6') },
    { name: 'Yến mạch nguyên hạt', price: 90000, unit: 'kg', image: U('1614373532018-92a75430a0da') },
  ],
  'Thịt/Trứng/Sữa': [
    { name: 'Trứng gà ta', price: 35000, unit: 'vỉ', image: U('1582722872445-44dc5f7e3c8f') },
    { name: 'Gà ta thả vườn', price: 130000, unit: 'con', image: U('1612170153139-6f881ff067e0') },
    { name: 'Sữa bò tươi', price: 35000, unit: 'lít', image: U('1550583724-b2692b85b150') },
    { name: 'Sữa chua nhà làm', price: 40000, unit: 'lốc', image: U('1488477181946-6428a0291777') },
    { name: 'Cá lóc đồng', price: 90000, unit: 'kg', image: U('1498654200943-1088dd4438ae') },
  ],
  'Vật tư nông nghiệp': [
    { name: 'Phân NPK 16-16-8', price: 250000, unit: 'bao', image: U('1416879595882-3373a0480b5b') },
    { name: 'Đất sạch trồng rau', price: 60000, unit: 'bao', image: U('1585314062340-f1a5a7c9328d') },
    { name: 'Hạt giống cải ngọt', price: 18000, unit: 'gói', image: U('1466692476868-aef1dfb1e735') },
    { name: 'Khay ươm hạt', price: 25000, unit: 'khay', image: U('1591857177580-dc82b9ac4e1e') },
    { name: 'Ống tưới nhỏ giọt', price: 150000, unit: 'bộ', image: U('1625246333195-78d9c38ad449') },
  ],
};
