import { Module } from '@nestjs/common';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [VouchersController],
  providers: [VouchersService],
  exports: [VouchersService], // Export để OrdersModule dùng
})
export class VouchersModule {}
