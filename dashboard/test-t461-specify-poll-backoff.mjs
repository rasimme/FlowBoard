// T-461: SpecifyStepper's session poll must (a) not fire while the panel is
// not visible (document.hidden), and (b) never leave a freshly arrived
// clarification/proposal/error sitting behind a backed-off interval — a
// change must snap the cadence back to the fast base immediately, and so
// must an explicit user action (answer/skip/revise/retry/confirm), since its
// own POST response applies the change locally before the next poll tick
// could otherwise notice.
//
// The scheduler under test (src/utils/adaptivePoll.mjs) is the pure,
// non-React piece SpecifyStepper.jsx wires up in its poll effect. It takes
// injectable isHidden/addVisibilityListener/setTimeoutFn/clearTimeoutFn, so
// its exact timing/backoff behavior can be driven and observed here with a
// deterministic virtual clock — no browser, no jsdom, no real waiting.
// Mirrors this suite's existing style for pure-logic modules (see
// test-connection-state.mjs): plain node:assert calls, no test framework.

import assert from 'node:assert/strict';
import { startAdaptivePoll } from './src/utils/adaptivePoll.mjs';

console.log('# Specify session poll: visibility pause + adaptive backoff (T-461)');

// --- Deterministic fake clock ---------------------------------------------

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, cb }
  const scheduledDelays = [];

  function setTimeoutFn(cb, delay) {
    const id = nextId++;
    scheduledDelays.push(delay);
    timers.set(id, { at: now + delay, cb });
    return id;
  }
  function clearTimeoutFn(id) {
    timers.delete(id);
  }
  // Advances the virtual clock by `ms`, running every timer whose fire time
  // falls at or before the target — including a timer newly scheduled by a
  // callback that already ran within this same advance (a real event loop
  // does the same for a chain of immediately-rescheduled timers).
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      let earliestId = null;
      let earliestAt = Infinity;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < earliestAt) { earliestAt = t.at; earliestId = id; }
      }
      if (earliestId == null) { now = target; return; }
      const { cb } = timers.get(earliestId);
      timers.delete(earliestId);
      now = earliestAt;
      await cb();
    }
  }
  return { setTimeoutFn, clearTimeoutFn, advance, scheduledDelays, pendingCount: () => timers.size };
}

function createFakeVisibility(initiallyHidden) {
  let hidden = initiallyHidden;
  let handler = null;
  return {
    isHidden: () => hidden,
    addVisibilityListener: (h) => { handler = h; return () => { handler = null; }; },
    // Flips visibility and fires the registered handler, awaiting whatever
    // it returns — mirrors document.dispatchEvent('visibilitychange') being
    // synchronous, but lets the test await the handler's own async reload.
    async setHidden(next) {
      hidden = next;
      return handler ? handler() : undefined;
    },
  };
}

