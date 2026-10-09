import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { ADDRESSES as A, ZAP_PATH } from './constants.mjs';
import { planZapQuote, units18 } from './launch.mjs';

const QUOTER_ABI = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut)']);

// Quotes devBuyEth through the launch zap route at the RPC head and writes zapQuote into launch.config.json.
async function main() {
  const configPath = 'launch.config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!process.env.MAINNET_RPC_URL) throw Error('MAINNET_RPC_URL required');
  const client = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL) });
  if (await client.getChainId() !== 1) throw Error('RPC is not Ethereum Mainnet');
  const block = await client.getBlock();
  if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 300) throw Error('RPC head is stale or the system clock is wrong');
  const devBuyWei = units18(config.devBuyEth, 'devBuyEth');
  const { result: quoteOut } = await client.simulateContract({ address: A.quoter, abi: QUOTER_ABI,
    functionName: 'quoteExactInput', args: [ZAP_PATH, devBuyWei], blockNumber: block.number });
  const plan = planZapQuote({ quoteOut, devBuyWei, initialFdvWei: units18(config.initialFdvEth, 'initialFdvEth'),
    supply: units18(config.totalSupply, 'totalSupply'), slippageBps: config.zapSlippageBps });
  config.zapQuote = { quotedAt: new Date(Number(block.timestamp) * 1000).toISOString(), blockNumber: block.number.toString(),
    devBuyEth: config.devBuyEth, initialFdvEth: config.initialFdvEth, zapSlippageBps: config.zapSlippageBps,
    quoteOut: quoteOut.toString(), ...plan };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify(config.zapQuote, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
