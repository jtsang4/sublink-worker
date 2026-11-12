import { parseBool } from '../../utils.js';
import { InvalidConfigError } from '../../services/errors.js';

export function normalizeSnellProxy(proxy) {
    const version = Number(proxy.version ?? 1);
    const port = Number(proxy.server_port);
    const networks = Array.isArray(proxy.network) ? [...new Set(proxy.network)] : proxy.network ? [proxy.network] : [];
    if (networks.some(network => !['tcp', 'udp'].includes(network))) {
        throw new InvalidConfigError('Snell network must contain tcp and/or udp');
    }
    const network = networks.length === 1 ? networks[0] : undefined;
    if (typeof proxy.server !== 'string' || !proxy.server || /[\s,]/.test(proxy.server) ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new InvalidConfigError('Snell requires a server and a port between 1 and 65535');
    }
    if (typeof proxy.psk !== 'string' || !proxy.psk) {
        throw new InvalidConfigError('Snell requires a non-empty psk');
    }
    if (!Number.isInteger(version) || version < 1 || version > 6) {
        throw new InvalidConfigError('Snell version must be between 1 and 6');
    }
    if (proxy.obfs_mode && !['none', 'http', 'tls', 'shadow-tls', 'restls', 'jls'].includes(proxy.obfs_mode)) {
        throw new InvalidConfigError('Unsupported Snell obfuscation mode');
    }
    if (proxy.udp_port !== undefined && (!Number.isInteger(proxy.udp_port) || proxy.udp_port < 1 || proxy.udp_port > 65535)) {
        throw new InvalidConfigError('Snell UDP port must be between 1 and 65535');
    }
    if (version === 6) {
        const length = new TextEncoder().encode(proxy.psk).length;
        if (length < 12 || length > 255) {
            throw new InvalidConfigError('Snell v6 requires a psk of 12 to 255 bytes');
        }
        if (['http', 'tls'].includes(proxy.obfs_mode) || proxy.obfs_host) {
            throw new InvalidConfigError('Snell v6 does not support HTTP/TLS obfuscation');
        }
    }
    if (proxy.mode && (version !== 6 || !['default', 'unshaped', 'unsafe-raw'].includes(proxy.mode))) {
        throw new InvalidConfigError('Snell mode must be default, unshaped or unsafe-raw and requires v6');
    }
    const udp = parseBool(proxy.udp);
    for (const key of ['udp', 'reuse', 'tcp_fast_open']) {
        if (proxy[key] !== undefined && proxy[key] !== null && parseBool(proxy[key]) === undefined) {
            throw new InvalidConfigError(`Snell ${key} must be a boolean`);
        }
    }
    if (version < 3 && (udp === true || network === 'udp')) {
        throw new InvalidConfigError('Snell UDP relay requires v3 or later');
    }
    return { ...proxy, server_port: port, version, network, udp, reuse: parseBool(proxy.reuse), tcp_fast_open: parseBool(proxy.tcp_fast_open) };
}

export function parseSnell(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new InvalidConfigError('Invalid Snell URL');
    }
    if (parsed.protocol.toLowerCase() !== 'snell:') return undefined;

    try {
        const params = parsed.searchParams;
        const server = parsed.hostname.replace(/^\[|\]$/g, '');
        const authority = server.includes(':') ? `[${server}]` : server;
        return normalizeSnellProxy({
            tag: decodeURIComponent(parsed.hash.slice(1)) || `Snell ${authority}:${parsed.port}`,
            type: 'snell',
            server,
            server_port: parsed.port,
            psk: params.get('psk') ?? decodeURIComponent(parsed.username + (parsed.password ? `:${parsed.password}` : '')),
            version: params.get('version') ?? 1,
            udp: params.get('udp'),
            reuse: params.get('reuse'),
            obfs_mode: params.get('obfs') ?? params.get('obfs-mode') ?? params.get('obfs_mode') ?? undefined,
            obfs_host: params.get('obfs-host') ?? params.get('obfs_host') ?? undefined,
            obfs_uri: params.get('obfs-uri') ?? undefined,
            udp_port: params.has('udp-port') ? Number(params.get('udp-port')) : undefined,
            tcp_fast_open: params.get('tfo'),
            userkey: params.get('userkey') ?? undefined,
            mode: params.get('mode') ?? undefined
        });
    } catch (error) {
        if (error instanceof InvalidConfigError) throw error;
        throw new InvalidConfigError('Invalid Snell URL encoding');
    }
}
