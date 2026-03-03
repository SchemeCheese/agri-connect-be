import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateVoucherDto } from './dtos/create-voucher.dto';
import { ValidateVoucherDto } from './dtos/validate-voucher.dto';
import { DiscountType } from '@prisma/client';

@Injectable()
export class VouchersService {
  constructor(private readonly db: DatabaseService) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  SELLER
  // ─────────────────────────────────────────────────────────────────────────

  /** POST /vouchers — Tạo voucher mới (seller only) */
  async createVoucher(sellerId: string, dto: CreateVoucherDto) {
    // Kiểm tra code không trùng trong shop này
    const existing = await this.db.voucher.findUnique({
      where: { seller_id_code: { seller_id: sellerId, code: dto.code.toUpperCase() } },
    });
    if (existing) {
      throw new ConflictException(`Mã voucher "${dto.code}" đã tồn tại trong shop của bạn.`);
    }

    return this.db.voucher.create({
      data: {
        seller_id: sellerId,
        code: dto.code.toUpperCase(),
        discount_type: dto.discount_type,
        discount_value: dto.discount_value,
        min_order_value: dto.min_order_value,
        max_discount_amount: dto.max_discount_amount,
        valid_from: new Date(dto.valid_from),
        valid_to: new Date(dto.valid_to),
        usage_limit: dto.usage_limit ?? 100,
        is_active: dto.is_active ?? true,
      },
    });
  }

  /** GET /vouchers/mine — Danh sách voucher của shop mình */
  async getMyVouchers(sellerId: string) {
    return this.db.voucher.findMany({
      where: { seller_id: sellerId },
      orderBy: { created_at: 'desc' },
    });
  }

  /** PATCH /vouchers/:id — Sửa voucher */
  async updateVoucher(sellerId: string, voucherId: string, dto: Partial<CreateVoucherDto>) {
    const voucher = await this._findAndCheckOwner(voucherId, sellerId);

    const data: Record<string, any> = {};
    if (dto.discount_type !== undefined) data.discount_type = dto.discount_type;
    if (dto.discount_value !== undefined) data.discount_value = dto.discount_value;
    if (dto.min_order_value !== undefined) data.min_order_value = dto.min_order_value;
    if (dto.max_discount_amount !== undefined) data.max_discount_amount = dto.max_discount_amount;
    if (dto.valid_from !== undefined) data.valid_from = new Date(dto.valid_from);
    if (dto.valid_to !== undefined) data.valid_to = new Date(dto.valid_to);
    if (dto.usage_limit !== undefined) data.usage_limit = dto.usage_limit;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;

    // Nếu đổi code, kiểm tra không trùng
    if (dto.code && dto.code.toUpperCase() !== voucher.code) {
      const conflict = await this.db.voucher.findUnique({
        where: { seller_id_code: { seller_id: sellerId, code: dto.code.toUpperCase() } },
      });
      if (conflict) throw new ConflictException(`Mã "${dto.code}" đã tồn tại.`);
      data.code = dto.code.toUpperCase();
    }

    return this.db.voucher.update({ where: { id: voucherId }, data });
  }

