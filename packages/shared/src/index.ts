export const SERVICE_NAMES = ['api', 'worker', 'web'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface HealthResponse {
  status: 'ok';
  service: ServiceName;
}

export function healthResponse(service: ServiceName): HealthResponse {
  return { status: 'ok', service };
}

export * from './permissions';
export * from './auth';
export * from './queues';
