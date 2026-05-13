import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { ToolResult } from './types';

export interface SearchProductsInput {
  query: string;
  max_price?: number;
  min_price?: number;
  location?: string;
  category?: string;
  limit?: number;
}

export interface GetProductDetailsInput {
  product_id: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  reference_price: number;
  unit: string;
  location: string | null;
  stock_quantity: number;
  is_negotiable: boolean;
  min_negotiation_qty: number | null;
  certification: string | null;
  seller: { id: string; store_name: string | null };
  category: string | null;
  description: string | null;
}

export interface ProductDetails extends ProductSummary {
  recent_transactions: { avg_price: number; min_price: number; max_price: number; count: number } | null;
}

@Injectable()
export class ProductSearchTool {
  private readonly logger = new Logger(ProductSearchTool.name);

  constructor(private readonly db: DatabaseService) {}

  async searchProducts(input: SearchProductsInput): Promise<ToolResult<ProductSummary[]>> {
    try {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

      const products = await this.db.product.findMany({
        where: {
          is_active: true,
          stock_quantity: { gt: 0 },
          OR: [
            { name: { contains: input.query, mode: 'insensitive' } },
            { description: { contains: input.query, mode: 'insensitive' } },
          ],
          ...(input.max_price !== undefined && { reference_price: { lte: input.max_price } }),
          ...(input.min_price !== undefined && { reference_price: { gte: input.min_price } }),
          ...(input.location && { location: { contains: input.location, mode: 'insensitive' } }),
          ...(input.category && {
            category: { name: { contains: input.category, mode: 'insensitive' } },
          }),
        },
        include: {
          seller: {
            select: {
              id: true,
              profile: { select: { store_name: true } },
            },
          },
          category: { select: { name: true } },
        },
        orderBy: [{ is_active: 'desc' }, { updated_at: 'desc' }],
        take: limit,
      });

      const data: ProductSummary[] = products.map((p) => ({
        id: p.id,
        name: p.name,
        reference_price: Number(p.reference_price),
        unit: p.unit,
        location: p.location,
        stock_quantity: Number(p.stock_quantity),
        is_negotiable: p.min_negotiation_qty !== null,
        min_negotiation_qty: p.min_negotiation_qty ? Number(p.min_negotiation_qty) : null,
        certification: p.certification,
        seller: {
          id: p.seller.id,
          store_name: p.seller.profile?.store_name ?? null,
        },
        category: p.category?.name ?? null,
        description: p.description
          ? p.description.slice(0, 150) + (p.description.length > 150 ? '...' : '')
          : null,
      }));

      return { success: true, data };
    } catch (err) {
      this.logger.error('ProductSearchTool.searchProducts error', err);
      return { success: false, error: 'Lỗi tìm kiếm sản phẩm' };
    }
  }

  async getProductDetails(input: GetProductDetailsInput): Promise<ToolResult<ProductDetails>> {
    try {
      const product = await this.db.product.findUnique({
        where: { id: input.product_id },
        include: {
          seller: {
            select: {
              id: true,
              profile: { select: { store_name: true } },
            },
          },
          category: { select: { name: true } },
          order_items: {
            where: { order: { status: 'COMPLETED' } },
            select: { negotiated_price: true },
            take: 50,
            orderBy: { order: { created_at: 'desc' } },
          },
        },
      });

      if (!product) {
        return { success: false, error: 'Không tìm thấy sản phẩm' };
      }

      const prices = product.order_items.map((i) => Number(i.negotiated_price));
      const recent_transactions =
        prices.length > 0
          ? {
              avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
              min_price: Math.min(...prices),
              max_price: Math.max(...prices),
              count: prices.length,
            }
          : null;

      const data: ProductDetails = {
        id: product.id,
        name: product.name,
        reference_price: Number(product.reference_price),
        unit: product.unit,
        location: product.location,
        stock_quantity: Number(product.stock_quantity),
        is_negotiable: product.min_negotiation_qty !== null,
        min_negotiation_qty: product.min_negotiation_qty ? Number(product.min_negotiation_qty) : null,
        certification: product.certification,
        seller: {
          id: product.seller.id,
          store_name: product.seller.profile?.store_name ?? null,
        },
        category: product.category?.name ?? null,
        description: product.description,
        recent_transactions,
      };

      return { success: true, data };
    } catch (err) {
      this.logger.error('ProductSearchTool.getProductDetails error', err);
      return { success: false, error: 'Lỗi lấy chi tiết sản phẩm' };
    }
  }
}
