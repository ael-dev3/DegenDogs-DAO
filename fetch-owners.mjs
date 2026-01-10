import { createWriteStream } from 'node:fs';

const RPC_URL = process.env.RPC_URL ?? 'https://mainnet.base.org';
const CONTRACT = (process.env.CONTRACT ??
  '0x09154248fFDbaF8aA877aE8A4bf8cE1503596428').toLowerCase();
const OUT_FILE = process.env.OUT_FILE ?? 'degendog-owners.txt';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 0);

let rpcId = 0;

async function rpc(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method,
      params,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || 'RPC error');
  }

  return json.result;
}

async function call(data) {
  return rpc('eth_call', [{ to: CONTRACT, data }, 'latest']);
}

async function getTotalSupply() {
  const result = await call('0x18160ddd');
  if (!result || result === '0x') {
    throw new Error('empty totalSupply result');
  }
  return BigInt(result);
}

async function getBlockNumber() {
  const result = await rpc('eth_blockNumber', []);
  return BigInt(result);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ownerOf(tokenId) {
  const data = '0x6352211e' + tokenId.toString(16).padStart(64, '0');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await call(data);
      if (!result || result === '0x') {
        return null;
      }
      const addr = '0x' + result.slice(-40);
      return addr.toLowerCase();
    } catch (err) {
      const message = String(err?.message ?? '').toLowerCase();
      if (
        message.includes('execution reverted') ||
        message.includes('nonexistent') ||
        message.includes('erc721nonexistenttoken')
      ) {
        return null;
      }

      if (attempt === 2) {
        return null;
      }

      if (message.includes('rate limit') || message.includes('429')) {
        await sleep(1000 * (attempt + 1));
      } else if (message.includes('abort') || message.includes('timeout')) {
        await sleep(500 * (attempt + 1));
      } else {
        await sleep(250 * (attempt + 1));
      }
    }
  }

  return null;
}

async function maybeDelay() {
  if (REQUEST_DELAY_MS > 0) {
    await sleep(REQUEST_DELAY_MS);
  }
}

async function main() {
  const totalSupply = await getTotalSupply();
  if (totalSupply === 0n) {
    throw new Error('totalSupply is zero');
  }

  const maxTokenId = totalSupply - 1n;
  if (maxTokenId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`maxTokenId too large: ${maxTokenId.toString()}`);
  }

  const max = Number(maxTokenId);
  console.log(`TotalSupply (next token id): ${totalSupply.toString()}`);
  console.log(`Scanning tokenId range: 0..${max}`);
  let blockNumber = null;
  try {
    blockNumber = await getBlockNumber();
  } catch {
    // Non-fatal; continue without block info.
  }

  const owners = new Array(max + 1);
  let nextId = 0;
  let completed = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const tokenId = nextId++;
      if (tokenId > max) {
        break;
      }

      const owner = await ownerOf(BigInt(tokenId));
      if (owner) {
        owners[tokenId] = owner;
      }
      await maybeDelay();

      completed++;
      if (completed % 500 === 0) {
        process.stdout.write(`Fetched ${completed}/${max + 1}\r`);
      }
    }
  });

  await Promise.all(workers);

  const out = createWriteStream(OUT_FILE, { encoding: 'utf8' });
  out.write(`# chain=base rpc=${RPC_URL} contract=${CONTRACT}\n`);
  if (blockNumber !== null) {
    out.write(`# block=${blockNumber.toString()}\n`);
  }
  out.write('tokenId,owner\n');

  for (let i = 0; i <= max; i++) {
    const owner = owners[i];
    if (owner) {
      out.write(`${i},${owner}\n`);
    }
  }

  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    out.end();
  });

  console.log(`Wrote ${OUT_FILE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
