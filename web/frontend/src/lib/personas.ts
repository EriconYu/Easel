import type { PersonaItem } from './api';

const WORKING_PERSONA_KEY = 'easel_working_persona';

/** null means never selected; an empty string is an explicit general-mode choice. */
export function loadWorkingPersona(): string | null {
  try {
    const raw = localStorage.getItem(WORKING_PERSONA_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

export function saveWorkingPersona(persona: string): void {
  try { localStorage.setItem(WORKING_PERSONA_KEY, JSON.stringify(persona)); }
  catch {
    window.dispatchEvent(new CustomEvent('easel-editor-save-error'));
  }
}

/** A failed or malformed response must never be mistaken for an empty catalog. */
export function parsePersonas(value: unknown): PersonaItem[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object'
    || typeof item.name !== 'string' || !item.name.trim() || item.name.startsWith('.')
    || item.name.startsWith('_') || /[/\\:]/.test(item.name)
    || Array.from(item.name as string).some((character) => character.charCodeAt(0) < 32)
    || typeof item.description !== 'string')
    || new Set(value.map((item) => item.name)).size !== value.length) {
    throw new Error('画像列表响应格式无效，请重试。');
  }
  return value;
}

/** Resolve the current identity without rewriting historical session metadata. */
export function availablePersona(name: string | undefined, catalog: PersonaItem[] | null): string {
  if (!name) return '';
  return catalog === null || catalog.some((item) => item.name === name) ? name : '';
}
