import { describe, expect, it } from 'vitest';
import { findUndeclaredRoutes } from './route-check';

const check = (body: string) => findUndeclaredRoutes(body, 'x.controller.ts').map((p) => p.route);

describe('findUndeclaredRoutes', () => {
  it('flags a route with no decorator', () => {
    expect(check(`@Controller('a') class A { @Get() list() {} }`)).toEqual(['A.list']);
  });

  it('accepts @Public and @RequirePermission on the method', () => {
    expect(
      check(`@Controller('a') class A {
        @Public() @Get() open() {}
        @RequirePermission('inbox.view') @Post() write() {}
      }`),
    ).toEqual([]);
  });

  it('accepts a class-level declaration for all its routes', () => {
    expect(check(`@Public() @Controller('a') class A { @Get() a() {} @Post() b() {} }`)).toEqual([]);
  });

  it('reports each offending route separately and ignores plain methods', () => {
    expect(
      check(`@Controller('a') class A {
        helper() {}
        @RequirePermission('x') @Get() ok() {}
        @Delete(':id') bad() {}
        @Put(':id') alsoBad() {}
      }`),
    ).toEqual(['A.bad', 'A.alsoBad']);
  });

  it('covers websocket gateways', () => {
    expect(check(`@WebSocketGateway() class G { @SubscribeMessage('ping') ping() {} }`)).toEqual(['G.ping']);
  });

  it('ignores classes that are not controllers', () => {
    expect(check(`class Svc { @Get() thing() {} }`)).toEqual([]);
  });

  it('reports the line number', () => {
    const [p] = findUndeclaredRoutes(`@Controller()\nclass A {\n  @Get()\n  x() {}\n}`, 'f.ts');
    expect(p?.line).toBe(3);
  });
});
