import { useSyncExternalStore } from 'react';

/** Subscribe a component to the embed controller's { surface, specifyClosed }. */
export function useEmbedState(embed) {
  return useSyncExternalStore(embed.subscribe, embed.getSnapshot, embed.getSnapshot);
}
