import type { JobSourceAdapter } from './types';

/** Adapters have different config types; the registry stores them type-erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = JobSourceAdapter<any>;

// Adapters register here; the core never needs source-specific logic (PRD §47).
// Kept on globalThis: Next.js may load this module once per route bundle, and all of them must see one registry.
const holder = globalThis as typeof globalThis & { __jobScraperAdapters?: Map<string, AnyAdapter> };
const adapters = (holder.__jobScraperAdapters ??= new Map<string, AnyAdapter>());

export function registerAdapter(adapter: AnyAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): AnyAdapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): AnyAdapter[] {
  return [...adapters.values()];
}
