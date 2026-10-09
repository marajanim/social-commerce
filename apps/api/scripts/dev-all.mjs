// Runs the three API entrypoints together for development, each with its own log prefix:
//   main.ts (REST :4000), webhooks.ts (Meta webhook receiver :4002), realtime.ts (Socket.IO :4003).
// In production they are three separate processes (see the Dockerfile and deploy files).
import { spawn } from 'node:child_process';

const entries = [
  ['api', 'src/main.ts'],
  ['webhooks', 'src/webhooks.ts'],
  ['realtime', 'src/realtime.ts'],
];

const children = entries.map(([name, file]) => {
  const child = spawn(process.execPath, ['--env-file=../../.env', '--import', 'tsx', '--watch', file], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) out.write(`[${name}] ${line}\n`);
    });
  tag(child.stdout, process.stdout);
  tag(child.stderr, process.stderr);
  return child;
});

const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
