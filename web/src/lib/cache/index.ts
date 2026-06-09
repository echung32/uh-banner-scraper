import { cachified } from "@epic-web/cachified";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

const storage = createStorage({ driver: memoryDriver() });

export const cache = {
  get: async (key: string) => {
    const value = await storage.getItem(key);
    return value as { metadata: { createdTime: number; ttl: number | null; swr: number | null }; value: unknown } | null | undefined;
  },
  set: async (key: string, value: unknown) => {
    await storage.setItem(key, value);
  },
  delete: async (key: string) => {
    await storage.removeItem(key);
  },
};

export { cachified };
