import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { FirebaseLoginDto } from './dtos/firebase-login.dto';
import { RefreshTokenDto } from './dtos/refresh-token.dto';
import { SelectRoleDto, SwitchRoleDto } from './dtos/select-role.dto';
import { JwtAuthGuard } from './decorators/guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Gửi OTP qua đăng ký: 5 request / 5 phút / IP (chống spam OTP/email).
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // Đăng nhập: 5 request / 5 phút / IP (chống brute-force mật khẩu).
  @Throttle({ default: { limit: 5, ttl: 300000 } })
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

  /**
   * POST /auth/select-role
   * Bước 2 của login khi user sở hữu cả BUYER lẫn SELLER: gửi { tempToken, role }.
   * BE verify tempToken (purpose=role_selection) + đối chiếu DB rồi phát token đầy
   * đủ với activeRole đã chọn. Public — tempToken tự nó là bằng chứng xác thực.
   */
  @Post('select-role')
  selectRole(@Body() dto: SelectRoleDto) {
    return this.authService.selectRole(dto.tempToken, dto.role);
  }

  /**
   * POST /auth/switch-role
   * Đổi workspace khi đang đăng nhập (nút "Đổi vai trò"). Yêu cầu access token hợp
   * lệ; BE kiểm tra user thực sự sở hữu vai trò mới trước khi phát token mới.
   */
  @UseGuards(JwtAuthGuard)
  @Post('switch-role')
  switchRole(@Request() req, @Body() dto: SwitchRoleDto) {
    return this.authService.switchRole(req.user.sub, dto.role);
  }
}