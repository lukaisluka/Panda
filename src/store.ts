import { create } from 'zustand';
import { applyUpdate, emptySession } from './protocol/reducer';
import type {
  AcpSessionUpdate,
  PermissionRequest,
  SessionDocument,
  SessionStatus,
} from './protocol/types';

/**
 * Thin store around the reducer — all mutation flows through `applyUpdate`,
 * the store never invents document state itself.
 */
interface PandaState {
  doc: SessionDocument;
  permission: PermissionRequest | null;
  update(update: AcpSessionUpdate): void;
  setStatus(status: SessionStatus): void;
  setPermission(request: PermissionRequest | null): void;
}

export const usePanda = create<PandaState>((set) => ({
  doc: emptySession(),
  permission: null,
  update: (update) => set((s) => ({ doc: applyUpdate(s.doc, update) })),
  setStatus: (status) => set((s) => ({ doc: { ...s.doc, status } })),
  setPermission: (request) => set({ permission: request }),
}));