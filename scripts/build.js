import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

execSync('rollup -c', { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });

const template = readFileSync('src/index.html', 'utf8');
const bundle   = readFileSync('dist/bundle.js', 'utf8');
const output   = template.replace('<!-- BUNDLE -->', `<script>\n${bundle}\n</script>`);
writeFileSync('dist/index.html', output);
console.log('Built dist/index.html');
