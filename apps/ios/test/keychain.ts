/** Read the map lazily: the mock factory can run before the test file declares its state. */
export function keychain(items: () => Map<string, string>) {
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
    getItemAsync: async (key: string) => items().get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      items().set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      items().delete(key);
    },
  };
}
