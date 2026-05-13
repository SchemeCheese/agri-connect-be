import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface UserBucket {
  requestCount: number;
  windowStart: number; // epoch ms
  dailyTokens: number;
  dayStart: number;    // epoch ms (midnight)
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly buckets = new Map<string, UserBucket>();

  private readonly maxRequestsPerHour: number;
  private readonly maxDailyTokens: number;

  constructor(private readonly config: ConfigService) {
    this.maxRequestsPerHour = this.config.get<number>('AI_RATE_LIMIT_PER_HOUR', 20);
    this.maxDailyTokens = this.config.get<number>('AI_DAILY_TOKEN_BUDGET', 10_000);
  }

  checkRequestLimit(userId: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(userId, now);

    const hourElapsed = now - bucket.windowStart > 3_600_000;
    if (hourElapsed) {
      bucket.requestCount = 0;
      bucket.windowStart = now;
    }

    if (bucket.requestCount >= this.maxRequestsPerHour) {
      const resetIn = Math.ceil((bucket.windowStart + 3_600_000 - now) / 60_000);
      return {
        allowed: false,
        reason: `Bạn đã đạt giới hạn ${this.maxRequestsPerHour} yêu cầu/giờ. Thử lại sau ${resetIn} phút.`,
      };
    }

    bucket.requestCount++;
    return { allowed: true };
  }

  checkTokenBudget(userId: string, tokensToUse: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(userId, now);

    const newDay = now - bucket.dayStart > 86_400_000;
    if (newDay) {
      bucket.dailyTokens = 0;
      bucket.dayStart = this.startOfDay(now);
    }

    if (bucket.dailyTokens + tokensToUse > this.maxDailyTokens) {
      return {
        allowed: false,
        reason: `Bạn đã sử dụng hết ngân sách AI hôm nay (${this.maxDailyTokens.toLocaleString()} tokens). Thử lại vào ngày mai.`,
      };
    }

    return { allowed: true };
  }

  recordTokenUsage(userId: string, tokens: number): void {
    const bucket = this.getOrCreateBucket(userId, Date.now());
    bucket.dailyTokens += tokens;
  }

  private getOrCreateBucket(userId: string, now: number): UserBucket {
    if (!this.buckets.has(userId)) {
      this.buckets.set(userId, {
        requestCount: 0,
        windowStart: now,
        dailyTokens: 0,
        dayStart: this.startOfDay(now),
      });
    }
    return this.buckets.get(userId)!;
  }

  private startOfDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
