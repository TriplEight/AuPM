// Test worker: never answers. It spins until the parent terminates it, so a
// test can reach the parse time limit without a large body.
for (;;) {
  // intentionally empty
}
