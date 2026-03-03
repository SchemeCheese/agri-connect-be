import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { DatabaseModule } from '../../database/database.module';
import { EmailModule } from '../../communication/email/email.module';

@Module({
  imports: [DatabaseModule, EmailModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
