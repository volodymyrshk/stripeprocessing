import axios from 'axios';
import Stripe from 'stripe';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhooks/stripe';

// Mock webhook events for testing
const createMockPaymentIntentSucceededEvent = (): Stripe.Event => {
  const now = Math.floor(Date.now() / 1000);
  const paymentIntentId = `pi_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const customerId = `cus_test_${Date.now()}`;

  return {
    id: `evt_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: now,
    type: 'payment_intent.succeeded',
    livemode: false,
    pending_webhooks: 0,
    request: {
      id: null,
      idempotency_key: null,
    },
    data: {
      object: {
        id: paymentIntentId,
        object: 'payment_intent',
        amount: Math.floor(Math.random() * 50000) + 10000, // Random amount between $100-$500
        amount_capturable: 0,
        amount_details: {},
        amount_received: 0,
        application: null,
        application_fee_amount: null,
        automatic_payment_methods: null,
        canceled_at: null,
        cancellation_reason: null,
        capture_method: 'automatic',
        charges: {
          object: 'list',
          data: [],
          has_more: false,
          total_count: 0,
          url: `/v1/charges?payment_intent=${paymentIntentId}`,
        },
        client_secret: `${paymentIntentId}_secret_test`,
        confirmation_method: 'automatic',
        created: now,
        currency: 'usd',
        customer: customerId,
        description: `Property deposit payment - Test ${Date.now()}`,
        invoice: null,
        last_payment_error: null,
        latest_charge: null,
        livemode: false,
        metadata: {
          property_id: `prop_${Math.random().toString(36).substr(2, 9)}`,
          payment_type: 'deposit',
          test_mode: 'true',
        },
        next_action: null,
        on_behalf_of: null,
        payment_method: null,
        payment_method_configuration_details: null,
        payment_method_options: {},
        payment_method_types: ['card'],
        processing: null,
        receipt_email: `test${Date.now()}@example.com`,
        review: null,
        setup_future_usage: null,
        shipping: null,
        source: null,
        statement_descriptor: null,
        statement_descriptor_suffix: null,
        status: 'succeeded',
        transfer_data: null,
        transfer_group: null,
      } as any,
    },
  } as any;
};

const createMockPaymentIntentFailedEvent = (): Stripe.Event => {
  const event = createMockPaymentIntentSucceededEvent();
  event.type = 'payment_intent.payment_failed';
  event.id = `evt_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  (event.data.object as any).status = 'failed';
  (event.data.object as any).last_payment_error = {
    code: 'card_declined',
    message: 'Your card was declined',
    type: 'card_error',
  };
  return event;
};

const createMockCustomerCreatedEvent = (): Stripe.Event => {
  const now = Math.floor(Date.now() / 1000);
  const customerId = `cus_test_${Date.now()}`;

  return {
    id: `evt_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: now,
    type: 'customer.created',
    livemode: false,
    pending_webhooks: 0,
    request: {
      id: null,
      idempotency_key: null,
    },
    data: {
      object: {
        id: customerId,
        object: 'customer',
        address: null,
        balance: 0,
        created: now,
        currency: null,
        default_source: null,
        delinquent: false,
        description: 'Real estate client',
        discount: null,
        email: `client${Date.now()}@realestate.com`,
        invoice_prefix: 'INV',
        invoice_settings: {
          custom_fields: null,
          default_payment_method: null,
          footer: null,
          rendering_options: null,
        },
        livemode: false,
        metadata: {},
        name: `Test Client ${Date.now()}`,
        phone: '+1234567890',
        preferred_locales: [],
        shipping: null,
        tax_exempt: 'none',
        test_clock: null,
      } as any,
    },
  } as any;
};

// Simulate webhook delivery
async function simulateWebhook(event: Stripe.Event) {
  console.log('\n' + '='.repeat(60));
  console.log(`🎯 Simulating webhook: ${event.type}`);
  console.log(`   Event ID: ${event.id}`);
  console.log('='.repeat(60));

  try {
    // In production, Stripe signs webhooks. For local testing, we skip verification
    // by using the raw endpoint or setting a test signature

    const response = await axios.post(WEBHOOK_URL, event, {
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'test_signature', // In production, use proper Stripe signatures
      },
    });

    console.log(`✅ Webhook delivered successfully`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, response.data);
  } catch (error: any) {
    console.error(`❌ Webhook delivery failed`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Error:`, error.response.data);
    } else {
      console.error(`   Error:`, error.message);
    }
  }
}

// Simulate a series of webhooks
async function runSimulation() {
  console.log('\n🚀 Starting webhook simulation...\n');

  // Wait a bit for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 1. Create customer
  console.log('Step 1: Creating customer...');
  await simulateWebhook(createMockCustomerCreatedEvent());
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 2. Successful payment
  console.log('\nStep 2: Processing successful payment...');
  await simulateWebhook(createMockPaymentIntentSucceededEvent());
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 3. Another successful payment
  console.log('\nStep 3: Processing another successful payment...');
  await simulateWebhook(createMockPaymentIntentSucceededEvent());
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 4. Failed payment
  console.log('\nStep 4: Processing failed payment...');
  await simulateWebhook(createMockPaymentIntentFailedEvent());
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('\n' + '='.repeat(60));
  console.log('🎉 Simulation complete!');
  console.log('='.repeat(60));
  console.log('\n📊 Check the stats at: http://localhost:3000/api/stats');
  console.log('🏥 Health check at: http://localhost:3000/health\n');
}

// Run if called directly
if (require.main === module) {
  runSimulation()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Simulation failed:', error);
      process.exit(1);
    });
}

export { simulateWebhook, createMockPaymentIntentSucceededEvent };
