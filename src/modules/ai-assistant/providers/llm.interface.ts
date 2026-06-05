export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

// ─── Basic message types ────────────────────────────────────────────────────

/**
 * Một phần nội dung trong message đa phương thức.
 * Hiện chỉ user message dùng image part (ảnh đính kèm trong AI chat);
 * system/assistant luôn là text thuần.
 */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageBase64: string; mimeType: string };

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /** String thuần hoặc mảng chunks (text + inline image) cho vision model. */
  content: string | LLMContentPart[];
}

/**
 * Flatten content về text — multimodal thì ghép các text part, bỏ qua ảnh.
 * Dùng cho provider text-only (Groq), token estimate, và summarization.
 */
export function textOfContent(content: string | LLMContentPart[] | null): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LLMContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ─── Tool calling types ─────────────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-serialized arguments
  };
}

/** Assistant message that contains tool invocations (no text content). */
export interface LLMToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
}

/** Tool result injected back into the conversation. */
export interface LLMToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string; // JSON-serialized ToolResult
}

/**
 * Union of all message types valid in a tool-calling conversation.
 * LLMMessage[] is assignable to this type (arrays are covariant in TS).
 */
export type LLMConversationMessage = LLMMessage | LLMToolCallMessage | LLMToolResultMessage;

// ─── Provider options & results ─────────────────────────────────────────────

export interface LLMStreamOptions {
  model: string;
  /** Accepts plain messages or full tool-calling conversation history. */
  messages: LLMConversationMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompleteResult {
  content: string;
  tokensUsed: number;
  model: string;
}

export interface LLMImageCompleteOptions {
  model: string;
  /** Instructions for the vision analysis (system role). */
  systemInstruction: string;
  /** Raw base64 payload — no data-URI prefix. */
  imageBase64: string;
  /** e.g. 'image/jpeg' */
  mimeType: string;
  /** When true, ask the provider for strict JSON output (Gemini: responseMimeType). */
  jsonOutput?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompleteWithToolsOptions {
  model: string;
  messages: LLMConversationMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompleteWithToolsResult {
  /** Text content — null when finish_reason is 'tool_calls'. */
  content: string | null;
  /** Non-empty when the model wants to invoke tools. */
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  tokensUsed: number;
}

// ─── Provider interface ──────────────────────────────────────────────────────

/**
 * Provider-agnostic LLM interface.
 * Swap Groq → Claude/OpenAI by providing a different implementation
 * and updating the DI token in AIAssistantModule — zero business logic changes.
 */
export interface ILLMProvider {
  /** Yields token chunks for streaming responses. */
  stream(options: LLMStreamOptions): AsyncGenerator<string>;

  /** Single-shot completion — used for intent classification & summarization. */
  complete(options: LLMStreamOptions): Promise<LLMCompleteResult>;

  /** Tool-enabled completion (non-streaming) — used for tool detection loop. */
  completeWithTools(options: LLMCompleteWithToolsOptions): Promise<LLMCompleteWithToolsResult>;

  /**
   * Vision completion over a single inline image — used for product suggestion.
   * Optional: text-only providers (e.g. Groq Llama) may not implement it;
   * callers must degrade gracefully when absent.
   */
  completeWithImage?(options: LLMImageCompleteOptions): Promise<LLMCompleteResult>;
}
