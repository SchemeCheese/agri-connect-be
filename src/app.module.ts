import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ChatModule } from './modules/chat/chat.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SearchModule } from './modules/search/search.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { ShopsModule } from './modules/shops/shops.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { BehaviorsModule } from './modules/behaviors/behaviors.module';
import { AIAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Rate limit mặc định: 20 request / 60s cho MỖI route, theo IP. Endpoint nhạy
    // cảm (login, OTP, checkout, review) bị siết chặt hơn bằng @Throttle tại handler.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 20 }]),
    DatabaseModule,
    AuthModule,
    ProductsModule,
    OrdersModule,
    ChatModule,
    ReviewsModule,
    ProfileModule,
    SearchModule,
    VouchersModule,
    ShopsModule,
    PaymentsModule,
    RecommendationsModule,
    BehaviorsModule,
    AIAssistantModule,
    AdminModule,
  ],
  controllers: [AppController],
  // ThrottlerGuard toàn cục → mọi route được rate-limit (mặc định 20/60s/route/IP).
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
