#!/usr/bin/env node
/**
 * Create or derive Polymarket CLOB API credentials from your wallet private key.
 * Run: POLY_PRIVATE_KEY=0x... node scripts/polymarket-create-api-key.js
 * Then use the printed apiKey, secret, passphrase + the same private key in the app's "Sign in Polymarket".
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const key = process.env.POLY_PRIVATE_KEY;
if (!key || !key.startsWith('0x')) {
  console.error('Set POLY_PRIVATE_KEY (hex, e.g. 0x...) in the environment.');
  process.exit(1);
}

const wallet = new Wallet(key.trim());
const client = new ClobClient(
  'https://clob.polymarket.com',
  137,
  wallet
);

const createNew = process.env.CREATE_NEW === '1' || process.env.CREATE_NEW === 'true';

try {
  const creds = createNew
    ? await client.createApiKey()
    : await client.createOrDeriveApiKey();
  const apiKey = creds?.key ?? creds?.apiKey;
  if (!apiKey) {
    console.error('CLOB returned no API key (often 400 Bad Request). Check:');
    console.error('  - POLY_PRIVATE_KEY is the full Polygon key (0x + 64 hex chars) for the wallet that holds your Polymarket balance.');
    console.error('  - You are using the Polygon private key from the same account that shows the balance on polymarket.com.');
    console.error('Try: CREATE_NEW=1 POLY_PRIVATE_KEY=0x... node scripts/polymarket-create-api-key.js');
    process.exit(1);
  }
  console.log('\nUse these in the NBA Odds Visualizer "Sign in Polymarket" form:\n');
  console.log('API Key:    ', apiKey);
  console.log('Secret:     ', creds.secret);
  console.log('Passphrase: ', creds.passphrase);
  console.log('\nPrivate key: (use the same key you set in POLY_PRIVATE_KEY)\n');
} catch (err) {
  console.error('Error:', err.message);
  if (err.message?.includes('400') || err.message?.includes('Bad Request')) {
    console.error('\n400 usually means: wrong private key for this account, or try creating new credentials.');
    console.error('Run: CREATE_NEW=1 POLY_PRIVATE_KEY=0x... node scripts/polymarket-create-api-key.js');
  }
  process.exit(1);
}
