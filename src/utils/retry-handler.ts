import logger from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  exponentialBackoff?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

export class RetryHandler {
  private maxAttempts: number;
  private delayMs: number;
  private exponentialBackoff: boolean;

  constructor(options: RetryOptions = {}) {
    this.maxAttempts = options.maxAttempts || parseInt(process.env.MAX_RETRY_ATTEMPTS || '3');
    this.delayMs = options.delayMs || parseInt(process.env.RETRY_DELAY_MS || '1000');
    this.exponentialBackoff = options.exponentialBackoff ?? true;
  }

  // Main retry loop - tries the function up to maxAttempts times
  async execute<T>(
    fn: () => Promise<T>,
    context: string = 'operation',
    options?: RetryOptions
  ): Promise<T> {
    const maxAttempts = options?.maxAttempts || this.maxAttempts;
    const delayMs = options?.delayMs || this.delayMs;
    const useExponentialBackoff = options?.exponentialBackoff ?? this.exponentialBackoff;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.info(`${context}: Attempt ${attempt}/${maxAttempts}`);
        return await fn();
      } catch (error) {
        lastError = error as Error;
        logger.warn(`${context}: Attempt ${attempt} failed:`, {
          error: lastError.message,
        });

        if (options?.onRetry) {
          options.onRetry(attempt, lastError);
        }

        // Don't sleep after the final attempt - just fail fast
        if (attempt < maxAttempts) {
          const waitTime = useExponentialBackoff
            ? this.calculateExponentialDelay(attempt, delayMs)
            : delayMs;

          logger.info(`${context}: Waiting ${waitTime}ms before retry`);
          await this.sleep(waitTime);
        }
      }
    }

    logger.error(`${context}: All ${maxAttempts} attempts failed`);
    throw new Error(
      `${context} failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`
    );
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, etc.
  // Jitter helps prevent thundering herd when multiple services retry at once
  private calculateExponentialDelay(attempt: number, baseDelay: number): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.3 * exponentialDelay; // +/- 30% randomness
    return Math.min(exponentialDelay + jitter, 30000); // never wait more than 30s
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Figure out if this error is worth retrying
  // Network issues? Yes. Bad request? No.
  static isRetryableError(error: any): boolean {
    // Connection problems - definitely retry these
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // HTTP errors - only retry server errors and rate limits
    if (error.response?.status) {
      const status = error.response.status;
      return status === 408 || status === 429 || (status >= 500 && status < 600);
    }

    return false;
  }
}

// Export default instance
export const retryHandler = new RetryHandler();
export default retryHandler;
