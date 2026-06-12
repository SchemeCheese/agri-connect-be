import { ProductStatus, TargetType } from '@prisma/client';
import { ProductsService } from './products.service';
import { persistProductImages } from '../../common/storage/product-image.storage';

jest.mock('../../common/storage/product-image.storage', () => ({
  persistProductImages: jest.fn(),
}));

describe('ProductsService', () => {
  const productUpdate = jest.fn();
  const attachmentDeleteMany = jest.fn();
  const attachmentCreateMany = jest.fn();
  const db = {
    product: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (callback: (tx: any) => unknown) =>
      callback({
        product: { update: productUpdate },
        attachment: {
          deleteMany: attachmentDeleteMany,
          createMany: attachmentCreateMany,
        },
      }),
    ),
  };

  let service: ProductsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProductsService(db as any);
    db.product.findUnique.mockResolvedValue({
      id: 'product-1',
      seller_id: 'seller-1',
      stock_quantity: 10,
      status: ProductStatus.ACTIVE,
    });
    productUpdate.mockResolvedValue({ id: 'product-1' });
    (persistProductImages as jest.Mock).mockResolvedValue([
      'https://storage.example/new-image.jpg',
    ]);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('replaces removed product images and keeps only the final image list', async () => {
    await service.updateProduct(
      'seller-1',
      'product-1',
      {
        retained_image_urls: ['https://storage.example/kept-image.jpg'],
        replace_images: true,
      },
      [{ filename: 'new-image.jpg' } as Express.Multer.File],
    );

    expect(attachmentDeleteMany).toHaveBeenCalledWith({
      where: {
        target_id: 'product-1',
        target_type: TargetType.PRODUCT,
      },
    });
    expect(attachmentCreateMany).toHaveBeenCalledWith({
      data: [
        {
          url: 'https://storage.example/kept-image.jpg',
          file_type: 'IMAGE',
          target_id: 'product-1',
          target_type: TargetType.PRODUCT,
        },
        {
          url: 'https://storage.example/new-image.jpg',
          file_type: 'IMAGE',
          target_id: 'product-1',
          target_type: TargetType.PRODUCT,
        },
      ],
    });
  });

  it('can remove every image without restoring old attachments', async () => {
    (persistProductImages as jest.Mock).mockResolvedValue([]);

    await service.updateProduct(
      'seller-1',
      'product-1',
      { retained_image_urls: [], replace_images: true },
      [],
    );

    expect(attachmentDeleteMany).toHaveBeenCalledTimes(1);
    expect(attachmentCreateMany).not.toHaveBeenCalled();
  });
});
