#!/usr/bin/env node
/** Build: write src/version.ts from package.json, then compile ESM (dist/esm) and CommonJS (dist/cjs). */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const versionFile = join(ROOT, 'src', 'version.ts');
const versionText = `// Written by scripts/build.mjs from package.json — do not edit by hand.\nexport const VERSION = '${pkg.version}';\n`;
if (readFileSync(versionFile, 'utf8') !== versionText) writeFileSync(versionFile, versionText);

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(tsc, ['-p', 'tsconfig.cjs.json'], { cwd: ROOT, stdio: 'inherit' });
mkdirSync(join(ROOT, 'dist', 'cjs'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'cjs', 'package.json'), '{\n  "type": "commonjs"\n}\n');
console.log(`built scriptivox ${pkg.version}: dist/esm, dist/cjs`);
