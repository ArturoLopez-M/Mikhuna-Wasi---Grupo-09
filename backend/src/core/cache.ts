import Redis from "ioredis";

// Operaciones de ElastiCache (Redis) que usa el sistema. Es una interfaz
// pequeña para poder probar con un doble en memoria.
export interface Cache {
  get(key: string): Promise<string | null>;
  // Con onlyIfAbsent = true es un SET NX: devuelve false si la clave ya existía.
  set(key: string, value: string, ttlSeconds: number, onlyIfAbsent?: boolean): Promise<boolean>;
  del(key: string): Promise<void>;
  addToSet(key: string, member: string, ttlSeconds: number): Promise<void>;
  removeFromSet(key: string, member: string): Promise<void>;
  members(key: string): Promise<string[]>;
}

export function createRedisCache(url: string): Cache {
  // Timeouts cortos y sin reintentos largos: si ElastiCache no responde, se
  // sigue sin caché en vez de bloquear la petición (RNF07).
  const redis = new Redis(url, {
    connectTimeout: 1000,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on("error", (err) => {
    console.error("ElastiCache no disponible:", err.message);
  });

  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds, onlyIfAbsent = false) {
      const res = onlyIfAbsent
        ? await redis.set(key, value, "EX", ttlSeconds, "NX")
        : await redis.set(key, value, "EX", ttlSeconds);
      return res === "OK";
    },
    async del(key) {
      await redis.del(key);
    },
    async addToSet(key, member, ttlSeconds) {
      await redis.multi().sadd(key, member).expire(key, ttlSeconds).exec();
    },
    async removeFromSet(key, member) {
      await redis.srem(key, member);
    },
    members: (key) => redis.smembers(key),
  };
}

// Pedido en la caché de lectura de Lectura y Configuración. Lleva el
// restaurante en la clave: un pedido nunca se sirve a otro restaurante.
export const ORDER_CACHE_TTL = 60;
export const orderCacheKey = (restaurantId: string, orderId: string) =>
  `order:${restaurantId}:${orderId}`;

// Ejecuta una operación de caché sin dejar que su falla tumbe la operación
// principal: si ElastiCache falla, devuelve `fallback` y lo registra.
export async function tryCache<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "CACHE_UNAVAILABLE",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return fallback;
  }
}
