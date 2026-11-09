// Some tests run this plugin the way Clearsky does, so they need a Clearsky checkout: the one
// set in CLEARSKY_CORE, else the Clearsky this folder sits in (plugins/<this plugin>/).
//
//   git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
//   CLEARSKY_CORE=.clearsky npm test
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.CLEARSKY_CORE ? resolve(process.env.CLEARSKY_CORE) : fileURLToPath(new URL('../../../', import.meta.url));
if (!existsSync(join(root, 'lib', 'plugins.mjs'))) {
  throw new Error(`No Clearsky at ${root}. Clone it and set CLEARSKY_CORE to it (see test/core.mjs).`);
}
export const core = (path) => import(pathToFileURL(join(root, path)).href);
