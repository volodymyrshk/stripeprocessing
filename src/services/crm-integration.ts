import axios, { AxiosInstance } from 'axios';
import logger from '../utils/logger';
import { RetryHandler } from '../utils/retry-handler';
import { redisClient } from '../utils/redis-client';

export interface CrmCustomer {
  id?: string;
  email: string;
  name: string | null;
  phone: string | null;
  stripeCustomerId: string;
  metadata?: Record<string, any>;
}

export interface CrmPayment {
  id?: string;
  customerId: string;
  amount: number;
  currency: string;
  status: string;
  description?: string;
  stripePaymentIntentId: string;
  metadata?: Record<string, any>;
}

export class CrmIntegrationService {
  private client: AxiosInstance;
  private retryHandler: RetryHandler;
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = process.env.MOCK_CRM_URL || 'http://localhost:3001';
    this.apiKey = process.env.MOCK_CRM_API_KEY || 'mock_crm_api_key_12345';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
    });

    this.retryHandler = new RetryHandler({
      maxAttempts: 3,
      delayMs: 1000,
      exponentialBackoff: true,
    });

    logger.info(`CRM Integration Service initialized with base URL: ${this.baseUrl}`);
  }

  // Sync customer to CRM - checks cache first to avoid duplicate API calls
  async syncCustomer(customer: CrmCustomer): Promise<{ success: boolean; crmId?: string }> {
    const context = `CRM Sync Customer (${customer.email})`;

    try {
      // Check cache first - no point hitting their API if we just did this
      const cacheKey = `customer:${customer.stripeCustomerId}`;
      const cachedId = await redisClient.getCrmSyncCache(cacheKey);

      if (cachedId) {
        logger.info(`${context}: Using cached CRM ID: ${cachedId}`);
        return { success: true, crmId: cachedId };
      }

      const result = await this.retryHandler.execute(
        async () => {
          logger.info(`${context}: Sending customer data to CRM`);

          const response = await this.client.post('/api/customers', customer);

          if (response.status !== 200 && response.status !== 201) {
            throw new Error(`CRM API returned status ${response.status}`);
          }

          return response.data;
        },
        context,
        {
          onRetry: (attempt, error) => {
            logger.warn(`${context}: Retry ${attempt} due to:`, error.message);
          },
        }
      );

      const crmId = result.id || result.customerId;

      // Cache it for an hour - prevents hammering their API with duplicates
      await redisClient.setCrmSyncCache(cacheKey, crmId, 3600);

      logger.info(`${context}: Successfully synced. CRM ID: ${crmId}`);
      return { success: true, crmId };
    } catch (error: any) {
      logger.error(`${context}: Failed to sync customer:`, {
        error: error.message,
        stack: error.stack,
      });
      return { success: false };
    }
  }

  // Push payment data to CRM with retry logic
  async syncPayment(payment: CrmPayment): Promise<{ success: boolean; crmPaymentId?: string }> {
    const context = `CRM Sync Payment (${payment.stripePaymentIntentId})`;

    try {
      // Check cache to prevent duplicate syncs
      const cacheKey = `payment:${payment.stripePaymentIntentId}`;
      const cachedStatus = await redisClient.getCrmSyncCache(cacheKey);

      if (cachedStatus === 'synced') {
        logger.info(`${context}: Payment already synced (cached)`);
        return { success: true };
      }

      const result = await this.retryHandler.execute(
        async () => {
          logger.info(`${context}: Sending payment data to CRM`);

          const response = await this.client.post('/api/payments', payment);

          if (response.status !== 200 && response.status !== 201) {
            throw new Error(`CRM API returned status ${response.status}`);
          }

          return response.data;
        },
        context,
        {
          onRetry: (attempt, error) => {
            logger.warn(`${context}: Retry ${attempt} due to:`, error.message);
          },
        }
      );

      const crmPaymentId = result.id || result.paymentId;

      // Cache the success status
      await redisClient.setCrmSyncCache(cacheKey, 'synced', 3600);

      logger.info(`${context}: Successfully synced. CRM Payment ID: ${crmPaymentId}`);
      return { success: true, crmPaymentId };
    } catch (error: any) {
      logger.error(`${context}: Failed to sync payment:`, {
        error: error.message,
        stack: error.stack,
      });
      return { success: false };
    }
  }

  /**
   * Update payment status in CRM
   */
  async updatePaymentStatus(
    stripePaymentIntentId: string,
    status: string
  ): Promise<boolean> {
    const context = `CRM Update Payment Status (${stripePaymentIntentId})`;

    try {
      await this.retryHandler.execute(
        async () => {
          logger.info(`${context}: Updating payment status to ${status}`);

          const response = await this.client.patch(
            `/api/payments/${stripePaymentIntentId}`,
            { status }
          );

          if (response.status !== 200) {
            throw new Error(`CRM API returned status ${response.status}`);
          }

          return response.data;
        },
        context
      );

      logger.info(`${context}: Successfully updated status to ${status}`);
      return true;
    } catch (error: any) {
      logger.error(`${context}: Failed to update payment status:`, {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get customer from CRM by Stripe ID
   */
  async getCustomerByStripeId(stripeCustomerId: string): Promise<CrmCustomer | null> {
    try {
      const response = await this.client.get(`/api/customers/stripe/${stripeCustomerId}`);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      logger.error('Error fetching customer from CRM:', error.message);
      throw error;
    }
  }

  /**
   * Health check for CRM API
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return response.status === 200;
    } catch (error) {
      logger.error('CRM health check failed:', error);
      return false;
    }
  }
}

export const crmIntegration = new CrmIntegrationService();
export default crmIntegration;
