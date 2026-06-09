import { Injectable, BadRequestException, UnauthorizedException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
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

  private async buildAuthResponse(
    user: {
      id: string; email: string; full_name: string;
      is_buyer: boolean; is_seller: boolean; is_admin: boolean;
      avatar?: string | null;
    },
    avatar?: string | null,
  ) {
    const { access_token, refresh_token } = await this.issueTokens(user);
    return {
      message: 'Đăng nhập thành công',
      access_token,
      refresh_token,
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

  // SHA-256 pre-hash để nén refresh token (dài) xuống 64 hex char trước khi bcrypt,
  // tránh giới hạn 72 byte của bcrypt làm rotation mất tác dụng (xem schema.prisma).
  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  // Mask an email for logs: "hoangkimchi46@gmail.com" → "ho***********@gmail.com".
  // Never log the full address (PII) — only enough to recognise it in support.
  private maskEmail(email: string): string {
    const [local, domain] = String(email).split('@');
    if (!domain) return '***';
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  // Sinh cặp access (ngắn hạn) + refresh (dài hạn) và LƯU hash refresh vào DB.
  // Gọi ở mọi điểm phát token (login / firebase / become-seller / refresh) → mỗi
  // lần phát là một lần rotate: hash cũ bị ghi đè, refresh token cũ hết hiệu lực.
  private async issueTokens(user: { id: string; email: string; is_buyer: boolean; is_seller: boolean; is_admin: boolean }) {
    // expiresIn từ env là string thuần; SignOptions.expiresIn nay là
    // `number | StringValue` (StringValue là template-literal type của `ms`),
    // nên cast về đúng kiểu field — runtime vẫn nhận chuỗi '1h'/'7d' như cũ.
    const access_token = await this.jwtService.signAsync(this.buildJwtPayload(user), {
      expiresIn: (process.env.JWT_ACCESS_EXPIRES || '1h') as JwtSignOptions['expiresIn'],
    });
    const refresh_token = await this.jwtService.signAsync(
      { sub: user.id, type: 'refresh' },
      { expiresIn: (process.env.JWT_REFRESH_EXPIRES || '7d') as JwtSignOptions['expiresIn'] },
    );

    const refresh_token_hash = await bcrypt.hash(this.sha256(refresh_token), await bcrypt.genSalt());
    await this.databaseService.user.update({
      where: { id: user.id },
      data: { refresh_token_hash },
    });

    return { access_token, refresh_token };
  }

  // --- REFRESH TOKEN ROTATION ---
  // Verify chữ ký + hạn của refresh token, đối chiếu hash trong DB, rồi phát cặp
  // token mới (rotate). Nếu hash không khớp → nghi ngờ token bị lộ/tái sử dụng:
  // xoá hash để buộc đăng nhập lại.
  async refreshToken(userId: string, refreshToken: string) {
    let payload: { sub?: string; type?: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã hết hạn.');
    }

    if (payload.type !== 'refresh' || payload.sub !== userId) {
      throw new UnauthorizedException('Refresh token không hợp lệ.');
    }

    const user = await this.databaseService.user.findUnique({ where: { id: userId } });
    if (!user || !user.refresh_token_hash) {
      throw new UnauthorizedException('Phiên đăng nhập không tồn tại. Vui lòng đăng nhập lại.');
    }

    const matches = await bcrypt.compare(this.sha256(refreshToken), user.refresh_token_hash);
    if (!matches) {
      // Refresh token đúng chữ ký nhưng không khớp hash hiện tại → có thể là token cũ
      // đã bị rotate hoặc bị đánh cắp. Vô hiệu hoá phiên để an toàn.
      await this.databaseService.user.update({
        where: { id: userId },
        data: { refresh_token_hash: null },
      });
      throw new UnauthorizedException('Refresh token không hợp lệ. Vui lòng đăng nhập lại.');
    }

    // issueTokens (gọi trong buildAuthResponse) sẽ ghi đè hash → rotate.
    return this.buildAuthResponse(user, user.photo_url ?? undefined);
  }

  // --- 1. ĐĂNG KÝ ---
  // Strict OTP policy: SMTP fail → 503. User MUST verify email qua OTP để dùng.
  // Để dev nhanh: set ENABLE_EMAIL_OTP=false trong .env local.
  async register(dto: RegisterDto) {
    const otpEnabled = process.env.ENABLE_EMAIL_OTP !== 'false';
    const mailConfigured = !!(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS);

    // Trace entry: which email, is OTP on, is the mail provider configured.
    this.logger.log(
      `[REGISTER] reached BE — email=${this.maskEmail(dto.email)} otpEnabled=${otpEnabled} mailConfigured=${mailConfigured}`,
    );

    if (otpEnabled && !mailConfigured) {
      this.logger.error('[REGISTER] OTP enabled nhưng MAIL_HOST/MAIL_USER/MAIL_PASS chưa set — Email service is not configured');
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

      // User đã tồn tại nhưng CHƯA xác thực email: KHÔNG xoá User record (tránh
      // huỷ dữ liệu liên quan / FK). Chỉ refresh mã OTP và gửi lại email.
      if (!otpEnabled) {
        // OTP tắt (dev): đánh dấu verified luôn để user dùng được.
        await this.databaseService.user.update({
          where: { id: existingUser.id },
          data: { verified_email: true },
        });
        return { message: 'Tài khoản đã sẵn sàng (DEV: OTP tắt).', userId: existingUser.id, emailSent: false, autoVerified: true };
      }

      try {
        const verification = await this.verificationService.createVerification(existingUser.id);
        // DEV-ONLY: surface the OTP in logs so you can test without a real inbox.
        // Gated on NODE_ENV so the code is NEVER printed in production.
        if (process.env.NODE_ENV !== 'production') {
          this.logger.debug(`[REGISTER][DEV] OTP for ${this.maskEmail(existingUser.email)} = ${verification.code}`);
        }
        const ok = await this.emailService.sendVerificationOTP(existingUser.email, verification.code, existingUser.full_name);
        if (!ok) throw new Error('EmailService returned false');

        this.logger.log(`[REGISTER] Resent OTP, email actually sent to ${this.maskEmail(existingUser.email)}`);
        return { message: 'Tài khoản đã tồn tại nhưng chưa xác thực. Mã OTP mới đã được gửi lại.', userId: existingUser.id, emailSent: true };
      } catch (err) {
        this.logger.error(`[REGISTER] OTP resend FAILED for ${this.maskEmail(existingUser.email)}: ${(err as Error)?.message}`);
        // Default: DO NOT pretend success and DO NOT silently verify (that would
        // bypass OTP). Surface a 503 so the client shows a clear error.
        // Opt-in escape hatch for local/dev only: STRICT_OTP=false → auto-bypass.
        const allowBypass = process.env.STRICT_OTP === 'false';
        if (!allowBypass) {
          throw new ServiceUnavailableException('Không gửi được email OTP. Vui lòng kiểm tra email hoặc thử lại sau.');
        }
        await this.databaseService.user.update({ where: { id: existingUser.id }, data: { verified_email: true } });
        return {
          message: 'Đăng ký thành công. (OTP tạm bỏ qua — admin đang xử lý vấn đề email)',
          userId: existingUser.id,
          emailSent: false,
          autoVerified: true,
        };
      }
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
        // DEV-ONLY OTP log (never printed in production).
        if (process.env.NODE_ENV !== 'production') {
          this.logger.debug(`[REGISTER][DEV] OTP for ${this.maskEmail(newUser.email)} = ${verification.code}`);
        }
        const ok = await this.emailService.sendVerificationOTP(newUser.email, verification.code, newUser.full_name);
        if (!ok) throw new Error('EmailService returned false');

        this.logger.log(`[REGISTER] OTP email actually sent to ${this.maskEmail(newUser.email)}`);
        return { message: 'Đăng ký thành công. Vui lòng kiểm tra email để lấy mã OTP.', userId: newUser.id, emailSent: true };
      } catch (err) {
        this.logger.error(`[REGISTER] OTP send FAILED for ${this.maskEmail(newUser.email)}: ${(err as Error)?.message}`);
        // Default: surface the failure (no silent verify → no OTP bypass).
        // Opt-in escape hatch for local/dev only: STRICT_OTP=false → auto-bypass.
        const allowBypass = process.env.STRICT_OTP === 'false';
        if (!allowBypass) {
          throw new ServiceUnavailableException('Không gửi được email OTP. Vui lòng kiểm tra email hoặc thử lại sau.');
        }
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

    return this.buildAuthResponse(user);
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

    return this.buildAuthResponse(user);
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

    return this.buildAuthResponse(user, firebasePhoto || user.photo_url || undefined);
  }
}
