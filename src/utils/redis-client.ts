import Redis from 'ioredis';
import logger from './logger';

class RedisClient {
  private client: Redis;
  private isConnected: boolean = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis client connected');
    });

    this.client.on('error', (err) => {
      logger.error('Redis client error:', err);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      this.isConnected = false;
      logger.warn('Redis client connection closed');
    });
  }

  /**
   * Check if webhook event has been processed (idempotency)
   */
  async isEventProcessed(eventId: string): Promise<boolean> {
    try {
      const key = `webhook:processed:${eventId}`;
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error('Error checking event processing status:', error);
      return false;
    }
  }

  /**
   * Mark webhook event as processed
   * TTL: 7 days (604800 seconds)
   */
  async markEventProcessed(eventId: string, ttl: number = 604800): Promise<void> {
    try {
      const key = `webhook:processed:${eventId}`;
      await this.client.setex(key, ttl, Date.now().toString());
      logger.info(`Marked event ${eventId} as processed`);
    } catch (error) {
      logger.error('Error marking event as processed:', error);
      throw error;
    }
  }

  /**
   * Cache CRM sync status to prevent duplicate API calls
   */
  async getCrmSyncCache(paymentId: string): Promise<string | null> {
    try {
      const key = `crm:sync:${paymentId}`;
      return await this.client.get(key);
    } catch (error) {
      logger.error('Error getting CRM sync cache:', error);
      return null;
    }
  }

  /**
   * Set CRM sync cache
   * TTL: 1 hour (3600 seconds)
   */
  async setCrmSyncCache(
    paymentId: string,
    status: string,
    ttl: number = 3600
  ): Promise<void> {
    try {
      const key = `crm:sync:${paymentId}`;
      await this.client.setex(key, ttl, status);
    } catch (error) {
      logger.error('Error setting CRM sync cache:', error);
    }
  }

  /**
   * Acquire distributed lock for payment processing
   */
  async acquireLock(
    resource: string,
    ttl: number = 30000
  ): Promise<string | null> {
    try {
      const lockKey = `lock:${resource}`;
      const lockValue = `${Date.now()}-${Math.random()}`;
      const result = await this.client.set(
        lockKey,
        lockValue,
        'PX',
        ttl,
        'NX'
      );
      return result === 'OK' ? lockValue : null;
    } catch (error) {
      logger.error('Error acquiring lock:', error);
      return null;
    }
  }

  /**
   * Release distributed lock
   */
  async releaseLock(resource: string, lockValue: string): Promise<boolean> {
    try {
      const lockKey = `lock:${resource}`;
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const result = await this.client.eval(script, 1, lockKey, lockValue);
      return result === 1;
    } catch (error) {
      logger.error('Error releasing lock:', error);
      return false;
    }
  }

  /**
   * Get Redis client instance
   */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isReady(): boolean {
    return this.isConnected;
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    await this.client.quit();
    logger.info('Redis client disconnected');
  }
}

export const redisClient = new RedisClient();
export default redisClient;
