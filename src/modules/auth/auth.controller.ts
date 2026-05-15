import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { FirebaseLoginDto } from './dtos/firebase-login.dto';
import { JwtAuthGuard } from './decorators/guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('firebase')
  firebaseLogin(@Body() dto: FirebaseLoginDto) {
    return this.authService.loginWithFirebase(dto);
  }

  // THÊM API MỚI CHO OTP
  @Post('verify-email')
  verifyEmail(@Body() body: { userId: string; code: string }) {
    return this.authService.verifyEmailOTP(body.userId, body.code);
  }

  /**
   * POST /auth/become-seller
   * Bật cờ is_seller=true cho user hiện tại, trả về JWT mới (chứa cờ seller).
   * Idempotent — user đã là seller cũng OK.
   */
  @UseGuards(JwtAuthGuard)
  @Post('become-seller')
  becomeSeller(@Request() req) {
    return this.authService.becomeSeller(req.user.sub);
  }
}