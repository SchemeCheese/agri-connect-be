import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
