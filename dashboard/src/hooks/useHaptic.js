/**
 * useHaptic — Telegram WebApp haptic feedback helper.
 * Returns no-op functions when running outside Telegram.
 */
export function useHaptic() {
  const haptic = window.Telegram?.WebApp?.HapticFeedback;
  return {
    light: () => haptic?.impactOccurred('light'),
    medium: () => haptic?.impactOccurred('medium'),
    heavy: () => haptic?.impactOccurred('heavy'),
    success: () => haptic?.notificationOccurred('success'),
    error: () => haptic?.notificationOccurred('error'),
    warning: () => haptic?.notificationOccurred('warning'),
  };
}
