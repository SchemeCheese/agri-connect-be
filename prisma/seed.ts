import { PrismaClient, UserRole, OrderStatus, TargetType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ==========================================
// DATA: DANH MỤC
// ==========================================
const CATEGORIES = [
  { id: 'trai-cay', name: 'Trái cây' },
  { id: 'rau-cu', name: 'Rau củ' },
  { id: 'ngu-coc', name: 'Ngũ cốc' },
  { id: 'gia-vi', name: 'Gia vị' },
  { id: 'khac', name: 'Khác' },
];

// ==========================================
// DATA: SHOPS
// ==========================================
const SHOPS = [
  { id: 'shop-1', userId: 'seller-shop-1', name: 'Nông Trại Cầu Đất', email: 'shop1@gmail.com', avatar: 'https://images.unsplash.com/photo-1605000797499-95a51c5269ae?w=200&h=200&fit=crop', location: 'TP. Đà Lạt, Lâm Đồng', desc: 'Chuyên Dâu tây & Rau củ' },
  { id: 'shop-2', userId: 'seller-shop-2', name: 'Vựa Gạo Miền Tây', email: 'shop2@gmail.com', avatar: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=200&h=200&fit=crop', location: 'TP. Cần Thơ', desc: 'Gạo ngon ST25' },
  { id: 'shop-3', userId: 'seller-shop-3', name: 'Hạt Dinh Dưỡng Organic', email: 'shop3@gmail.com', avatar: 'https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=200&h=200&fit=crop', location: 'Bình Phước', desc: 'Hạt điều & Granola' },
  { id: 'shop-4', userId: 'seller-shop-4', name: 'Thảo Mộc Tây Bắc', email: 'shop4@gmail.com', avatar: 'https://images.unsplash.com/photo-1615485925694-a039744c4b69?w=200&h=200&fit=crop', location: 'Sapa, Lào Cai', desc: 'Gia vị & Dược liệu' },
  { id: 'shop-5', userId: 'seller-shop-5', name: 'Nông Sản Miền Núi', email: 'shop5@gmail.com', avatar: 'https://images.unsplash.com/photo-1501004318641-b39e6451bec6?w=200&h=200&fit=crop', location: 'Kon Tum', desc: 'Nông sản sạch miền núi' }
];

// ==========================================
// DATA: PRODUCTS
// ==========================================
const PRODUCTS = [
  // --- TRÁI CÂY ---
  {
    id: 'tc-1', name: 'Dâu tây Đà Lạt', price: 120000, category: 'trai-cay', origin: 'da-lat', shopId: 'shop-1', stock: 50, images: [
      'https://images.unsplash.com/photo-1587393855524-087f83d95bc9?q=80&w=920&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1622143365323-b6f297a72df3?q=80&w=870&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1588165171080-c89acfa5ee83?q=80&w=687&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1648141294431-1f1d49becd1a?q=80&w=687&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1543156426-0fe5c9dba474?q=80&w=870&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1716209290705-7333e99e3434?q=80&w=870&auto=format&fit=crop'
    ], description: 'Dâu tây tươi ngon, đỏ mọng, vị ngọt thanh.'
  },

  {
    id: 'tc-2', name: 'Bơ sáp 034', price: 80000, category: 'trai-cay', origin: 'da-lat', shopId: 'shop-1', stock: 100, images: [
      'https://images.unsplash.com/photo-1653819370651-e5d283ec84aa?q=80&w=1160&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1612215047504-a6c07dbe4f7f?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1580823673284-e911e30564b6?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1580823673202-ef0405ae5b52?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1616485828923-2640a1ee48b4?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1691657915865-d7b9a6a54e6f?q=80&w=1374&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1741515045437-97682aa96a2d?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D'
    ], description: 'Bơ sáp dẻo quánh, béo ngậy, hạt nhỏ. Đặc sản Lâm Đồng.'
  },

  {
    id: 'tc-3', name: 'Xoài cát Hòa Lộc', price: 95000, category: 'trai-cay', origin: 'mien-tay', shopId: 'shop-2', stock: 40, images: [
      'https://images.unsplash.com/photo-1553279768-865429fa0078?w=600&q=80',
      'https://images.unsplash.com/photo-1601493700631-2b16ec4b4716?q=80&w=870&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1635716279493-d1e30afc25a0?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1582655299221-2b6bff351df0?q=80&w=1162&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1669207334420-66d0e3450283?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1605027990121-cbae9e0642df?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D'
    ], description: 'Xoài cát vỏ vàng, thịt ngọt lịm, thơm lừng.'
  },

  {
    id: 'tc-4', name: 'Chuối già hương', price: 25000, category: 'trai-cay', origin: 'mien-tay', shopId: 'shop-2', stock: 500, images: [
      'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?w=600&q=80',
      'https://images.unsplash.com/photo-1528825871115-3581a5387919?q=80&w=830&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1587920523737-556db3c49174?q=80&w=870&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?q=80&w=1160&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1676495706102-ca1be8fdf676?q=80&w=1630&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1580750587717-115f648f5402?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
    ], description: 'Chuối già hương chín cây, giàu năng lượng.'
  },
  {
    id: 'tc-5', name: 'Dưa hấu đỏ', price: 15000, category: 'trai-cay', origin: 'mien-tay', shopId: 'shop-2', stock: 50, images: [
      'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=600&q=80',
      'https://images.unsplash.com/photo-1563114773-84221bd62daa?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1622208489373-1fe93e2c6720?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1630081015918-8a21078e5cee?q=80&w=930&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1708982553355-794739c6693e?q=80&w=1825&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D'
    ], description: 'Dưa hấu giải nhiệt, ruột đỏ cát, ngọt mát.'
  },

  {
    id: 'tc-6', name: 'Cam sành vắt nước', price: 30000, category: 'trai-cay', origin: 'mien-tay', shopId: 'shop-2', stock: 200, images: [
      'https://images.unsplash.com/photo-1611080626919-7cf5a9dbab5b?w=600&q=80',
      'https://images.unsplash.com/photo-1597714026720-8f74c62310ba?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1547514701-42782101795e?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1586439702132-55ce0da661dd?q=80&w=928&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
      'https://images.unsplash.com/photo-1605986723344-f60873d873fa?q=80&w=656&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
    ], description: 'Cam mọng nước, nhiều vitamin C, tốt cho sức khỏe.'
  },

  {
    id: 'tc-7', name: 'Nho đen không hạt', price: 150000, category: 'trai-cay', origin: 'nhap-khau', shopId: 'shop-4', stock: 30, images: [
      'https://images.unsplash.com/photo-1516876319496-d5a849a2e89b?q=80&w=1160'
    ], description: 'Nho đen giòn ngọt, chùm to, không hạt. Nhập khẩu Mỹ.'
  },

  {
    id: 'tc-8', name: 'Táo Envy', price: 110000, category: 'trai-cay', origin: 'nhap-khau', shopId: 'shop-4', stock: 40, images: [
      'https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?w=600&q=80'
    ], description: 'Táo nhập khẩu, giòn tan, vị ngọt đậm.'
  },

  // --- RAU CỦ ---
  { id: 'rc-1', name: 'Xà lách thủy canh', price: 50000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 20, images: ['https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=600&q=80'], description: 'Rau sạch thủy canh, an toàn, tươi mát.' },
  { id: 'rc-2', name: 'Cà chua bi', price: 45000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 50, images: ['https://images.unsplash.com/photo-1561136594-7f68413baa99?w=600&q=80'], description: 'Cà chua nhỏ, giòn ngọt, thích hợp ăn sống.' },
  { id: 'rc-3', name: 'Cà rốt Đà Lạt', price: 25000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 100, images: ['https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=600&q=80'], description: 'Cà rốt củ to, màu cam đẹp, ngọt tự nhiên.' },
  { id: 'rc-4', name: 'Súp lơ xanh', price: 55000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 30, images: ['https://images.unsplash.com/photo-1583663848850-46af132dc08e?w=600&q=80'], description: 'Bông cải xanh giàu chất xơ, tốt cho tiêu hóa.' },
  { id: 'rc-5', name: 'Khoai tây vàng', price: 35000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 150, images: ['https://images.unsplash.com/photo-1518977676601-b53f82aba655?w=600&q=80'], description: 'Khoai tây bở, thích hợp nấu canh, chiên.' },
  { id: 'rc-6', name: 'Ớt chuông đỏ', price: 70000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 40, images: ['https://images.unsplash.com/photo-1592548868664-f8b4e4b1cfb7?q=80&w=691'], description: 'Ớt chuông dày cơm, ngọt, không hăng.' },
  { id: 'rc-7', name: 'Dưa leo Baby', price: 30000, category: 'rau-cu', origin: 'mien-tay', shopId: 'shop-2', stock: 100, images: ['https://images.unsplash.com/photo-1449300079323-02e209d9d3a6?w=600&q=80'], description: 'Dưa leo nhỏ, đặc ruột, giòn tan.' },
  { id: 'rc-8', name: 'Hành tây tím', price: 28000, category: 'rau-cu', origin: 'da-lat', shopId: 'shop-1', stock: 80, images: ['https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=600&q=80'], description: 'Hành tây tím, vị hăng nhẹ, làm salad rất ngon.' },

  // --- NGŨ CỐC ---
  { id: 'nc-1', name: 'Gạo ST25', price: 180000, category: 'ngu-coc', origin: 'mien-tay', shopId: 'shop-2', stock: 500, images: ['https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600&q=80'], description: 'Gạo ngon nhất thế giới, dẻo thơm.' },
  { id: 'nc-2', name: 'Yến mạch nguyên hạt', price: 90000, category: 'ngu-coc', origin: 'nhap-khau', shopId: 'shop-3', stock: 50, images: ['https://images.unsplash.com/photo-1614373532018-92a75430a0da?q=80&w=687'], description: 'Yến mạch nhập khẩu, tốt cho tim mạch.' },
  { id: 'nc-3', name: 'Đậu đen xanh lòng', price: 45000, category: 'ngu-coc', origin: 'tay-bac', shopId: 'shop-4', stock: 60, images: ['https://images.unsplash.com/photo-1543831113-c823c4a606b6?q=80&w=870'], description: 'Đậu đen hạt nhỏ, nấu chè bở tơi.' },
  { id: 'nc-4', name: 'Ngô ngọt (Bắp)', price: 15000, category: 'ngu-coc', origin: 'mien-tay', shopId: 'shop-2', stock: 100, images: ['https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=600&q=80'], description: 'Bắp ngô ngọt, hạt đều, luộc hay nướng đều ngon.' },
  { id: 'nc-5', name: 'Hạt Quinoa (Diêm mạch)', price: 250000, category: 'ngu-coc', origin: 'nhap-khau', shopId: 'shop-3', stock: 20, images: ['https://images.unsplash.com/photo-1722882270052-e132567e9f70?q=80&w=808'], description: 'Siêu thực phẩm, giàu protein, thay thế cơm.' },
  { id: 'nc-6', name: 'Gạo lứt đỏ', price: 50000, category: 'ngu-coc', origin: 'tay-bac', shopId: 'shop-4', stock: 100, images: ['https://images.unsplash.com/photo-1675150303909-1bb94e33132f?q=80&w=687'], description: 'Gạo lứt đỏ Điện Biên, dẻo, tốt cho người ăn kiêng.' },

  // --- GIA VỊ ---
  { id: 'gv-1', name: 'Tỏi cô đơn', price: 1200000, category: 'gia-vi', origin: 'mien-tay', shopId: 'shop-5', stock: 10, images: ['https://images.unsplash.com/photo-1620101680127-557e93569b1a?q=80&w=1325'], description: 'Tỏi một nhánh thơm nồng, dược tính cao.' },
  { id: 'gv-2', name: 'Tiêu đen Phú Quốc', price: 220000, category: 'gia-vi', origin: 'mien-tay', shopId: 'shop-5', stock: 50, images: ['https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=600&q=80'], description: 'Hạt tiêu chắc, cay nồng đặc trưng.' },
  { id: 'gv-3', name: 'Ớt bột Hàn Quốc', price: 150000, category: 'gia-vi', origin: 'nhap-khau', shopId: 'shop-5', stock: 30, images: ['https://images.unsplash.com/photo-1568481276363-88d890339390?q=80&w=870'], description: 'Ớt bột làm kim chi, màu đỏ đẹp, cay vừa.' },
  { id: 'gv-4', name: 'Quế thanh', price: 180000, category: 'gia-vi', origin: 'tay-bac', shopId: 'shop-4', stock: 20, images: ['https://images.unsplash.com/photo-1611256243212-48a03787ea01?q=80&w=1754'], description: 'Quế thanh cạo vỏ, thơm ngọt, dùng nấu phở.' },
  { id: 'gv-5', name: 'Gừng sẻ', price: 40000, category: 'gia-vi', origin: 'tay-bac', shopId: 'shop-4', stock: 40, images: ['https://images.unsplash.com/photo-1630623093145-f606591c2546?q=80&w=930'], description: 'Gừng củ nhỏ, cay nồng, ấm bụng.' },
  { id: 'gv-6', name: 'Nghệ tươi', price: 30000, category: 'gia-vi', origin: 'khac', shopId: 'shop-4', stock: 50, images: ['https://images.unsplash.com/photo-1666818398897-381dd5eb9139?q=80&w=1748'], description: 'Nghệ vàng tươi, dùng kho cá hoặc làm đẹp.' },

  // --- KHÁC ---
  { id: 'kh-1', name: 'Mật ong rừng', price: 350000, category: 'khac', origin: 'tay-bac', shopId: 'shop-4', stock: 20, images: ['https://images.unsplash.com/photo-1642067958024-1a2d9f836920?q=80&w=1788'], description: 'Mật ong nguyên chất, sánh đặc.' },
  { id: 'kh-2', name: 'Trà xanh Thái Nguyên', price: 200000, category: 'khac', origin: 'tay-bac', shopId: 'shop-4', stock: 60, images: ['https://images.unsplash.com/photo-1641997829221-a7d363722a1b?q=80&w=687'], description: 'Trà búp sao khô, nước xanh, vị chát hậu ngọt.' }
];

async function main() {
  console.log('🌱 Bắt đầu dọn dẹp và nạp dữ liệu mẫu toàn diện...');

  // 1. XÓA DỮ LIỆU CŨ (Để reset hoàn toàn DB mỗi khi chạy lại)
  console.log('--- Đang dọn dẹp Database ---');
  await prisma.attachment.deleteMany();
  await prisma.review.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.order.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.savedVoucher.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.verification.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash('123456', 10);

  // 2. TẠO NGƯỜI MUA (BUYER)
  console.log('--- Tạo Khách hàng ---');
  const buyer = await prisma.user.create({
    data: {
      id: 'buyer-default',
      email: 'khach@gmail.com',
      password_hash: passwordHash,
      full_name: 'Khách Hàng',
      role: UserRole.BUYER,
      verified_email: true,
    }
  });

  // 3. TẠO CỬA HÀNG (SELLERS)
  console.log('--- Tạo Cửa hàng (Shops) ---');
  const dbSellers = {};
  for (const shop of SHOPS) {
    const seller = await prisma.user.create({
      data: {
        id: shop.userId,
        email: shop.email,
        password_hash: passwordHash,
        full_name: shop.name,
        role: UserRole.SELLER,
        verified_email: true,
        profile: {
          create: {
            store_name: shop.name,
            address: shop.location,
            description: shop.desc,
            is_verified: true
          }
        }
      }
    });
    dbSellers[shop.id] = seller.id;

    // Lưu Avatar của Shop vào bảng Attachment
    await prisma.attachment.create({
      data: {
        url: shop.avatar,
        file_type: 'IMAGE',
        target_id: seller.id,
        target_type: TargetType.AVATAR
      }
    });
  }

  // 4. TẠO DANH MỤC
  console.log('--- Tạo Danh Mục ---');
  const dbCategories = {};
  for (const cat of CATEGORIES) {
    const createdCat = await prisma.category.create({
      data: { name: cat.name }
    });
    dbCategories[cat.id] = createdCat.id;
  }

  // 5. TẠO SẢN PHẨM & HÌNH ẢNH
  console.log(`--- Tạo ${PRODUCTS.length} Sản phẩm ---`);
  for (const p of PRODUCTS) {
    const prod = await prisma.product.create({
      data: {
        name: p.name,
        description: p.description,
        reference_price: p.price,
        stock_quantity: p.stock,
        unit: 'kg',
        location: p.origin,
        category_id: dbCategories[p.category],
        seller_id: dbSellers[p.shopId],
        is_active: true,
      }
    });

    // Tạo hình ảnh sản phẩm
    if (p.images.length > 0) {
      await prisma.attachment.createMany({
        data: p.images.map(url => ({
          url,
          file_type: 'IMAGE',
          target_id: prod.id,
          target_type: TargetType.PRODUCT
        }))
      });
    }

    // 6. GỈA LẬP ĐƠN HÀNG VÀ ĐÁNH GIÁ (Để có Review và Lượt bán)
    // Tự động tạo 1 đơn hàng đã hoàn thành và 1 đánh giá 5 sao cho mỗi sản phẩm
    const order = await prisma.order.create({
      data: {
        buyer_id: buyer.id,
        seller_id: dbSellers[p.shopId],
        status: OrderStatus.COMPLETED,
        final_total_price: p.price,
        shipping_address: '123 Đường ABC, Quận 1, TP.HCM',
        order_items: {
          create: {
            product_id: prod.id,
            quantity: 1, // Bán được 1 cái
            negotiated_price: p.price
          }
        }
      }
    });

    await prisma.review.create({
      data: {
        order_id: order.id,
        reviewer_id: buyer.id,
        rating: 5,
        comment: `Sản phẩm ${p.name} rất tuyệt vời! Sẽ tiếp tục ủng hộ shop.`
      }
    });
  }

  console.log('✅ Hoàn tất việc tạo dữ liệu Database');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });