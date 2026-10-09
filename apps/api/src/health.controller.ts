import { Controller, Get } from '@nestjs/common';
import { healthResponse, type HealthResponse } from '@sc/shared';

@Controller('health')
export class HealthController {
  @Get()
  get(): HealthResponse {
    return healthResponse('api');
  }
}
