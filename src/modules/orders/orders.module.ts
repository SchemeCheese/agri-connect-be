import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { DatabaseModule } from '../../database/database.module';
import { EmailModule } from '../../communication/email/email.module';
import { PaymentsModule } from '../payments/payments.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [DatabaseModule, EmailModule, PaymentsModule, ChatModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}