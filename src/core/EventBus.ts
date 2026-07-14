import type { IpcMessage, LedgerEntry } from '../../shared/types';

type EventHandler = (event: IpcMessage) => void;

export interface WebviewBridge {
  send(event: IpcMessage): void;
}

export class EventBus {
  private subscribers = new Map<string, Set<EventHandler>>();
  private webviewBridge?: WebviewBridge;
  private ledgerEntries: LedgerEntry[] = [];

  setWebviewBridge(bridge: WebviewBridge): void {
    this.webviewBridge = bridge;
  }

  emit(event: IpcMessage): void {
    const handlers = this.subscribers.get(event.type) ?? new Set();
    handlers.forEach((h) => h(event));
    this.webviewBridge?.send(event);
    this.ledgerEntries.push({
      timestamp: Date.now(),
      type: this.mapEventType(event.type),
      data: event.payload as Record<string, unknown>,
    });
  }

  on<T extends IpcMessage['type']>(type: T, handler: EventHandler): () => void {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    this.subscribers.get(type)!.add(handler);
    return () => this.subscribers.get(type)?.delete(handler);
  }

  getLedgerEntries(): LedgerEntry[] {
    return [...this.ledgerEntries];
  }

  private mapEventType(eventType: string): LedgerEntry['type'] {
    const map: Record<string, LedgerEntry['type']> = {
      PHASE_TRANSITION: 'phase_transition',
      ARTIFACT_CREATED: 'artifact_created',
      VERIFICATION_RESULT: 'verification',
      DELIVERY_COMPLETE: 'delivery',
      ERROR_OCCURRED: 'error',
      AGENT_STATUS_UPDATE: 'agent_status',
      REASONING_TRACE: 'reasoning',
      AGENT_COMMENTARY: 'agent_status',
      TOOL_CALL: 'agent_status',
      TOOL_RESULT: 'agent_status',
      SANDBOX_EVENT: 'error',
      SYMBOL_RESOLVED: 'symbol_resolved',
      SEMANTIC_EDIT_APPLIED: 'semantic_edit',
      API_KEY_PROMPT: 'agent_status',
      MODEL_CATALOG: 'agent_status',
    };
    return map[eventType] ?? 'phase_transition';
  }
}
