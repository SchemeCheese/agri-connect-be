import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { FirebaseLoginDto } from './dtos/firebase-login.dto';
import { RefreshTokenDto } from './dtos/refresh-token.dto';
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

  /**
   * POST /auth/refresh
   * Rotation: nhận { userId, refresh_token }, verify + đối chiếu hash trong DB,
   * trả về cặp access_token + refresh_token mới (refresh token cũ bị vô hiệu hoá).
   */
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.userId, dto.refresh_token);
  }

  /**
   * POST /auth/sync
   * Upsert a user record from a Firebase ID token. Idempotent: safe to call on
   * every Firebase sign-in (Google, email/password via Firebase, future providers).
   * Validates the token server-side via Firebase Admin, then inserts or updates
   * the row keyed by firebase_uid. Returns the app's JWT + user shape.
   * Alias of /auth/firebase with a clearer name for FE callers.
   */
  @Post('sync')
  syncFromFirebase(@Body() dto: FirebaseLoginDto) {
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