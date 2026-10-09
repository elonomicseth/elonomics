import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const CONTRACTS = {
  token: 'Elonomics', launcher: 'ElonomicsLauncher',
  processor: 'ElonomicsFeeProcessor', hook: 'ElonomicsHook',
};

export async function build() {
  if (solc.version() !== '0.8.26+commit.8a97fa7a.Emscripten.clang') throw Error('Expected locked solc 0.8.26');
  const sources = {};
  const pending = Object.values(CONTRACTS).map(name => `src/${name}.sol`);
  while (pending.length) {
    const name = pending.pop();
    if (sources[name]) continue;
    if (path.isAbsolute(name) || name.startsWith('../')) throw Error(`Unsafe source path: ${name}`);
    const content = await readFile(name.startsWith('@') ? `node_modules/${name}` : name, 'utf8');
    sources[name] = { content };
    for (const match of content.matchAll(/^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']\s*;/gmu)) {
      pending.push(match[1].startsWith('.') ? path.posix.join(path.posix.dirname(name), match[1]) : match[1]);
    }
  }
  const input = {
    language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', viaIR: false,
      metadata: { bytecodeHash: 'none', appendCBOR: false, useLiteralContent: true },
      libraries: {}, remappings: [],
      outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  await mkdir('build/artifacts', { recursive: true });
  await writeFile('build/standard-json.json', `${JSON.stringify(input)}\n`);
  await writeFile('build/compiler-output.json', `${JSON.stringify(output)}\n`);
  for (const [id, name] of Object.entries(CONTRACTS)) {
    const compiled = output.contracts[`src/${name}.sol`][name];
    if (compiled.evm.deployedBytecode.object.length / 2 > 24576) throw Error(`${name} exceeds EIP-170`);
    await writeFile(`build/artifacts/${id}.json`, `${JSON.stringify({
      abi: compiled.abi, metadata: compiled.metadata,
      bytecode: compiled.evm.bytecode, deployedBytecode: compiled.evm.deployedBytecode,
    })}\n`);
  }
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await build();
  console.log('Built 4 contracts with solc 0.8.26. Artifacts: build/');
}
