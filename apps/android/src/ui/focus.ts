import { useState } from "react";

/**
 * Whether a control has keyboard or D-pad focus, for it to show. Touch doesn't focus a button on
 * Android, so this is the keyboard's mark alone; spread the handlers onto the `Pressable`.
 */
export function useKeyboardFocus() {
  const [focused, setFocused] = useState(false);

  return {
    focused,
    handlers: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  };
}
