import type { IdeaReference } from './api';

/** No automatic injection: the explicit switch is authoritative. */
export function ideaReferences(enabled: boolean, selected: IdeaReference[]): IdeaReference[] {
  return enabled ? selected.map(({idea_id, version_id}) => ({idea_id, ...(version_id ? {version_id} : {})})) : [];
}
export function toggleIdeaReference(selected: IdeaReference[], value: IdeaReference): IdeaReference[] {
  const same = (ref: IdeaReference) => ref.idea_id === value.idea_id && (ref.version_id || '') === (value.version_id || '');
  return selected.some(same) ? selected.filter(ref => !same(ref)) : [...selected, value];
}
