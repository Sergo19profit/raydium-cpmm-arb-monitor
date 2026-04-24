import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '5000');
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.5');
const CPMM_FEE = 0.0025;

const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const connection = new Connection(RPC_URL, 'confirmed');

interface PoolData {
  price: number;
  address: string;
  reserveA: bigint;
  reserveB: bigint;
}

type PairPools = Record<string, Record<string, PoolData>>;

function parsePool(pubkey: string, data: Buffer): PoolData | null {
  try {
    if (data.length < 300) return null;
    const reserveA = data.readBigUInt64LE(253);
    const reserveB = data.readBigUInt64LE(261);
    if (reserveA === 0n || reserveB === 0n) return null;
    return { price: Number(reserveB) / Number(reserveA), address: pubkey, reserveA, reserveB };
  } catch { return null; }
}

function getMintPair(data: Buffer): [string, string] | null {
  try {
    return [
      new PublicKey(data.subarray(72, 104)).toBase58(),
      new PublicKey(data.subarray(104, 136)).toBase58(),
    ];
  } catch { return null; }
}

async function fetchAndGroupPools(): Promise<PairPools> {
  const filters: GetProgramAccountsFilter[] = [{ dataSize: 637 }];
  const accounts = await connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM, { filters, commitment: 'confirmed' });
  const poolPairs: PairPools = {};

  for (const { pubkey, account } of accounts) {
    const data = account.data as Buffer;
    const mints = getMintPair(data);
    if (!mints) continue;
    const pool = parsePool(pubkey.toBase58(), data);
    if (!pool) continue;
    const pair = mints.sort().join(':');
    if (!poolPairs[pair]) poolPairs[pair] = {};
    poolPairs[pair][pool.address] = pool;
  }
  return poolPairs;
}

function findArbitrage(poolPairs: PairPools): void {
  let found = 0;
  for (const [pair, pools] of Object.entries(poolPairs)) {
    const sorted = Object.values(pools).sort((a, b) => a.price - b.price);
    if (sorted.length < 2) continue;
    const poolA = sorted[0];
    const poolB = sorted[sorted.length - 1];
    const grossPct = ((poolB.price - poolA.price) / poolA.price) * 100;
    const netPct = grossPct - CPMM_FEE * 2 * 100;
    if (netPct > MIN_PROFIT_PCT) {
      found++;
      console.log('\n' + '═'.repeat(55));
      console.log('🎯 ARBITRAGE OPPORTUNITY');
      console.log(`Pair:       ${pair.slice(0, 20)}...`);
      console.log(`Pool A:     ${poolA.address.slice(0, 8)}... @ ${poolA.price.toExponential(4)}`);
      console.log(`Pool B:     ${poolB.address.slice(0, 8)}... @ ${poolB.price.toExponential(4)}`);
      console.log(`Net profit: ${netPct.toFixed(3)}%`);
      console.log(`Direction:  ${poolA.address.slice(0, 8)} -> ${poolB.address.slice(0, 8)}`);
      console.log(`Time:       ${new Date().toISOString()}`);
    }
  }
  if (found === 0) process.stdout.write(`\r[${new Date().toISOString()}] No opportunities above ${MIN_PROFIT_PCT}%   `);
}

async function main(): Promise<void> {
  console.log('🚀 Raydium CPMM Arbitrage Monitor v1.1.0');
  console.log(`📡 RPC: ${RPC_URL} | ⏱ ${CHECK_INTERVAL_MS}ms | 💰 Min: ${MIN_PROFIT_PCT}%`);
  const run = async () => {
    try {
      const poolPairs = await fetchAndGroupPools();
      findArbitrage(poolPairs);
    } catch (err) { console.error(`\nError: ${(err as Error).message}`); }
  };
  await run();
  setInterval(run, CHECK_INTERVAL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
