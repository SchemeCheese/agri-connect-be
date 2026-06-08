import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Content,
  FunctionDeclaration,
  GenerateContentResult,
  GoogleGenerativeAI,
  Part,
  Tool,
} from '@google/generative-ai';
import {
  ILLMProvider,
  LLMCompleteResult,
  LLMCompleteWithToolsOptions,
  LLMCompleteWithToolsResult,
  LLMConversationMessage,
  LLMImageCompleteOptions,
  LLMStreamOptions,
  ToolCall,
  ToolDefinition,
  textOfContent,
} from './llm.interface';

/** JSON-Schema keys Gemini's Schema type does not accept — stripped recursively. */
const UNSUPPORTED_SCHEMA_KEYS = ['additionalProperties', '$schema', 'default', 'exclusiveMinimum', 'exclusiveMaximum'];

/**
 * Centralized Gemini model routing — single source of truth (Acceptance Criterion 1).
 *
 * - CHAT / CHAT_LITE → gemini-2.5-flash(-lite): general conversational chat,
 *   tool detection, summarization. Low latency / low cost, both multimodal.
 * - VISION → gemini-2.5-pro: used STRICTLY for image vision / moderation
 *   analysis (e.g. classifying an uploaded product photo for listing
 *   suggestions). Highest-capability tier; NOT used for ordinary chat turns
 *   that merely happen to include an image — those stay on CHAT to avoid the
 *   thinking-token latency/cost of pro on every conversational reply.
 *
 * Callers should resolve a task → model via GeminiProvider.resolveModel() (or
 * import GEMINI_MODELS) so routing never drifts between the service and provider.
 */
export const GEMINI_MODELS = {
  /** General chat (reasoning) — multimodal-capable, fast. */
  CHAT: 'gemini-2.5-flash',
  /** Lightweight chat / tool-detection / summarization — cheapest. */
  CHAT_LITE: 'gemini-2.5-flash-lite',
  /** Image vision + moderation analysis ONLY — most capable tier. */
  VISION: 'gemini-2.5-pro',
} as const;

export type GeminiTask = 'chat' | 'chat_lite' | 'vision';

@Injectable()
export class GeminiProvider implements ILLMProvider, OnModuleInit {
  private readonly logger = new Logger(GeminiProvider.name);
  private client!: GoogleGenerativeAI;
  /** Monotonic counter for synthetic tool-call ids (Gemini has no native ids). */
  private callSeq = 0;

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolve a task category to its routed Gemini model. Single entry point so
   * model selection stays consistent across every caller (Criterion 1):
   * vision/moderation → gemini-2.5-pro, everything else → flash/flash-lite.
   */
  static resolveModel(task: GeminiTask): string {
    switch (task) {
      case 'vision':
        return GEMINI_MODELS.VISION;
      case 'chat_lite':
        return GEMINI_MODELS.CHAT_LITE;
      case 'chat':
      default:
        return GEMINI_MODELS.CHAT;
    }
  }

