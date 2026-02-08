import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  // --- ĐĂNG KÝ ---
  async register(dto: RegisterDto) {
    // 1. Kiểm tra email đã tồn tại chưa
    const existingUser = await this.databaseService.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new BadRequestException('Email này đã được sử dụng');
    }

    // 2. Mã hóa mật khẩu
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // 3. Lưu vào DB
    const newUser = await this.databaseService.user.create({
      data: {
        email: dto.email,
        password_hash: hashedPassword,
        full_name: dto.full_name,
        role: dto.role,
      },
    });

    // 4. Trả về thông báo (Không trả về pass)
    return {
      message: 'Đăng ký thành công',
      user: {
        id: newUser.id,
        email: newUser.email,
        full_name: newUser.full_name,
        role: newUser.role,
      },
    };
  }

  // --- ĐĂNG NHẬP ---
  async login(dto: LoginDto) {
    // 1. Tìm user theo email
    const user = await this.databaseService.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    // 2. Kiểm tra mật khẩu
    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    // 3. Tạo Token (JWT)
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    return {
      access_token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
      },
    };
  }
}