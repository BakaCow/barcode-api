import fs from 'node:fs';
import path from 'node:path';
import { compare } from '../web/benchmark/metrics.mjs';

try {
  const args = process.argv.slice(2), options = {};
  if (args.length !== 6) throw new Error('Usage: node tools/compare-scanners.mjs --left left.json --right right.json --output comparison.json');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--left', '--right', '--output'].includes(key) || options[key] || !args[index + 1]) throw new Error('Expected one --left, --right and --output argument.');
    options[key] = args[index + 1];
  }
  const read = filename => {
    if (fs.statSync(filename).size > 10000000) throw new Error('Input reports must be smaller than 10 MB.');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  };
  if ([options['--left'], options['--right']].some(input => path.resolve(input) === path.resolve(options['--output']))) throw new Error('Output must not overwrite either input report.');
  const result = compare(read(options['--left']), read(options['--right']));
  fs.writeFileSync(options['--output'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(`Compared ${result.pairs.length} paired trials. Saved ${options['--output']}.`);
  console.log('Only completed trials contribute to accuracy/time summaries. Inspect wrong-first counts alongside time to correct.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
