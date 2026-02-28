import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [
    DatabaseModule,
    MulterModule.register({}), // Đã config chi tiết ở Controller
  ],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
