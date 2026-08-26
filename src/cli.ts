#!/usr/bin/env node
import { main } from './index.ts';
import type { NodeError } from './types.ts';

main().catch((err: NodeError) => {
  console.error(`kommit: ${err.message}`);
  process.exit(1);
});
