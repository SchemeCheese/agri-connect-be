import { Module } from '@nestjs/common';
import { BehaviorsController } from './behaviors.controller';
import { BehaviorsService } from './behaviors.service';

@Module({
  controllers: [BehaviorsController],
  providers: [BehaviorsService],
})
export class BehaviorsModule {}
