// Coordinates asynchronous Files operations against the project + visibility
// target currently rendered by FilesView. A target generation changes whenever
// either input changes; every operation from the previous generation is
// aborted and can no longer publish a continuation.

export function createFileTargetRuntime() {
  let target = { key: null, generation: 0 };
  const operations = new Set();

  function setTarget(key) {
    if (target.key === key) return target;

    for (const operation of operations) {
      if (!operation.controller.signal.aborted) {
        operation.controller.abort(new DOMException('Files target changed', 'AbortError'));
      }
    }
    target = { key, generation: target.generation + 1 };
    return target;
  }

  function begin(key) {
    if (target.key !== key) setTarget(key);
    const operation = {
      key,
      generation: target.generation,
      controller: new AbortController(),
    };
    operations.add(operation);
    return operation;
  }

  function isCurrent(operation) {
    return !!operation
      && operations.has(operation)
      && !operation.controller.signal.aborted
      && target.key === operation.key
      && target.generation === operation.generation;
  }

  function finish(operation) {
    operations.delete(operation);
  }

  return {
    begin,
    finish,
    getTarget: () => target,
    isCurrent,
    setTarget,
  };
}
