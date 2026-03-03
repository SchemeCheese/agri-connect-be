import { Module } from '@nestjs/common';
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

@Module({
  imports: [
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
