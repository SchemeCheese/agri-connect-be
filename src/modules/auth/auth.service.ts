import { Injectable, BadRequestException, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { FirebaseLoginDto } from './dtos/firebase-login.dto';
import { getAuth } from 'firebase-admin/auth';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { EmailService } from '../../communication/email/email.service';
import { VerificationService } from './verification.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly verificationService: VerificationService,
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

  private buildAuthResponse(
    user: {
      id: string; email: string; full_name: string;
      is_buyer: boolean; is_seller: boolean; is_admin: boolean;
      avatar?: string | null;
    },
    accessToken: string,
    avatar?: string | null,
  ) {
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

  private buildJwtPayload(user: { id: string; email: string; is_buyer: boolean; is_seller: boolean; is_admin: boolean }) {
    return { sub: user.id, email: user.email, is_buyer: user.is_buyer, is_seller: user.is_seller, is_admin: user.is_admin };
  }

  // --- 1. ĐĂNG KÝ ---
  async register(dto: RegisterDto) {
    const otpEnabled = process.env.ENABLE_EMAIL_OTP !== 'false';
    const bypassOtpOnError = process.env.BYPASS_EMAIL_OTP_ON_ERROR === 'true';

    const existingUser = await this.databaseService.user.findUnique({ where: { email: dto.email } });

    if (existingUser) {
      if (existingUser.verified_email) {
        throw new BadRequestException('Email này đã được đăng ký và xác thực!');
      }
      await this.databaseService.user.delete({ where: { email: dto.email } });
    }

    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // Mọi tài khoản mới mặc định là BUYER. SELLER chỉ được kích hoạt qua flow
    // "Đăng ký bán hàng" (POST /auth/become-seller) sau khi user đã đăng nhập.
    const wantBuyer = dto.is_buyer ?? true;
    const wantSeller = dto.is_seller ?? false;
    const finalBuyer = wantBuyer || !wantSeller; // chống edge case cả 2 đều false

    const newUser = await this.databaseService.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        full_name: dto.full_name,
        is_buyer: finalBuyer,
        is_seller: wantSeller,
        verified_email: !otpEnabled,
      },
    });

    if (otpEnabled) {
      try {
        const verification = await this.verificationService.createVerification(newUser.id);
        const ok = await this.emailService.sendVerificationOTP(newUser.email, verification.code, newUser.full_name);
        if (!ok) throw new Error('EmailService returned false');

        return { message: 'Đăng ký thành công. Vui lòng kiểm tra email để lấy mã OTP.', userId: newUser.id, emailSent: true };
      } catch (err) {
        if (bypassOtpOnError) {
          await this.databaseService.user.update({ where: { id: newUser.id }, data: { verified_email: true } });
          return { message: 'Email OTP không gửi được (bỏ qua dev). Tài khoản đã kích hoạt.', userId: newUser.id, emailSent: false, autoVerified: true };
        }
        throw new ServiceUnavailableException('Không gửi được email OTP, vui lòng thử lại.');
      }
    }

    return { message: 'Đăng ký thành công (DEV: OTP tắt).', userId: newUser.id, emailSent: false, autoVerified: true };
  }

  // --- 2. XÁC THỰC OTP ---
  async verifyEmailOTP(userId: string, code: string) {
    await this.verificationService.verifyCode(userId, code);
    await this.databaseService.user.update({ where: { id: userId }, data: { verified_email: true } });
    return { message: 'Xác thực tài khoản thành công!' };
  }

  // --- 3. ĐĂNG NHẬP ---
  async login(dto: LoginDto) {
    const user = await this.databaseService.user.findUnique({ where: { email: dto.email } });

    if (!user) throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    if (!user.verified_email) throw new UnauthorizedException('Tài khoản chưa xác thực. Vui lòng kiểm tra email.');

    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) throw new UnauthorizedException('Email hoặc mật khẩu không đúng');

    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
    return this.buildAuthResponse(user, access_token);
  }

  // --- 3.5. NÂNG CẤP THÀNH SELLER ---
  // Idempotent: gọi nhiều lần OK. Sau khi mutate, sign JWT mới với is_seller=true
  // để FE thay token cũ (token cũ vẫn có thể tiếp tục dùng nhưng thiếu cờ seller).
  async becomeSeller(userId: string) {
    const user = await this.databaseService.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Tài khoản không tồn tại.');

    if (!user.is_seller) {
      await this.databaseService.user.update({
        where: { id: userId },
        data: { is_seller: true },
      });
      user.is_seller = true;
    }

    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
    return this.buildAuthResponse(user, access_token);
  }

  // --- 4. ĐĂNG NHẬP / ĐĂNG KÝ QUA FIREBASE (GOOGLE) ---
  async loginWithFirebase(dto: FirebaseLoginDto) {
    this.ensureFirebaseApp();

    let decoded: import('firebase-admin/auth').DecodedIdToken;
    try {
      decoded = await getAuth().verifyIdToken(dto.idToken);
    } catch {
      throw new UnauthorizedException('Firebase ID token không hợp lệ hoặc đã hết hạn.');
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('Google account không có email hợp lệ.');

    const firebaseName = decoded.name?.trim();
    const firebasePhoto = decoded.picture?.trim();

    let user = await this.databaseService.user.findUnique({ where: { email } });

    // DTO chỉ có `role` ('BUYER' | 'SELLER'). Derive boolean cờ tương ứng.
    const wantBuyer  = dto.role === undefined ? true  : dto.role === 'BUYER';
    const wantSeller = dto.role === undefined ? false : dto.role === 'SELLER';

    if (!user) {
      // Tạo tài khoản mới với role được chọn
      user = await this.databaseService.user.create({
        data: {
          email,
          password_hash: randomBytes(32).toString('hex'),
          full_name: firebaseName || email.split('@')[0],
          is_buyer: wantBuyer,   // mặc định là buyer nếu không chọn
          is_seller: wantSeller,
          verified_email: true,
        },
      });
    } else {
      // User đã tồn tại: merge role (chỉ thêm, không bỏ)
      const shouldUpdateName = firebaseName && (!user.full_name || user.full_name === user.email.split('@')[0]);
      const addBuyer  = wantBuyer  && !user.is_buyer;
      const addSeller = wantSeller && !user.is_seller;

      if (!user.verified_email || shouldUpdateName || addBuyer || addSeller) {
        user = await this.databaseService.user.update({
          where: { id: user.id },
          data: {
            verified_email: true,
            ...(shouldUpdateName ? { full_name: firebaseName } : {}),
            ...(addBuyer  ? { is_buyer: true }  : {}),
            ...(addSeller ? { is_seller: true } : {}),
          },
        });
      }
    }

    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
    return this.buildAuthResponse(user, access_token, firebasePhoto || undefined);
  }
}
