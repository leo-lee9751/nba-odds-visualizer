/**
 * One-time script to derive Polymarket API key, secret, and passphrase
 * from your wallet's private key. Run once and paste the output into the
 * "Sign in to Polymarket" form.
 *
 * Usage (from project root):
 *   set POLY_PRIVATE_KEY=0xYourPrivateKeyHere
 *   node scripts/derive-polymarket-creds.js
 *
 * Or on Mac/Linux:
 *   POLY_PRIVATE_KEY=0xYourPrivateKeyHere node scripts/derive-polymarket-creds.js
 *
 * Get your private key from the wallet you use on Polymarket.
 * If you signed up with email/Google, check polymarket.com/settings
 * for export options for your proxy wallet.
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const privateKey = process.env.POLY_PRIVATE_KEY?.trim();
if (!privateKey || !privateKey.startsWith('0x')) {
  console.error('Set POLY_PRIVATE_KEY to your wallet private key (e.g. 0x...)');
  console.error('Example: set POLY_PRIVATE_KEY=0xYourKeyHere   then run this script again.');
  process.exit(1);
}

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

try {
  const signer = new Wallet(privateKey);
  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const apiCreds = await tempClient.createOrDeriveApiKey();

  const apiKey = apiCreds.apiKey ?? apiCreds.key;
  console.log('\n--- Paste these into the "Sign in to Polymarket" form ---\n');
  console.log('API Key:    ', apiKey);
  console.log('Secret:     ', apiCreds.secret);
  console.log('Passphrase: ', apiCreds.passphrase);
  console.log('\nPrivate key: (use the same one you set in POLY_PRIVATE_KEY)\n');
} catch (err) {
  console.error('Error deriving credentials:', err.message);
  process.exit(1);
}
