import type { Command } from "../shared/messages";
import type {
  ImportPreview,
  RouteDecision,
  RoutingContext,
  Server,
  ValidationResult,
} from "../shared/state";

// Foundation signatures only; the routing implementation must replace these before release.
export function canonicalHost(_input: string): ValidationResult<string> {
  throw new Error("Routing implementation not installed");
}
export function resolveRoute(
  _host: string,
  _context: RoutingContext,
): RouteDecision {
  throw new Error("Routing implementation not installed");
}
export function generatePac(_context: RoutingContext): string {
  throw new Error("Routing implementation not installed");
}
export function validateServers(_input: unknown): ValidationResult<Server[]> {
  throw new Error("Routing implementation not installed");
}
export function validateImport(
  _input: unknown,
  _servers: readonly Server[],
): ValidationResult<ImportPreview> {
  throw new Error("Routing implementation not installed");
}
export function validateCommand(_input: unknown): ValidationResult<Command> {
  throw new Error("Routing implementation not installed");
}
