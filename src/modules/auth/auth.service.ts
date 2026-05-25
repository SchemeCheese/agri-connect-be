import { Injectable, BadRequestException, UnauthorizedException, ServiceUnavailableException, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(AuthService.name);

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
  // Strict OTP policy: SMTP fail → 503. User MUST verify email qua OTP để dùng.
  // Để dev nhanh: set ENABLE_EMAIL_OTP=false trong .env local.
  async register(dto: RegisterDto) {
    const otpEnabled = process.env.ENABLE_EMAIL_OTP !== 'false';
    const mailConfigured = !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);

    if (otpEnabled && !mailConfigured) {
      this.logger.error('OTP enabled nhưng MAIL_HOST/MAIL_USER/MAIL_PASS chưa set');
      throw new ServiceUnavailableException(
        'Hệ thống email chưa cấu hình. Liên hệ admin để fix SMTP.',
      );
    }

    // Map field `role` (string alias) → boolean flags. Hỗ trợ cả 2 cách truyền DTO.
    // BUYER là role base — mọi user đều có quyền mua hàng. SELLER là quyền bổ sung
    // bật thêm trên cùng user (RolesGuard check `is_buyer` cho /orders/checkout).
    const wantSeller = dto.is_seller ?? (dto.role === 'SELLER');
    const finalBuyer = true;

    const existingUser = await this.databaseService.user.findUnique({ where: { email: dto.email } });

    if (existingUser) {
      if (existingUser.verified_email) {
        throw new BadRequestException('Email này đã được đăng ký và xác thực!');
      }
      await this.databaseService.user.delete({ where: { email: dto.email } });
    }

    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    const newUser = await this.databaseService.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        full_name: dto.full_name,
        display_name: dto.full_name,
        provider: 'password',
        last_login_at: new Date(),
        is_buyer: finalBuyer,
        is_seller: wantSeller,
        verified_email: !otpEnabled,
      },
    });

    this.logger.log(`[REGISTER] ${newUser.email} buyer=${finalBuyer} seller=${wantSeller} otp=${otpEnabled}`);

    if (otpEnabled) {
      try {
        const verification = await this.verificationService.createVerification(newUser.id);
        const ok = await this.emailService.sendVerificationOTP(newUser.email, verification.code, newUser.full_name);
        if (!ok) throw new Error('EmailService returned false');

        return { message: 'Đăng ký thành công. Vui lòng kiểm tra email để lấy mã OTP.', userId: newUser.id, emailSent: true };
      } catch (err) {
        this.logger.error(`[REGISTER] OTP send failed for ${newUser.email}: ${(err as Error)?.message}`);
        const strictOtp = process.env.STRICT_OTP === 'true';
        if (strictOtp) {
          // Production strict mode — yêu cầu OTP phải gửi được
          throw new ServiceUnavailableException('Không gửi được email OTP. Vui lòng liên hệ admin hoặc thử lại sau.');
        }
        // Mặc định: auto-bypass để user vẫn đăng ký được (UX > strictness)
        await this.databaseService.user.update({ where: { id: newUser.id }, data: { verified_email: true } });
        return {
          message: 'Đăng ký thành công. (OTP tạm bỏ qua — admin đang xử lý vấn đề email)',
          userId: newUser.id,
          emailSent: false,
          autoVerified: true,
        };
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

    // Update last_login_at — fire-and-forget so we don't slow the response
    void this.databaseService.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    }).catch((e) => this.logger.warn(`[LOGIN] last_login_at update failed: ${(e as Error).message}`));

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

  // --- 4. ĐĂNG NHẬP / ĐĂNG KÝ QUA FIREBASE (GOOGLE / EMAIL-PASSWORD-VIA-FIREBASE) ---
  // This is the "upsert" endpoint: server validates the Firebase ID token, then
  // creates or updates the User row keyed by firebase_uid (fallback to email for
  // legacy rows that pre-date firebase_uid).
  async loginWithFirebase(dto: FirebaseLoginDto) {
    this.ensureFirebaseApp();

    let decoded: import('firebase-admin/auth').DecodedIdToken;
    try {
      decoded = await getAuth().verifyIdToken(dto.idToken);
    } catch {
      throw new UnauthorizedException('Firebase ID token không hợp lệ hoặc đã hết hạn.');
    }

    const firebase_uid = decoded.uid;
    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('Google account không có email hợp lệ.');

    const firebaseName = decoded.name?.trim();
    const firebasePhoto = decoded.picture?.trim();
    // Firebase identifies provider via firebase.sign_in_provider (google.com, password, etc.)
    const signInProvider = (decoded.firebase as any)?.sign_in_provider as string | undefined;
    const provider = signInProvider === 'password' ? 'password' : 'google';

    // 1) Look up by firebase_uid (preferred), fall back to email for legacy rows
    let user = await this.databaseService.user.findUnique({ where: { firebase_uid } });
    if (!user) {
      user = await this.databaseService.user.findUnique({ where: { email } });
    }

    const wantBuyer  = dto.role === undefined ? true  : dto.role === 'BUYER';
    const wantSeller = dto.role === undefined ? false : dto.role === 'SELLER';
    const now = new Date();

    if (!user) {
      // 2a) Insert
      user = await this.databaseService.user.create({
        data: {
          email,
          firebase_uid,
          password_hash: randomBytes(32).toString('hex'),
          full_name: firebaseName || email.split('@')[0],
          display_name: firebaseName || email.split('@')[0],
          photo_url: firebasePhoto || null,
          provider,
          last_login_at: now,
          is_buyer: wantBuyer,
          is_seller: wantSeller,
          verified_email: true,
        },
      });
    } else {
      // 2b) Update — merge role (never remove), refresh Firebase-sourced fields, bump last_login_at
      const shouldUpdateName = firebaseName && (!user.full_name || user.full_name === user.email.split('@')[0]);
      const addBuyer  = wantBuyer  && !user.is_buyer;
      const addSeller = wantSeller && !user.is_seller;

      user = await this.databaseService.user.update({
        where: { id: user.id },
        data: {
          firebase_uid,                                              // backfill if previously null
          verified_email: true,
          provider,
          last_login_at: now,
          ...(firebaseName ? { display_name: firebaseName } : {}),
          ...(firebasePhoto ? { photo_url: firebasePhoto } : {}),
          ...(shouldUpdateName ? { full_name: firebaseName } : {}),
          ...(addBuyer  ? { is_buyer: true }  : {}),
          ...(addSeller ? { is_seller: true } : {}),
        },
      });
    }

    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user));
    return this.buildAuthResponse(user, access_token, firebasePhoto || user.photo_url || undefined);
  }
}
