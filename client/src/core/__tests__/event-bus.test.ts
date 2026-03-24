import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('on() registers a handler and returns an unsubscribe function', () => {
    const handler = vi.fn();
    const unsub = bus.on('component:added', handler);

    bus.emit('component:added', { id: '1' });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: 'component:added', payload: { id: '1' } });

    // Unsubscribe
    unsub();
    bus.emit('component:added', { id: '2' });
    expect(handler).toHaveBeenCalledOnce(); // still 1
  });

  it('emit() calls all registered handlers for the event type', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('wire:added', handler1);
    bus.on('wire:added', handler2);

    bus.emit('wire:added');
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('emit() does not call handlers for other event types', () => {
    const handler = vi.fn();
    bus.on('component:added', handler);

    bus.emit('wire:added');
    expect(handler).not.toHaveBeenCalled();
  });

  it('off() removes a specific handler', () => {
    const handler = vi.fn();
    bus.on('component:moved', handler);

    bus.off('component:moved', handler);
    bus.emit('component:moved');
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler errors do not break other handlers', () => {
    const errorHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const safeHandler = vi.fn();

    bus.on('document:changed', errorHandler);
    bus.on('document:changed', safeHandler);

    // Should not throw
    expect(() => bus.emit('document:changed')).not.toThrow();
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(safeHandler).toHaveBeenCalledOnce();
  });

  it('clear() removes all listeners', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('component:added', handler1);
    bus.on('wire:removed', handler2);

    bus.clear();

    bus.emit('component:added');
    bus.emit('wire:removed');
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});
