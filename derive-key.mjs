// Run: node derive-key.mjs
// Make sure MetaMask is NOT needed — just paste your Account 2 private key below

import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

const PRIVATE_KEY = process.argv[2]; // pass as: node derive-key.mjs YOUR_PRIVATE_KEY
if (!PRIVATE_KEY) { console.error('Usage: node derive-key.mjs YOUR_PRIVATE_KEY'); process.exit(1); }

const wallet = new ethers.Wallet(PRIVATE_KEY);
console.log('Wallet address:', wallet.address);

const client = new ClobClient('https://clob.polymarket.com', 137, wallet);

try {
  const apiKey = await client.createOrDeriveApiKey();
  console.log('\n=== YOUR API CREDENTIALS ===');
  console.log('Full response:', JSON.stringify(apiKey, null, 2));
  console.log('API Key:    ', apiKey.apiKey || apiKey.key || apiKey.api_key);
  console.log('Secret:     ', apiKey.secret);
  console.log('Passphrase: ', apiKey.passphrase);
  console.log('============================\n');
  console.log('Copy these into the app Sign in form.');
} catch (err) {
  console.error('Error:', err?.response?.data || err.message);
}
