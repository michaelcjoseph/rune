import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ROOTS = ['src', 'scripts', 'cli'] as const;
const PROTECTED_PORTS = new Set([3847, 3848]);

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function collectAutomatedTestFiles(): string[] {
  const files: string[] = [];

  function visit(absPath: string): void {
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absPath)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        visit(join(absPath, entry));
      }
      return;
    }

    const relPath = relative(REPO_ROOT, absPath).split(sep).join('/');
    const isTestFile = relPath.endsWith('.test.ts');
    const isAcceptanceCode = relPath.endsWith('.acceptance.ts');
    const isTestHelper = relPath.startsWith('src/test/') && relPath.endsWith('.ts');
    if (isTestFile || isAcceptanceCode || isTestHelper) files.push(absPath);
  }

  for (const root of SCAN_ROOTS) visit(join(REPO_ROOT, root));
  return files.sort();
}

function rel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectConstNumbers(sourceFile: ts.SourceFile): Map<string, number> {
  const bindings = new Map<string, number>();

  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = numericValue(declaration.initializer, bindings);
        if (value !== null) bindings.set(declaration.name.text, value);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

function numericValue(node: ts.Expression, bindings: Map<string, number>): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node)) return numericValue(node.expression, bindings);
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) return numericValue(node.expression, bindings);
  if (
    ts.isPrefixUnaryExpression(node)
    && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

function callExpressionName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function objectNumberProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  property: string,
  bindings: Map<string, number>,
): { node: ts.Node; value: number } | null {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyName(prop.name);
    if (name !== property) continue;
    const value = numericValue(prop.initializer, bindings);
    if (value !== null) return { node: prop, value };
  }
  return null;
}

function findPortHygieneViolationsInSource(source: string, file: string): Violation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = collectConstNumbers(sourceFile);
  const violations: Violation[] = [];
  const configPortAssignments: Array<{ property: 'HTTP_PORT' | 'RUNE_MCP_PORT'; node: ts.Node; value: number }> = [];
  const listenerBootCalls = new Set<'startHttpServer' | 'startMcpDaemon'>();

  function add(node: ts.Node, detail: string): void {
    violations.push({ file, line: lineOf(sourceFile, node), detail });
  }

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of ['HTTP_PORT', 'RUNE_MCP_PORT'] as const) {
        const assignment = objectNumberProperty(node, property, bindings);
        if (assignment && PROTECTED_PORTS.has(assignment.value)) {
          configPortAssignments.push({ property, node: assignment.node, value: assignment.value });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const name = callExpressionName(node);

      if (name === 'listen') {
        const portArg = node.arguments[0];
        const port = portArg ? numericValue(portArg, bindings) : null;
        if (port !== null && PROTECTED_PORTS.has(port)) {
          add(node, `test listener binds protected production port ${port}; use port 0 or a task-local injected port`);
        }
        if (portArg && ts.isObjectLiteralExpression(portArg)) {
          const optionsPort = objectNumberProperty(portArg, 'port', bindings);
          if (optionsPort && PROTECTED_PORTS.has(optionsPort.value)) {
            add(
              node,
              `test listener binds protected production port ${optionsPort.value}; use port 0 or a task-local injected port`,
            );
          }
        }
      }

      if (name === 'startHttpServer' || name === 'startMcpDaemon') {
        listenerBootCalls.add(name);
      }

      if (name === 'startMcpDaemon') {
        const optionsArg = node.arguments[0];
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          const port = objectNumberProperty(optionsArg, 'port', bindings);
          if (port && PROTECTED_PORTS.has(port.value)) {
            add(port.node, `startMcpDaemon test options bind protected production port ${port.value}; use port 0 or a task-local injected port`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  for (const assignment of configPortAssignments) {
    if (assignment.property === 'HTTP_PORT' && listenerBootCalls.has('startHttpServer')) {
      add(
        assignment.node,
        `mock config HTTP_PORT=${assignment.value} is used while booting startHttpServer; test listeners must use port 0`,
      );
    }
    if (assignment.property === 'RUNE_MCP_PORT' && listenerBootCalls.has('startMcpDaemon')) {
      add(
        assignment.node,
        `mock config RUNE_MCP_PORT=${assignment.value} is used while booting startMcpDaemon; test listeners must use port 0`,
      );
    }
  }

  return violations;
}

function findPortHygieneViolations(absPath: string): Violation[] {
  return findPortHygieneViolationsInSource(readFileSync(absPath, 'utf8'), rel(absPath));
}

describe('test-port-hygiene-regression (project 19 / test-plan §5A)', () => {
  it('flags protected ports passed through listener options objects', () => {
    const source = `
      import http from 'node:http';

      const RUNE_WEB_PORT = 3847;
      const server = http.createServer();

      server.listen({ host: '127.0.0.1', port: RUNE_WEB_PORT });
    `;

    expect(
      findPortHygieneViolationsInSource(source, 'src/example/listener-options.test.ts').map(
        (violation) => violation.detail,
      ),
    ).toContain('test listener binds protected production port 3847; use port 0 or a task-local injected port');
  });

  it('keeps automated test listeners off protected Rune web/MCP production ports', () => {
    const files = collectAutomatedTestFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(findPortHygieneViolations);

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} - ${violation.detail}`),
    ).toEqual([]);
  });
});
