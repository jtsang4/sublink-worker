import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
let commit = [
    process.env.WORKERS_CI_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA
].find(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value || ''));

if (!commit) {
    try {
        commit = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        commit = '';
    }
}

const output = new URL('src/buildInfo.generated.js', root);
const content = `export const APP_COMMIT = ${JSON.stringify(commit.slice(0, 7))};\n`;
// Wrangler watches src; rewriting identical metadata would retrigger its build.
if (await readFile(output, 'utf8').catch(() => '') !== content) {
    await writeFile(output, content);
}
