// Compiles contracts/FeePassPool.cash with cashc and writes the artifact the app and tests import.
// Prints the artifact sha256 and the redeem-script opcode count (evidence/compile.json).
import { compileFile } from 'cashc';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const compiled = compileFile(new URL('../contracts/FeePassPool.cash', import.meta.url));
// Drop the timestamp so the committed artifact (and its sha256) is reproducible; CI recompiles and diffs it.
const { updatedAt: _ignored, ...artifact } = compiled;
const json = JSON.stringify(artifact, null, 2) + '\n';
mkdirSync(new URL('../src/contracts/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src/contracts/FeePassPool.artifact.json', import.meta.url), json);

const sha256 = createHash('sha256').update(json).digest('hex');
const asmTokens = artifact.bytecode.split(' ').length; // compiled script, before constructor args
const summary = {
  contract: artifact.contractName,
  compiler: artifact.compiler,
  abi: artifact.abi.map((f) => `${f.name}(${f.inputs.map((i) => `${i.type} ${i.name}`).join(', ')})`),
  constructorInputs: artifact.constructorInputs.map((i) => `${i.type} ${i.name}`),
  bytecodeAsmTokens: asmTokens,
  artifactSha256: sha256,
};
writeFileSync(new URL('../evidence/compile.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
