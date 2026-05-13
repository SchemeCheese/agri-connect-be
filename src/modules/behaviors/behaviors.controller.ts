import { Body, Controller, Headers, Post } from '@nestjs/common';
import { BehaviorsService } from './behaviors.service';
import { CreateBehaviorDto } from './dtos/create-behavior.dto';

@Controller('behaviors')
export class BehaviorsController {
  constructor(private readonly behaviorsService: BehaviorsService) {}

  @Post()
  create(
    @Body() createBehaviorDto: CreateBehaviorDto,
    @Headers('authorization') authorization?: string,
  ) {
    return this.behaviorsService.create(createBehaviorDto, authorization);
  }
}
