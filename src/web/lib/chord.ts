// The shell owns the `g` navigation chord. Page-level shortcut handlers cannot
// rely on running before it — an effect that re-subscribes puts its listener at
// the back of the queue — so the shell records *which* event it consumed and
// pages stand aside for both a pending chord and the event that closed one.
let pendingUntil = 0;
let consumed: KeyboardEvent | null = null;

export const startChord = () => {
  pendingUntil = Date.now() + 1000;
};

export const chordPending = () => Date.now() < pendingUntil;

/** The shell handled this keystroke as the second half of a chord. */
export function consumeChord(event: KeyboardEvent) {
  consumed = event;
  pendingUntil = 0;
}

/** True while the given keystroke is the one the shell just consumed. */
export function chordConsumed(event: KeyboardEvent) {
  return consumed === event;
}

export const clearChord = () => {
  pendingUntil = 0;
  consumed = null;
};
