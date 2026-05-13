import { AIMode, AIRole } from '@prisma/client';

export class AiMessageDto {
  id: string;
  role: AIRole;
  content: string;
  intent?: string;
  model_used?: string;
  tokens_used?: number;
  created_at: Date;
}

export class AiSessionDto {
  id: string;
  mode: AIMode;
  context?: Record<string, unknown>;
  summary?: string;
  total_tokens_used: number;
  messages: AiMessageDto[];
  created_at: Date;
  updated_at: Date;
}
