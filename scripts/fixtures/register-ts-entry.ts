import { basename } from 'node:path';
import { LoaderProbe } from './register-ts-helper.js';

const probe = new LoaderProbe(42);
console.log(`loader-ok:${probe.value}:${basename(import.meta.url)}`);
