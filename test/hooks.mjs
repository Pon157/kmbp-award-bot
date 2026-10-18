import { pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const map = {
  'sdk': pathToFileURL(path.join(here, 'mock-sdk.mjs')).href,
  'sdk/db': pathToFileURL(path.join(here, 'mock-sdk-db.mjs')).href,
};
export async function resolve(specifier, context, next) {
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return next(specifier, context);
}
