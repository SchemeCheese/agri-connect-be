import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('PostgreSQL connected successfully');
    } catch (err: any) {
      this.logger.error(`PostgreSQL connection failed: ${err?.message ?? err}`);
      if (err?.message?.includes('ECONNREFUSED') || err?.message?.includes('connect ETIMEDOUT')) {
        this.logger.error('Hint: check that DATABASE_URL points to a reachable PostgreSQL instance (Railway external URL for local dev)');
      }
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}