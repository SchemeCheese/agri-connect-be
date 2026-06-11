export type ToolName =
  | 'search_products'
  | 'get_product_details'
  | 'analyze_price_trends'
  | 'recommend_sellers'
  | 'get_negotiation_guidance'
  | 'get_platform_policy'
  | 'get_seller_analytics'
  | 'get_similar_products'
  | 'get_discounted_products'
  | 'get_admin_overview';

export const TOOL_WHITELIST: ReadonlySet<ToolName> = new Set<ToolName>([
  'search_products',
  'get_product_details',
  'analyze_price_trends',
  'recommend_sellers',
  'get_negotiation_guidance',
  'get_platform_policy',
  'get_seller_analytics',
  'get_similar_products',
  'get_discounted_products',
  'get_admin_overview',
]);

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cached?: boolean;
}

export interface ToolExecutionContext {
  userId: string;
  sessionId: string;
  /** true nếu user là admin (lấy từ DB, không tin client) — gate tool toàn sàn. */
  isAdmin?: boolean;
}

export const MAX_TOOL_ROUNDS = 3;
export const TOOL_EXECUTION_TIMEOUT_MS = 8_000;
export const MAX_TOOL_CALLS_PER_REQUEST = 6;
