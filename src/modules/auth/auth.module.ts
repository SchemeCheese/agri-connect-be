import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { DatabaseModule } from '../../database/database.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    DatabaseModule, // Để dùng DatabaseService
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'secretKeyCuaBan', // Nên đưa vào file .env
      signOptions: { expiresIn: '1d' }, // Token hết hạn sau 1 ngày
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}