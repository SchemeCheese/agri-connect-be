import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      // Báo cho NestJS biết token nằm ở phần Header (Bearer Token)
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // Từ chối token đã hết hạn
      secretOrKey: process.env.JWT_SECRET || 'secretKeyCuaBan', // Phải GIỐNG HỆT chuỗi bí mật trong AuthModule
    });
  }

  // Hàm này tự động chạy sau khi token được giải mã thành công
  async validate(payload: any) {
    // Trả về object này, NestJS sẽ tự động gán nó vào `req.user` ở Controller
    return { 
      sub: payload.sub, 
      email: payload.email, 
      role: payload.role 
    };
  }
}