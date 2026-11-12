/**
 * A local, structural copy of the dev-tools registration contract (version 1) served by
 * `@adonis-agora/agent`'s MCP provider at `/mcp/agora`. Resilience never imports the agent: it
 * registers into the `'agora.devTools'` container binding when it exists.
 *
 * Resilience has no console, so it registers WITHOUT its own `authorize`: the endpoint-level
 * `devTools.authorize` (config/mcp.ts) gates its tools. That needs a hub that says
 * `supports('endpoint-authorize')`.
 */

/** The container binding the hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
  /** Optional capability probe. Resilience needs `'endpoint-authorize'`. */
  supports?(capability: string): boolean;
}

export interface DevToolsLib {
  lib: string;
  title: string;
  /** Omitted: the endpoint's `devTools.authorize` decides. */
  authorize?: (ctx: unknown) => Promise<unknown>;
  tools: DevTool[];
}

export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

export interface DevToolsCaller {
  id: string;
  via: 'token' | 'session' | 'open';
}

export interface DevToolCall {
  ctx: unknown;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}
