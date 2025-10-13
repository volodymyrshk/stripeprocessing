import { PrismaClient, PaymentStatus } from '@prisma/client';
import logger from '../utils/logger';
import { crmIntegration } from './crm-integration';
import { redisClient } from '../utils/redis-client';

const prisma = new PrismaClient();

export interface ProcessPaymentData {
  stripePaymentIntentId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  description?: string;
  metadata?: any;
}

export class PaymentProcessorService {
  /**
   * Process payment and sync to CRM
   */
  async processPayment(data: ProcessPaymentData): Promise<void> {
    const context = `Process Payment (${data.stripePaymentIntentId})`;
    logger.info(`${context}: Starting payment processing`);

    // Acquire lock to prevent duplicate processing
    const lockValue = await redisClient.acquireLock(
      `payment:${data.stripePaymentIntentId}`,
      30000
    );

    if (!lockValue) {
      logger.warn(`${context}: Could not acquire lock, payment may be processing elsewhere`);
      return;
    }

    try {
      // Check if payment already exists
      const existingPayment = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: data.stripePaymentIntentId },
        include: { customer: true },
      });

      if (existingPayment) {
        logger.info(`${context}: Payment already exists, updating status`);
        await this.updatePaymentStatus(data.stripePaymentIntentId, data.status);
        return;
      }

      // Create payment in database
      const payment = await prisma.payment.create({
        data: {
          stripePaymentIntentId: data.stripePaymentIntentId,
          customerId: data.customerId,
          amount: data.amount,
          currency: data.currency,
          status: data.status,
          description: data.description,
          metadata: data.metadata,
        },
        include: { customer: true },
      });

      logger.info(`${context}: Payment created in database`, { paymentId: payment.id });

      // Sync to CRM
      await this.syncPaymentToCrm(payment.id);
    } catch (error: any) {
      logger.error(`${context}: Error processing payment:`, {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    } finally {
      // Release lock
      await redisClient.releaseLock(`payment:${data.stripePaymentIntentId}`, lockValue);
    }
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    stripePaymentIntentId: string,
    status: PaymentStatus
  ): Promise<void> {
    const context = `Update Payment Status (${stripePaymentIntentId})`;
    logger.info(`${context}: Updating to ${status}`);

    try {
      const payment = await prisma.payment.update({
        where: { stripePaymentIntentId },
        data: { status },
      });

      // Sync status update to CRM
      await crmIntegration.updatePaymentStatus(stripePaymentIntentId, status);

      logger.info(`${context}: Successfully updated to ${status}`);
    } catch (error: any) {
      logger.error(`${context}: Error updating payment status:`, error.message);
      throw error;
    }
  }

  /**
   * Sync payment to CRM with retry tracking
   */
  async syncPaymentToCrm(paymentId: string): Promise<void> {
    const context = `Sync Payment to CRM (${paymentId})`;

    try {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { customer: true },
      });

      if (!payment) {
        throw new Error(`Payment ${paymentId} not found`);
      }

      if (payment.syncedToCrm) {
        logger.info(`${context}: Already synced`);
        return;
      }

      logger.info(`${context}: Attempting CRM sync (attempt ${payment.crmSyncAttempts + 1})`);

      // Sync customer first if needed
      if (!payment.customer.crmId) {
        logger.info(`${context}: Syncing customer first`);
        const customerResult = await crmIntegration.syncCustomer({
          email: payment.customer.email,
          name: payment.customer.name,
          phone: payment.customer.phone,
          stripeCustomerId: payment.customer.stripeId,
        });

        if (customerResult.success && customerResult.crmId) {
          await prisma.customer.update({
            where: { id: payment.customer.id },
            data: { crmId: customerResult.crmId },
          });
        }
      }

      // Sync payment to CRM
      const result = await crmIntegration.syncPayment({
        customerId: payment.customer.crmId || payment.customer.stripeId,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        description: payment.description || undefined,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        metadata: payment.metadata as any,
      });

      // Update sync status in database
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          syncedToCrm: result.success,
          crmSyncAttempts: payment.crmSyncAttempts + 1,
          lastCrmSyncAt: new Date(),
          crmSyncError: result.success ? null : 'Failed to sync to CRM',
        },
      });

      if (result.success) {
        logger.info(`${context}: Successfully synced to CRM`);
      } else {
        logger.error(`${context}: Failed to sync to CRM`);
      }
    } catch (error: any) {
      logger.error(`${context}: Error syncing to CRM:`, {
        error: error.message,
        stack: error.stack,
      });

      // Update error in database
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          crmSyncAttempts: { increment: 1 },
          lastCrmSyncAt: new Date(),
          crmSyncError: error.message,
        },
      });

      throw error;
    }
  }

  /**
   * Retry failed CRM syncs
   */
  async retryFailedSyncs(): Promise<void> {
    logger.info('Checking for failed CRM syncs to retry');

    try {
      const failedPayments = await prisma.payment.findMany({
        where: {
          syncedToCrm: false,
          crmSyncAttempts: { lt: 5 }, // Max 5 attempts
        },
        take: 10, // Process in batches
      });

      logger.info(`Found ${failedPayments.length} payments to retry`);

      for (const payment of failedPayments) {
        try {
          await this.syncPaymentToCrm(payment.id);
        } catch (error: any) {
          logger.error(`Failed to retry sync for payment ${payment.id}:`, error.message);
        }
      }
    } catch (error: any) {
      logger.error('Error retrying failed syncs:', error.message);
    }
  }
}

export const paymentProcessor = new PaymentProcessorService();
export default paymentProcessor;
