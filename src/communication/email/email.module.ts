import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { EmailService } from './email.service';
import { join } from 'path';

@Module({
  imports: [
    MailerModule.forRootAsync({
      useFactory: () => ({
        transport: {
          host: process.env.MAIL_HOST,
          port: Number(process.env.MAIL_PORT) || 587,
          secure: Number(process.env.MAIL_PORT) === 465, // 465 = SSL, 587 = STARTTLS
          requireTLS: Number(process.env.MAIL_PORT) === 587,
          connectionTimeout: 10000,
          socketTimeout: 10000,
          family: 4, // Ưu tiên IPv4 tránh lỗi ENETUNREACH IPv6
          auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS, // Mật khẩu ứng dụng 16 ký tự
          },
          tls: {
            rejectUnauthorized: false,
            servername: process.env.MAIL_HOST,
          },
        },
        defaults: {
          from: process.env.MAIL_FROM || '"Agri Connect" <noreply@agriconnect.com>',
        },
        template: {
          // SỬA DÒNG NÀY: Dùng process.cwd() để trỏ từ thư mục gốc của project
          dir: join(process.cwd(), 'src/communication/email/templates'),
          adapter: new HandlebarsAdapter(),
          options: {
            strict: true,
          },
        },
      }),
    }),
  ],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}