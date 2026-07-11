import type { Phase } from '@/types';
import type { StateCreator } from 'zustand';
import type { OmniActions, OmniState } from '../storeTypes';

/** Pipeline / phase navigation slice. */
export type PipelineSlice = Pick<
  OmniState,
  'currentPhase' | 'completedPhases' | 'scrollTargetPhase' | 'isRunning'
> &
  Pick<OmniActions, 'scrollToPhase' | 'clearScrollTarget'>;

export const createPipelineSlice: StateCreator<
  OmniState & OmniActions,
  [],
  [],
  PipelineSlice
> = (set) => ({
  currentPhase: 'idle' as Phase,
  completedPhases: [],
  scrollTargetPhase: null,
  isRunning: false,
  scrollToPhase: (phase) => set({ activeTab: 'chat', scrollTargetPhase: phase }),
  clearScrollTarget: () => set({ scrollTargetPhase: null }),
});
