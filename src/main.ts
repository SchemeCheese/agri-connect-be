import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';

// Load environment-specific file first (.env.development or .env.production),
// then fall back to .env for any variables not already set.
// override: false ensures Railway-injected vars (already in process.env) are never overwritten.
const nodeEnv = process.env.NODE_ENV || 'development';
dotenvConfig({ path: resolve(process.cwd(), `.env.${nodeEnv}`), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env'), override: false });

// Railway exposes the database URL as DATABASE_URL directly.
// Some older Railway setups use RAILWAY_DATABASE_URL — support both.
if (process.env.RAILWAY_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.RAILWAY_DATABASE_URL;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const port = Number(process.env.PORT) || 3001;

  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : undefined;

  app.useStaticAssets(join(__dirname, '..', 'public'));

  // Express mặc định giới hạn JSON body 100kb — quá nhỏ cho ảnh base64
  // (POST /ai/suggest-product). 15mb ≈ ảnh 10MB sau khi encode base64.
  app.useBodyParser('json', { limit: '15mb' });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  }));

  // Không bao giờ dùng origin:true khi credentials:true (cho phép mọi origin gửi
  // cookie/Authorization = lỗ hổng bảo mật). Fallback: CORS_ORIGIN → FRONTEND_URL → false.
  const corsOrigin: string[] | string | boolean =
    corsOrigins && corsOrigins.length > 0
      ? corsOrigins
      : process.env.FRONTEND_URL
        ? process.env.FRONTEND_URL.trim()
        : false;

  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Bind explicitly to 0.0.0.0 so phones on the same Wi-Fi (Expo Go) can
  // reach the dev server at the host's LAN IP, not just localhost.
  await app.listen(port, '0.0.0.0');
  console.log(`[Bootstrap] Server listening on port ${port}`);
  console.log(`[Bootstrap] NODE_ENV: ${nodeEnv}`);
  console.log(`[Bootstrap] CORS origins: ${Array.isArray(corsOrigin) ? corsOrigin.join(', ') : corsOrigin === false ? 'none (disabled)' : corsOrigin}`);
  console.log(`[Bootstrap] DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ':***@') ?? 'NOT SET'}`);
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] FATAL: Application failed to start');
  console.error('[Bootstrap] Error:', err?.message ?? err);
  if (err?.message?.includes('ECONNREFUSED') || err?.message?.includes('ETIMEDOUT')) {
    console.error('[Bootstrap] Hint: DATABASE_URL may be unreachable. For local dev, use the Railway PostgreSQL external URL.');
  }
  process.exit(1);
});
