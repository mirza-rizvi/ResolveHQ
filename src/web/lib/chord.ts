// The shell owns the `g` navigation chord. Page-level shortcut handlers run
// before it (child effects subscribe first), so they consult `chordPending()`
// to keep `g k` from also moving the inbox selection on its way to Knowledge.
let pendingUntil = 0;

export const startChord = () => {
  pendingUntil = Date.now() + 1000;
};

export const chordPending = () => Date.now() < pendingUntil;

export const clearChord = () => {
  pendingUntil = 0;
};
