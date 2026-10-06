/** Client-safe helpers for the task table. Imports only the plain constants in ./settings (zod, no I/O, no node built-ins): keep it that way. */
import { DEFAULT_MODELS, type AiProvider } from './settings';

/** The model a task gets when its provider is chosen: the provider's default, else the first listed one, else empty (the user types it). */
export function defaultModelFor(provider: AiProvider, listed: string[]): string {
  return provider === 'none' ? '' : DEFAULT_MODELS[provider].fast ?? listed[0] ?? '';
}

/** One table row as the form shows it. A model the provider's list doesn't contain is `other`, so it is visible in the free-text field. */
export function taskRow(provider: AiProvider, model: string | null, listed: string[]): { provider: AiProvider; model: string; other: boolean } {
  return { provider, model: model ?? '', other: provider !== 'none' && !!model && !listed.includes(model) };
}

