// Start TrueForge in local mode, allowing it to call Kinfile's MCP server (and local models) on localhost.
// TrueForge blocks private hosts by default (SSRF guard); OUTBOUND_URL_ALLOWED_HOSTS opens only loopback.
import { spawn } from 'node:child_process';

const env = { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: process.env.OUTBOUND_URL_ALLOWED_HOSTS ?? '["127.0.0.1","localhost"]' };
const version = process.env.TRUEFORGE_VERSION ?? 'latest';
console.log(`Starting TrueForge (${version}) on http://localhost:8790 with OUTBOUND_URL_ALLOWED_HOSTS=${env.OUTBOUND_URL_ALLOWED_HOSTS}`);
const child = spawn('npx', ['-y', `@truefoundry/trueforge@${version}`, ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', code => process.exit(code ?? 0));
