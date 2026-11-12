import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { ProxyParser } from '../src/parsers/ProxyParser.js';
import { parseSnell } from '../src/parsers/protocols/snellParser.js';
import { parseSubscriptionContent } from '../src/parsers/subscription/subscriptionContentParser.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { encodeBase64 } from '../src/utils.js';

const psk = 'test-snell-secret';
const uri = `snell://${psk}@example.com:443?version=4&obfs=http&obfs-host=cdn.example.com&reuse=true&tfo=true#HK-Snell`;
const surgeLine = `HK-Snell = snell, example.com, 443, psk=${psk}, version=4, reuse=true, obfs=http, obfs-host=cdn.example.com, tfo=true`;
const clashNode = {
    name: 'HK-Snell', type: 'snell', server: 'example.com', port: 443,
    psk, version: 4, reuse: true, tfo: true,
    'obfs-opts': { mode: 'http', host: 'cdn.example.com' }
};
const nativeNode = {
    tag: 'HK-Snell', type: 'snell', server: 'example.com', server_port: 443,
    psk, version: 4, reuse: true, tcp_fast_open: true,
    obfs_mode: 'http', obfs_host: 'cdn.example.com'
};

function build(input, target, version = '1.14', countries = false) {
    const args = [input, 'minimal', [], null, 'en-US', null, countries];
    const builder = target === 'clash' ? new ClashConfigBuilder(...args)
        : target === 'surge' ? new SurgeConfigBuilder(...args)
            : new SingboxConfigBuilder(...args, false, undefined, undefined, version);
    return builder.build();
}

function mockSubscription(content) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content)));
}

function testApp() {
    return createApp({ kv: new MemoryKVAdapter(), logger: console });
}

afterEach(() => vi.unstubAllGlobals());

describe('Snell inputs', () => {
    it('parses a share link with protocol and transport options', async () => {
        expect(await ProxyParser.parse(uri.replace('snell://', 'SNELL://'))).toMatchObject(nativeNode);
    });

    it('preserves encoded credentials and IPv6 addresses', () => {
        const result = parseSnell('snell://p%40ss%3A%2B%2F%3D%23%26@[2001:db8::1]:8443?version=4&udp=false#%E9%A6%99%E6%B8%AF');
        expect(result).toMatchObject({
            server: '2001:db8::1', server_port: 8443, tag: '香港',
            psk: 'p@ss:+/=#&', udp: false
        });
    });

    it('uses the legacy default version and supplies a name', () => {
        expect(parseSnell('snell://secret@example.com:443')).toMatchObject({
            tag: 'Snell example.com:443', version: 1, psk: 'secret'
        });
        expect(parseSnell('snell://[2001:db8::1]:443?psk=secret').tag).toBe('Snell [2001:db8::1]:443');
    });

    it('accepts standalone Surge node declarations', async () => {
        expect(await ProxyParser.parse(surgeLine)).toMatchObject(nativeNode);
    });

    it('keeps protocol URI parsing ahead of Surge declaration detection', async () => {
        const node = await ProxyParser.parse('ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#name=snell,proxy');
        expect(node.type).toBe('shadowsocks');
    });

    it.each([
        '[Proxy]\n' + surgeLine,
        yaml.dump({ proxies: [clashNode] }),
        JSON.stringify({ outbounds: [nativeNode] })
    ])('imports Snell nodes from full configs', input => {
        expect(parseSubscriptionContent(input).proxies[0]).toMatchObject(nativeNode);
    });

    it.each([
        'snell://secret@example.com:0?version=4',
        'snell://secret@example.com:65536?version=4',
        'snell://secret@example.com?version=4',
        'snell://example.com:443?version=4',
        'snell://secret@example.com:443?version=7',
        'snell://secret@example.com:443?version=4.5',
        'snell://secret@example.com:443?version=2&udp=true',
        'snell://secret@example.com:443?version=4&udp=invalid',
        'snell://secret@example.com:443?version=4&tfo=invalid',
        'snell://secret@example.com:443?version=4&mode=unshaped',
        'snell://secret@example.com:443?version=6',
        `snell://${psk}@example.com:443?version=6&obfs=http`,
        `snell://${psk}@example.com:443?version=4&obfs=unknown`,
        `snell://${psk}@example.com:443?version=4&udp-port=70000`,
        'snell://%GG@example.com:443?version=4'
    ])('rejects invalid Snell parameters: %s', input => {
        expect(() => parseSnell(input)).toThrow();
    });
});

