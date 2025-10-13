import Stripe from 'stripe';
import { PrismaClient, PaymentStatus } from '@prisma/client';
import logger from '../utils/logger';
import { redisClient } from '../utils/redis-client';
import { paymentProcessor } from './payment-processor';

const prisma = new PrismaClient();

export class StripeWebhookService {
  private stripe: Stripe;
  private webhookSecret: string;

  constructor() {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    if (!stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }

    this.stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
    });

    logger.info('Stripe Webhook Service initialized');
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      );
      return event;
    } catch (error: any) {
      logger.error('Webhook signature verification failed:', error.message);
      throw new Error(`Webhook signature verification failed: ${error.message}`);
    }
  }

  /**
   * Process webhook event
   */
  async processWebhook(event: Stripe.Event): Promise<void> {
    const context = `Webhook ${event.type} (${event.id})`;
    logger.info(`${context}: Processing webhook event`);

    // Check for duplicate event (idempotency)
    const isProcessed = await redisClient.isEventProcessed(event.id);
    if (isProcessed) {
      logger.info(`${context}: Event already processed (idempotent check)`);
      return;
    }

    try {
      // Store webhook event in database
      await this.storeWebhookEvent(event);

      // Process based on event type
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentIntentSucceeded(event);
          break;

        case 'payment_intent.payment_failed':
          await this.handlePaymentIntentFailed(event);
          break;

        case 'payment_intent.canceled':
          await this.handlePaymentIntentCanceled(event);
          break;

        case 'charge.refunded':
          await this.handleChargeRefunded(event);
          break;

        case 'customer.created':
          await this.handleCustomerCreated(event);
          break;

        case 'customer.updated':
          await this.handleCustomerUpdated(event);
          break;

        default:
          logger.info(`${context}: Unhandled event type`);
      }

      // Mark event as processed in Redis
      await redisClient.markEventProcessed(event.id);

      // Update webhook event status
      await prisma.webhookEvent.updateMany({
        where: { stripeEventId: event.id },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });

      logger.info(`${context}: Successfully processed`);
    } catch (error: any) {
      logger.error(`${context}: Error processing webhook:`, {
        error: error.message,
        stack: error.stack,
      });

      // Update error in database
      await prisma.webhookEvent.updateMany({
        where: { stripeEventId: event.id },
        data: {
          processingError: error.message,
          retryCount: { increment: 1 },
        },
      });

      throw error;
    }
  }

  /**
   * Store webhook event in database
   */
  private async storeWebhookEvent(event: Stripe.Event): Promise<void> {
    await prisma.webhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        payload: event as any,
      },
    });
  }

  /**
   * Handle payment_intent.succeeded
   */
  private async handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    logger.info(`Payment succeeded: ${paymentIntent.id}`);

    // Get or create customer
    const customer = await this.getOrCreateCustomer(paymentIntent.customer as string);

    // Process payment
    await paymentProcessor.processPayment({
      stripePaymentIntentId: paymentIntent.id,
      customerId: customer.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: PaymentStatus.SUCCEEDED,
      description: paymentIntent.description || undefined,
      metadata: paymentIntent.metadata,
    });
  }

  /**
   * Handle payment_intent.payment_failed
   */
  private async handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    logger.warn(`Payment failed: ${paymentIntent.id}`);

    const customer = await this.getOrCreateCustomer(paymentIntent.customer as string);

    await paymentProcessor.processPayment({
      stripePaymentIntentId: paymentIntent.id,
      customerId: customer.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: PaymentStatus.FAILED,
      description: paymentIntent.description || undefined,
      metadata: paymentIntent.metadata,
    });
  }

  /**
   * Handle payment_intent.canceled
   */
  private async handlePaymentIntentCanceled(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    logger.info(`Payment canceled: ${paymentIntent.id}`);

    await paymentProcessor.updatePaymentStatus(
      paymentIntent.id,
      PaymentStatus.CANCELED
    );
  }

  /**
   * Handle charge.refunded
   */
  private async handleChargeRefunded(event: Stripe.Event): Promise<void> {
    const charge = event.data.object as Stripe.Charge;
    logger.info(`Charge refunded: ${charge.id}`);

    if (charge.payment_intent) {
      await paymentProcessor.updatePaymentStatus(
        charge.payment_intent as string,
        PaymentStatus.REFUNDED
      );
    }
  }

  /**
   * Handle customer.created
   */
  private async handleCustomerCreated(event: Stripe.Event): Promise<void> {
    const stripeCustomer = event.data.object as Stripe.Customer;
    logger.info(`Customer created: ${stripeCustomer.id}`);

    await this.getOrCreateCustomer(stripeCustomer.id);
  }

  /**
   * Handle customer.updated
   */
  private async handleCustomerUpdated(event: Stripe.Event): Promise<void> {
    const stripeCustomer = event.data.object as Stripe.Customer;
    logger.info(`Customer updated: ${stripeCustomer.id}`);

    const customer = await prisma.customer.findUnique({
      where: { stripeId: stripeCustomer.id },
    });

    if (customer) {
      await prisma.customer.update({
        where: { stripeId: stripeCustomer.id },
        data: {
          email: stripeCustomer.email || customer.email,
          name: stripeCustomer.name || customer.name,
          phone: stripeCustomer.phone || customer.phone,
        },
      });
    }
  }

  /**
   * Get or create customer from Stripe ID
   */
  private async getOrCreateCustomer(stripeCustomerId: string): Promise<any> {
    // Check if customer exists in database
    let customer = await prisma.customer.findUnique({
      where: { stripeId: stripeCustomerId },
    });

    if (customer) {
      return customer;
    }

    // Fetch customer from Stripe
    const stripeCustomer = await this.stripe.customers.retrieve(stripeCustomerId);

    if (stripeCustomer.deleted) {
      throw new Error(`Customer ${stripeCustomerId} has been deleted`);
    }

    // Create customer in database
    customer = await prisma.customer.create({
      data: {
        stripeId: stripeCustomerId,
        email: stripeCustomer.email || `unknown-${stripeCustomerId}@example.com`,
        name: stripeCustomer.name,
        phone: stripeCustomer.phone,
      },
    });

    logger.info(`Created customer: ${customer.id} (Stripe: ${stripeCustomerId})`);

    return customer;
  }

  /**
   * Retry failed webhook processing
   */
  async retryFailedWebhooks(): Promise<void> {
    logger.info('Checking for failed webhooks to retry');

    try {
      const failedEvents = await prisma.webhookEvent.findMany({
        where: {
          processed: false,
          retryCount: { lt: 3 },
        },
        take: 10,
      });

      logger.info(`Found ${failedEvents.length} failed webhooks to retry`);

      for (const event of failedEvents) {
        try {
          await this.processWebhook(event.payload as any);
        } catch (error: any) {
          logger.error(`Failed to retry webhook ${event.id}:`, error.message);
        }
      }
    } catch (error: any) {
      logger.error('Error retrying failed webhooks:', error.message);
    }
  }
}

export const stripeWebhook = new StripeWebhookService();
export default stripeWebhook;
