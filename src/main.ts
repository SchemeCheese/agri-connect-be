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

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  }));

  app.enableCors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(port);
  console.log(`[Bootstrap] Server listening on port ${port}`);
  console.log(`[Bootstrap] NODE_ENV: ${nodeEnv}`);
  console.log(`[Bootstrap] CORS origins: ${corsOrigins?.join(', ') ?? 'all (open)'}`);
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
