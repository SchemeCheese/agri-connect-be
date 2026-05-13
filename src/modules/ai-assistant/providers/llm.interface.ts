export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

// ─── Basic message types ────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
}
