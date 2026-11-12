import { parseShadowsocks } from './protocols/shadowsocksParser.js';
import { parseVmess } from './protocols/vmessParser.js';
import { parseVless } from './protocols/vlessParser.js';
import { parseHysteria2 } from './protocols/hysteria2Parser.js';
import { parseTrojan } from './protocols/trojanParser.js';
import { parseTuic } from './protocols/tuicParser.js';
import { parseAnytls } from './protocols/anytlsParser.js';
import { parseSnell } from './protocols/snellParser.js';
import { convertSurgeProxyToObject } from './convertSurgeProxyToObject.js';
import { fetchSubscription } from './subscription/httpSubscriptionFetcher.js';
import { InvalidConfigError } from '../services/errors.js';

const protocolParsers = {
    ss: parseShadowsocks,
    vmess: parseVmess,
    vless: parseVless,
    hysteria: parseHysteria2,
    hysteria2: parseHysteria2,
    hy2: parseHysteria2,
    http: fetchSubscription,
    https: fetchSubscription,
    trojan: parseTrojan,
    tuic: parseTuic,
    anytls: parseAnytls,
    snell: parseSnell
};

export class ProxyParser {
    static async parse(url, userAgent) {
        if (!url || typeof url !== 'string') {
            return undefined;
        }
        const trimmed = url.trim();
        const type = trimmed.split('://')[0].toLowerCase();
        const parser = protocolParsers[type];
        const isStandaloneSnell = !parser && /^.+?=\s*snell\s*,/i.test(trimmed);
        if (!parser && !isStandaloneSnell) {
            return undefined;
        }
        try {
            return isStandaloneSnell
                ? convertSurgeProxyToObject(trimmed)
                : await parser(trimmed, userAgent);
        } catch (error) {
            // Preserve explicit validation errors from structured remote subscriptions.
            if ((type === 'http' || type === 'https') && error instanceof InvalidConfigError) {
                throw error;
            }
            // One malformed link must not fail the whole request or, inside a
            // subscription, drop every link after it. The link is not logged
            // because it carries credentials.
            const label = isStandaloneSnell ? 'snell' : type;
            console.warn(`Skipping malformed ${label} link:`, error?.message || error);
            return undefined;
        }
    }
}
