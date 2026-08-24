#!/usr/bin/env node
// @ts-expect-error - index is still JavaScript; becomes './index.ts' when it is ported.
import { main } from './index.js';

main().catch((err: Error) => {
  console.error(`kommit: ${err.message}`);
  process.exit(1);
});
