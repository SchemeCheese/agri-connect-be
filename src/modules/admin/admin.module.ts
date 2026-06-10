import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { DisputeController } from './dispute.controller';
import { AdminService } from './admin.service';
import { DisputeService } from './dispute.service';

// DatabaseModule là @Global() nên không cần import lại. JwtAuthGuard dùng strategy
// 'jwt' do AuthModule đăng ký toàn cục.
@Module({
  controllers: [AdminController, DisputeController],
  providers: [AdminService, DisputeService],
})
export class AdminModule {}