  onModuleInit() {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — AI features will be unavailable');
    }
    this.client = new GoogleGenerativeAI(apiKey ?? 'missing');
  }

  async *stream(options: LLMStreamOptions): AsyncGenerator<string> {
    const { systemInstruction, contents } = this.toGeminiContent(options.messages);

    const model = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 800,
        temperature: options.temperature ?? 0.7,
      },
    });

    const result = await model.generateContentStream({ contents });

    for await (const chunk of result.stream) {
      // chunk.text() throws when the chunk carries no text part (e.g. a
      // function call or a safety block) — guard so the stream never crashes.
      let token: string;
      try {
        token = chunk.text();
      } catch {
        continue;
      }
      if (token) yield token;
    }
  }

  async complete(options: LLMStreamOptions): Promise<LLMCompleteResult> {
    const { systemInstruction, contents } = this.toGeminiContent(options.messages);

    const model = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 150,
        temperature: options.temperature ?? 0.1,
      },
    });

    const result = await model.generateContent({ contents });

    return {
      content: this.safeText(result),
      tokensUsed: result.response.usageMetadata?.totalTokenCount ?? 0,
      model: options.model,
    };
  }

  async completeWithImage(options: LLMImageCompleteOptions): Promise<LLMCompleteResult> {
    // Vision/moderation is routed to gemini-2.5-pro (Criterion 1); default here
    // so any caller that omits a model still lands on the correct tier.
    const resolvedModel = options.model || GEMINI_MODELS.VISION;
    const model = this.client.getGenerativeModel({
      model: resolvedModel,
      systemInstruction: options.systemInstruction,
      generationConfig: {
        // gemini-2.5-pro is a thinking model — thinking tokens count toward
        // maxOutputTokens, so reserve a generous budget (raised from 800) or
        // the JSON answer can be starved to an empty response.
        maxOutputTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.2,
        // Forces the model to emit syntactically valid JSON (no markdown fences).
        ...(options.jsonOutput ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: options.imageBase64, mimeType: options.mimeType } },
            { text: 'Analyze this image.' },
          ],
        },
      ],
    });

    return {
      content: this.safeText(result),
      tokensUsed: result.response.usageMetadata?.totalTokenCount ?? 0,
      model: resolvedModel,
    };
  }

  async completeWithTools(options: LLMCompleteWithToolsOptions): Promise<LLMCompleteWithToolsResult> {
    const { systemInstruction, contents } = this.toGeminiContent(options.messages);

    const model = this.client.getGenerativeModel({
      model: options.model,
      systemInstruction,
      tools: this.toGeminiTools(options.tools),
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 300,
        temperature: options.temperature ?? 0.2,
      },
    });

    const result = await model.generateContent({ contents });
    const response = result.response;
    const candidate = response.candidates?.[0];

    // Gemini does not assign ids to function calls — synthesize stable ones so
    // tool results can be threaded back through toGeminiContent (id → name).
    const toolCalls: ToolCall[] = (response.functionCalls() ?? []).map((fc) => ({
      id: `gemini_call_${++this.callSeq}_${fc.name}`,
      type: 'function' as const,
      function: {
        name: fc.name,
        arguments: JSON.stringify(fc.args ?? {}),
      },
    }));

    let finishReason: LLMCompleteWithToolsResult['finishReason'] = 'stop';
    if (toolCalls.length > 0) finishReason = 'tool_calls';
    else if (candidate?.finishReason === 'MAX_TOKENS') finishReason = 'length';

    return {
      content: toolCalls.length > 0 ? null : this.safeText(result),
      toolCalls,
      finishReason,
      tokensUsed: response.usageMetadata?.totalTokenCount ?? 0,
    };
  }

  // ─── Mapping helpers ────────────────────────────────────────────────────────

  /**
   * Maps our OpenAI-shaped LLMConversationMessage union to Gemini's Content[].
   *
   * Differences handled here:
   * - 'system'    → pulled out into systemInstruction (Gemini has no system role)
   * - 'assistant' → role 'model'; tool_calls become functionCall parts
   * - 'tool'      → role 'user' with a functionResponse part, resolved back to
   *                 the original function name via the tool_call_id
   * - Consecutive same-role messages are merged (Gemini expects alternation)
   */
  private toGeminiContent(messages: LLMConversationMessage[]): {
    systemInstruction?: string;
    contents: Content[];
  } {
    // Gemini matches function responses by name, not id — build id → name map
    // from the assistant tool_calls seen earlier in the conversation.
    const callIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && 'tool_calls' in msg) {
        for (const tc of msg.tool_calls) callIdToName.set(tc.id, tc.function.name);
      }
    }

    const systemParts: string[] = [];
    const contents: Content[] = [];

    const push = (role: 'user' | 'model', parts: Part[]) => {
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(textOfContent(msg.content));
        continue;
      }

      if (msg.role === 'tool') {
        push('user', [
          {
            functionResponse: {
              name: callIdToName.get(msg.tool_call_id) ?? 'unknown_function',
              response: this.toResponseObject(msg.content),
            },
          },
        ]);
        continue;
      }

      if (msg.role === 'assistant' && 'tool_calls' in msg) {
        const parts: Part[] = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: this.parseArgs(tc.function.arguments),
            },
          });
        }
        push('model', parts);
        continue;
      }

      // Plain user / assistant message — multimodal content thành text + inlineData parts
      const parts: Part[] =
        typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : msg.content.map(
              (p): Part =>
                p.type === 'text'
                  ? { text: p.text }
                  : { inlineData: { data: p.imageBase64, mimeType: p.mimeType } },
            );
      push(msg.role === 'assistant' ? 'model' : 'user', parts.length > 0 ? parts : [{ text: ' ' }]);
    }

    // Gemini requires the conversation to start with a 'user' turn.
    if (contents.length === 0 || contents[0].role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
    }

    return {
      systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      contents,
    };
  }

  /** Converts OpenAI-style ToolDefinition[] to Gemini's Tool/FunctionDeclaration format. */
  private toGeminiTools(tools: ToolDefinition[]): Tool[] {
    const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: this.sanitizeSchema(tool.function.parameters) as FunctionDeclaration['parameters'],
    }));

    return [{ functionDeclarations }];
  }

  /** Strips JSON-Schema keywords Gemini's OpenAPI-subset Schema rejects. */
  private sanitizeSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map((item) => this.sanitizeSchema(item));
    if (schema === null || typeof schema !== 'object') return schema;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (UNSUPPORTED_SCHEMA_KEYS.includes(key)) continue;
      result[key] = this.sanitizeSchema(value);
    }

    // Gemini's proto Schema.enum chỉ nhận string[] — enum số (vd period_days:
    // [7, 14, 30, 90]) bị reject 400 "Invalid value ... (TYPE_STRING), 7".
    // Groq bỏ qua nên coerce tại đây, registry giữ nguyên kiểu gốc; tool
    // executor không ảnh hưởng vì arg dùng trong phép trừ (tự coerce số).
    if (Array.isArray(result.enum)) {
      result.enum = result.enum.map(String);
    }
    return result;
  }

  /** functionCall.args must be an object — tolerate malformed JSON from history. */
  private parseArgs(argsJson: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return {};
    }
  }

  /** functionResponse.response must be an object — wrap scalars/arrays. */
  private toResponseObject(contentJson: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(contentJson);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { result: parsed };
    } catch {
      return { result: contentJson };
    }
  }

  /** response.text() throws when the candidate has no text parts (e.g. safety block). */
  private safeText(result: GenerateContentResult): string {
    try {
      return result.response.text() ?? '';
    } catch {
      return '';
    }
  }
}
