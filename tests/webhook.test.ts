import { redisClient } from '../src/utils/redis-client';
import { retryHandler, RetryHandler } from '../src/utils/retry-handler';

describe('Redis Client', () => {
  beforeAll(async () => {
    // Wait for Redis to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    await redisClient.disconnect();
  });

  describe('Event Processing', () => {
    it('should mark event as processed', async () => {
      const eventId = 'test_event_123';

      // Initially not processed
      let isProcessed = await redisClient.isEventProcessed(eventId);
      expect(isProcessed).toBe(false);

      // Mark as processed
      await redisClient.markEventProcessed(eventId, 10); // 10 second TTL for test

      // Should now be processed
      isProcessed = await redisClient.isEventProcessed(eventId);
      expect(isProcessed).toBe(true);
    });

    it('should prevent duplicate event processing', async () => {
      const eventId = 'test_event_duplicate';

      await redisClient.markEventProcessed(eventId, 10);

      const isProcessed = await redisClient.isEventProcessed(eventId);
      expect(isProcessed).toBe(true);
    });
  });

  describe('CRM Sync Cache', () => {
    it('should cache CRM sync status', async () => {
      const paymentId = 'payment_123';
      const status = 'synced';

      await redisClient.setCrmSyncCache(paymentId, status, 10);

      const cachedStatus = await redisClient.getCrmSyncCache(paymentId);
      expect(cachedStatus).toBe(status);
    });

    it('should return null for non-existent cache', async () => {
      const cachedStatus = await redisClient.getCrmSyncCache('non_existent');
      expect(cachedStatus).toBeNull();
    });
  });

  describe('Distributed Lock', () => {
    it('should acquire and release lock', async () => {
      const resource = 'payment_456';

      // Acquire lock
      const lockValue = await redisClient.acquireLock(resource, 5000);
      expect(lockValue).not.toBeNull();

      // Try to acquire same lock (should fail)
      const lockValue2 = await redisClient.acquireLock(resource, 5000);
      expect(lockValue2).toBeNull();

      // Release lock
      const released = await redisClient.releaseLock(resource, lockValue!);
      expect(released).toBe(true);

      // Should be able to acquire again
      const lockValue3 = await redisClient.acquireLock(resource, 5000);
      expect(lockValue3).not.toBeNull();

      // Cleanup
      await redisClient.releaseLock(resource, lockValue3!);
    });
  });
});

describe('Retry Handler', () => {
  it('should succeed on first attempt', async () => {
    const mockFn = jest.fn().mockResolvedValue('success');

    const result = await retryHandler.execute(mockFn, 'Test Operation');

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    let attempts = 0;
    const mockFn = jest.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Temporary failure');
      }
      return Promise.resolve('success');
    });

    const result = await retryHandler.execute(
      mockFn,
      'Test Operation',
      {
        maxAttempts: 3,
        delayMs: 100,
      }
    );

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should fail after max attempts', async () => {
    const mockFn = jest.fn().mockRejectedValue(new Error('Persistent failure'));

    await expect(
      retryHandler.execute(mockFn, 'Test Operation', {
        maxAttempts: 2,
        delayMs: 50,
      })
    ).rejects.toThrow('failed after 2 attempts');

    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should call onRetry callback', async () => {
    let attempts = 0;
    const mockFn = jest.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Failure');
      }
      return Promise.resolve('success');
    });

    const onRetry = jest.fn();

    await retryHandler.execute(mockFn, 'Test Operation', {
      maxAttempts: 3,
      delayMs: 50,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

describe('Error Classification', () => {
  it('should identify retryable errors', () => {
    const retryableErrors = [
      { code: 'ECONNREFUSED' },
      { code: 'ETIMEDOUT' },
      { code: 'ENOTFOUND' },
      { response: { status: 429 } },
      { response: { status: 503 } },
    ];

    retryableErrors.forEach((error) => {
      expect(RetryHandler.isRetryableError(error)).toBe(true);
    });
  });

  it('should identify non-retryable errors', () => {
    const nonRetryableErrors = [
      { response: { status: 400 } },
      { response: { status: 401 } },
      { response: { status: 404 } },
      { message: 'Generic error' },
    ];

    nonRetryableErrors.forEach((error) => {
      expect(RetryHandler.isRetryableError(error)).toBe(false);
    });
  });
});
