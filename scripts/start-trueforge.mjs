// Start TrueForge in local mode, allowing it to call Kinfile's MCP server (and local models) on localhost.
// TrueForge blocks private hosts by default (SSRF guard); OUTBOUND_URL_ALLOWED_HOSTS opens only loopback.
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  OUTBOUND_URL_ALLOWED_HOSTS: process.env.OUTBOUND_URL_ALLOWED_HOSTS ?? '["127.0.0.1","localhost"]',
  // Free shared endpoints (e.g. NVIDIA build) can hold response headers until the answer is ready.
  MODEL_HTTP_HEADERS_TIMEOUT_MS: process.env.MODEL_HTTP_HEADERS_TIMEOUT_MS ?? '300000',
  MODEL_HTTP_BODY_TIMEOUT_MS: process.env.MODEL_HTTP_BODY_TIMEOUT_MS ?? '300000',
  // No silent re-sends of paid/quota'd requests: Kinfile's Relay retries once, visibly, then falls back.
  MODEL_HTTP_MAX_RETRIES: process.env.MODEL_HTTP_MAX_RETRIES ?? '0',
};
const version = process.env.TRUEFORGE_VERSION ?? 'latest';
console.log(`Starting TrueForge (${version}) on http://localhost:8790 with OUTBOUND_URL_ALLOWED_HOSTS=${env.OUTBOUND_URL_ALLOWED_HOSTS}`);
const child = spawn('npx', ['-y', `@truefoundry/trueforge@${version}`, ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', code => process.exit(code ?? 0));
