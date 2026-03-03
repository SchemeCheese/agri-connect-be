import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * GET /search?q=<keyword>
   * Response: { shops: [...], products: [...] }
   * Nếu có shop khớp → shops được trả trước, products sau
   */
  @Get()
  async search(@Query('q') q: string) {
    return this.searchService.search(q ?? '');
  }
}
