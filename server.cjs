// server.cjs
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.APP_SHARED_SECRET;

app.use(express.json());

// --- Logging middleware ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Health check ---
app.get('/status', (req, res) => {
  res.json({
    success: true,
    message: '✅ Aurora backend is running correctly!'
  });
});

// --- Apple receipt validation ---
app.post('/verify-receipt', async (req, res) => {
  const receiptData = req.body['receipt-data'] || req.body.receiptData;
  const isSandbox = req.body.isSandbox || false;

  if (!receiptData) {
    return res.status(400).json({ success: false, error: 'Missing receipt-data' });
  }

  const requestBody = {
    'receipt-data': receiptData,
    password: SHARED_SECRET,
    'exclude-old-transactions': true,
  };

  const endpoints = {
    production: 'https://buy.itunes.apple.com/verifyReceipt',
    sandbox: 'https://sandbox.itunes.apple.com/verifyReceipt',
  };

  try {
    // Decide endpoint if explicitly testing
    let endpoint = isSandbox ? endpoints.sandbox : endpoints.production;

    let response = await axios.post(endpoint, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    let data = response.data;

    // Apple sandbox redirect: retry automatically
    if (data.status === 21007) {
      console.log('🔁 Retrying receipt validation in sandbox environment...');
      response = await axios.post(endpoints.sandbox, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      data = response.data;
    }

    // Handle Apple response codes cleanly
    if (data.status === 0) {
      console.log('✅ Receipt validated successfully');
      return res.json({
        success: true,
        environment: data.environment,
        latest_receipt_info: data.latest_receipt_info,
        pending_renewal_info: data.pending_renewal_info,
      });
    } else {
      console.warn(`⚠️ Apple returned status code ${data.status}`);
      return res.status(400).json({
        success: false,
        status: data.status,
        environment: data.environment,
        message: 'Apple receipt validation failed',
        raw: data,
      });
    }
  } catch (error) {
    console.error('❌ Error verifying receipt:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`⚡ Aurora backend running on port ${PORT}`);
});
