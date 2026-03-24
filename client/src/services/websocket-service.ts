import { serializeDocument } from '../core/document';
import type { CircuitDocument } from '../core/types';

export type ConnectionState = 'connected' | 'disconnected' | 'connecting';

/**
 * WebSocket service for auto-saving circuit documents.
 * Features:
 * - Debounced save (500ms) on every document change
 * - Auto-reconnect with exponential backoff
 * - Connection state callbacks for UI indicators
 */
export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 500;
  private intentionalClose = false;
  private pendingDoc: CircuitDocument | null = null;

  // Callbacks
  onConnectionChange: ((state: ConnectionState) => void) | null = null;
  onSaveAck: ((data: { id: string; updatedAt: string }) => void) | null = null;

  constructor(url: string = `ws://${location.hostname}:3001/ws`) {
    this.url = url;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;
    this.setState('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectDelay = 1000;
      this.setState('connected');

      // If there's a pending save from while we were disconnected, send it now
      if (this.pendingDoc) {
        this.sendSave(this.pendingDoc);
        this.pendingDoc = null;
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this.ws = null;
      this.setState('disconnected');

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      // onclose will fire after this, which handles reconnect
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'save:ack' && this.onSaveAck) {
          this.onSaveAck(msg);
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * Queue a debounced save. Multiple rapid calls collapse into one save.
   */
  saveDocument(doc: CircuitDocument): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.isConnected) {
        this.sendSave(doc);
      } else {
        // Store for when we reconnect
        this.pendingDoc = doc;
      }
    }, this.saveDebounceMs);
  }

  private sendSave(doc: CircuitDocument): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = JSON.parse(serializeDocument(doc));
    this.ws.send(JSON.stringify({ type: 'save', payload }));
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onConnectionChange?.(state);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;

    console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