describe('Snell output conversion', () => {
    const sources = [uri, surgeLine, '[Proxy]\n' + surgeLine,
        yaml.dump({ proxies: [clashNode] }), JSON.stringify({ outbounds: [nativeNode] })];

    it.each(sources)('converts supported inputs to all three target formats', async input => {
        const clash = yaml.load(await build(input, 'clash'));
        expect(clash.proxies[0]).toMatchObject({ ...clashNode, udp: true });
        expect(clash['proxy-groups'].some(group => group.proxies?.includes('HK-Snell'))).toBe(true);

        const surge = await build(input, 'surge');
        expect(surge).toContain(surgeLine);
        expect(surge).not.toContain('Unsupported proxy type: snell');

        const singbox = await build(input, 'singbox');
        expect(singbox.outbounds.find(node => node.type === 'snell')).toMatchObject(nativeNode);
        expect(singbox.outbounds.find(node => node.type === 'snell')).not.toHaveProperty('obfs_opts');
    });

    it.each([1, 2, 3, 4, 5, 6])('preserves Snell v%s in Surge and Mihomo', async version => {
        const input = `snell://${psk}@example.com:443?version=${version}#Snell`;
        expect(await build(input, 'surge')).toContain(`psk=${psk}, version=${version}`);
        const node = yaml.load(await build(input, 'clash')).proxies[0];
        expect(node.version).toBe(version);
        expect(node.udp).toBe(version >= 3);
    });

    it('converts v5 to sing-box v4 compatibility mode', async () => {
        const config = await build(uri.replace('version=4', 'version=5'), 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell').version).toBe(4);
    });

    it('preserves v6 shaping and connection reuse', async () => {
        const input = `snell://${psk}@example.com:443?version=6&mode=unshaped&reuse=true#Snell6`;
        const config = await build(input, 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell')).toMatchObject({ version: 6, mode: 'unshaped', reuse: true });
        expect(await build(input, 'surge')).toContain('mode=unshaped');
    });

    it('preserves disabled UDP in native sing-box fields', async () => {
        const config = await build(uri, 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell').network).toBeUndefined();
        const disabled = await build(uri.replace('&reuse=true', '&udp=false&reuse=true'), 'singbox');
        const node = disabled.outbounds.find(node => node.type === 'snell');
        expect(node.network).toBe('tcp');
        expect(node).not.toHaveProperty('udp');
        await expect(build(uri.replace('&reuse=true', '&udp=false&reuse=true'), 'surge')).rejects.toThrow('cannot represent');
    });

    it('keeps an explicit network restriction on native JSON input', async () => {
        const config = await build(JSON.stringify({ outbounds: [{ ...nativeNode, network: ['udp'] }] }), 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell').network).toBe('udp');
    });

    it('keeps Mihomo-specific obfuscation options for Mihomo output', async () => {
        const extended = { ...clashNode, 'client-fingerprint': 'chrome', 'obfs-opts': {
            mode: 'shadow-tls', host: 'cdn.example.com', password: 'tls-password', version: 3
        } };
        const input = yaml.dump({ proxies: [extended] });
        expect(yaml.load(await build(input, 'clash')).proxies[0]).toMatchObject(extended);
        await expect(build(input, 'surge')).rejects.toThrow('cannot represent');
        expect((await build(input, 'singbox')).outbounds.some(node => node.type === 'snell')).toBe(false);
    });

    it('includes Snell nodes in country groups and deduplicates repeated inputs', async () => {
        const config = yaml.load(await build(`${uri}\n${uri}`, 'clash', '1.14', true));
        expect(config.proxies).toHaveLength(1);
        expect(config['proxy-groups'].some(group => group.name.includes('Hong Kong') && group.proxies.includes('HK-Snell'))).toBe(true);
    });

    it.each(['1.11', '1.12'])('drops Snell for sing-box %s while keeping other nodes', async version => {
        const fallback = `ss://${btoa('aes-128-gcm:pw')}@1.2.3.4:8388#SS-Node`;
        const config = await build(`${uri}\n${fallback}`, 'singbox', version);
        expect(config.outbounds.filter(node => node.server).map(node => node.tag)).toEqual(['SS-Node']);
    });

    it.each([1, 2, 3])('drops Snell v%s for sing-box while keeping other nodes', async version => {
        const fallback = `ss://${btoa('aes-128-gcm:pw')}@1.2.3.4:8388#SS-Node`;
        const config = await build(`snell://${psk}@example.com:443?version=${version}#Snell-v${version}\n${fallback}`, 'singbox');
        expect(config.outbounds.filter(node => node.server).map(node => node.tag)).toEqual(['SS-Node']);
    });

    it('preserves Surge-only options for Surge, errors on Mihomo, and drops for sing-box', async () => {
        const input = '[Proxy]\n' + surgeLine + ', udp-port=8443, obfs-uri=/snell';
        expect(await build(input, 'surge')).toContain('obfs-uri=/snell, udp-port=8443');
        await expect(build(input, 'clash')).rejects.toThrow('cannot represent');
        expect((await build(input, 'singbox')).outbounds.some(node => node.type === 'snell')).toBe(false);
    });
});

describe('Snell subscriptions and HTTP endpoints', () => {
    it('imports every node in a Base64 list of standalone Surge declarations', async () => {
        const input = encodeBase64(surgeLine + '\n' + surgeLine.replace('HK-Snell', 'US-Snell').replace('example.com, 443', 'example.com, 8443'));
        const config = await build(input, 'singbox');
        expect(config.outbounds.filter(node => node.type === 'snell').map(node => node.tag)).toEqual(['HK-Snell', 'US-Snell']);
    });
    it.each([uri, encodeBase64(uri), encodeBase64(surgeLine)])('reads remote plain and Base64 subscriptions', async content => {
        mockSubscription(content);
        const config = await build('https://subscription.example.com/snell', 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell')).toMatchObject(nativeNode);
    });

    it.each([false, true])('preserves percent-encoded credentials in remote subscriptions (Base64: %s)', async encoded => {
        const link = 'snell://p%40ss%3A%2B%2F%3D%23%26@example.com:443?version=4#Snell';
        mockSubscription(encoded ? encodeBase64(link) : link);
        const config = await build('https://subscription.example.com/snell', 'singbox');
        expect(config.outbounds.find(node => node.type === 'snell').psk).toBe('p@ss:+/=#&');
    });

    it.each(['clash', 'surge', 'singbox'])('serves valid Snell conversion from /%s', async target => {
        const response = await testApp().request(`http://localhost/${target}?${new URLSearchParams({ config: uri, singbox_version: '1.14' })}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('HK-Snell');
    });

    it('detects sing-box 1.14 from User-Agent', async () => {
        const response = await testApp().request(`http://localhost/singbox?${new URLSearchParams({ config: uri })}`, {
            headers: { 'User-Agent': 'sing-box/1.14.4' }
        });
        expect(response.status).toBe(200);
        expect((await response.json()).outbounds.some(node => node.type === 'snell')).toBe(true);
    });

    it.each([
        '[Proxy]\n' + surgeLine.replace('version=4', 'version=9'),
        '[Proxy]\nBroken = snell, example.com',
        '[Proxy]\n' + surgeLine.replace('443,', 'invalid,'),
        '[Proxy]\n' + surgeLine.replace('tfo=true', 'tfo=invalid'),
        yaml.dump({ proxies: [{ ...clashNode, psk: '' }] })
    ])('returns clean 400 errors for invalid structured inputs', async config => {
        const response = await testApp().request(`http://localhost/surge?${new URLSearchParams({ config })}`);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain(psk);
    });

    it('drops Snell on incompatible sing-box versions instead of failing mixed subscriptions', async () => {
        const fallback = `ss://${btoa('aes-128-gcm:pw')}@1.2.3.4:8388#SS-Node`;
        const response = await testApp().request(`http://localhost/singbox?${new URLSearchParams({ config: `${uri}\n${fallback}`, singbox_version: '1.12' })}`);
        expect(response.status).toBe(200);
        expect((await response.json()).outbounds.filter(node => node.server).map(node => node.tag)).toEqual(['SS-Node']);
    });

    it.each([
        'snell://%GG@example.com:443?version=4',
        `snell://${psk}@example.com:443?version=9`,
        'Broken = snell, example.com'
    ])('skips malformed standalone Snell link (%s) and keeps valid nodes', async bad => {
        const response = await testApp().request(`http://localhost/singbox?${new URLSearchParams({ config: `${bad}\n${uri}`, singbox_version: '1.14' })}`);
        expect(response.status).toBe(200);
        expect((await response.json()).outbounds.filter(node => node.server).map(node => node.tag)).toEqual(['HK-Snell']);
    });

    it('propagates remote subscription validation errors', async () => {
        mockSubscription('[Proxy]\n' + surgeLine.replace('version=4', 'version=9'));
        const response = await testApp().request(`http://localhost/surge?${new URLSearchParams({ config: 'https://subscription.example.com/snell' })}`);
        expect(response.status).toBe(400);
    });
});
