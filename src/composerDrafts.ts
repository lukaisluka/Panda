import { create } from 'zustand';
import type { ImageAttachment } from './attachments';

/**
 * Composer drafts, keyed by foreground session (bug hunt #15): the composer
 * is a single instance across the app, but a message composed for one
 * session must never be sent to another. The key swaps whenever the
 * foreground does — different connection, or a different session on the
 * same connection — so each conversation keeps its own text, image
 * attachments and attachment error, and switching back restores them.
 */

export type ComposerDraft = {
  value: string;
  attachments: ImageAttachment[];
  attachmentError: string | null;
};

/** Draft identity of a foreground session: the (connection, session) pair. */
export function composerDraftKey(connectionId: string, sessionId: string | null): string {
  return `${connectionId}::${sessionId ?? 'none'}`;
}

/** Draft identity of the scripted replay display layer (#/demo,
 *  production-reachable since #196/#197). */
export const DEMO_DRAFT_KEY = 'demo';

const NO_DRAFT: ComposerDraft = { value: '', attachments: [], attachmentError: null };

interface ComposerDraftsState {
  drafts: Record<string, ComposerDraft>;
  setDraft: (key: string, patch: Partial<ComposerDraft>) => void;
  clearDraft: (key: string) => void;
  /** Drops every draft belonging to a session across all connections —
   * called when the session itself is deleted, so image data does not
   * linger in memory. */
  clearSessionDrafts: (sessionId: string) => void;
}

export const useComposerDrafts = create<ComposerDraftsState>((set) => ({
  drafts: {},
  setDraft: (key, patch) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: { ...draftOf(s, key), ...patch } } })),
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[key];
      return { drafts };
    }),
  clearSessionDrafts: (sessionId) =>
    set((s) => {
      const suffix = `::${sessionId}`;
      const drops = Object.keys(s.drafts).filter((key) => key.endsWith(suffix));
      if (drops.length === 0) return s;
      const drafts = { ...s.drafts };
      for (const key of drops) delete drafts[key];
      return { drafts };
    }),
}));

function draftOf(s: ComposerDraftsState, key: string): ComposerDraft {
  return s.drafts[key] ?? NO_DRAFT;
}

/** Stable read for the composer render (a missing key must not produce a
 * fresh object per render — zustand selectors compare by identity). */
export function draftForKey(s: ComposerDraftsState, key: string): ComposerDraft {
  return draftOf(s, key);
}
