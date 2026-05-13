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
    return {
      sub: payload.sub,
      email: payload.email,
      is_buyer: payload.is_buyer,
      is_seller: payload.is_seller,
      is_admin: payload.is_admin,
    };
  }
}
