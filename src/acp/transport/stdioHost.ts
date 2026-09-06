import type { AcpTransport } from './AcpTransport';

/**
 * Host capability seam for stdio agents (issue #121; architecture doc §5.2:
 * "spawn 能力由宿主注入 StdioTransportFactory,未注入时 fail-fast 抛错").
 * Spawning a child process is a capability a browser host never has, so the
 * spawn implementation is injected here by a desktop host's boot module and
 * everything else — profile UI, connection manager — only asks this module.
 * With no factory registered, a stdio connect fails fast as a connection
 * error (liveConnections reports it); it never silently degrades to another
 * transport.
 */

/** What a registered factory receives: the profile's pure-data fields, with
 * args already argv-split for the wire (see splitArgs). */
export type StdioAgentConfig = {
  program: string;
  args: string[];
  cwd: string;
};

export type StdioTransportFactory = (config: StdioAgentConfig) => AcpTransport;

let factory: StdioTransportFactory | null = null;

/** Registers (or clears, with null) the host's spawn capability. Set once at
 * host boot; a replacement registration warns — silent replacement would make
 * transport provenance undiagnosable. */
export function setStdioTransportFactory(next: StdioTransportFactory | null): void {
  if (factory !== null && next !== null) {
    console.warn('[panda/acp] replacing an already-registered stdio transport factory');
  }
  factory = next;
}

export function getStdioTransportFactory(): StdioTransportFactory | null {
  return factory;
}

/** Whether this host can spawn stdio agents — gates the profile form's option. */
export function hasStdioHost(): boolean {
  return factory !== null;
}

/** Splits the profile's whitespace-separated args string into argv. */
export function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((part) => part.length > 0);
}
