import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
  INTENT_LABELS,
  IntentLabel,
} from '../prompts/intent-classifier.prompt';
import { LLM_PROVIDER } from '../providers/llm.interface';
import type { ILLMProvider } from '../providers/llm.interface';
import { InputSanitizer } from '../security/input-sanitizer';

// Fast model — cheap, deterministic classification
const CLASSIFIER_MODEL = 'llama-3.1-8b-instant';

@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: ILLMProvider,
    private readonly sanitizer: InputSanitizer,
  ) {}

  async classify(userMessage: string): Promise<IntentLabel> {
    // Layer 1: keyword blacklist — 0ms, 0 cost
    if (this.sanitizer.isObviouslyOffTopic(userMessage)) {
      this.logger.debug(`[Keyword block] "${userMessage.substring(0, 60)}"`);
      return 'OFF_TOPIC';
    }

    // Layer 2: LLM classifier with small fast model
    try {
      const result = await this.llm.complete({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: INTENT_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        maxTokens: 20,
        temperature: 0.1,
      });

      const label = result.content.trim().toUpperCase() as IntentLabel;

      if (INTENT_LABELS.includes(label as IntentLabel)) {
        this.logger.debug(`[Intent] "${userMessage.substring(0, 60)}" → ${label}`);
        return label;
      }

      // Model returned garbage — default to OFF_TOPIC for safety
      this.logger.warn(`[Intent] Unrecognized label "${result.content}" — defaulting OFF_TOPIC`);
      return 'OFF_TOPIC';
    } catch (err: unknown) {
      this.logger.error(`Intent classification failed: ${(err as Error).message}`);
      // Fail open: treat as FAQ (safest fallback — LLM will still apply domain constraints)
      return 'FAQ';
    }
  }
}
