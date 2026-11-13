import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

const source = fileURLToPath(new URL('../../../web/', import.meta.url));
const destination = fileURLToPath(new URL('../public/scanner-assets/', import.meta.url));
const exampleRoot = fileURLToPath(new URL('../', import.meta.url));
const boundary = relative(resolve(exampleRoot, 'public'), resolve(destination));
if (boundary.startsWith('..') || isAbsolute(boundary)) throw new Error('Asset destination must remain inside this example/public.');
const files = ['sdk', 'vendor', 'scanner-worker.js', 'scan-policy.js', 'pos-policy.js', 'frame-analysis.js', 'capture-selection.js', 'styles.css', 'icon.svg', 'LICENSE.txt'];
mkdirSync(destination, { recursive: true });
for (const name of files) cpSync(resolve(source, name), resolve(destination, name), { recursive: true });
const examplesStyle = resolve(destination, 'examples.css');
mkdirSync(dirname(examplesStyle), { recursive: true });
cpSync(resolve(source, 'examples/examples.css'), examplesStyle);
console.log('Copied local scanner, decoder, styles, and license notices into public/scanner-assets.');
