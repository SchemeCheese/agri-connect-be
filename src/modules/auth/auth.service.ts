import { Injectable, BadRequestException, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
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
    // 1. Kiểm tra email đã tồn tại chưa
    const existingUser = await this.databaseService.user.findUnique({
      where: { email: dto.email },
    });
    
    if (existingUser) {
      if (existingUser.is_active) {
        throw new BadRequestException('Email này đã được đăng ký và xác thực!');
      } else {
        // Nếu user tồn tại nhưng CHƯA xác thực, có thể xóa đi tạo lại hoặc cho phép ghi đè.
        // Ở đây để đơn giản, ta xóa user rác cũ đi.
        await this.databaseService.user.delete({ where: { email: dto.email }});
      }
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
        verified_email: false, // Quan trọng: Đánh dấu chưa xác thực
      },
    });

    // 4. Sinh mã OTP và lưu vào DB
    const verification = await this.verificationService.createVerification(newUser.id);

    // 5. Gửi mã OTP đó qua Email
    await this.emailService.sendVerificationOTP(newUser.email, verification.code, newUser.full_name);

    // 6. Trả về userId để Frontend làm bước tiếp theo (hiển thị form nhập OTP)
    return {
      message: 'Đăng ký thành công bước 1. Vui lòng kiểm tra email để lấy mã OTP.',
      userId: newUser.id,
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