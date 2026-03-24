import type { EventType, AppEvent } from './types';

type EventHandler = (event: AppEvent) => void;

/**
 * Typed pub/sub event bus for cross-module communication.
 * All modules communicate through events, not direct imports.
 */
export class EventBus {
  private listeners = new Map<EventType, Set<EventHandler>>();

  on(type: EventType, handler: EventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(handler);
    };
  }

  off(type: EventType, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: EventType, payload?: unknown): void {
    const event: AppEvent = { type, payload };
    this.listeners.get(type)?.forEach(handler => {
      try {
        handler(event);
      } catch (err) {
        console.error(`Event handler error for ${type}:`, err);
      }
    });
  }

  /** Remove all listeners */
  clear(): void {
    this.listeners.clear();
  }
}

/** Singleton event bus instance */
export const eventBus = new EventBus();
