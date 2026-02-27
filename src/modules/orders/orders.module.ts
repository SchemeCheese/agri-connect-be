import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { DatabaseModule } from '../../database/database.module'; // Thêm dòng này

@Module({
  imports: [DatabaseModule], // Khai báo vào imports
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}