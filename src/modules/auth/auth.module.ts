import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { DatabaseModule } from '../../database/database.module';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy'; 
import { PassportModule } from '@nestjs/passport';
// THÊM 2 IMPORT NÀY:
import { EmailModule } from '../../communication/email/email.module';
import { VerificationService } from './verification.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';


@Module({
  imports: [
    PassportModule,
    DatabaseModule,
    EmailModule, // <- Đã thêm EmailModule vào đây
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'secretKeyCuaBan',
      signOptions: { expiresIn: '1d' },
    }),
  ],
  controllers: [AuthController, GoogleAuthController],
  providers: [AuthService, JwtStrategy, VerificationService, GoogleAuthService], // <- Đã thêm VerificationService vào đây
})
export class AuthModule {}