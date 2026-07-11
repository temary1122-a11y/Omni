import type { StateCreator } from 'zustand';
import type { OmniActions, OmniState } from '../storeTypes';

/** Shell UI slice (tabs, sidebar, agent detail panel). */
export type UiSlice = Pick<
  OmniState,
  'activeTab' | 'sidebarOpen' | 'selectedAgentId' | 'showAgentDetail'
> &
  Pick<OmniActions, 'setActiveTab' | 'setSidebarOpen' | 'setSelectedAgent' | 'setShowAgentDetail'>;

export const createUiSlice: StateCreator<OmniState & OmniActions, [], [], UiSlice> = (set) => ({
  activeTab: 'chat',
  sidebarOpen: false,
  selectedAgentId: null,
  showAgentDetail: false,
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
  setShowAgentDetail: (show) => set({ showAgentDetail: show }),
});
