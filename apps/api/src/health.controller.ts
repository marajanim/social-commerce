import { Controller, Get } from '@nestjs/common';
import { healthResponse, type HealthResponse } from '@sc/shared';
import { Public } from './common/decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  get(): HealthResponse {
    return healthResponse('api');
  }
}
