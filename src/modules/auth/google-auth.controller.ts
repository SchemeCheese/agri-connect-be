import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { GoogleAuthService } from './google-auth.service';
import { GoogleRegisterDto, GoogleLoginDto } from './dto/auth.dto';

@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly googleAuthService: GoogleAuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: GoogleRegisterDto) {
    const { idToken, role } = body;
    return this.googleAuthService.registerWithGoogle(idToken, role);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: GoogleLoginDto) {
    const { idToken, role } = body;
    return this.googleAuthService.loginWithGoogle(idToken, role as any);
  }
}
