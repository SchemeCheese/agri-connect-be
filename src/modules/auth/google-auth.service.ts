import { Injectable, HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { JwtService } from '@nestjs/jwt';
import { getAuth } from 'firebase-admin/auth';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { GoogleAuthRole } from './dtos/firebase-login.dto';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  private ensureFirebaseApp() {
    if (getApps().length > 0) return;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new ServiceUnavailableException('Firebase config is missing on the server.');
    }

    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }

  private roleFlags(role?: GoogleAuthRole) {
    // BUYER là role base — mọi user (kể cả seller) đều có quyền mua hàng,
    // nên RolesGuard cho /orders/checkout pass. SELLER là quyền bổ sung.
    return {
      is_buyer: true,
      is_seller: role === GoogleAuthRole.SELLER,
    };
  }

  private buildJwtPayload(user: { id: string; email: string; is_buyer: boolean; is_seller: boolean; is_admin: boolean }) {
    return {
      sub: user.id,
      email: user.email,
      is_buyer: user.is_buyer,
      is_seller: user.is_seller,
      is_admin: user.is_admin,
    };
  }

  async registerWithGoogle(idToken: string, role?: GoogleAuthRole) {
    this.ensureFirebaseApp();

    let decoded: import('firebase-admin/auth').DecodedIdToken;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Firebase ID token không hợp lệ hoặc đã hết hạn.');
    }

    const firebase_uid = decoded.uid;
    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('Google account không có email hợp lệ.');

    const firebaseName = decoded.name?.trim();
    const firebasePhoto = decoded.picture?.trim();
    const existing = (await this.prisma.user.findUnique({ where: { firebase_uid } }))
      ?? (await this.prisma.user.findUnique({ where: { email } }));
    const flags = this.roleFlags(role);
    const now = new Date();

    if (existing) {
      const roleAlreadyExists = flags.is_buyer ? existing.is_buyer : flags.is_seller ? existing.is_seller : false;
      if (roleAlreadyExists) {
        throw new HttpException(`Tài khoản này đã được đăng ký với vai trò ${role || 'được chọn'}.`, HttpStatus.CONFLICT);
      }

      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          firebase_uid,
          verified_email: true,
          full_name: existing.full_name || firebaseName || email.split('@')[0],
          display_name: firebaseName || existing.display_name,
          photo_url: firebasePhoto || existing.photo_url,
          provider: 'google',
          last_login_at: now,
          ...flags,
        },
      });

      return {
        message: 'Đăng ký thành công. Vui lòng đăng nhập để tiếp tục.',
        user: {
          id: updated.id,
          email: updated.email,
          full_name: updated.full_name,
          is_buyer: updated.is_buyer,
          is_seller: updated.is_seller,
          is_admin: updated.is_admin,
        },
      };
    }

    const created = await this.prisma.user.create({
      data: {
        email,
        firebase_uid,
        password_hash: await bcrypt.hash(randomBytes(16).toString('hex'), 10),
        full_name: firebaseName || email.split('@')[0],
        display_name: firebaseName || email.split('@')[0],
        photo_url: firebasePhoto || null,
        provider: 'google',
        last_login_at: now,
        verified_email: true,
        is_admin: false,
        ...flags,
      },
    });

    return {
      message: 'Đăng ký thành công. Vui lòng đăng nhập để tiếp tục.',
      user: {
        id: created.id,
        email: created.email,
        full_name: created.full_name,
        is_buyer: created.is_buyer,
        is_seller: created.is_seller,
        is_admin: created.is_admin,
      },
    };
  }

  async loginWithGoogle(idToken: string, selectedRole?: GoogleAuthRole) {
    this.ensureFirebaseApp();

    let decoded: import('firebase-admin/auth').DecodedIdToken;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Firebase ID token không hợp lệ hoặc đã hết hạn.');
    }

    const firebase_uid = decoded.uid;
    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('Google account không có email hợp lệ.');

    let user = (await this.prisma.user.findUnique({ where: { firebase_uid } }))
      ?? (await this.prisma.user.findUnique({ where: { email } }));
    if (!user) {
      throw new HttpException('Tài khoản chưa được đăng ký. Vui lòng đăng ký trước.', HttpStatus.NOT_FOUND);
    }
    // Touch sync fields + last_login_at every time we let them in
    user = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        firebase_uid,
        provider: 'google',
        last_login_at: new Date(),
        ...(decoded.name ? { display_name: decoded.name.trim() } : {}),
        ...(decoded.picture ? { photo_url: decoded.picture.trim() } : {}),
      },
    });

    if (selectedRole) {
      const selectedRoleIsBuyer = selectedRole === GoogleAuthRole.BUYER;
      const selectedRoleIsSeller = selectedRole === GoogleAuthRole.SELLER;

      if ((selectedRoleIsBuyer && !user.is_buyer) || (selectedRoleIsSeller && !user.is_seller)) {
        throw new HttpException(
          `Tài khoản này chưa được đăng ký với vai trò ${selectedRole}.`,
          HttpStatus.FORBIDDEN,
        );
      }

      const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
      return this.buildAuthResponse(user, access_token);
    }

    const roles = [
      user.is_buyer ? GoogleAuthRole.BUYER : null,
      user.is_seller ? GoogleAuthRole.SELLER : null,
    ].filter(Boolean);
    if (roles.length > 1) {
      // HTTP 300 Multiple Choices — Nest HttpStatus enum không có hằng này, dùng số trực tiếp
      throw new HttpException({ message: 'Cần chọn vai trò để đăng nhập', roles }, 300);
    }

    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
    return this.buildAuthResponse(user, access_token);
  }

  private buildAuthResponse(user: any, accessToken: string, avatar?: string | null) {
    return {
      message: 'Đăng nhập thành công',
      access_token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        is_buyer: user.is_buyer,
        is_seller: user.is_seller,
        is_admin: user.is_admin,
        avatar: avatar ?? '',
      },
    };
  }
}
