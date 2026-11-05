/** Recognizes callable capabilities across realms without executing the candidate. */
export function isCallable(value: unknown): value is Function {
  try {
    Function.prototype.toString.call(value);

    return true;
  } catch {
    return false;
  }
}
