import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import {
  ILLMProvider,
  LLMCompleteResult,
  LLMCompleteWithToolsOptions,
  LLMCompleteWithToolsResult,
  LLMConversationMessage,
  LLMStreamOptions,
  ToolCall,
  textOfContent,
} from './llm.interface';

@Injectable()
export class GroqProvider implements ILLMProvider, OnModuleInit {
  private readonly logger = new Logger(GroqProvider.name);
  private client!: Groq;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROQ_API_KEY not set — AI features will be unavailable');
    }
    this.client = new Groq({ apiKey: apiKey ?? 'missing' });
  }

  async *stream(options: LLMStreamOptions): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: this.toGroqMessages(options.messages),
      max_tokens: options.maxTokens ?? 800,
      temperature: options.temperature ?? 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }

  async complete(options: LLMStreamOptions): Promise<LLMCompleteResult> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: this.toGroqMessages(options.messages),
      max_tokens: options.maxTokens ?? 150,
      temperature: options.temperature ?? 0.1,
      stream: false,
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      tokensUsed: response.usage?.total_tokens ?? 0,
      model: response.model,
    };
  }

  async completeWithTools(options: LLMCompleteWithToolsOptions): Promise<LLMCompleteWithToolsResult> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: this.toGroqMessages(options.messages),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: options.tools as any,
      tool_choice: 'auto',
      max_tokens: options.maxTokens ?? 300,
      temperature: options.temperature ?? 0.2,
      stream: false,
    });

    const choice = response.choices[0];
    const finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length';

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason,
      tokensUsed: response.usage?.total_tokens ?? 0,
    };
  }

  /**
   * Maps our internal LLMConversationMessage union to the Groq SDK's expected format.
   * The Groq SDK uses the same message format as OpenAI.
   */
  private toGroqMessages(messages: LLMConversationMessage[]): ChatCompletionMessageParam[] {
    return messages.map((msg): ChatCompletionMessageParam => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        } as ChatCompletionMessageParam;
      }

      if (msg.role === 'assistant' && 'tool_calls' in msg) {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        } as ChatCompletionMessageParam;
      }

      // Standard user / assistant / system message.
      // Groq Llama text-only — multimodal content bị flatten về text, ảnh bỏ qua.
      return { role: msg.role, content: textOfContent(msg.content) } as ChatCompletionMessageParam;
    });
  }
}
