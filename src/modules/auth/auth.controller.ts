import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { FirebaseAuthDto } from './dtos/firebase-auth.dto';

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

  // THÊM API MỚI CHO OTP
  @Post('verify-email')
  verifyEmail(@Body() body: { userId: string; code: string }) {
    return this.authService.verifyEmailOTP(body.userId, body.code);
  }

  /**
   * POST /auth/firebase
   *
   * Accepts a Firebase ID token (obtained after Google sign-in on the frontend)
   * and returns a standard JWT for use with all other API endpoints.
   *
   * Body: { idToken: string, role?: "BUYER" | "SELLER" }
   */
  @Post('firebase')
  loginWithFirebase(@Body() dto: FirebaseAuthDto) {
    return this.authService.loginWithFirebase(dto);
  }
}