import { parse } from '@babel/parser';
import type { FileCoverageData } from 'istanbul-lib-coverage';

type Point = { line: number; column: number };
type Location = { start: Point; end: Point };
type Node = {
  type: string;
  loc: Location;
  body?: Node;
  id?: { name: string };
  key?: { name: string };
  test?: unknown;
  operator?: string;
  [key: string]: unknown;
};
type FunctionRow = {
  name: string;
  body: Location;
  complexity: number;
  statements: string[];
};

const functionTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
const decisions = new Set([
  'IfStatement',
  'ConditionalExpression',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'LogicalExpression',
]);
const ignored = new Set(['loc', 'start', 'end', 'extra', 'comments', 'tokens']);
const position = (point: Point) => point.line * 1_000_000 + point.column;
const size = (location: Location) =>
  position(location.end) - position(location.start);
const contains = (outer: Location, inner: Location) =>
  position(outer.start) <= position(inner.start) &&
  position(outer.end) >= position(inner.end);

function walk(value: unknown, visit: (node: Node) => void) {
  if (!value || typeof value !== 'object') return;
  const node = value as Node;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (ignored.has(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else walk(child, visit);
  }
}

function isDecision(node: Node) {
  return (
    decisions.has(node.type) ||
    (node.type === 'SwitchCase' && node.test !== null) ||
    (node.type === 'AssignmentExpression' &&
      ['&&=', '||=', '??='].includes(node.operator ?? ''))
  );
}

function functionInventory(ast: unknown) {
  const functions: FunctionRow[] = [];
  walk(ast, (node) => {
    if (['StaticBlock', 'Decorator'].includes(node.type))
      throw new Error(`Unsupported executable syntax: ${node.type}`);
    if (functionTypes.has(node.type) && node.body)
      functions.push({
        name:
          node.id?.name ??
          node.key?.name ??
          `anonymous@${node.loc.start.line}:${node.loc.start.column}`,
        body: node.body.loc,
        complexity: 1,
        statements: [],
      });
  });
  return functions;
}

function functionCounter(fn: FunctionRow, coverage: FileCoverageData) {
  const matches = Object.entries(coverage.fnMap).filter(
    ([, record]) =>
      JSON.stringify(record.loc) ===
      JSON.stringify({
        start: { line: fn.body.start.line, column: fn.body.start.column },
        end: { line: fn.body.end.line, column: fn.body.end.column },
      }),
  );
  if (matches.length !== 1)
    throw new Error(`Ambiguous function identity ${fn.name}`);
  return matches[0][0];
}

export function analyze(source: string, coverage: FileCoverageData) {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });
  const functions = functionInventory(ast);
  if (Object.keys(coverage.fnMap).length !== functions.length)
    throw new Error('Function inventory mismatch');
  const owner = (location: Location) =>
    functions
      .filter((fn) => contains(fn.body, location))
      .sort((a, b) => size(a.body) - size(b.body))[0];
  walk(ast, (node) => {
    if (isDecision(node)) {
      const fn = owner(node.loc);
      if (fn) fn.complexity++;
    }
  });
  for (const [id, location] of Object.entries(coverage.statementMap))
    owner(location)?.statements.push(id);
  return functions.map((fn) => {
    const id = functionCounter(fn, coverage);
    const total = fn.statements.length;
    const covered = fn.statements.filter(
      (statement) => coverage.s[statement] > 0,
    ).length;
    const ratio = total ? covered / total : Number(coverage.f[id] > 0);
    return {
      name: fn.name,
      line: fn.body.start.line,
      complexity: fn.complexity,
      covered,
      total,
      coverage: ratio,
      score: fn.complexity ** 2 * (1 - ratio) ** 3 + fn.complexity,
    };
  });
}
