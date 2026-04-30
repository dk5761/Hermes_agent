import * as SecureStore from "expo-secure-store";

// Namespaced wrapper so future cohabitating data (push token, etc.) can't
// collide. SecureStore keys must match /^[\w.-]+$/ on iOS.

const NS = "hermes";

const k = (key: string): string => `${NS}.${key}`;

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(k(key));
  },
  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(k(key), value);
  },
  async del(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(k(key));
  },
};
