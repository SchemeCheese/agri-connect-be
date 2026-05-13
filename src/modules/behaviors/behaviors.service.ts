import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { CreateBehaviorDto } from './dtos/create-behavior.dto';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class BehaviorsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  async create(createDto: CreateBehaviorDto, authorizationHeader?: string) {
    const tokenUserId = this.extractUserIdFromHeader(authorizationHeader);
    const userId = tokenUserId ?? createDto.userId ?? null;
    const sessionId = createDto.sessionId?.trim() || null;

    if (!userId && !sessionId) {
      throw new BadRequestException('userId hoặc sessionId là bắt buộc khi ghi nhận hành vi.');
    }

    const persisted = await this.db.userBehavior.create({
      data: {
        user_id: userId,
        session_id: sessionId,
        action: createDto.action,
        target_id: createDto.targetId ?? null,
        metadata:
          createDto.metadata === undefined
            ? undefined
            : (createDto.metadata as Prisma.InputJsonValue),
        weight: createDto.weight ?? this.resolveDefaultWeight(createDto.action),
      },
    });

    return {
      id: persisted.id,
      userId: persisted.user_id,
      sessionId: persisted.session_id,
      action: persisted.action,
      createdAt: persisted.created_at,
    };
  }

  private extractUserIdFromHeader(authorizationHeader?: string) {
    if (!authorizationHeader?.startsWith('Bearer ')) return null;

    const token = authorizationHeader.replace('Bearer ', '').trim();
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<{ sub?: string }>(token);
      return payload?.sub ?? null;
    } catch {
      return null;
    }
  }

  private resolveDefaultWeight(action: CreateBehaviorDto['action']) {
    if (action === 'VIEW_PRODUCT') return 1;
    if (action === 'SEARCH') return 2;
    if (action === 'ADD_TO_CART') return 4;
    if (action === 'START_CHAT') return 5;
    return 10;
  }
}
