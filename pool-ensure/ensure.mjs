#!/usr/bin/env node
// Compatibility entry point for existing @v1 callers. GCE/EC2 capacity is managed by the launcher,
// independently of this action. No credentials, configuration reads or network requests are needed.
import { appendFile } from 'node:fs/promises';

console.log('ci-kit pool: no-op; the launcher provisions GCE/EC2 runners automatically');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'result=none\n');
