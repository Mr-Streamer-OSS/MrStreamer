import { createContext, useContext, useEffect, useState } from "react";

/**
 * Told when a control under it takes keyboard or D-pad focus (`true`) and when that control
 * blurs or unmounts (`false`), once each, so a screen can count the controls holding focus.
 * Watch provides it to keep its controls up while one has focus. Keep the value stable.
 */
export const FocusWithin = createContext<((focused: boolean) => void) | null>(null);

/**
 * Whether a control has keyboard or D-pad focus, for it to show. Touch doesn't focus a button on
 * Android, so this is the keyboard's mark alone; spread the handlers onto the `Pressable`.
 */
export function useKeyboardFocus() {
  const [focused, setFocused] = useState(false);
  const within = useContext(FocusWithin);
  useEffect(() => {
    if (!focused || !within) return;
    within(true);

    return () => within(false);
  }, [focused, within]);

  return {
    focused,
    handlers: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  };
}
