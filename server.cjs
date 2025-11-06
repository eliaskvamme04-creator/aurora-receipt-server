// server.cjs
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- Required environment variables ---
const REQUIRED_ENV_VARS = ['APP_SHARED_SECRET'];
const OPTIONAL_ENV_VARS = ['STRIPE_SECRET_KEY'];

// Check environment variables
const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
const missingOptionalEnv = OPTIONAL_ENV_VARS.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(
    `❌ Missing required environment variables: ${missingEnv.join(', ')}`
  );
  process.exit(1);
}
if (missingOptionalEnv.length > 0) {
  console.warn(
    `⚠️ Optional environment variables not set: ${missingOptionalEnv.join(', ')}`
  );
}

// --- Config ---
const PORT = Number(process.env.PORT) || 3000;
const SHARED_SECRET = process.env.APP_SHARED_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;

const APPLE_ENDPOINTS = {
  production: 'https://buy.itunes.apple.com/verifyReceipt',
  sandbox: 'https://sandbox.itunes.apple.com/verifyReceipt',
};

const APPLE_STATUS_MESSAGES = {
  21000: 'The App Store could not read the JSON object you provided.',
  21002: 'The data in the receipt-data property was malformed or missing.',
  21003: 'The receipt could not be authenticated.',
  21004: 'The shared secret you provided does not match the one on file.',
  21005: 'The receipt server is not currently available.',
  21006: 'The receipt is valid, but the subscription has expired.',
  21007: 'This receipt is from the test environment. Retry against the sandbox server.',
  21008: 'This receipt is from the production environment. Retry against the production server.',
};

// --- Middleware ---
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// --- Request logger ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${
        res.statusCode
      } (${duration}ms)`
    );
  });
  next();
});

const nowIso = () => new Date().toISOString();

// --- Health check ---
app.get('/status', (_req, res) => {
  res.json({
    success: true,
    message: '✅ Aurora backend is running correctly.',
    timestamp: nowIso(),
  });
});

// --- Subscription status (placeholder endpoint) ---
app.get('/subscription/status', (_req, res) => {
  res.json({
    success: true,
    isPremium: false,
    message: '🧾 Subscription status endpoint active.',
    timestamp: nowIso(),
  });
});

// --- Utility: check active subscription ---
const determineSubscriptionStatus = (latestReceiptInfo = []) => {
  if (!Array.isArray(latestReceiptInfo)) {
    return { isPremium: false, latestTransaction: null };
  }

  const sorted = [...latestReceiptInfo].sort(
    (a, b) => Number(b.expires_date_ms || 0) - Number(a.expires_date_ms || 0)
  );

  const now = Date.now();
  const mostRecent = sorted[0] || null;
  const active = sorted.find(
    (entry) => Number(entry.expires_date_ms || 0) > now
  );

  return { isPremium: Boolean(active), latestTransaction: mostRecent };
};

// --- Apple receipt validation ---
app.post('/verify-receipt', async (req, res) => {
  const timestamp = nowIso();
  const receiptData =
    req.body['receipt-data'] || req.body.receiptData || req.body.receipt;
  const productId = req.body.productId;
  const isSandbox = Boolean(req.body.isSandbox);

  if (!receiptData) {
    return res.status(400).json({
      success: false,
      message: 'Missing receipt data.',
      timestamp,
    });
  }

  const requestBody = {
    'receipt-data': receiptData,
    password: SHARED_SECRET,
    'exclude-old-transactions': true,
  };

  const attempt = (endpoint) =>
    axios.post(endpoint, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

  try {
    let endpoint = isSandbox
      ? APPLE_ENDPOINTS.sandbox
      : APPLE_ENDPOINTS.production;
    let response = await attempt(endpoint);
    let data = response.data;

    // Retry if wrong environment
    if (data.status === 21007 && endpoint !== APPLE_ENDPOINTS.sandbox) {
      console.log('🔁 Retrying receipt validation in sandbox environment...');
      response = await attempt(APPLE_ENDPOINTS.sandbox);
      data = response.data;
    }

    const { isPremium, latestTransaction } = determineSubscriptionStatus(
      data.latest_receipt_info
    );

    if (data.status === 0) {
      return res.json({
        success: true,
        isPremium,
        environment: data.environment,
        latestReceipt: data.latest_receipt || null,
        latestTransaction,
        productId: productId || latestTransaction?.product_id || null,
        timestamp,
        message: '✅ Receipt validated successfully.',
      });
    }

    const message =
      APPLE_STATUS_MESSAGES[data.status] ||
      '❌ Apple receipt validation failed with unknown status.';

    return res.status(400).json({
      success: false,
      isPremium,
      status: data.status,
      message,
      environment: data.environment || (isSandbox ? 'Sandbox' : 'Production'),
      timestamp,
    });
  } catch (error) {
    console.error('❌ Error verifying receipt:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error.',
      timestamp,
    });
  }
});

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found.',
    timestamp: nowIso(),
  });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(
    `⚡ Aurora backend running on port ${PORT}. Stripe configured: ${Boolean(
      STRIPE_SECRET_KEY
    )}`
  );
});
