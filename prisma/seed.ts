import { PrismaClient, UserRole, TargetType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// 1. Dữ liệu Danh mục khớp với Frontend
const CATEGORIES = [
  { name: 'Trái cây', code: 'trai-cay' },
  { name: 'Rau củ', code: 'rau-cu' },
  { name: 'Ngũ cốc', code: 'ngu-coc' },
  { name: 'Gia vị', code: 'gia-vi' },
  { name: 'Khác', code: 'khac' },
];

// 2. Dữ liệu Sản phẩm từ Mock Data của bạn
const PRODUCTS_DATA = [
  // --- TRÁI CÂY ---
  {
    name: 'Dâu tây Đà Lạt',
    price: 120000,
    categoryCode: 'trai-cay',
    origin: 'Đà Lạt',
    description: 'Dâu tây tươi ngon, đỏ mọng, vị ngọt thanh. Hái tại vườn vào sáng sớm.',
    stock: 50,
    images: [
      'https://images.unsplash.com/photo-1587393855524-087f83d95bc9?q=80&w=920&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1622143365323-b6f297a72df3?q=80&w=870&auto=format&fit=crop'
    ]
  },
  {
    name: 'Bơ sáp 034',
    price: 80000,
    categoryCode: 'trai-cay',
    origin: 'Đà Lạt',
    description: 'Bơ sáp dẻo quánh, béo ngậy, hạt nhỏ. Đặc sản Lâm Đồng.',
    stock: 100,
    images: ['https://images.unsplash.com/photo-1653819370651-e5d283ec84aa?q=80&w=1160&auto=format&fit=crop']
  },
  {
    name: 'Xoài cát Hòa Lộc',
    price: 95000,
    categoryCode: 'trai-cay',
    origin: 'Miền Tây',
    description: 'Xoài cát vỏ vàng, thịt ngọt lịm, thơm lừng.',
    stock: 40,
    images: ['https://images.unsplash.com/photo-1553279768-865429fa0078?w=600&q=80']
  },
  // --- RAU CỦ ---
  {
    name: 'Xà lách thủy canh',
    price: 50000,
    categoryCode: 'rau-cu',
    origin: 'Đà Lạt',
    description: 'Rau sạch thủy canh, an toàn, tươi mát. Dùng làm salad cực ngon.',
    stock: 20,
    images: ['https://images.unsplash.com/photo-1622206151226-18ca2c9ab4a1?w=600&q=80']
  },
  {
    name: 'Cà chua bi',
    price: 45000,
    categoryCode: 'rau-cu',
    origin: 'Đà Lạt',
    description: 'Cà chua nhỏ, giòn ngọt, thích hợp ăn sống.',
    stock: 50,
    images: ['https://images.unsplash.com/photo-1561136594-7f68413baa99?w=600&q=80']
  },
  {
    name: 'Cà rốt Đà Lạt',
    price: 25000,
    categoryCode: 'rau-cu',
    origin: 'Đà Lạt',
    description: 'Cà rốt củ to, màu cam đẹp, ngọt tự nhiên.',
    stock: 100,
    images: ['https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=600&q=80']
  },
  // --- NGŨ CỐC ---
  {
    name: 'Gạo ST25',
    price: 180000,
    categoryCode: 'ngu-coc',
    origin: 'Miền Tây',
    description: 'Gạo ngon nhất thế giới, dẻo thơm.',
    stock: 500,
    images: ['https://images.unsplash.com/photo-1586201375761-83865001e31c?w=600&q=80']
  },
  // --- GIA VỊ ---
  {
    name: 'Tỏi cô đơn',
    price: 1200000,
    categoryCode: 'gia-vi',
    origin: 'Miền Tây',
    description: 'Tỏi một nhánh thơm nồng, dược tính cao.',
    stock: 10,
    images: ['https://images.unsplash.com/photo-1620101680127-557e93569b1a?q=80&w=1325&auto=format&fit=crop']
  }
];

async function main() {
  console.log('🌱 Bắt đầu tạo dữ liệu mẫu...');

  // 1. Tạo Danh Mục (Categories)
  console.log('--- Tạo Danh Mục ---');
  const categoryMap = new Map();
  for (const cat of CATEGORIES) {
    // Tìm hoặc tạo mới để tránh lỗi trùng lặp
    const createdCat = await prisma.category.upsert({
      where: { id: 0 }, // Trick: upsert yêu cầu unique, ở đây ta dùng findFirst logic trong loop
      update: {},
      create: { name: cat.name },
    }).catch(async () => {
       // Fallback nếu logic trên phức tạp: Dùng findFirst rồi create
       const exist = await prisma.category.findFirst({ where: { name: cat.name }});
       if(exist) return exist;
       return await prisma.category.create({ data: { name: cat.name } });
    });
    
    // Lưu mapping để tí nữa gán sản phẩm
    // Note: Code code (trai-cay) -> ID DB
    categoryMap.set(cat.code, createdCat.id);
    console.log(`Đã tạo: ${cat.name}`);
  }

  // 2. Tạo Người Bán (Sellers)
  console.log('--- Tạo Người Bán Mẫu ---');
  const passwordHash = await bcrypt.hash('123456', 10);
  
  const seller1 = await prisma.user.upsert({
    where: { email: 'dalat@shop.com' },
    update: {},
    create: {
      email: 'dalat@shop.com',
      password_hash: passwordHash,
      full_name: 'Nông Trại Đà Lạt',
      role: UserRole.SELLER,
      profile: {
        create: {
          store_name: 'Đà Lạt Fresh',
          description: 'Chuyên đặc sản Đà Lạt tươi ngon',
          address: 'Phường 8, Đà Lạt, Lâm Đồng'
        }
      }
    }
  });

  const seller2 = await prisma.user.upsert({
    where: { email: 'mientay@shop.com' },
    update: {},
    create: {
      email: 'mientay@shop.com',
      password_hash: passwordHash,
      full_name: 'Vựa Trái Cây Miền Tây',
      role: UserRole.SELLER,
      profile: {
        create: {
          store_name: 'Miền Tây Fruits',
          description: 'Trái cây miệt vườn chính gốc',
          address: 'Cái Bè, Tiền Giang'
        }
      }
    }
  });

  console.log(`Đã tạo Seller: ${seller1.email}, ${seller2.email}`);

  // 3. Tạo Sản Phẩm & Ảnh
  console.log('--- Tạo Sản Phẩm ---');
  
  for (const prod of PRODUCTS_DATA) {
    // Chọn ngẫu nhiên seller
    const seller = prod.origin === 'Đà Lạt' ? seller1 : seller2;
    const categoryId = categoryMap.get(prod.categoryCode);

    if (!categoryId) {
      console.warn(`Không tìm thấy danh mục cho ${prod.name}`);
      continue;
    }

    const product = await prisma.product.create({
      data: {
        name: prod.name,
        description: prod.description,
        reference_price: prod.price,
        stock_quantity: prod.stock,
        unit: 'kg', // Mặc định
        location: prod.origin,
        category_id: categoryId,
        seller_id: seller.id,
        is_active: true,
      }
    });

    // Tạo Attachments (Ảnh)
    if (prod.images && prod.images.length > 0) {
      await prisma.attachment.createMany({
        data: prod.images.map(url => ({
          url: url,
          file_type: 'IMAGE',
          target_id: product.id,
          target_type: TargetType.PRODUCT
        }))
      });
    }
    console.log(`+ Đã thêm: ${prod.name}`);
  }

  console.log('✅ Hoàn tất tạo dữ liệu mẫu!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });