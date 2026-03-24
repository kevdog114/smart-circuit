import type { Command, CircuitDocument } from './types';
import { eventBus } from './event-bus';

/**
 * Undo/redo command stack.
 * All document mutations go through commands to enable undo/redo.
 */
export class CommandStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory = 100;
  private document: CircuitDocument;

  constructor(document: CircuitDocument) {
    this.document = document;
  }

  execute(command: Command): void {
    command.execute(this.document);
    this.undoStack.push(command);
    this.redoStack = [];
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    eventBus.emit('document:changed', { command: command.type });
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo(this.document);
    this.redoStack.push(command);
    eventBus.emit('undo', { command: command.type });
    eventBus.emit('document:changed', { command: `undo:${command.type}` });
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.execute(this.document);
    this.undoStack.push(command);
    eventBus.emit('redo', { command: command.type });
    eventBus.emit('document:changed', { command: `redo:${command.type}` });
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  get undoDescription(): string | null {
    const last = this.undoStack[this.undoStack.length - 1];
    return last?.description ?? null;
  }

  get redoDescription(): string | null {
    const last = this.redoStack[this.redoStack.length - 1];
    return last?.description ?? null;
  }

  setDocument(doc: CircuitDocument): void {
    this.document = doc;
    this.undoStack = [];
    this.redoStack = [];
  }
}
