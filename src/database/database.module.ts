import { Module, Global } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Global() // Dùng Global để không phải import lại ở nhiều nơi
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}