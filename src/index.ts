import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import logger from './utils/logger';
import { stripeWebhook } from './services/stripe-webhook';
import { paymentProcessor } from './services/payment-processor';
import { redisClient } from './utils/redis-client';
import { crmIntegration } from './services/crm-integration';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient();

// Stripe webhook endpoint - needs raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      logger.error('Missing Stripe signature header');
      return res.status(400).json({ error: 'Missing signature' });
    }

    try {
      const event = stripeWebhook.verifyWebhookSignature(req.body, signature);

      logger.info(`Received webhook: ${event.type} (${event.id})`);

      // Fire and forget - don't make Stripe wait for our processing
      stripeWebhook.processWebhook(event).catch((error) => {
        logger.error('Error processing webhook:', error);
      });

      // Always respond quickly so Stripe doesn't retry
      res.status(200).json({ received: true });
    } catch (error: any) {
      logger.error('Webhook signature verification failed:', error.message);
      return res.status(400).json({ error: error.message });
    }
  }
);

// Standard JSON middleware for other routes
app.use(express.json());

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    const dbHealthy = true;

    // Check Redis connection
    const redisHealthy = redisClient.isReady();

    // Check CRM connection
    const crmHealthy = await crmIntegration.healthCheck();

    const healthy = dbHealthy && redisHealthy && crmHealthy;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'up' : 'down',
        redis: redisHealthy ? 'up' : 'down',
        crm: crmHealthy ? 'up' : 'down',
      },
    });
  } catch (error: any) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

// Get system statistics
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const [
      totalCustomers,
      totalPayments,
      successfulPayments,
      failedPayments,
      syncedPayments,
      unsyncedPayments,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'SUCCEEDED' } }),
      prisma.payment.count({ where: { status: 'FAILED' } }),
      prisma.payment.count({ where: { syncedToCrm: true } }),
      prisma.payment.count({ where: { syncedToCrm: false } }),
    ]);

    const recentPayments = await prisma.payment.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: {
          select: {
            email: true,
            name: true,
          },
        },
      },
    });

    res.json({
      customers: {
        total: totalCustomers,
      },
      payments: {
        total: totalPayments,
        succeeded: successfulPayments,
        failed: failedPayments,
        synced: syncedPayments,
        unsynced: unsyncedPayments,
        syncRate: totalPayments > 0 ? ((syncedPayments / totalPayments) * 100).toFixed(2) + '%' : '0%',
      },
      recentPayments: recentPayments.map((p) => ({
        id: p.id,
        amount: p.amount / 100,
        currency: p.currency,
        status: p.status,
        syncedToCrm: p.syncedToCrm,
        customerEmail: p.customer.email,
        createdAt: p.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger CRM sync retry
app.post('/api/retry-syncs', async (_req: Request, res: Response) => {
  try {
    logger.info('Manually triggering CRM sync retry');
    await paymentProcessor.retryFailedSyncs();
    res.json({ success: true, message: 'Retry triggered' });
  } catch (error: any) {
    logger.error('Error triggering retry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually retry failed webhooks
app.post('/api/retry-webhooks', async (_req: Request, res: Response) => {
  try {
    logger.info('Manually triggering webhook retry');
    await stripeWebhook.retryFailedWebhooks();
    res.json({ success: true, message: 'Webhook retry triggered' });
  } catch (error: any) {
    logger.error('Error triggering webhook retry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down gracefully...');

  try {
    await prisma.$disconnect();
    await redisClient.disconnect();
    logger.info('Cleanup completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // Schedule periodic retry jobs
    setInterval(async () => {
      try {
        await paymentProcessor.retryFailedSyncs();
      } catch (error) {
        logger.error('Error in scheduled CRM sync retry:', error);
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    setInterval(async () => {
      try {
        await stripeWebhook.retryFailedWebhooks();
      } catch (error) {
        logger.error('Error in scheduled webhook retry:', error);
      }
    }, 10 * 60 * 1000); // Every 10 minutes

    app.listen(PORT, () => {
      logger.info('='.repeat(60));
      logger.info(`🚀 Payment Automation Service running on port ${PORT}`);
      logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
      logger.info(`📊 Statistics: http://localhost:${PORT}/api/stats`);
      logger.info(`🔗 Stripe webhooks: http://localhost:${PORT}/webhooks/stripe`);
      logger.info('='.repeat(60));
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
