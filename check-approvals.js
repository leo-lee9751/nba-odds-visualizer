import { ethers } from 'ethers';

const WALLET        = '0x5dB1B301A752F9b37D64061F50a816065AEFc481';
const RPC = 'https://polygon-bor-rpc.publicnode.com';
const USDC          = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF           = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CLOB_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const provider = new ethers.providers.JsonRpcProvider(RPC, 137);
const usdc = new ethers.Contract(USDC, ['function allowance(address,address) view returns (uint256)'], provider);
const ctf  = new ethers.Contract(CTF,  ['function isApprovedForAll(address,address) view returns (bool)'], provider);

const [usdcAllowance, ctfApproved] = await Promise.all([
  usdc.allowance(WALLET, CLOB_EXCHANGE),
  ctf.isApprovedForAll(WALLET, CLOB_EXCHANGE)
]);

console.log('USDC allowance:', ethers.utils.formatUnits(usdcAllowance, 6), 'USDC');
console.log('CTF approved:  ', ctfApproved);