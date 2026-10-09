import ts from 'typescript';

const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head', 'SubscribeMessage']);
const PERMISSION_DECORATORS = new Set(['Public', 'RequirePermission']);

export interface RouteProblem {
  file: string;
  line: number;
  route: string;
}

const decoratorName = (d: ts.Decorator): string | undefined => {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return undefined;
};

/**
 * Finds controller/gateway handlers that declare neither @Public() nor @RequirePermission(...),
 * on the method or on its class. The runtime guard already refuses such routes; this fails the
 * build before one ships.
 */
export function findUndeclaredRoutes(source: string, file: string): RouteProblem[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const problems: RouteProblem[] = [];

  sf.forEachChild(function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const classDecos = (ts.getDecorators(node) ?? []).map(decoratorName);
      const isHandlerClass = classDecos.some((n) => n === 'Controller' || n === 'WebSocketGateway');
      const classCovered = classDecos.some((n) => n && PERMISSION_DECORATORS.has(n));
      if (isHandlerClass) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const names = (ts.getDecorators(member) ?? []).map(decoratorName);
          const isRoute = names.some((n) => n && ROUTE_DECORATORS.has(n));
          const covered = classCovered || names.some((n) => n && PERMISSION_DECORATORS.has(n));
          if (isRoute && !covered) {
            const { line } = sf.getLineAndCharacterOfPosition(member.getStart());
            problems.push({
              file,
              line: line + 1,
              route: `${node.name?.text ?? 'anonymous'}.${member.name.getText()}`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return problems;
}
