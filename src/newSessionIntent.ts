import { create } from 'zustand';

/**
 * One-shot deep-link intent (#221): the settings page's post-create CTA asks
 * for the new-session picker with the freshly saved profile preselected. The
 * Sidebar owns that dialog, so the intent crosses the component boundary
 * through this tiny store — consumed exactly once, on arrival; a stale intent
 * must never re-open the dialog on some later mount.
 */
type NewSessionIntentState = {
  /** The profile the picker should highlight; null = no intent pending. */
  profileId: string | null;
  request(profileId: string): void;
  consume(): string | null;
};

export const useNewSessionIntent = create<NewSessionIntentState>((set, get) => ({
  profileId: null,
  request: (profileId) => set({ profileId }),
  consume: () => {
    const pending = get().profileId;
    if (pending !== null) set({ profileId: null });
    return pending;
  },
}));
