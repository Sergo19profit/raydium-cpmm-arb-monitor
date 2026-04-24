import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '5000');
const MIN_PROFIT_PCT = parseFloat(process.env.MIN_PROFIT_PCT || '0.5');
const CPMM_FEE = 0.0025;

const connection = new Connection(RPC_URL, 'confirmed');

interface Pool {
  address: string;
  mintA: string;
  mintB: string;
  reserveA: bigint;
  reserveB: bigint;
  price: number;
}

interface Opportunity {
  pair: string;
  poolBuy: Pool;
  poolSell: Pool;
  grossPct: number;
  netPct: number;
  timestamp: string;
}

function parsePool(pubkey: string, data: Buffer): Pool | null {
  try {
    if (data.length < 300) return null;
    const mintA = new PublicKey(data.subarray(72, 104)).toBase58();
    const mintB = new PublicKey(data.subarray(104, 136)).toBase58();
    const reserveA = data.readBigUInt64LE(253);
    const reserveB = data.readBigUInt64LE(261);
    if (reserveA === 0n || reserveB === 0n) return null;
    const price = Number(reserveB) / Number(reserveA);
    return { address: pubkey, mintA, mintB, reserveA, reserveB, price };
  } catch { return null; }
}

async function fetchPools(): Promise<Pool[]> {
  const filters: GetProgramAccountsFilter[] = [{ dataSize: 637 }];
  const accounts = await connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM, {
    filters, commitment: 'confirmed',
  });
  const pools: Pool[] = [];
  for (const { pubkey, account } of accounts) {
    const pool = parsePool(pubkey.toBase58(), account.data as Buffer);
    if (pool) pools.push(pool);
  }
  return pools;
}

function groupByPair(pools: Pool[]): Map<string, Pool[]> {
  const map = new Map<string, Pool[]>();
  for (const pool of pools) {
    const key = [pool.mintA, pool.mintB].sort().join(':');
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(pool);
  }
  return map;
}

function findOpportunities(pools: Pool[]): Opportunity[] {
  const pairs = groupByPair(pools);
  const opportunities: Opportunity[] = [];
  for (const [pair, group] of pairs) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const high = a.price > b.price ? a : b;
        const low  = a.price > b.price ? b : a;
        const grossPct = ((high.price - low.price) / low.price) * 100;
        const netPct   = grossPct - CPMM_FEE * 2 * 100;
        if (netPct >= MIN_PROFIT_PCT) {
          opportunities.push({ pair, poolBuy: low, poolSell: high,
            grossPct, netPct, timestamp: new Date().toISOString() });
        }
      }
    }
  }
  return opportunities.sort((a, b) => b.netPct - a.netPct);
}

async function main(): Promise<void> {
  console.log('🚀 Raydium CPMM Arbitrage Monitor v1.0.0');
  console.log(`📡 RPC: ${RPC_URL} | ⏱ ${CHECK_INTERVAL_MS}ms | 💰 Min: ${MIN_PROFIT_PCT}%`);
  let cycle = 0;
  while (true) {
    cycle++;
    try {
      process.stdout.write(`\r[${cycle}] Fetching...`);
      const pools = await fetchPools();
      const opps = findOpportunities(pools);
      if (opps.length === 0) {
        process.stdout.write(`\r[${cycle}] ${pools.length} pools — no opportunities   `);
      } else {
        for (const opp of opps) {
          console.log('\n' + '═'.repeat(50));
          console.log('🎯 ARBITRAGE OPPORTUNITY');
          console.log(`Buy:  ${opp.poolBuy.address.slice(0,8)}... @ ${opp.poolBuy.price.toExponential(4)}`);
          console.log(`Sell: ${opp.poolSell.address.slice(0,8)}... @ ${opp.poolSell.price.toExponential(4)}`);
          console.log(`Net profit: ${opp.netPct.toFixed(3)}%`);
          console.log(`Time: ${opp.timestamp}`);
        }
      }
    } catch (err) {
      console.error(`\n[${cycle}] Error:`, (err as Error).message);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
