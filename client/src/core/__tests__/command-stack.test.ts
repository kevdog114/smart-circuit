import { describe, it, expect, beforeEach } from 'vitest';
import { CommandStack } from '../command-stack';
import { createDocument } from '../document';
import type { CircuitDocument, Command } from '../types';

// ---- Test Helpers ----

let counter = 0;

/** A minimal command that tracks execute/undo calls via a mutation on the doc name. */
function makeCommand(label?: string): Command {
  const tag = label ?? `cmd-${++counter}`;
  return {
    type: 'TEST',
    description: tag,
    execute(doc: CircuitDocument) {
      doc.name = `${doc.name}+${tag}`;
    },
    undo(doc: CircuitDocument) {
      doc.name = doc.name.replace(`+${tag}`, '');
    },
  };
}

// ---- Tests ----

describe('CommandStack', () => {
  let doc: CircuitDocument;
  let stack: CommandStack;

  beforeEach(() => {
    counter = 0;
    doc = createDocument('base');
    stack = new CommandStack(doc);
  });

  it('execute pushes to undo stack', () => {
    expect(stack.canUndo).toBe(false);
    stack.execute(makeCommand());
    expect(stack.canUndo).toBe(true);
  });

  it('undo pops from undo and pushes to redo', () => {
    stack.execute(makeCommand());
    expect(stack.canRedo).toBe(false);

    stack.undo();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);
  });

  it('redo pops from redo and pushes to undo', () => {
    stack.execute(makeCommand());
    stack.undo();
    stack.redo();

    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
  });

  it('new execute after undo clears redo stack', () => {
    stack.execute(makeCommand('A'));
    stack.execute(makeCommand('B'));
    stack.undo(); // undo B → redo has B
    expect(stack.canRedo).toBe(true);

    stack.execute(makeCommand('C')); // should clear redo
    expect(stack.canRedo).toBe(false);
  });

  it('undo returns false when stack is empty', () => {
    expect(stack.undo()).toBe(false);
  });

  it('redo returns false when stack is empty', () => {
    expect(stack.redo()).toBe(false);
  });

  it('undoDescription and redoDescription reflect top of stack', () => {
    expect(stack.undoDescription).toBeNull();
    expect(stack.redoDescription).toBeNull();

    stack.execute(makeCommand('first'));
    expect(stack.undoDescription).toBe('first');

    stack.undo();
    expect(stack.redoDescription).toBe('first');
  });

  it('execute actually mutates the document', () => {
    const cmd = makeCommand('x');
    stack.execute(cmd);
    expect(doc.name).toBe('base+x');

    stack.undo();
    expect(doc.name).toBe('base');

    stack.redo();
    expect(doc.name).toBe('base+x');
  });

  it('enforces history limit of 100 commands', () => {
    for (let i = 0; i < 101; i++) {
      stack.execute(makeCommand(`c${i}`));
    }
    // The first command should have been evicted
    // We can verify by undoing 100 times (should succeed) and the 101st should fail
    let undoCount = 0;
    while (stack.undo()) {
      undoCount++;
    }
    expect(undoCount).toBe(100);
  });

  it('setDocument resets both stacks', () => {
    stack.execute(makeCommand());
    stack.undo();
    expect(stack.canRedo).toBe(true);

    const newDoc = createDocument('new');
    stack.setDocument(newDoc);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });
});
