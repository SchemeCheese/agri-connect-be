import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const port = Number(process.env.PORT) || 3001;

  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : undefined;

  // Phục vụ file tĩnh từ thư mục /public (ví dụ: /placeholder.png)
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // 1. Kích hoạt kiểm tra dữ liệu đầu vào (Validation)
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // Tự động loại bỏ các trường thừa (ví dụ user gửi thêm field "hack: true" sẽ bị lọc bỏ)
    forbidNonWhitelisted: true, // Báo lỗi nếu gửi trường không cho phép
  }));

  // 2. Cho phép Frontend gọi API (CORS)
  app.enableCors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(port);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();