  /** DELETE /vouchers/:id — Xóa voucher */
  async deleteVoucher(sellerId: string, voucherId: string) {
    await this._findAndCheckOwner(voucherId, sellerId);
    await this.db.voucher.delete({ where: { id: voucherId } });
    return { message: 'Xóa voucher thành công.' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  BUYER
  // ─────────────────────────────────────────────────────────────────────────

  /** GET /vouchers/shop/:shopId — Xem voucher public của một shop (buyer) */
  async getShopVouchers(shopId: string) {
    const now = new Date();
    // Lấy tất cả voucher còn hạn, filter used_count < usage_limit ở code
    const vouchers = await this.db.voucher.findMany({
      where: {
        seller_id: shopId,
        is_active: true,
        valid_from: { lte: now },
        valid_to: { gte: now },
      },
      orderBy: { created_at: 'desc' },
    });
    // Lọc còn lượt dùng
    return vouchers.filter((v) => v.used_count < v.usage_limit);
  }

  /** POST /vouchers/save/:id — Lưu voucher vào ví buyer */
  async saveVoucher(buyerId: string, voucherId: string) {
    // Kiểm tra voucher tồn tại và còn hiệu lực
    const voucher = await this.db.voucher.findUnique({ where: { id: voucherId } });
    if (!voucher || !voucher.is_active) {
      throw new NotFoundException('Voucher không tồn tại hoặc đã bị vô hiệu hóa.');
    }

    const now = new Date();
    if (now < voucher.valid_from || now > voucher.valid_to) {
      throw new BadRequestException('Voucher chưa đến hạn hoặc đã hết hạn.');
    }

    if (voucher.used_count >= voucher.usage_limit) {
      throw new BadRequestException('Voucher đã hết lượt sử dụng.');
    }

    // Kiểm tra đã lưu chưa
    const alreadySaved = await this.db.savedVoucher.findUnique({
      where: { user_id_voucher_id: { user_id: buyerId, voucher_id: voucherId } },
    });
    if (alreadySaved) {
      throw new ConflictException('Bạn đã lưu voucher này rồi.');
    }

    const saved = await this.db.savedVoucher.create({
      data: { user_id: buyerId, voucher_id: voucherId },
      include: { voucher: true },
    });

    return { message: 'Lưu voucher thành công.', data: saved };
  }

  /** GET /vouchers/saved — Ví voucher của buyer */
  async getSavedVouchers(buyerId: string) {
    const now = new Date();
    return this.db.savedVoucher.findMany({
      where: { user_id: buyerId },
      include: {
        voucher: {
          include: {
            seller: {
              select: { id: true, profile: { select: { store_name: true } } },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * POST /vouchers/validate
   * Body: { code, seller_id, order_total }
   * Trả về: { discount_amount, final_total, voucher }
   */
  async validateVoucher(buyerId: string, dto: ValidateVoucherDto) {
    const now = new Date();

    // Tìm voucher của shop với code đúng
    const voucher = await this.db.voucher.findUnique({
      where: {
        seller_id_code: {
          seller_id: dto.seller_id,
          code: dto.code.toUpperCase(),
        },
      },
    });

    if (!voucher) throw new NotFoundException('Mã giảm giá không tồn tại.');
    if (!voucher.is_active) throw new BadRequestException('Mã giảm giá đã bị vô hiệu hóa.');
    if (now < voucher.valid_from) throw new BadRequestException('Mã giảm giá chưa có hiệu lực.');
    if (now > voucher.valid_to) throw new BadRequestException('Mã giảm giá đã hết hạn.');
    if (voucher.used_count >= voucher.usage_limit) throw new BadRequestException('Mã giảm giá đã hết lượt sử dụng.');

    // Kiểm tra đơn tối thiểu
    if (dto.order_total < Number(voucher.min_order_value)) {
      throw new BadRequestException(
        `Đơn hàng tối thiểu ${Number(voucher.min_order_value).toLocaleString('vi-VN')}₫ để dùng mã này.`,
      );
    }

    // Tính số tiền giảm
    let discount_amount = 0;
    if (voucher.discount_type === DiscountType.PERCENT) {
      discount_amount = (dto.order_total * Number(voucher.discount_value)) / 100;
      // Giới hạn tối đa
      discount_amount = Math.min(discount_amount, Number(voucher.max_discount_amount));
    } else {
      // FIXED
      discount_amount = Math.min(Number(voucher.discount_value), dto.order_total);
    }

    discount_amount = Math.floor(discount_amount); // Làm tròn xuống

    return {
      voucher_id: voucher.id,
      code: voucher.code,
      discount_type: voucher.discount_type,
      discount_value: Number(voucher.discount_value),
      discount_amount,
      final_total: dto.order_total - discount_amount,
      voucher,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  INTERNAL (dùng trong OrdersService)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Áp dụng voucher khi đặt hàng và tăng used_count.
   * Trả về discount_amount (0 nếu không dùng voucher).
   */
  async applyVoucherOnCheckout(
    buyerId: string,
    sellerId: string,
    voucherCode: string | undefined,
    orderTotal: number,
  ): Promise<{ voucherId: string | null; discountAmount: number }> {
    if (!voucherCode) return { voucherId: null, discountAmount: 0 };

    const result = await this.validateVoucher(buyerId, {
      code: voucherCode,
      seller_id: sellerId,
      order_total: orderTotal,
    });

    // Tăng used_count
    await this.db.voucher.update({
      where: { id: result.voucher_id },
      data: { used_count: { increment: 1 } },
    });

    return { voucherId: result.voucher_id, discountAmount: result.discount_amount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private async _findAndCheckOwner(voucherId: string, sellerId: string) {
    const voucher = await this.db.voucher.findUnique({ where: { id: voucherId } });
    if (!voucher) throw new NotFoundException('Voucher không tồn tại.');
    if (voucher.seller_id !== sellerId) throw new ForbiddenException('Bạn không có quyền sửa voucher này.');
    return voucher;
  }
}
