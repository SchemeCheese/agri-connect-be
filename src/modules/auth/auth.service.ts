import { Injectable, BadRequestException, UnauthorizedException, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
// THÊM IMPORT:
import { EmailService } from '../../communication/email/email.service';
import { VerificationService } from './verification.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    // INJECT THÊM 2 SERVICE NÀY:
    private readonly emailService: EmailService,
    private readonly verificationService: VerificationService,
  ) {}

  // --- 1. ĐĂNG KÝ (TẠO TÀI KHOẢN & GỬI OTP) ---
  async register(dto: RegisterDto) {
    const otpEnabled = process.env.ENABLE_EMAIL_OTP !== 'false';
    const bypassOtpOnError = process.env.BYPASS_EMAIL_OTP_ON_ERROR === 'true';

    // 1. Kiểm tra email đã tồn tại chưa
    const existingUser = await this.databaseService.user.findUnique({
      where: { email: dto.email },
    });
    
    if (existingUser) {
      // Chỉ chặn khi tài khoản đã xác thực email; cho phép ghi đè nếu còn chưa verified
      if (existingUser.verified_email) {
        throw new BadRequestException('Email này đã được đăng ký và xác thực!');
      }

      // Nếu chưa xác thực, xóa bản ghi cũ để tạo lại và gửi OTP mới
      await this.databaseService.user.delete({ where: { email: dto.email } });
    }

    // 2. Mã hóa mật khẩu
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // 3. Lưu vào DB (Trạng thái MẶC ĐỊNH là chưa xác thực)
    const newUser = await this.databaseService.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        full_name: dto.full_name,
        role: dto.role,
        verified_email: !otpEnabled, // Nếu tắt OTP (dev) thì auto verify
      },
    });

    // 4. Nếu bật OTP: sinh mã + gửi mail, nếu lỗi có thể bypass theo env
    if (otpEnabled) {
      try {
        const verification = await this.verificationService.createVerification(newUser.id);
        await this.emailService.sendVerificationOTP(newUser.email, verification.code, newUser.full_name);

        return {
          message: 'Đăng ký thành công bước 1. Vui lòng kiểm tra email để lấy mã OTP.',
          userId: newUser.id,
          emailSent: true,
        };
      } catch (err) {
        if (bypassOtpOnError) {
          // Cho môi trường dev/staging: nếu gửi mail thất bại, tự xác thực để không chặn đăng ký
          await this.databaseService.user.update({
            where: { id: newUser.id },
            data: { verified_email: true },
          });
          return {
            message: 'Email OTP không gửi được (bỏ qua trong môi trường dev). Tài khoản đã được kích hoạt.',
            userId: newUser.id,
            emailSent: false,
            autoVerified: true,
          };
        }
        throw new ServiceUnavailableException('Không gửi được email OTP, vui lòng thử lại sau.');
      }
    }

    // Nếu OTP tắt hoàn toàn (dev mode)
    return {
      message: 'Đăng ký thành công (DEV: OTP bị tắt, tài khoản đã xác thực).',
      userId: newUser.id,
      emailSent: false,
      autoVerified: true,
    };
  }

  // --- 2. XÁC THỰC MÃ OTP ---
  async verifyEmailOTP(userId: string, code: string) {
    // Gọi hàm kiểm tra OTP (sẽ throw lỗi nếu sai/hết hạn)
    await this.verificationService.verifyCode(userId, code);

    // Nếu code chạy đến đây tức là OTP đúng -> Kích hoạt tài khoản
    await this.databaseService.user.update({
      where: { id: userId },
      data: { verified_email: true }
    });

    return { message: 'Xác thực tài khoản thành công!' };
  }

  // --- 3. ĐĂNG NHẬP ---
  async login(dto: LoginDto) {
    // 1. Tìm user theo email
    const user = await this.databaseService.user.findUnique({
      where: { email: dto.email },
    });
    
    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    // CHẶN ĐĂNG NHẬP NẾU CHƯA XÁC THỰC EMAIL
    if (!user.verified_email) {
       throw new UnauthorizedException('Tài khoản chưa được xác thực. Vui lòng kiểm tra email của bạn.');
    }

    // 2. Kiểm tra mật khẩu
    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    // 3. Tạo Token
    const payload = { sub: user.id, email: user.email, role: user.role };
    const access_token = await this.jwtService.signAsync(payload);

    return {
      message: 'Đăng nhập thành công',
      access_token: access_token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        avatar: '', // Có thể nối bảng lấy avatar sau
      },
    };
  }
}