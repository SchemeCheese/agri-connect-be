import { ToolDefinition } from '../providers/llm.interface';

/**
 * Canonical tool definitions sent to the LLM.
 * These define the structural domain boundary — the LLM can only act
 * through these tools, making off-topic behavior physically impossible.
 */
export const AGRI_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Tìm kiếm sản phẩm nông sản trên sàn Agri-Connect theo từ khóa, giá, vùng, danh mục. ' +
        'Dùng khi user hỏi về sản phẩm cụ thể, muốn tìm mua nông sản, hoặc so sánh sản phẩm.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Từ khóa tìm kiếm: tên sản phẩm, loại nông sản (ví dụ: "gạo ST25", "cà phê Robusta")',
          },
          max_price: {
            type: 'number',
            description: 'Giá tối đa tính theo VND (ví dụ: 30000 = 30.000đ/kg)',
          },
          min_price: {
            type: 'number',
            description: 'Giá tối thiểu tính theo VND',
          },
          location: {
            type: 'string',
            description: 'Vùng/tỉnh thành của seller (ví dụ: "Đà Lạt", "Hậu Giang")',
          },
          category: {
            type: 'string',
            description: 'Tên danh mục (ví dụ: "Trái cây", "Rau củ", "Ngũ cốc", "Gia vị", "Thủy sản")',
          },
          limit: {
            type: 'integer',
            description: 'Số sản phẩm tối đa trả về (1-10, mặc định 5)',
            minimum: 1,
            maximum: 10,
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product_details',
      description:
        'Lấy thông tin chi tiết của một sản phẩm theo ID: mô tả đầy đủ, thông tin seller, ' +
        'lịch sử giá gần đây, điều kiện thương lượng. Dùng sau khi search_products để xem chi tiết.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'ID của sản phẩm (lấy từ kết quả search_products)',
          },
        },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_price_trends',
      description:
        'Phân tích xu hướng giá của một loại nông sản dựa trên lịch sử giao dịch THỰC TẾ: ' +
        'giá trung bình, min/max, xu hướng tăng/giảm, khối lượng giao dịch theo tuần. ' +
        'Dùng cho câu hỏi về giá cả, so sánh giá, xu hướng thị trường.',
      parameters: {
        type: 'object',
        properties: {
          product_name: {
            type: 'string',
            description: 'Tên sản phẩm hoặc loại nông sản (ví dụ: "cà phê", "gạo", "tiêu")',
          },
          period_days: {
            type: 'integer',
            description: 'Số ngày phân tích (7, 14, 30, hoặc 90 ngày, mặc định 30)',
            enum: [7, 14, 30, 90],
          },
        },
        required: ['product_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_sellers',
      description:
        'Gợi ý seller/shop uy tín trên Agri-Connect dựa trên điểm tổng hợp: ' +
        'tỷ lệ hoàn thành đơn hàng, đánh giá từ buyer, giá cạnh tranh. ' +
        'Dùng khi user hỏi "shop nào tốt", "mua ở đâu uy tín".',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Danh mục sản phẩm cần tìm seller',
          },
          product_name: {
            type: 'string',
            description: 'Tên sản phẩm cụ thể cần mua',
          },
          min_rating: {
            type: 'number',
            description: 'Rating tối thiểu (1.0-5.0, mặc định 3.5)',
            minimum: 1,
            maximum: 5,
          },
          limit: {
            type: 'integer',
            description: 'Số seller tối đa trả về (1-10, mặc định 5)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_negotiation_guidance',
      description:
        'Hỗ trợ thương lượng giá dựa trên lịch sử giao dịch THỰC TẾ: ' +
        'tỷ lệ chấp nhận theo mức giá, mức đề xuất tối ưu, số lượng tác động. ' +
        'Dùng khi buyer/seller hỏi nên đề giá bao nhiêu, mức giá nào hợp lý.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'ID sản phẩm muốn thương lượng',
          },
          desired_quantity: {
            type: 'number',
            description: 'Số lượng muốn mua/bán',
          },
          role: {
            type: 'string',
            enum: ['BUYER', 'SELLER'],
            description: 'Vai trò người đang hỏi',
          },
        },
        required: ['product_id', 'desired_quantity', 'role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_platform_policy',
      description:
        'Tra cứu quy trình và chính sách chính thức của sàn Agri-Connect: ' +
        'quy trình mua bán, phương thức thanh toán, quy trình thương lượng, chính sách vận chuyển, ' +
        'hướng dẫn đăng ký seller. Dùng cho câu hỏi về cách sử dụng sàn.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [
              'order_process',
              'payment_methods',
              'negotiation_process',
              'shipping',
              'return_policy',
              'seller_registration',
              'buyer_guide',
            ],
            description: 'Chủ đề cần tra cứu',
          },
        },
        required: ['topic'],
      },
    },
  },
];
