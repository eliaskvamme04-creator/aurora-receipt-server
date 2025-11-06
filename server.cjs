// server.cjs
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const REQUIRED_ENV_VARS = ['APP_SHARED_SECRET'];
const OPTIONAL_ENV_VARS = ['STRIPE_SECRET_KEY'];
const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
const missingOptionalEnv = OPTIONAL_ENV_VARS.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(
      ', '
    )}. Please set them in your .env file.`
  );
  process.exit(1);
}

if (missingOptionalEnv.length > 0) {
  console.warn(
    `Optional environment variables not set: ${missingOptionalEnv.join(
      ', '
    )}.`
  );
}

const PORT = Number(process.env.PORT) || 3000;
const SHARED_SECRET = process.env.APP_SHARED_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

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

app.use(express.json({ limit: '2mb' }));
app.use(cors());

// --- Logging middleware ---
app.use((req, res, next) => {
  const requestTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - requestTime;
    console.log(
      `[${new Date(requestTime).toISOString()}] ${req.method} ${
        req.originalUrl
      } -> ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

const nowIso = () => new Date().toISOString();

// --- Health check ---
app.get('/status', (req, res) => {
  res.json({
    success: true,
    message: 'Aurora backend is running correctly.',
    timestamp: nowIso(),
  });
});

// --- Subscription status (stateless placeholder) ---
app.get('/subscription/status', (req, res) => {
  res.json({
    success: true,
    isPremium: false,
    message: 'No subscription state stored on the server.',
    timestamp: nowIso(),
  });
});

const determineSubscriptionStatus = (latestReceiptInfo = []) => {
  if (!Array.isArray(latestReceiptInfo)) {
    return { isPremium: false, latestTransaction: null };
  }

  const sortedByExpiry = [...latestReceiptInfo].sort((a, b) => {
    const aExpiry = Number(a.expires_date_ms || 0);
    const bExpiry = Number(b.expires_date_ms || 0);
    return bExpiry - aExpiry;
  });

  const now = Date.now();
  const mostRecent = sortedByExpiry[0] || null;
  const active = sortedByExpiry.find((entry) => {
    const expiresAt = Number(entry.expires_date_ms || 0);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });

  return {
    isPremium: Boolean(active),
    latestTransaction: mostRecent,
  };
};

// --- Apple receipt validation ---
app.post('/verify-receipt', async (req, res) => {
  const timestamp = nowIso();
  const receiptData =
    req.body['receipt-data'] || req.body.receiptData || req.body.receipt;
  const productId = req.body.productId;
  const requestSandboxFlag = Boolean(req.body.isSandbox);

  if (!receiptData) {
    return res.status(400).json({
      success: false,
      isPremium: false,
      status: 400,
      message:
        'Missing receipt data. Provide receipt-data, receiptData, or receipt in the JSON body.',
      timestamp,
    });
  }

  const requestBody = {
    'receipt-data': receiptData,
    password: SHARED_SECRET,
    'exclude-old-transactions': true,
  };

  const attemptValidation = async (endpoint) =>
    axios.post(endpoint, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

  try {
    let endpoint = requestSandboxFlag
      ? APPLE_ENDPOINTS.sandbox
      : APPLE_ENDPOINTS.production;
    let response = await attemptValidation(endpoint);
    let data = response.data;

    if (data.status === 21007 && endpoint !== APPLE_ENDPOINTS.sandbox) {
      console.log('Retrying receipt validation against the sandbox endpoint.');
      response = await attemptValidation(APPLE_ENDPOINTS.sandbox);
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
        pendingRenewalInfo: data.pending_renewal_info || null,
        productId: productId || latestTransaction?.product_id || null,
        timestamp,
        message: 'Receipt validated successfully.',
      });
    }

    const message =
      APPLE_STATUS_MESSAGES[data.status] ||
      'Apple receipt validation failed with an unknown status.';

    return res.status(400).json({
      success: false,
      isPremium,
      status: data.status,
      environment: data.environment || (requestSandboxFlag ? 'Sandbox' : null),
      message,
      latestTransaction,
      timestamp,
    });
  } catch (error) {
    const appleStatus = error.response?.data?.status;
    const message =
      error.response?.data?.message ||
      APPLE_STATUS_MESSAGES[appleStatus] ||
      error.message ||
      'Unexpected error during receipt validation.';

    return res.status(500).json({
      success: false,
      isPremium: false,
      status: appleStatus || 'REQUEST_FAILED',
      message,
      timestamp,
    });
  }
});

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    timestamp: nowIso(),
  });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(
    `Aurora backend running on port ${PORT}. Stripe key configured: ${Boolean(
      STRIPE_SECRET_KEY
    )}`
  );
});
