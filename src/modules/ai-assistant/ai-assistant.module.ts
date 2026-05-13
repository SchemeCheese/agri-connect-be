import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AIAssistantGateway } from './ai-assistant.gateway';
import { AIAssistantService } from './services/ai-assistant.service';
import { IntentClassifierService } from './services/intent-classifier.service';
import { SessionService } from './services/session.service';
import { RateLimitService } from './services/rate-limit.service';
import { GroqProvider } from './providers/groq.provider';
import { InputSanitizer } from './security/input-sanitizer';
import { OutputValidator } from './security/output-validator';
import { LLM_PROVIDER } from './providers/llm.interface';
// Tools
import { ProductSearchTool } from './tools/product-search.tool';
import { PriceAnalysisTool } from './tools/price-analysis.tool';
import { NegotiationGuideTool } from './tools/negotiation-guide.tool';
import { SellerRecommendationTool } from './tools/seller-recommendation.tool';
import { PlatformFaqTool } from './tools/platform-faq.tool';
import { ToolExecutorService } from './tools/tool-executor.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'secretKeyCuaBan'),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    // LLM provider — swap to Claude/OpenAI by replacing GroqProvider
    { provide: LLM_PROVIDER, useClass: GroqProvider },

    // Security
    InputSanitizer,
    OutputValidator,

    // Core services
    RateLimitService,
    SessionService,
    IntentClassifierService,

    // Tool layer — individual tools injected into ToolExecutorService
    ProductSearchTool,
    PriceAnalysisTool,
    NegotiationGuideTool,
    SellerRecommendationTool,
    PlatformFaqTool,
    ToolExecutorService,

    // Orchestrator
    AIAssistantService,

    // WebSocket gateway
    AIAssistantGateway,
  ],
  exports: [AIAssistantService, SessionService],
})
export class AIAssistantModule {}
