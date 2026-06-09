import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'secretKeyCuaBan',
    });
  }

  async validate(payload: any) {
    // Từ chối tempToken chọn vai trò (purpose='role_selection') trên mọi route
    // nghiệp vụ — nó chỉ hợp lệ tại /auth/select-role (verify thủ công trong service).
    if (payload?.purpose === 'role_selection' || payload?.type === 'refresh') {
      return null; // → Passport coi như unauthorized
    }
    return {
      sub: payload.sub,
      email: payload.email,
      is_buyer: payload.is_buyer,
      is_seller: payload.is_seller,
      is_admin: payload.is_admin,
      // activeRole = workspace đang dùng (đã ký vào JWT); RolesGuard chỉ tin field này.
      allowedRoles: payload.allowedRoles ?? [],
      activeRole: payload.activeRole ?? null,
    };
  }
}
