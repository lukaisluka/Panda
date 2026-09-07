import { create } from 'zustand';

/**
 * Pending-elicitation form values, keyed by elicitation id (bug hunt #16):
 * the card lives inside a virtualized stream (Virtuoso mounts/unmounts rows
 * ±600px outside the viewport) and the foreground session can switch away
 * and back — a form the user has half-filled must survive both. Settling
 * (submit/decline) clears the draft.
 */

export type ElicitationFormValues = Record<string, string | number | boolean | string[]>;

interface ElicitationDraftsState {
  drafts: Record<string, ElicitationFormValues>;
  /** Writes one field of one form, creating the draft on first touch. */
  setField: (elicitationId: string, fieldKey: string, value: string | number | boolean | string[]) => void;
  /** Drops a settled (or otherwise gone) form's draft. */
  clearDraft: (elicitationId: string) => void;
}

export const useElicitationDrafts = create<ElicitationDraftsState>((set) => ({
  drafts: {},
  setField: (elicitationId, fieldKey, value) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [elicitationId]: { ...(s.drafts[elicitationId] ?? {}), [fieldKey]: value },
      },
    })),
  clearDraft: (elicitationId) =>
    set((s) => {
      if (!(elicitationId in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[elicitationId];
      return { drafts };
    }),
}));

/** Stable read for the card render (a missing draft must not produce a fresh
 * object per render — zustand selectors compare by identity). */
export function draftValuesFor(s: ElicitationDraftsState, elicitationId: string): ElicitationFormValues {
  return s.drafts[elicitationId] ?? NO_VALUES;
}

const NO_VALUES: ElicitationFormValues = {};
