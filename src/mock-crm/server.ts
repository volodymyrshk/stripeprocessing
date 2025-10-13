import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.MOCK_CRM_API_KEY || 'mock_crm_api_key_12345';

// In-memory storage (simulating CRM database)
const customers: Map<string, any> = new Map();
const payments: Map<string, any> = new Map();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// API Key authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  next();
};

// Randomly fail 10% of requests to test our retry logic
// The real CRM had occasional timeouts too, so this simulates that
const simulateRandomFailure = (_req: Request, res: Response, next: NextFunction) => {
  if (Math.random() < 0.1) {
    console.log('🔴 Simulating API failure for testing');
    return res.status(503).json({
      error: 'Service Temporarily Unavailable',
      message: 'Simulated failure for testing retry logic',
    });
  }
  next();
};

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Mock CRM API',
    timestamp: new Date().toISOString(),
  });
});

// ==================== CUSTOMER ENDPOINTS ====================

// Create or update customer
app.post('/api/customers', authenticate, simulateRandomFailure, (req: Request, res: Response) => {
  try {
    const { email, name, phone, stripeCustomerId, metadata } = req.body;

    if (!email || !stripeCustomerId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email and stripeCustomerId are required',
      });
    }

    // Check if we've seen this customer before
    let customer = Array.from(customers.values()).find(
      (c) => c.stripeCustomerId === stripeCustomerId
    );

    if (customer) {
      // Update existing - their API worked this way too
      customer.email = email;
      customer.name = name;
      customer.phone = phone;
      customer.metadata = metadata;
      customer.updatedAt = new Date().toISOString();

      console.log(`✅ Updated customer: ${customer.id}`);

      return res.status(200).json({
        id: customer.id,
        customerId: customer.id,
        ...customer,
      });
    }

    // Create new customer
    const customerId = `crm_cust_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    customer = {
      id: customerId,
      email,
      name,
      phone,
      stripeCustomerId,
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    customers.set(customerId, customer);
    console.log(`✅ Created customer: ${customerId}`);

    res.status(201).json({
      id: customerId,
      customerId,
      ...customer,
    });
  } catch (error: any) {
    console.error('Error creating customer:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message,
    });
  }
});

// Get customer by Stripe ID
app.get('/api/customers/stripe/:stripeId', authenticate, (req: Request, res: Response) => {
  const { stripeId } = req.params;

  const customer = Array.from(customers.values()).find(
    (c) => c.stripeCustomerId === stripeId
  );

  if (!customer) {
    return res.status(404).json({
      error: 'Not Found',
      message: 'Customer not found',
    });
  }

  res.status(200).json(customer);
});

// List all customers
app.get('/api/customers', authenticate, (_req: Request, res: Response) => {
  const customerList = Array.from(customers.values());
  res.status(200).json({
    customers: customerList,
    total: customerList.length,
  });
});

// ==================== PAYMENT ENDPOINTS ====================

// Create payment
app.post('/api/payments', authenticate, simulateRandomFailure, (req: Request, res: Response) => {
  try {
    const { customerId, amount, currency, status, description, stripePaymentIntentId, metadata } = req.body;

    if (!customerId || !amount || !stripePaymentIntentId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'customerId, amount, and stripePaymentIntentId are required',
      });
    }

    // Check if payment already exists
    let payment = Array.from(payments.values()).find(
      (p) => p.stripePaymentIntentId === stripePaymentIntentId
    );

    if (payment) {
      console.log(`✅ Payment already exists: ${payment.id}`);
      return res.status(200).json({
        id: payment.id,
        paymentId: payment.id,
        ...payment,
      });
    }

    // Create new payment
    const paymentId = `crm_pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    payment = {
      id: paymentId,
      customerId,
      amount,
      currency: currency || 'usd',
      status: status || 'pending',
      description,
      stripePaymentIntentId,
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    payments.set(paymentId, payment);
    console.log(`✅ Created payment: ${paymentId} (Amount: $${amount / 100})`);

    res.status(201).json({
      id: paymentId,
      paymentId,
      ...payment,
    });
  } catch (error: any) {
    console.error('Error creating payment:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message,
    });
  }
});

// Update payment status
app.patch('/api/payments/:paymentIntentId', authenticate, simulateRandomFailure, (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.params;
    const { status } = req.body;

    const payment = Array.from(payments.values()).find(
      (p) => p.stripePaymentIntentId === paymentIntentId
    );

    if (!payment) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Payment not found',
      });
    }

    payment.status = status;
    payment.updatedAt = new Date().toISOString();

    console.log(`✅ Updated payment ${payment.id} status to: ${status}`);

    res.status(200).json(payment);
  } catch (error: any) {
    console.error('Error updating payment:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message,
    });
  }
});

// Get payment by Stripe Payment Intent ID
app.get('/api/payments/:paymentIntentId', authenticate, (req: Request, res: Response) => {
  const { paymentIntentId } = req.params;

  const payment = Array.from(payments.values()).find(
    (p) => p.stripePaymentIntentId === paymentIntentId
  );

  if (!payment) {
    return res.status(404).json({
      error: 'Not Found',
      message: 'Payment not found',
    });
  }

  res.status(200).json(payment);
});

// List all payments
app.get('/api/payments', authenticate, (_req: Request, res: Response) => {
  const paymentList = Array.from(payments.values());
  res.status(200).json({
    payments: paymentList,
    total: paymentList.length,
  });
});

// ==================== ANALYTICS ENDPOINTS ====================

// Get payment statistics
app.get('/api/analytics/payments', authenticate, (_req: Request, res: Response) => {
  const paymentList = Array.from(payments.values());

  const stats = {
    totalPayments: paymentList.length,
    totalAmount: paymentList.reduce((sum, p) => sum + p.amount, 0),
    byStatus: {} as Record<string, number>,
    recentPayments: paymentList.slice(-5).reverse(),
  };

  paymentList.forEach((payment) => {
    stats.byStatus[payment.status] = (stats.byStatus[payment.status] || 0) + 1;
  });

  res.status(200).json(stats);
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
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

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Mock CRM API Server running on port ${PORT}`);
  console.log(`📋 API Key: ${API_KEY}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log('='.repeat(60));
});

export default app;
