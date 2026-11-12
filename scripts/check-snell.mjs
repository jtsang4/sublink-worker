// Real protocol exchanges catch incompatibilities that config validation cannot detect.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';

const execute = promisify(execFile);
const singbox = process.env.SING_BOX_BINARY || 'sing-box';
const mihomo = process.env.MIHOMO_BINARY || 'mihomo';
const psk = 'test-snell-secret';

async function unusedPort() {
    for (let attempt = 0; attempt < 20; attempt++) {
        const udp = dgram.createSocket('udp4');
        udp.bind(0, '127.0.0.1');
        await once(udp, 'listening');
        const port = udp.address().port;
        const tcp = net.createServer();
        try {
            tcp.listen(port, '127.0.0.1');
            await once(tcp, 'listening');
            return port;
        } catch (error) {
            if (error.code !== 'EADDRINUSE') throw error;
        } finally {
            if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
            await new Promise(resolve => udp.close(resolve));
        }
    }
    throw new Error('No port available for both TCP and UDP');
}

async function start(t, binary, args, ready) {
    const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(typeof ready === 'string' ? { cwd: dirname(ready) } : {})
    });
    let output = '';
    const closed = once(child, 'close');
    t.after(async () => {
        child.kill('SIGTERM');
        await closed;
    });
    let timer;
    let watcher;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Core startup timeout\n${output}`)), 8000);
            child.once('error', reject);
            child.once('exit', code => reject(new Error(`Core exited ${code}\n${output}`)));
            if (typeof ready === 'string') {
                const check = () => access(ready).then(resolve, () => {});
                watcher = watch(dirname(ready), check);
                check();
            }
            for (const stream of [child.stdout, child.stderr]) {
                stream.on('data', chunk => {
                    output += chunk;
                    if (ready instanceof RegExp && ready.test(output)) resolve();
                });
            }
        });
    } finally {
        clearTimeout(timer);
        watcher?.close();
    }
    return () => output;
}

async function udpThroughSocks(port, targetPort) {
    const control = net.createConnection({ host: '127.0.0.1', port });
    const socket = dgram.createSocket('udp4');
    let timer;
    try {
        await once(control, 'connect');
        control.setTimeout(3000, () => control.destroy(new Error('SOCKS handshake timeout')));
        const chunks = control[Symbol.asyncIterator]();
        let buffered = Buffer.alloc(0);
        const read = async count => {
            while (buffered.length < count) {
                const { value, done } = await chunks.next();
                assert.ok(!done, 'SOCKS connection ended before handshake completed');
                buffered = Buffer.concat([buffered, value]);
            }
            const result = buffered.subarray(0, count);
            buffered = buffered.subarray(count);
            return result;
        };
        control.write(Buffer.from([5, 1, 0]));
        assert.deepEqual(await read(2), Buffer.from([5, 0]));
        control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
        const reply = await read(4);
        assert.equal(reply[1], 0, 'SOCKS UDP association failed');
        assert.equal(reply[3], 1, 'Expected an IPv4 UDP relay');
        const address = await read(6);
        const relayPort = address.readUInt16BE(4);
        const payload = Buffer.from('SNELL-UDP-OK');
        const header = Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]);
        const response = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Snell UDP relay timeout')), 3000);
            socket.once('error', reject);
            socket.once('message', resolve);
        });
        socket.send(Buffer.concat([header, payload]), relayPort, '127.0.0.1');
        const packet = await response;
        assert.equal(packet[3], 1);
        assert.deepEqual(packet.subarray(10), payload);
    } finally {
        clearTimeout(timer);
        control.destroy();
        socket.close();
    }
}

test('generated Snell nodes relay TCP and UDP through real cores', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'sublink-snell-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const web = http.createServer((_request, response) => response.end('SNELL-TCP-OK'));
    web.listen(0, '127.0.0.1');
    await once(web, 'listening');
    t.after(() => new Promise(resolve => web.close(resolve)));
    const echo = dgram.createSocket('udp4');
    echo.on('message', (message, peer) => echo.send(message, peer.port, peer.address));
    echo.bind(0, '127.0.0.1');
    await once(echo, 'listening');
    t.after(() => new Promise(resolve => echo.close(resolve)));

    for (const scenario of [
        { version: 4, obfs: false, reuse: false },
        { version: 4, obfs: true, reuse: true },
        { version: 5, obfs: true, reuse: true },
        { version: 6, obfs: false, reuse: true }
    ]) {
        for (const target of ['singbox', 'mihomo']) {
            await t.test(`${target} v${scenario.version}, obfs=${scenario.obfs}, reuse=${scenario.reuse}`, async t => {
                const serverPort = await unusedPort();
                const socksPort = await unusedPort();
                const serverPath = join(directory, 'server.json');
                await writeFile(serverPath, JSON.stringify({
                    log: { level: 'debug' },
                    inbounds: [{
                        type: 'snell', tag: 'snell-in', listen: '127.0.0.1', listen_port: serverPort,
                        version: scenario.version === 6 ? 6 : 5, psk,
                        ...(scenario.obfs ? { obfs_mode: 'http' } : {}),
                        ...(scenario.version === 6 ? { mode: 'unshaped' } : {})
                    }],
                    outbounds: [{ type: 'direct', tag: 'direct' }]
                }));
                const serverLogs = await start(t, singbox, ['run', '-c', serverPath], /sing-box started/);
                const input = `snell://${psk}@127.0.0.1:${serverPort}?version=${scenario.version}&reuse=${scenario.reuse}` +
                    (scenario.obfs ? '&obfs=http&obfs-host=cdn.example.com' : '') +
                    (scenario.version === 6 ? '&mode=unshaped' : '') + '#Snell';
                const args = [input, 'minimal', [], null, 'en-US', null];
                let clientPath;
                let clientLogs;
                if (target === 'singbox') {
                    const config = await new SingboxConfigBuilder(...args, false, false, undefined, undefined, '1.14').build();
                    clientPath = join(directory, 'client.json');
                    await writeFile(clientPath, JSON.stringify(config));
                    await execute(singbox, ['check', '-c', clientPath]);
                    await writeFile(clientPath, JSON.stringify({
                        log: { level: 'debug' },
                        inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: socksPort }],
                        outbounds: config.outbounds.filter(node => node.type === 'snell'),
                        route: { final: 'Snell' }
                    }));
                    clientLogs = await start(t, singbox, ['run', '-c', clientPath], /sing-box started/);
                } else {
                    const content = await new ClashConfigBuilder(...args).build();
                    clientPath = join(directory, 'client.yaml');
                    await writeFile(clientPath, content);
                    await execute(mihomo, ['-t', '-f', clientPath, '-d', directory]);
                    await writeFile(clientPath, yaml.dump({
                        'log-level': 'debug',
                        'mixed-port': socksPort, 'bind-address': '127.0.0.1', mode: 'rule',
                        proxies: yaml.load(content).proxies, rules: ['MATCH,Snell']
                    }));
                    // Mihomo binds listeners before routing is ready; post-up runs after initialization.
                    const readyPath = join(directory, 'SUBLINK_CORE_READY');
                    await rm(readyPath, { force: true });
                    clientLogs = await start(t, mihomo, [
                        '-f', clientPath, '-d', directory, '-post-up', 'touch SUBLINK_CORE_READY'
                    ], readyPath);
                }
                for (let attempt = 0; attempt < 2; attempt++) {
                    const { stdout } = await execute('curl', [
                        '--silent', '--show-error', '--noproxy', '', '--max-time', '3',
                        '--socks5-hostname', `127.0.0.1:${socksPort}`, `http://127.0.0.1:${web.address().port}/`
                    ]).catch(error => {
                        throw new Error(`${error.message}\nClient:\n${clientLogs()}\nServer:\n${serverLogs()}`, { cause: error });
                    });
                    assert.equal(stdout, 'SNELL-TCP-OK');
                }
                await udpThroughSocks(socksPort, echo.address().port);
                assert.ok(serverLogs().includes('inbound/snell[snell-in]'), serverLogs());
            });
        }
    }
});
