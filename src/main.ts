import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Kích hoạt kiểm tra dữ liệu đầu vào (Validation)
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // Tự động loại bỏ các trường thừa (ví dụ user gửi thêm field "hack: true" sẽ bị lọc bỏ)
    forbidNonWhitelisted: true, // Báo lỗi nếu gửi trường không cho phép
  }));

  // 2. Cho phép Frontend gọi API (CORS)
  app.enableCors({
    origin: '*', // Tạm thời cho phép tất cả (Sau này sẽ đổi thành domain của FE)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(3001);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();