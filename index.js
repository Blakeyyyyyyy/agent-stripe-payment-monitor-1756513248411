const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_API_KEY);
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

// Logging system
const logs = [];
const addLog = (level, message, data = {}) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
    id: Date.now() + Math.random()
  };
  logs.unshift(logEntry);
  if (logs.length > 100) logs.pop(); // Keep last 100 logs
  console.log(`[${level.toUpperCase()}] ${message}`, data);
};

// Gmail setup
const oauth2Client = new google.auth.OAuth2();
oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Send email function
async function sendFailureNotification(event, paymentData) {
  try {
    addLog('info', 'Preparing to send email notification', { eventType: event.type });
    
    const { customer, amount, currency, last_payment_error } = paymentData;
    const customerName = customer?.name || customer?.email || 'Unknown Customer';
    const amountFormatted = amount ? (amount / 100).toFixed(2) : 'Unknown';
    
    const subject = `Payment Failed - ${customerName}`;
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc3545;">Payment Failure Alert</h2>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <h3>Payment Details:</h3>
          <ul>
            <li><strong>Customer:</strong> ${customerName}</li>
            <li><strong>Amount:</strong> ${amountFormatted} ${(currency || 'USD').toUpperCase()}</li>
            <li><strong>Event Type:</strong> ${event.type}</li>
            <li><strong>Time:</strong> ${new Date(event.created * 1000).toLocaleString()}</li>
          </ul>
        </div>

        ${last_payment_error ? `
        <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <h4 style="color: #856404;">Error Details:</h4>
          <p><strong>Code:</strong> ${last_payment_error.code || 'N/A'}</p>
          <p><strong>Message:</strong> ${last_payment_error.message || 'No specific error message'}</p>
          <p><strong>Type:</strong> ${last_payment_error.type || 'N/A'}</p>
        </div>
        ` : ''}

        <div style="background-color: #d1ecf1; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #17a2b8;">
          <h4 style="color: #0c5460;">Next Steps:</h4>
          <ol>
            <li>Review the payment method with the customer</li>
            <li>Check for insufficient funds or expired cards</li>
            <li>Consider reaching out to the customer directly</li>
            <li>Monitor for retry attempts</li>
          </ol>
        </div>

        <p style="color: #6c757d; font-size: 14px; margin-top: 30px;">
          This alert was generated automatically by your Stripe Payment Monitor.
        </p>
      </div>
    `;

    const message = {
      from: process.env.GMAIL_FROM_EMAIL || 'noreply@yourcompany.com',
      to: process.env.NOTIFICATION_EMAIL || 'admin@yourcompany.com',
      subject: subject,
      html: htmlBody
    };

    // Create raw email message
    const rawMessage = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      message.html
    ].join('\n');

    const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    addLog('success', 'Email notification sent successfully', { 
      customer: customerName, 
      amount: amountFormatted,
      eventType: event.type 
    });

  } catch (error) {
    addLog('error', 'Failed to send email notification', { 
      error: error.message,
      eventType: event.type 
    });
    throw error;
  }
}

// Extract payment data from Stripe event
function extractPaymentData(event) {
  const data = event.data.object;
  
  switch (event.type) {
    case 'payment_intent.payment_failed':
      return {
        customer: data.customer,
        amount: data.amount,
        currency: data.currency,
        last_payment_error: data.last_payment_error
      };
    
    case 'invoice.payment_failed':
      return {
        customer: data.customer,
        amount: data.amount_due,
        currency: data.currency,
        last_payment_error: data.last_payment_error
      };
    
    case 'charge.failed':
      return {
        customer: data.customer,
        amount: data.amount,
        currency: data.currency,
        last_payment_error: data.failure_code ? {
          code: data.failure_code,
          message: data.failure_message,
          type: 'card_error'
        } : null
      };
    
    default:
      return {
        customer: data.customer || null,
        amount: data.amount || data.amount_due || null,
        currency: data.currency || null,
        last_payment_error: data.last_payment_error || null
      };
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Payment Failure Monitor',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      'GET /': 'Service status and information',
      'GET /health': 'Health check endpoint',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook': 'Stripe webhook endpoint'
    },
    lastStarted: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    logsCount: logs.length
  });
});

app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: logs.slice(0, limit),
    total: logs.length,
    timestamp: new Date().toISOString()
  });
});

app.post('/test', async (req, res) => {
  try {
    addLog('info', 'Manual test initiated');
    
    // Create a test event structure
    const testEvent = {
      type: 'payment_intent.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          customer: 'cus_test123',
          amount: 2500,
          currency: 'usd',
          last_payment_error: {
            code: 'card_declined',
            message: 'Your card was declined.',
            type: 'card_error'
          }
        }
      }
    };

    const paymentData = extractPaymentData(testEvent);
    paymentData.customer = { name: 'Test Customer', email: 'test@example.com' };
    
    await sendFailureNotification(testEvent, paymentData);
    
    addLog('success', 'Test completed successfully');
    res.json({ 
      success: true, 
      message: 'Test email sent successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    addLog('error', 'Test failed', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    addLog('info', 'Webhook received', { eventType: event.type, eventId: event.id });
    
  } catch (err) {
    addLog('error', 'Webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle payment failure events
  const failureEvents = [
    'payment_intent.payment_failed',
    'invoice.payment_failed', 
    'charge.failed'
  ];

  if (failureEvents.includes(event.type)) {
    try {
      addLog('info', 'Processing payment failure event', { eventType: event.type });
      
      const paymentData = extractPaymentData(event);
      
      // Fetch customer details if we have a customer ID
      if (paymentData.customer && typeof paymentData.customer === 'string') {
        try {
          paymentData.customer = await stripe.customers.retrieve(paymentData.customer);
        } catch (error) {
          addLog('warning', 'Could not retrieve customer details', { 
            customerId: paymentData.customer,
            error: error.message 
          });
        }
      }
      
      await sendFailureNotification(event, paymentData);
      
      addLog('success', 'Payment failure processed successfully', { 
        eventType: event.type,
        eventId: event.id 
      });
      
    } catch (error) {
      addLog('error', 'Failed to process payment failure', { 
        eventType: event.type,
        eventId: event.id,
        error: error.message 
      });
    }
  } else {
    addLog('info', 'Event ignored (not a payment failure)', { eventType: event.type });
  }

  res.json({ received: true });
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog('error', 'Unhandled error', { error: error.message, stack: error.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  addLog('info', `Stripe Payment Monitor started on port ${port}`);
  console.log(`Stripe Payment Failure Monitor running on port ${port}`);
});

module.exports = app;