import { IsEnum } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class SelectPaymentDto {
  @IsEnum(PaymentMethod)
  payment_method: PaymentMethod;
}
