import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';

@Module({
  imports: [DatabaseModule, AuthModule, ProductsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
