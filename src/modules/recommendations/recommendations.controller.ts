import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/decorators/guards/jwt-auth.guard';
import { RecommendationsService } from './recommendations.service';
import { GetRecommendationsQueryDto } from './dtos/get-recommendations-query.dto';

@Controller('recommendations')
@UseGuards(JwtAuthGuard)
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  @Get('me')
  async getMyRecommendations(@Request() req, @Query() query: GetRecommendationsQueryDto) {
    return this.recommendationsService.getPersonalizedProducts(
      req.user.sub,
      query.limit,
      query.context,
      query.targetId,
    );
  }
}
