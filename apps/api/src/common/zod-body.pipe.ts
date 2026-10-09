import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Validates a request body against a Zod schema from @sc/shared. */
export class ZodBodyPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }
}