// --- Test 1: paused entirely while the panel is not visible ---------------
{
  const clock = createFakeClock();
  const vis = createFakeVisibility(true);
  let pollCalls = 0;
  const poller = startAdaptivePoll({
    poll: async () => { pollCalls += 1; return false; },
    baseMs: 2000,
    maxMs: 12000,
    isHidden: vis.isHidden,
    addVisibilityListener: vis.addVisibilityListener,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await clock.advance(60000); // well past many base intervals
  assert.equal(pollCalls, 0,
    'no poll fires while document.hidden is true, no matter how long the panel stays open in the background');
  poller.stop();
}

// --- Test 2: becoming visible reloads immediately, not on the old cadence -
{
  const clock = createFakeClock();
  const vis = createFakeVisibility(true);
  let pollCalls = 0;
  const poller = startAdaptivePoll({
    poll: async () => { pollCalls += 1; return false; },
    baseMs: 2000,
    maxMs: 12000,
    isHidden: vis.isHidden,
    addVisibilityListener: vis.addVisibilityListener,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  assert.equal(pollCalls, 0, 'sanity: still paused before becoming visible');
  await vis.setHidden(false); // fires the registered visibilitychange handler
  assert.equal(pollCalls, 1, 'becoming visible triggers an immediate poll, not a wait for the next scheduled tick');
  poller.stop();
}

// --- Test 3: stepwise backoff while unchanged, capped at maxMs ------------
{
  const clock = createFakeClock();
  const vis = createFakeVisibility(false);
  let pollCalls = 0;
  const poller = startAdaptivePoll({
    poll: async () => { pollCalls += 1; return false; }, // always "unchanged"
    baseMs: 2000,
    maxMs: 12000,
    isHidden: vis.isHidden,
    addVisibilityListener: vis.addVisibilityListener,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await clock.advance(2000 + 4000 + 8000 + 12000 + 12000); // 5 ticks
  assert.equal(pollCalls, 5, 'five ticks fired across the advanced window');
  assert.deepEqual(
    clock.scheduledDelays,
    [2000, 4000, 8000, 12000, 12000, 12000],
    'the delay between ticks doubles from the 2s base up to the 12s ceiling and then holds '
    + '(the trailing 12000 is the 6th tick, scheduled by the 5th but not yet fired)',
  );
  poller.stop();
}

// --- Test 4: any change snaps the cadence back to the fast base -----------
{
  const clock = createFakeClock();
  const vis = createFakeVisibility(false);
  const results = [false, false, true, false]; // unchanged, unchanged, CHANGED, unchanged
  let i = 0;
  const poller = startAdaptivePoll({
    poll: async () => results[Math.min(i++, results.length - 1)],
    baseMs: 2000,
    maxMs: 12000,
    isHidden: vis.isHidden,
    addVisibilityListener: vis.addVisibilityListener,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await clock.advance(16000);
  assert.deepEqual(
    clock.scheduledDelays,
    [2000, 4000, 8000, 2000, 4000],
    'a poll reporting a change (3rd tick) resets the next delay to the 2s base — a freshly arrived '
    + 'question/proposal/error is never left waiting behind the backed-off cadence',
  );
  poller.stop();
}

// --- Test 5: explicit reset() (a user action) lowers the *next* backoff ---
// --- step, without touching a timer that's already pending ----------------
{
  const clock = createFakeClock();
  const vis = createFakeVisibility(false);
  let pollCalls = 0;
  const poller = startAdaptivePoll({
    poll: async () => { pollCalls += 1; return false; }, // always "unchanged"
    baseMs: 2000,
    maxMs: 12000,
    isHidden: vis.isHidden,
    addVisibilityListener: vis.addVisibilityListener,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  await clock.advance(2000 + 4000); // two unchanged ticks -> a third is pending, 8s out
  assert.deepEqual(clock.scheduledDelays, [2000, 4000, 8000],
    'sanity: two unchanged ticks back the cadence off to an 8s pending tick');
  assert.equal(clock.pendingCount(), 1, 'sanity: the third tick is already scheduled');

  poller.reset(); // simulates postStep/requestNext firing mid-cycle after a user action
  assert.equal(clock.pendingCount(), 1,
    'reset() does not cancel/reschedule a timer that is already pending — matches '
    + "DashboardContext's resetPollInterval (T-450-4)");

  await clock.advance(8000); // let the already-pending tick fire
  assert.equal(pollCalls, 3, 'the pending tick still fires at its original 8s delay, unaffected by reset()');
  assert.deepEqual(clock.scheduledDelays, [2000, 4000, 8000, 4000],
    'that tick still reported "unchanged", so the delay it schedules afterwards doubles from the just-reset '
    + 'base (2s -> 4s) instead of continuing the pre-reset progression (would have been 12s) — reset() takes '
    + 'effect starting with the very next backoff step, exactly like DashboardContext.resetPollInterval',
  );
  poller.stop();
}

console.log('T-461 adaptive poll backoff tests passed');
