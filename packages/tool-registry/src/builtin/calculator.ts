import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";

const InputSchema = z.object({ expression: z.string().min(1).max(500) });

/**
 * Safe arithmetic evaluator. Implements a recursive-descent parser over a
 * whitelist grammar — no `eval`, no `Function`, no identifiers beyond named
 * constants and math functions.
 */
export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function parseExpression(): number {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = next();
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parsePower();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = next();
      const right = parsePower();
      if ((operator === "/" || operator === "%") && right === 0) throw new Error("division by zero");
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  }

  function parsePower(): number {
    const base = parseUnary();
    if (peek() === "^") {
      next();
      return base ** parsePower();
    }
    return base;
  }

  function parseUnary(): number {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const token = next();
    if (token === undefined) throw new Error("unexpected end of expression");
    if (token === "(") {
      const value = parseExpression();
      if (next() !== ")") throw new Error("missing closing parenthesis");
      return value;
    }
    if (/^\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`invalid number "${token}"`);
      return value;
    }
    if (/^[a-z]+$/i.test(token)) {
      const lowered = token.toLowerCase();
      if (lowered === "pi") return Math.PI;
      if (lowered === "e") return Math.E;
      if (peek() !== "(") throw new Error(`unknown identifier "${token}"`);
      next();
      const argument = parseExpression();
      const closeArgs: number[] = [];
      while (peek() === ",") {
        next();
        closeArgs.push(parseExpression());
      }
      if (next() !== ")") throw new Error("missing closing parenthesis in function call");
      return applyFunction(lowered, [argument, ...closeArgs]);
    }
    throw new Error(`unexpected token "${token}"`);
  }

  const result = parseExpression();
  if (index !== tokens.length) throw new Error(`unexpected trailing token "${tokens[index]}"`);
  if (!Number.isFinite(result)) throw new Error("result is not finite");
  return result;
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sqrt: ([a]) => {
    if (a === undefined || a < 0) throw new Error("sqrt of a negative number");
    return Math.sqrt(a);
  },
  abs: ([a]) => Math.abs(requireArg("abs", a)),
  round: ([a, b]) => {
    const decimals = b ?? 0;
    return Number(requireArg("round", a).toFixed(Math.max(0, Math.min(12, Math.trunc(decimals)))));
  },
  floor: ([a]) => Math.floor(requireArg("floor", a)),
  ceil: ([a]) => Math.ceil(requireArg("ceil", a)),
  log: ([a]) => {
    const value = requireArg("log", a);
    if (value <= 0) throw new Error("log of a non-positive number");
    return Math.log(value);
  },
  sin: ([a]) => Math.sin(requireArg("sin", a)),
  cos: ([a]) => Math.cos(requireArg("cos", a)),
  tan: ([a]) => Math.tan(requireArg("tan", a)),
  pow: ([a, b]) => requireArg("pow", a) ** requireArg("pow", b),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
};

function requireArg(name: string, value: number | undefined): number {
  if (value === undefined) throw new Error(`${name} expects more arguments`);
  return value;
}

function applyFunction(name: string, args: number[]): number {
  const fn = FUNCTIONS[name];
  if (!fn) throw new Error(`unknown function "${name}"`);
  return fn(args);
}

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let number = "";
      while (index < expression.length && /[0-9.]/.test(expression[index] as string)) {
        number += expression[index];
        index += 1;
      }
      tokens.push(number);
      continue;
    }
    if (/[a-z]/i.test(char)) {
      let word = "";
      while (index < expression.length && /[a-z]/i.test(expression[index] as string)) {
        word += expression[index];
        index += 1;
      }
      tokens.push(word);
      continue;
    }
    if ("+-*/%^(),".includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    throw new Error(`invalid character "${char}"`);
  }
  return tokens;
}

export const calculatorTool: ToolDefinition<z.infer<typeof InputSchema>> = {
  name: "math.calculate",
  title: "Calculadora",
  description:
    "Evalúa una expresión aritmética de forma segura. Soporta + - * / % ^, paréntesis, pi, e, y funciones sqrt, abs, round, floor, ceil, log, sin, cos, tan, pow, min, max.",
  risk: "public_read",
  requiresApproval: false,
  timeoutMs: 1000,
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Expresión a evaluar, por ejemplo: (2+3)*sqrt(16)" },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  parse: (raw) => InputSchema.parse(raw),
  availability: () => ({ available: true }),
  execute: async (input) => {
    const value = evaluateExpression(input.expression);
    return { ok: true, data: { expression: input.expression, value }, summary: `${input.expression} = ${value}`, unavailable: false };
  },
};
