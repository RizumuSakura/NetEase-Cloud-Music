/**
 * 网易云音乐自动签到脚本（完善版）
 * 
 * @description 支持青龙面板的全自动签到脚本（云贝 + 黑胶乐签 + VIP 成长任务，先查后签）
 * @version 1.5.0
 * @license MIT
 * 
 * @changelog v1.5.0（新增每日任务自动化，实验性，默认关闭）
 *  - 新增 NCM_TASKS 开关：like / share / browse / welfare / view / listen，逗号分隔，默认全部不执行
 *  - like：红心 3 首 VIP 单曲（eapi /interface3 的 song/like，官方现行口径）
 *  - share：分享 1 首单曲到动态（xeapi + 易盾反作弊 token）
 *  - browse：浏览类任务上报（云贝任务列表自带 subAction，配合 eapi yunbei/click/task）
 *  - welfare：领取会员尊享福利（welfare/new/list + welfare/claim，自动跳过付费福利）
 *  - view：查看类会员任务上报（查看AI调音大师等，middle/page/view/report 浏览时长上报）
 *  - listen：听 3 首 VIP 歌曲上报播放（⚠️ 属刷歌行为，风控高发，需显式开启）
 *  - eapiRequest 支持切换域名（interface3 / clientlog）与 os、weapiRequest 支持自定义 UA
 * 
 * @changelog v1.4.0（依据 NeteaseCloudMusicApiEnhanced 官方接口模块校准）
 *  - 云贝签到升级为官方现行 xeapi 协议（interface3 + X25519/AES-128-GCM），
 *    并携带易盾反作弊 token v3；失败自动回退旧 weapi 通道
 *  - "云贝今日是否已签"改用官方 /weapi/point/today/get（原 pointmall/user/sign/today 已废弃）
 *  - 黑胶乐签：修复 host 错误（interface3 → music.163.com 的 weapi 通道）
 *  - 黑胶乐签前置检查改用官方 eapi 接口 checkin/history/detail（interfacepc）
 *  - VIP 成长任务列表 / 一键领取升级 xeapi 协议，失败回退 weapi
 *  - 云贝任务奖励领取 depositCode 默认 '0'（官方口径）
 *  - deviceId 持久化到状态文件，不再每次运行随机生成
 *  - 所有请求增加重试（2 次）+ 随机延时（250~900ms），降低风控风险
 *  - 修复：main 未捕获异常、通知推送失败导致进程崩溃、静默失败无日志、
 *    重复请求 task/todo/query 与 growhpoint/basic、空 catch 吞异常等问题
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ================= 环境变量解析 =================

const rawEnvCookie = process.env.NETEASE_MUSIC_U || '';

if (!rawEnvCookie) {
    console.log('❌ 请设置环境变量 NETEASE_MUSIC_U');
    process.exit(1);
}

let musicU = rawEnvCookie.trim();
const uMatch = rawEnvCookie.match(/MUSIC_U=([^;]+)/);
if (uMatch) musicU = uMatch[1];

const csrfMatch = rawEnvCookie.match(/__csrf=([^;]+)/);
const csrfToken = csrfMatch ? csrfMatch[1] : '';

// 是否跳过随机延时（调试用）：NCM_NO_DELAY=1
const NO_DELAY = process.env.NCM_NO_DELAY === '1';

// 每日任务自动化开关（实验性）：NCM_TASKS=like,share,browse,welfare,view
//   like    = 红心 3 首 VIP 单曲
//   share   = 分享 1 首单曲到动态
//   browse  = 浏览类任务上报（云贝任务中心 click/task）
//   welfare = 领取会员尊享福利（免费领福利）
//   view    = 查看类会员任务上报（查看AI调音大师等，页面浏览时长上报）
//   listen  = 听 3 首 VIP 歌曲上报播放（⚠️ 刷歌行为，风控高发，谨慎开启）
// 留空 = 全部不执行（默认）
const TASK_SWITCH = (process.env.NCM_TASKS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const taskEnabled = (name) => TASK_SWITCH.includes(name);

// ================= 状态文件（deviceId / xeapi 公钥持久化） =================

const STATE_FILE = path.join(__dirname, '.netease-checkin-state.json');
const XEAPI_KEY_TTL = 3 * 24 * 3600 * 1000; // 公钥 3 天刷新一次

let state = { deviceId: '', xeapiPublicKey: null, updatedAt: 0 };
try {
    if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object') state = { ...state, ...parsed };
    }
} catch (e) {
    console.log('⚠️ 状态文件读取失败，使用全新状态:', e.message);
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        console.log('⚠️ 状态文件保存失败（不影响本次运行）:', e.message);
    }
}

// deviceId：优先环境变量，其次持久化状态，最后生成并保存（固定复用，对抗风控）
const deviceIdMatch = rawEnvCookie.match(/deviceId=([^;]+)/);
let deviceId = deviceIdMatch ? deviceIdMatch[1] : (state.deviceId || '');
if (!deviceId) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 32; i++) {
        deviceId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    state.deviceId = deviceId;
    saveState();
}

// ================= 通知模块 =================

let notify;
try {
    notify = require('./sendNotify');
} catch (e) {
    notify = {
        sendNotify: async (title, content) => {
            console.log(`📢 ${title}\n${content}`);
        }
    };
}

// ================= 加密实现 =================
// 参考 NeteaseCloudMusicApiEnhanced 的 util/crypto.js（MIT License）

const presetKey = '0CoJUm6Qyw8W8jud';
const iv = '0102030405060708';
const publicKeyHex = '010001';
const modulusHex = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const eapiKey = 'e82ckenh8dichen8';
const xeapiStaticKey = Buffer.from('ab1d5a430f6bb04a3f01e81ddd72bd916d5ce591248ac128714806d7f8fb1b84', 'hex');
const xeapiSignKey = 'mUHCwVNWJbunMqAHf5MImuirT6plvs6VSFW62MGHstFQxhBGdEoIhLItH3djc4+FB/OKty3+lL2rGeoFBpVe5g==';
const x25519SpkiPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const EAPI_SEPARATOR = '-36cd479b6b5-';

function generateSecretKey(size) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < size; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

// ---------- weapi ----------
function aesEncryptCBC(text, key) {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
}

function modPow(base, exp, mod) {
    let res = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) res = (res * base) % mod;
        base = (base * base) % mod;
        exp = exp / 2n;
    }
    return res;
}

function rsaEncrypt(text, pubKeyHex, modHex) {
    const reversedText = text.split('').reverse().join('');
    const hexText = Buffer.from(reversedText).toString('hex');
    return modPow(BigInt('0x' + hexText), BigInt('0x' + pubKeyHex), BigInt('0x' + modHex))
        .toString(16)
        .padStart(256, '0');
}

function weapiEncrypt(data) {
    const payload = { ...data };
    if (!('csrf_token' in payload)) payload.csrf_token = csrfToken;
    const text = JSON.stringify(payload);
    const secretKey = generateSecretKey(16);
    const params = aesEncryptCBC(aesEncryptCBC(text, presetKey), secretKey);
    const encSecKey = rsaEncrypt(secretKey, publicKeyHex, modulusHex);
    return { params, encSecKey };
}

// ---------- eapi ----------
function eapiEncrypt(uri, object) {
    const text = typeof object === 'object' ? JSON.stringify(object) : object;
    const message = `nobody${uri}use${text}md5forencrypt`;
    const digest = crypto.createHash('md5').update(message).digest('hex');
    const data = `${uri}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;
    const cipher = crypto.createCipheriv('aes-128-ecb', eapiKey, null);
    return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

// ---------- xeapi（X25519 ECDH + AES-128-GCM） ----------
function aesEcbEncrypt(key, plaintext) {
    const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
    return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

function aesEcbDecrypt(key, ciphertext) {
    const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function xeapiSign(timestamp, nonce) {
    return crypto.createHmac('sha256', xeapiSignKey)
        .update(String(timestamp) + nonce)
        .digest('base64');
}

function createX25519PublicKey(raw) {
    return crypto.createPublicKey({
        key: Buffer.concat([x25519SpkiPrefix, raw]),
        format: 'der',
        type: 'spki',
    });
}

function deriveX25519AesKey(sharedSecret, ephemeralPublicKey) {
    const prk = crypto.createHmac('sha256', Buffer.alloc(32))
        .update(sharedSecret.length ? sharedSecret : Buffer.alloc(32))
        .digest();
    return crypto.createHmac('sha256', prk)
        .update(Buffer.concat([ephemeralPublicKey, Buffer.from([1])]))
        .digest()
        .subarray(0, 16);
}

function xeapiMidTransform(ciphertext) {
    const random = crypto.randomBytes(16);
    const xored = Buffer.alloc(ciphertext.length);
    for (let i = 0; i < ciphertext.length; i++) {
        xored[i] = ciphertext[i] ^ random[i & 0x0f];
    }
    const b64 = Buffer.from(xored.toString('base64'));
    const rot = b64.length ? (random[0] & 0x0f) % b64.length : 0;
    return Buffer.concat([random, b64.subarray(rot), b64.subarray(0, rot)]);
}

function xeapiEncryptS(dynamicKey, publicKeyState, os = 'android') {
    const peerKey = createX25519PublicKey(Buffer.from(publicKeyState.publicKey, 'base64'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const ephemeralRaw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32);
    const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: peerKey });
    const aesKey = deriveX25519AesKey(sharedSecret, ephemeralRaw);
    const gcmIv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, gcmIv);
    const plaintext = Buffer.from(`${dynamicKey.toString('base64')}|${os}|${publicKeyState.sk || ''}`);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ephemeralRaw, gcmIv, encrypted, cipher.getAuthTag()]);
}

function buildXeapiPlaintext(uri, data) {
    const fields = {};
    const url = new URL(uri, 'https://interface.music.163.com');
    if (url.search) fields.queryString = url.search.slice(1);
    if (data !== undefined && data !== null) {
        const bodyData = { ...data };
        delete bodyData.e_r;
        fields.body = Buffer.from(new URLSearchParams(bodyData).toString()).toString('base64');
    }
    fields.queryString = fields.queryString ? `${fields.queryString}&e_r=true` : 'e_r=true';
    return JSON.stringify(fields);
}

function xeapiEncrypt(uri, data, publicKeyState) {
    const dynamicKey = crypto.randomBytes(16);
    const plaintext = Buffer.from(buildXeapiPlaintext(uri, data));
    const B = aesEcbEncrypt(dynamicKey, xeapiMidTransform(aesEcbEncrypt(xeapiStaticKey, plaintext)));
    const S = xeapiEncryptS(dynamicKey, publicKeyState);
    const R = aesEcbEncrypt(xeapiStaticKey, Buffer.from(`${publicKeyState.version}|`));
    return { B: B.toString('base64'), S: S.toString('base64'), R: R.toString('base64') };
}

function xeapiResDecrypt(body) {
    const decrypted = aesEcbDecrypt(eapiKey, body);
    const plaintext = decrypted[0] === 0x1f && decrypted[1] === 0x8b ? zlib.gunzipSync(decrypted) : decrypted;
    return JSON.parse(plaintext.toString());
}

// ---------- 易盾反作弊 token v3 ----------
async function fetchAntiCheatTokenV3() {
    const result = await rawRequest({
        hostname: 'ac.dun.163yun.com',
        path: '/v3/b?pn=YD00000558929251',
        method: 'GET',
        timeout: 10000,
    });
    if (result.status !== 200) return '';
    const body = result.data.toString();
    const m = body.match(/null\(\[(\d+),\d+,"([^"]+)"\]\)/);
    if (m && m[1] === '200') return m[2];
    return '';
}

// ---------- xeapi 公钥获取（register_xeapikey 协议） ----------
async function fetchXeapiPublicKey(currentVersion = '') {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
    const timestamp = String(Date.now());
    const data = {
        appVersion: '9.5.61',
        currentKeyVersion: currentVersion,
        deviceId,
        nonce,
        os: 'android',
        requestType: 'active',
        signature: xeapiSign(timestamp, nonce),
        t1: '',
        t2: '',
        timestamp,
        uid: '',
    };
    const result = await rawRequest({
        hostname: 'interface.music.163.com',
        path: '/api/gorilla/anti/crawler/security/key/get',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)',
            'Cookie': `deviceId=${encodeURIComponent(deviceId)}`,
        },
        body: new URLSearchParams(data).toString(),
        timeout: 15000,
    });
    if (result.status !== 200) throw new Error(`公钥接口 HTTP ${result.status}`);
    const json = JSON.parse(result.data.toString());
    if (!json || json.code !== 200 || !json.data || !json.data.encryptedData) {
        throw new Error('xeapi 公钥响应异常');
    }
    if (json.data.signature && xeapiSign(json.data.timestamp, nonce) !== json.data.signature) {
        throw new Error('xeapi 公钥响应签名校验失败');
    }
    const publicKey = JSON.parse(
        aesEcbDecrypt(xeapiStaticKey, Buffer.from(json.data.encryptedData, 'base64')).toString()
    );
    if (!publicKey.sk) {
        // 刷新响应无 sk 时复用旧 sk（官方客户端行为）
        if (state.xeapiPublicKey && state.xeapiPublicKey.sk) {
            publicKey.sk = state.xeapiPublicKey.sk;
        } else {
            throw new Error('xeapi 公钥响应缺少 sk');
        }
    }
    return publicKey;
}

async function getXeapiPublicKeyState() {
    const cached = state.xeapiPublicKey;
    const fresh = cached && cached.version && cached.publicKey &&
        Date.now() - state.updatedAt < XEAPI_KEY_TTL;
    if (fresh) return cached;
    try {
        const pub = await fetchXeapiPublicKey(cached ? cached.version : '');
        state.xeapiPublicKey = pub;
        state.updatedAt = Date.now();
        saveState();
        return pub;
    } catch (e) {
        console.log(`   ⚠️ xeapi 公钥获取失败（将回退 weapi）: ${e.message}`);
        // 用缓存兜底（即使过期）
        if (cached && cached.version && cached.publicKey) return cached;
        return null;
    }
}

// ================= HTTP 请求层 =================

function rawRequest({ hostname, path, method = 'POST', headers = {}, body = '', timeout = 15000 }) {
    return new Promise((resolve) => {
        const postData = Buffer.from(body);
        const options = {
            hostname,
            port: 443,
            path,
            method,
            timeout,
            headers: {
                ...headers,
                ...(method === 'POST' && { 'Content-Length': postData.length }),
            },
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({ status: res.statusCode || -1, headers: res.headers, data: Buffer.concat(chunks) });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('请求超时'));
        });
        req.on('error', (err) => {
            resolve({ status: -1, headers: {}, data: Buffer.from(''), message: err.message });
        });
        if (method === 'POST') req.write(postData);
        req.end();
    });
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, label = '', retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            if (!NO_DELAY) await delay(250 + Math.floor(Math.random() * 650));
            return await fn();
        } catch (e) {
            if (i < retries) {
                await delay(800 * (i + 1));
                continue;
            }
            console.log(`   ⚠️ ${label} 失败: ${e.message}`);
            return { code: -1, message: e.message };
        }
    }
}

// 严格版：失败时抛出异常，供"主通道失败 → 回退备用通道"的场景使用
async function withRetryStrict(fn, label = '', retries = 2) {
    const res = await withRetry(fn, label, retries);
    if (res && res.code === -1) throw new Error(res.message || `${label} 失败`);
    return res;
}

function buildCookie(extra = {}) {
    const parts = [`MUSIC_U=${musicU}`, `__csrf=${csrfToken}`, `deviceId=${deviceId}`];
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${v}`);
    }
    return parts.join('; ');
}

// weapi 请求 → music.163.com/weapi/*
async function weapiRequest(path, data, extra = {}) {
    const encrypted = weapiEncrypt(data);
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;
    const os = extra.os || 'android';
    const appver = extra.appver || (os === 'android' ? '9.0.70' : '3.0.0');
    const result = await rawRequest({
        hostname: extra.hostname || 'music.163.com',
        path,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': buildCookie({ os, appver }),
            'User-Agent': extra.ua || (os === 'android'
                ? `NeteaseMusic/${appver} (Android 12; Pixel 6)`
                : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
            'Referer': 'https://music.163.com/',
            'Origin': 'https://music.163.com',
        },
        body,
    });
    return parseJsonResponse(result, 'weapi');
}

// eapi 请求 → 默认 interfacepc.music.163.com/eapi/*（响应为明文 JSON）
// opts: { hostname, os, appver, osver } —— App 侧接口需切到 interface3 / clientlog
async function eapiRequest(uri, data, opts = {}) {
    const now = Date.now();
    const os = opts.os || 'pc';
    const appver = opts.appver || '3.1.17.204416';
    const osver = opts.osver || 'Microsoft-Windows-10-Professional-build-19045-64bit';
    const header = {
        osver,
        deviceId,
        os,
        appver,
        versioncode: '140',
        mobilename: '',
        buildver: String(now).substr(0, 10),
        resolution: '1920x1080',
        __csrf: csrfToken,
        channel: 'netease',
        requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
        MUSIC_U: musicU,
    };
    const payload = { ...data, header };
    const params = eapiEncrypt(uri, payload);
    const nmtid = '00O' + crypto.randomBytes(19).toString('hex');
    const result = await rawRequest({
        hostname: opts.hostname || 'interfacepc.music.163.com',
        path: '/eapi/' + uri.substr(5),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': buildCookie({ os, appver, NMTID: nmtid }),
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://music.163.com/',
            'Origin': 'https://music.163.com',
        },
        body: `params=${encodeURIComponent(params)}`,
    });
    return parseJsonResponse(result, 'eapi');
}

// xeapi 请求 → interface3.music.163.com/xeapi/*（响应为加密体）
async function xeapiRequest(uri, data, { checkToken = false } = {}) {
    const publicKeyState = await getXeapiPublicKeyState();
    if (!publicKeyState) throw new Error('xeapi 公钥不可用');
    const encrypted = xeapiEncrypt(uri, data, publicKeyState);
    const body = `B=${encodeURIComponent(encrypted.B)}&S=${encodeURIComponent(encrypted.S)}&R=${encodeURIComponent(encrypted.R)}`;
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'X-Client-Enc-State': 'ENCRYPTED',
        'x-aeapi': 'true',
        'x-deviceid': deviceId,
        'x-os': 'android',
        'x-osver': '16',
        'x-appver': '9.1.65',
        'x-sdeviceid': deviceId,
        'x-buildver': String(Date.now()).substr(0, 10),
        'x-music-u': musicU,
        'Cookie': buildCookie({
            os: 'android',
            osver: '16',
            appver: '9.1.65',
            buildver: String(Date.now()).substr(0, 10),
            sDeviceId: deviceId,
        }),
        'User-Agent': 'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)',
    };
    if (checkToken) {
        const token = await fetchAntiCheatTokenV3();
        if (token) headers['X-antiCheatToken'] = token;
    }
    const result = await rawRequest({
        hostname: 'interface3.music.163.com',
        path: '/xeapi/' + uri.substr(5),
        headers,
        body,
    });
    if (result.status !== 200) {
        return { code: -1, message: `xeapi HTTP ${result.status}` };
    }
    try {
        const json = xeapiResDecrypt(result.data);
        if (json && json.code !== undefined) json.code = Number(json.code);
        return json;
    } catch (e) {
        return { code: -1, message: `xeapi 响应解密失败: ${e.message}` };
    }
}

function parseJsonResponse(result, label) {
    if (result.status === -1) return { code: -1, message: result.message || `${label} 网络错误` };
    try {
        const json = JSON.parse(result.data.toString());
        if (json && json.code !== undefined) json.code = Number(json.code);
        return json;
    } catch (e) {
        return { code: -1, message: `${label} 响应解析失败 (HTTP ${result.status})` };
    }
}

// ================= 接口方法（端点与加密方式依据 NeteaseCloudMusicApiEnhanced 校准） =================

async function getUserInfo() {
    return await withRetry(() => weapiRequest('/weapi/nuser/account/get', {}), '登录状态检查');
}

async function dailySign(type = 0) {
    const os = type === 0 ? 'android' : 'pc';
    return await withRetry(() => weapiRequest('/weapi/point/dailyTask', { type }, { os }), '旧版签到');
}

// 云贝今日签到检查（官方 /weapi/point/today/get）
async function yunbeiCheckToday() {
    return await withRetry(() => weapiRequest('/weapi/point/today/get', {}), '云贝签到检查');
}

// 云贝签到：官方 xeapi + 反作弊 token v3，失败回退 weapi
async function yunbeiSign() {
    try {
        return await withRetryStrict(
            () => xeapiRequest('/api/pointmall/user/sign', {}, { checkToken: true }),
            '云贝签到(xeapi)'
        );
    } catch (e) {
        console.log(`   ⚠️ xeapi 通道异常，回退 weapi: ${e.message}`);
    }
    return await withRetry(() => weapiRequest('/weapi/pointmall/user/sign', {}), '云贝签到(weapi)');
}

// 云贝连签进度与抽奖（旧接口，保留兼容）
async function yunbeiSignProgress() {
    return await withRetry(() => weapiRequest('/weapi/pointmall/user/sign/progress', {}), '连签进度');
}

async function yunbeiSignLottery(userLotteryId) {
    return await withRetry(
        () => weapiRequest('/weapi/pointmall/user/lottery/get', { userLotteryId: String(userLotteryId) }),
        '连签奖励领取'
    );
}

async function yunbeiTaskTodo() {
    return await withRetry(() => weapiRequest('/weapi/usertool/task/todo/query', {}), '云贝任务列表');
}

async function yunbeiTaskFinish(task) {
    const data = {
        userTaskId: String(task.userTaskId || task.taskId || ''),
        depositCode: task.depositCode ? String(task.depositCode) : '0',
    };
    if (task.period !== undefined) data.period = String(task.period);
    return await withRetry(() => weapiRequest('/weapi/usertool/task/point/receive', data), '云贝任务领取');
}

async function getYunbeiInfo() {
    const res = await withRetry(() => weapiRequest('/weapi/v1/user/info', {}), '云贝余额');
    if (res.code === 200 && res.data) return res;
    return await withRetry(() => weapiRequest('/weapi/pointmall/user/info', {}), '云贝余额(备用)');
}

// 黑胶乐签打卡详情（eapi，官方预检查口径）
async function vipSignCheckDetail() {
    return await withRetry(
        () => eapiRequest('/api/vipnewcenter/app/level/user/checkin/history/detail', {
            signDayTime: Date.now(),
            type: '1',
        }),
        '黑胶乐签检查(eapi)'
    );
}

// 黑胶乐签执行（weapi，music.163.com）
async function vipSign() {
    return await withRetry(() => weapiRequest('/weapi/vip-center-bff/task/sign', {}), '黑胶乐签');
}

async function getVipGrowth() {
    return await withRetry(
        () => weapiRequest('/weapi/vipnewcenter/app/level/growhpoint/basic', {}),
        'VIP成长值'
    );
}

// VIP 成长任务列表（官方 xeapi，回退 weapi）
async function getVipMissionProgress(userId) {
    try {
        return await withRetryStrict(
            () => xeapiRequest('/api/middle/vip/mission/user/progress/list', {
                taskType: 'app_vip_task_center',
                userId: String(userId || ''),
            }),
            'VIP任务列表(xeapi)'
        );
    } catch (e) {
        console.log(`   ⚠️ xeapi 通道异常，回退 weapi: ${e.message}`);
    }
    return await withRetry(
        () => weapiRequest('/weapi/middle/vip/mission/user/progress/list', {}),
        'VIP任务列表(weapi)'
    );
}

// VIP 任务奖励领取（无官方新端点，双 host 尝试）
async function receiveVipMissionReward(userRewardId, userProgressId) {
    const data = { userRewardId: String(userRewardId), userProgressId: String(userProgressId) };
    let res = await withRetry(
        () => weapiRequest('/weapi/middle/vip/mission/user/reward/receive', data),
        'VIP任务领取'
    );
    if (res.code !== 200) {
        res = await withRetry(
            () => weapiRequest('/weapi/middle/vip/mission/user/reward/receive', data, { hostname: 'interface3.music.163.com' }),
            'VIP任务领取(备用host)'
        );
    }
    return res;
}

// VIP 成长任务一键领取（官方 xeapi，回退 weapi）
async function receiveAllVipReward() {
    try {
        return await withRetryStrict(
            () => xeapiRequest('/api/vipnewcenter/app/level/task/reward/getall', {}),
            'VIP一键领取(xeapi)'
        );
    } catch (e) {
        console.log(`   ⚠️ xeapi 通道异常，回退 weapi: ${e.message}`);
    }
    return await withRetry(
        () => weapiRequest('/weapi/vipnewcenter/app/level/task/reward/getall', {}),
        'VIP一键领取(weapi)'
    );
}

// ================= 结果判定工具 =================

// 云贝签到成功与否 / 是否重复的宽容判定
function isAlreadySignedMsg(msg) {
    if (!msg) return false;
    return msg.includes('重复') || msg.includes('已签到') || msg.includes('已打卡');
}

// 解析云贝余额
function parseYunbeiBalance(info) {
    if (!info || info.code !== 200) return null;
    const candidates = [
        info.data?.userPoint,
        info.data?.balance,
        info.data?.userPoint?.balance,
        info.userPoint?.balance,
        info.userPoint,
        info.data?.totalPoint,
        info.point,
    ];
    for (const val of candidates) {
        if (typeof val === 'number') return val;
    }
    return null;
}

// ================= 每日任务自动化（实验性 · 默认关闭） =================
// 接口依据（全部来自本机两个开源项目的源码，非猜测）：
//   song/like                → https://interface3.music.163.com/eapi/song/like   （ncmctl api/eapi/song.go）
//   share/friends/resource   → xeapi + 易盾 token                                （api-enhanced module/share_resource.js）
//   usertool/task/recommend/v2 → 云贝任务列表，返回体自带 subAction 字段          （ncmctl api/weapi/yunbei.go）
//   yunbei/click/task        → 浏览类任务上报                                     （ncmctl api/eapi/yunbei.go）
//   feedback/weblog          → 播放上报                                          （api-enhanced module/scrobble.js）

// 每日推荐歌曲（作为挑选 VIP 单曲的来源）
async function getDailySongs() {
    return await withRetry(
        () => weapiRequest('/weapi/v3/discovery/recommend/songs', {}),
        '每日推荐歌曲'
    );
}

// 从推荐里挑歌：优先 fee=1 的 VIP 单曲，不足时回退普通歌曲
function pickTaskSongs(songs, count) {
    const list = Array.isArray(songs) ? songs.filter((s) => s && s.id) : [];
    const vip = list.filter((s) => s.fee === 1 || s.privilege?.fee === 1);
    const useVip = vip.length >= count;
    return {
        picked: (useVip ? vip : list).slice(0, count),
        vipCount: vip.length,
        total: list.length,
        useVip,
    };
}

// 红心歌曲（eapi · interface3，官方现行口径；返回 playlistId = 我喜欢的音乐）
async function likeSong(trackId) {
    return await withRetry(
        () => eapiRequest('/api/song/like', {
            trackId: String(trackId),
            like: 'true',
            time: '3',
            checkToken: '',
        }, { hostname: 'interface3.music.163.com' }),
        '红心歌曲'
    );
}

// 分享单曲到动态（xeapi + 易盾反作弊 token）
async function shareSong(songId) {
    return await withRetryStrict(
        () => xeapiRequest('/api/share/friends/resource', {
            type: 'song',
            msg: '',
            id: String(songId),
        }, { checkToken: true }),
        '分享单曲'
    );
}

// 云贝任务列表（返回体含 taskId / userTaskId / subAction / link / completed）
async function yunbeiRecommendTasks() {
    return await withRetry(
        () => weapiRequest('/weapi/usertool/task/recommend/v2?adExtJson=', {}, {
            hostname: 'interface3.music.163.com',
        }),
        '云贝任务列表'
    );
}

// 浏览类任务上报（源码注释：宣告浏览会员中心等任务开始）
async function clickYunbeiTask(taskId, subAction) {
    return await withRetryStrict(
        () => eapiRequest('/api/yunbei/click/task', {
            taskId: String(taskId),
            subAction: subAction || '',
            type: 'browse',
            checkToken: '',
        }, { hostname: 'interface3.music.163.com' }),
        '浏览任务上报'
    );
}

// 会员等级任务列表（诊断用：查看 VIP 侧任务结构与 taskId）
async function vipTaskList() {
    return await withRetry(
        () => weapiRequest('/weapi/vipnewcenter/app/level/task/list', {}),
        '会员任务列表'
    );
}

// ============ 会员成长任务（查看类 / 免费领福利） ============
// 接口依据（ncmctl api/weapi/vip.go）：
//   任务进度列表  POST interface3 /weapi/middle/vip/mission/user/progress/list  → basicMissionDTO.schemaContent 内含 jumpUrl
//   页面浏览上报  POST interface  /weapi/middle/page/view/report   { data: JSON字符串 }（VipMiddlePageViewReport）
//   福利列表      POST interface3 /weapi/vipnewcenter/app/level/welfare/new/list → { 等级: [福利项] }
//   福利领取      POST music.163  /weapi/vipnewcenter/app/level/welfare/claim   { welfareId }

// 会员任务进度列表（weapi 口径，字段含 schemaContent）
async function vipMissionProgressWeapi(userId) {
    return await withRetry(
        () => weapiRequest('/weapi/middle/vip/mission/user/progress/list', {
            taskType: 'app_vip_task_center',
            userId: String(userId || ''),
        }, { hostname: 'interface3.music.163.com' }),
        '会员任务进度(weapi)'
    );
}

// 解析 schemaContent（字符串形式的 JSON）拿 jumpUrl 等字段
function parseSchemaContent(schemaContent) {
    if (!schemaContent) return {};
    try {
        const obj = typeof schemaContent === 'string' ? JSON.parse(schemaContent) : schemaContent;
        return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
        return {};
    }
}

// 从 jumpUrl 的查询串里提取上报所需字段
function parseJumpUrlParams(jumpUrl) {
    const out = {};
    if (!jumpUrl || typeof jumpUrl !== 'string') return out;
    const q = jumpUrl.indexOf('?');
    if (q < 0) return out;
    try {
        const sp = new URLSearchParams(jumpUrl.slice(q + 1));
        for (const k of ['taskId', 'taskType', 'taskBusiness', 'resourceType', 'pageCode', 'activityPlatformId', 'viewTime']) {
            const v = sp.get(k);
            if (v) out[k] = v;
        }
    } catch (e) { /* 忽略解析失败 */ }
    return out;
}

// 中台页面浏览上报（模拟 App 内 webview，用 iPhone webview UA）
async function middlePageViewReport(fields) {
    const data = {
        actionType: fields.actionType || 'view',
        time: Date.now(),
        taskId: String(fields.taskId || ''),
        taskType: Number(fields.taskType) || 0,
        viewTime: Number(fields.viewTime) || 15000,
        jumpUrl: fields.jumpUrl || '',
        taskBusiness: fields.taskBusiness || '',
        resourceType: fields.resourceType || '',
        pageCode: fields.pageCode || '',
    };
    if (fields.activityPlatformId) data.activityPlatformId = fields.activityPlatformId;
    return await withRetryStrict(
        () => weapiRequest('/weapi/middle/page/view/report', { data: JSON.stringify(data) }, {
            hostname: 'interface.music.163.com',
            ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CloudMusic/0.1.1 NeteaseMusic/9.4.95',
        }),
        '页面浏览上报'
    );
}

// 尊享福利列表
async function vipWelfareList() {
    return await withRetry(
        () => weapiRequest('/weapi/vipnewcenter/app/level/welfare/new/list', {}, {
            hostname: 'interface3.music.163.com',
        }),
        '会员福利列表'
    );
}

// 领取尊享福利
async function vipWelfareClaim(welfareId) {
    return await withRetryStrict(
        () => weapiRequest('/weapi/vipnewcenter/app/level/welfare/claim', { welfareId: Number(welfareId) }),
        '福利领取'
    );
}

// 播放上报（⚠️ 刷歌行为：仅当 listen 开关显式打开时调用）
async function scrobbleSong(songId, sourceId, seconds) {
    const src = String(sourceId || songId);
    const startplayLogs = JSON.stringify([{
        action: 'startplay',
        json: { id: songId, type: 'song', mainsite: '1', mainsiteWeb: '1', content: `id=${src}` },
    }]);
    const playLogs = JSON.stringify([{
        action: 'play',
        json: {
            download: 0, end: 'playend', id: songId, sourceId: src, time: seconds,
            type: 'song', wifi: 0, source: 'list', mainsite: '1', mainsiteWeb: '1', content: `id=${src}`,
        },
    }]);
    const opts = { hostname: 'clientlog.music.163.com', os: 'osx', appver: '3.1.10.5100', osver: '15.5' };
    const startplay = await withRetry(() => eapiRequest('/api/feedback/weblog', { logs: startplayLogs }, opts), '播放上报(startplay)');
    const play = await withRetry(() => eapiRequest('/api/feedback/weblog', { logs: playLogs }, opts), '播放上报(play)');
    return { startplay, play };
}

// 执行每日任务，返回给通知用的摘要
async function runDailyTasks(userId) {
    console.log('\n🧩 每日任务自动化（实验性）...');
    console.log(`   已开启：${TASK_SWITCH.join(', ')}`);
    const summary = [];

    // 准备歌曲源
    let songs = [];
    try {
        const daily = await getDailySongs();
        songs = daily?.data?.dailySongs || [];
        console.log(`   ℹ️ 每日推荐 ${songs.length} 首`);
    } catch (e) {
        console.log(`   ⚠️ 获取每日推荐失败：${e.message}`);
    }
    const { picked, vipCount, total, useVip } = pickTaskSongs(songs, 3);
    if (total) {
        console.log(`   ℹ️ 其中 VIP 单曲 ${vipCount} 首${useVip ? '' : `（不足 3 首，回退使用普通歌曲）`}`);
    }

    // 1) 红心 3 首 VIP 单曲
    if (taskEnabled('like')) {
        console.log('   ❤️ 红心歌曲...');
        if (!picked.length) {
            console.log('      ⚠️ 没有可用歌曲（每日推荐为空），跳过');
        } else {
            let ok = 0;
            let likedPlaylistId = '';
            for (const s of picked) {
                const r = await likeSong(s.id);
                if (r.code === 200) {
                    ok++;
                    if (r.playlistId) likedPlaylistId = r.playlistId;
                    console.log(`      ✅ ${s.name}${s.fee === 1 ? ' (VIP)' : ''}`);
                } else {
                    console.log(`      ⚠️ ${s.name} 失败 code=${r.code}${r.msg ? ', ' + r.msg : ''}`);
                }
            }
            if (likedPlaylistId) {
                console.log(`      ℹ️ 我喜欢的音乐 playlistId=${likedPlaylistId}`);
            }
            summary.push(`❤️ 红心×${ok}`);
        }
    }

    // 2) 分享单曲
    if (taskEnabled('share')) {
        console.log('   🔗 分享单曲...');
        if (!picked.length) {
            console.log('      ⚠️ 没有可用歌曲，跳过');
        } else {
            try {
                const r = await shareSong(picked[0].id);
                console.log(`      ${r.code === 200 ? '✅' : '⚠️'} 分享 [${picked[0].name}] code=${r.code}${r.msg ? ', ' + r.msg : ''}`);
                if (r.code === 200) summary.push('🔗 分享×1');
            } catch (e) {
                console.log(`      ⚠️ 分享失败：${e.message}`);
            }
        }
    }

    // 3) 浏览类任务（云贝任务中心）
    if (taskEnabled('browse')) {
        console.log('   👀 浏览类任务...');
        try {
            const res = await yunbeiRecommendTasks();
            const items = Array.isArray(res?.data) ? res.data : [];
            if (!items.length) {
                console.log(`      ⚠️ 云贝任务列表为空 (code=${res.code}${res.msg ? ', ' + res.msg : ''})`);
            } else {
                console.log(`      ℹ️ 云贝任务共 ${items.length} 个：`);
                for (const t of items) {
                    console.log(`         · ${t.taskName} +${t.taskPoint} taskId=${t.taskId} subAction=${t.subAction ?? '-'} 已完成=${t.completed === true}`);
                }
                const targets = items.filter((t) => t.completed !== true && /浏览|查看|逛|体验/.test(t.taskName || ''));
                if (!targets.length) {
                    console.log('      ℹ️ 没有待完成的浏览类任务');
                }
                for (const t of targets) {
                    try {
                        const r = await clickYunbeiTask(t.taskId, t.subAction);
                        console.log(`      ${r.code === 200 ? '✅' : '⚠️'} 上报 [${t.taskName}] code=${r.code} data=${JSON.stringify(r.data ?? null)}`);
                    } catch (e) {
                        console.log(`      ⚠️ 上报 [${t.taskName}] 失败：${e.message}`);
                    }
                }
                // 复查是否真的变成已完成
                const after = await yunbeiRecommendTasks();
                const afterItems = Array.isArray(after?.data) ? after.data : [];
                const done = afterItems.filter((t) => t.completed === true).length;
                console.log(`      ℹ️ 复查：已完成 ${done}/${afterItems.length} 个`);
                if (done > items.filter((t) => t.completed === true).length) summary.push('👀 浏览任务已上报');
            }
        } catch (e) {
            console.log(`      ⚠️ 浏览任务处理异常：${e.message}`);
        }

        // 会员侧任务结构诊断（查看AI调音大师等属于会员成长任务，机制待确认）
        try {
            const vip = await vipTaskList();
            const list = vip?.data?.taskList || vip?.taskList || [];
            if (Array.isArray(list) && list.length) {
                console.log('      ℹ️ 会员任务结构（诊断）：');
                for (const t of list.slice(0, 20)) {
                    const items = t.taskItems || [];
                    if (!items.length) {
                        console.log(`         · [${t.taskType ?? '-'}] ${t.taskName ?? ''} ${t.taskTag ?? ''}`);
                        continue;
                    }
                    for (const it of items) {
                        console.log(`         · ${it.taskName ?? it.taskId} 成长值+${it.growthPoint ?? 0} taskId=${it.taskId ?? '-'} tag=${it.taskTag ?? '-'}`);
                    }
                }
            } else {
                console.log(`      ℹ️ 会员任务列表返回 code=${vip.code}${vip.msg ? '：' + vip.msg : '（结构可能已变）'}`);
            }
        } catch (e) {
            console.log(`      ⚠️ 会员任务诊断异常：${e.message}`);
        }
    }

    // 4) 免费领福利（会员尊享福利，paid 项自动跳过）
    if (taskEnabled('welfare')) {
        console.log('   🎁 会员尊享福利...');
        try {
            const res = await vipWelfareList();
            const raw = res?.data;
            let items = [];
            if (Array.isArray(raw)) items = raw;
            else if (raw && typeof raw === 'object') {
                items = Object.values(raw).flat().filter((x) => x && typeof x === 'object');
            }
            if (!items.length) {
                console.log(`      ⚠️ 福利列表为空 (code=${res.code}${res.msg ? ', ' + res.msg : ''})`);
            } else {
                console.log(`      ℹ️ 共 ${items.length} 项福利`);
                let claimed = 0;
                for (const it of items) {
                    const paid = Number(it.specialPrice || 0) > 0;
                    const received = Number(it.userReceiveStatus) === 1;
                    console.log(`         · [Lv.${it.level ?? '-'}] ${it.showName ?? it.id} id=${it.id} 状态=${it.status ?? '-'} 已领=${received}${paid ? ' 付费' : ''}`);
                    if (paid) continue;
                    if (received) continue;
                    try {
                        const r = await vipWelfareClaim(it.id);
                        if (r.code === 200) {
                            claimed++;
                            console.log(`         ✅ 领取成功：${it.showName ?? it.id}`);
                        } else {
                            console.log(`         ⚠️ 领取失败 code=${r.code}${r.msg ? ', ' + r.msg : ''}`);
                        }
                    } catch (e) {
                        console.log(`         ⚠️ 领取异常：${e.message}`);
                    }
                }
                if (claimed > 0) summary.push(`🎁 福利×${claimed}`);
            }
        } catch (e) {
            console.log(`      ⚠️ 福利处理异常：${e.message}`);
        }
    }

    // 5) 查看类会员任务（查看AI调音大师等：页面浏览时长上报）
    if (taskEnabled('view')) {
        console.log('   🔍 会员查看类任务...');
        try {
            let res = await vipMissionProgressWeapi(userId);
            let missions = Array.isArray(res?.data) ? res.data : null;
            if (!missions) {
                // weapi 口径不可用时退回 xeapi 口径
                const alt = await getVipMissionProgress(userId);
                missions = Array.isArray(alt?.data) ? alt.data : [];
                console.log(`      ℹ️ weapi 口径 code=${res.code}，改用 xeapi 口径（${missions.length} 项）`);
            }
            if (!missions.length) {
                console.log('      ⚠️ 会员任务列表为空，无法定位查看类任务');
            } else {
                const targets = [];
                for (const m of missions) {
                    const dto = m.basicMissionDTO || {};
                    const schema = parseSchemaContent(dto.schemaContent);
                    const jumpUrl = schema.jumpUrl || schema['jumpUrl '] || '';
                    const name = dto.name || '';
                    console.log(`         · ${name} missionCode=${dto.missionCode ?? '-'} 状态=${m.missionStatus ?? '-'} jumpUrl=${jumpUrl ? String(jumpUrl).slice(0, 60) + '…' : '-'}`);
                    if (!/查看|浏览|体验|逛逛/.test(name)) continue;
                    targets.push({ name, dto, schema, jumpUrl });
                }
                if (!targets.length) {
                    console.log('      ℹ️ 没有匹配到查看类任务（名称需含 查看/浏览/体验/逛逛）');
                }
                for (const t of targets) {
                    const fromUrl = parseJumpUrlParams(t.jumpUrl);
                    const fields = {
                        actionType: 'view',
                        taskId: fromUrl.taskId || t.dto.missionId || '',
                        taskType: fromUrl.taskType || t.dto.missionType || 0,
                        viewTime: 15000,
                        jumpUrl: t.jumpUrl,
                        taskBusiness: fromUrl.taskBusiness || '',
                        resourceType: fromUrl.resourceType || '',
                        pageCode: fromUrl.pageCode || '',
                        activityPlatformId: fromUrl.activityPlatformId,
                    };
                    console.log(`      ℹ️ [${t.name}] 上报参数：${JSON.stringify({ ...fields, jumpUrl: fields.jumpUrl ? '(略)' : '' })}`);
                    console.log(`      ℹ️ [${t.name}] schemaContent 原文：${JSON.stringify(t.schema).slice(0, 300)}`);
                    try {
                        const r = await middlePageViewReport(fields);
                        console.log(`      ${r.code === 200 ? '✅' : '⚠️'} [${t.name}] 上报 code=${r.code} data=${JSON.stringify(r.data ?? null)}${r.msg ? ' msg=' + r.msg : ''}`);
                    } catch (e) {
                        console.log(`      ⚠️ [${t.name}] 上报失败：${e.message}`);
                    }
                }
                // 复查
                const after = await vipMissionProgressWeapi(userId);
                const afterList = Array.isArray(after?.data) ? after.data : [];
                const doneCount = afterList.filter((m) => Number(m.missionStatus) === 2 || Number(m.missionStatus) === 3).length;
                console.log(`      ℹ️ 复查：会员任务已完成 ${doneCount}/${afterList.length} 项（missionStatus 2/3 视作已完成，仅供参考）`);
            }
        } catch (e) {
            console.log(`      ⚠️ 查看类任务处理异常：${e.message}`);
        }
    }

    // 6) 听 3 首 VIP 歌曲（⚠️ 刷歌行为）
    if (taskEnabled('listen')) {
        console.log('   🎧 播放上报（⚠️ 刷歌行为，风控高发）...');
        if (!picked.length) {
            console.log('      ⚠️ 没有可用歌曲，跳过');
        } else {
            let ok = 0;
            for (const s of picked) {
                const r = await scrobbleSong(s.id, s.id, 200);
                const pass = r.play?.code === 200;
                if (pass) ok++;
                console.log(`      ${pass ? '✅' : '⚠️'} ${s.name}${s.fee === 1 ? ' (VIP)' : ''} startplay=${r.startplay?.code} play=${r.play?.code}`);
            }
            summary.push(`🎧 播放上报×${ok}`);
        }
    }

    return summary.length ? `\n🧩 每日任务：${summary.join(' / ')}\n` : '';
}

// ================= 主流程 =================

async function main() {
    console.log('🎵 网易云音乐自动签到 (v1.5.0)');
    console.log('时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
    console.log('='.repeat(50));

    let message = '';

    // 1. 登录状态验证
    console.log('\n🔐 检查登录状态...');
    const userInfo = await getUserInfo();
    const account = userInfo.account || userInfo.data?.account;
    const profile = userInfo.profile || userInfo.data?.profile;
    if (userInfo.code === 200 && (account || profile)) {
        const nickname = profile?.nickname || account?.userName || '用户';
        console.log(`   ✅ 用户：${nickname}`);
        message += `👤 用户：${nickname}\n`;
    } else {
        console.log('   ❌ 登录失败，请检查 MUSIC_U 是否有效');
        await safeNotify('网易云签到失败', '登录失效，请更新 MUSIC_U');
        return;
    }
    const userId = account?.id || profile?.userId || '';

    // 2. 旧版普通签到（积分系统已清退，仅作通道连通性检查）
    console.log('\n📝 旧版普通签到（积分系统已清退，仅作通道连通）...');
    const androidSign = await dailySign(0);
    if (androidSign.code === 200) {
        console.log(`   ℹ️ 安卓端已打卡 (旧积分返回: ${androidSign.point || 0})`);
    } else if (androidSign.code === -2) {
        console.log('   ℹ️ 安卓端今日已签过');
    } else {
        console.log(`   ⚠️ 安卓端旧签到接口返回异常 (code=${androidSign.code}${androidSign.msg ? ', ' + androidSign.msg : ''})`);
    }

    const pcSign = await dailySign(1);
    if (pcSign.code === 200) {
        console.log(`   ℹ️ PC端已打卡 (旧积分返回: ${pcSign.point || 0})`);
    } else if (pcSign.code === 403 || pcSign.code === -2) {
        console.log('   ℹ️ PC端旧签到接口已由官方永久下线 (403)');
    } else {
        console.log(`   ⚠️ PC端旧签到接口返回异常 (code=${pcSign.code}${pcSign.msg ? ', ' + pcSign.msg : ''})`);
    }

    // 3. 云贝签到（先查后签）
    console.log('\n☁️ 云贝签到...');
    let yunbeiSigned = false;
    try {
        const checkRes = await yunbeiCheckToday();
        if (checkRes.code === 200 && checkRes.data === true) {
            yunbeiSigned = true;
        } else if (checkRes.code === 200 && checkRes.data && typeof checkRes.data === 'object') {
            const d = checkRes.data;
            if (d.isSign === true || d.sign === true || d.signed === true || d.status === 1) yunbeiSigned = true;
            if (d.isSign === false || d.sign === false || d.signed === false) yunbeiSigned = false;
        }

        if (yunbeiSigned) {
            console.log('   ℹ️ 云贝今日已签到');
            message += '☁️ 云贝：今日已签到\n';
        } else {
            const yunbei = await yunbeiSign();
            const msg = yunbei.msg || yunbei.message || '';
            const alreadySigned = yunbei.code === -2 || isAlreadySignedMsg(msg) ||
                yunbei.data === false ||
                (yunbei.code === 200 && (yunbei.data?.code === -2 || isAlreadySignedMsg(yunbei.data?.msg)));

            if (yunbei.code === 200 && !alreadySigned) {
                let point = 0;
                if (typeof yunbei.point === 'number') point = yunbei.point;
                else if (typeof yunbei.data === 'number') point = yunbei.data;
                else if (typeof yunbei.data?.point === 'number') point = yunbei.data.point;
                else if (typeof yunbei.data?.signPoint === 'number') point = yunbei.data.signPoint;

                if (point > 0) {
                    console.log(`   ✅ 云贝签到成功！获得 ${point} 云贝`);
                    message += `✅ 云贝签到成功 (+${point}云贝)\n`;
                } else {
                    console.log('   ✅ 云贝签到接口返回成功' + (yunbei.data ? ` (${JSON.stringify(yunbei.data).substring(0, 80)})` : ''));
                    message += '✅ 云贝签到成功\n';
                }
            } else if (alreadySigned) {
                console.log('   ℹ️ 云贝今日已签到');
                message += '☁️ 云贝：今日已签到\n';
            } else {
                console.log(`   ⚠️ 云贝签到反馈：${msg || `接口返回异常 (code=${yunbei.code})`}`);
            }
        }
    } catch (e) {
        console.log(`   ⚠️ 云贝签到执行异常: ${e.message}`);
    }

    // 3.1 云贝连签进度奖励
    console.log('\n📅 云贝连签进度奖励...');
    try {
        const progress = await yunbeiSignProgress();
        if (progress.code === 200 && progress.data?.lotteryConfig) {
            let rewardCount = 0;
            for (const config of progress.data.lotteryConfig) {
                const lotteryId = config.userLotteryId || config.baseLotteryId;
                if (lotteryId && (config.baseLotteryStatus === 1 || config.status === 1)) {
                    const lottery = await yunbeiSignLottery(lotteryId);
                    if (lottery.code === 200) {
                        console.log(`   ✅ 连续签到${config.signDay || ''}天奖励领取成功`);
                        rewardCount++;
                    }
                }
            }
            if (rewardCount > 0) message += `✅ 云贝连签奖励×${rewardCount}\n`;
            else console.log('   ℹ️ 暂无连签阶段奖励可领');
        } else {
            console.log(`   ℹ️ 连签进度接口返回 ${progress.code}${progress.msg ? '：' + progress.msg : ''}（可能已下线，不影响主流程）`);
        }
    } catch (e) {
        console.log(`   ⚠️ 连签奖励执行异常: ${e.message}`);
    }

    // 3.2 云贝日常任务
    console.log('\n📋 云贝日常任务...');
    try {
        const tasks = await yunbeiTaskTodo();
        if (tasks.code === 200 && Array.isArray(tasks.data)) {
            let taskCount = 0;
            for (const task of tasks.data) {
                const isAdTask = task.taskName?.includes('福利');
                const isFinished = task.completed === true || task.status === 1;

                if (isFinished && !task.received && !isAdTask) {
                    const finish = await yunbeiTaskFinish(task);
                    const isRealSuccess = finish.code === 200 &&
                        finish.data !== false &&
                        finish.data !== null &&
                        finish.data !== 0 &&
                        !isAlreadySignedMsg(finish.msg || '');

                    if (isRealSuccess) {
                        console.log(`   ✅ [${task.taskName}] 领取成功，+${task.taskPoint || 0}云贝`);
                        taskCount++;
                    } else {
                        console.log(`   ⚠️ [${task.taskName}] 领取失败 (code=${finish.code}${finish.msg ? ', ' + finish.msg : ''})`);
                    }
                }
            }
            if (taskCount > 0) message += `✅ 云贝日常任务×${taskCount}\n`;
            else console.log('   ℹ️ 暂无可领取的日常任务奖励');
        } else {
            console.log(`   ℹ️ 任务列表接口返回 code=${tasks.code}${tasks.msg ? '：' + tasks.msg : ''}`);
        }
    } catch (e) {
        console.log(`   ⚠️ 云贝日常任务异常: ${e.message}`);
    }

    // 3.3 云贝当前余额
    try {
        const info = await getYunbeiInfo();
        const balance = parseYunbeiBalance(info);
        if (balance !== null) {
            console.log(`   💰 云贝当前可用余额：${balance}`);
            message += `☁️ 云贝余额：${balance}\n`;
        } else {
            console.log(`   ⚠️ 未能解析到云贝余额 (code=${info.code})`);
        }
    } catch (e) {
        console.log(`   ⚠️ 云贝余额查询异常: ${e.message}`);
    }

    // 4. 黑胶乐签打卡（官方 eapi 预检查 + weapi 执行）
    console.log('\n💎 黑胶乐签打卡...');
    try {
        let isVipSigned = false;
        const detail = await vipSignCheckDetail();
        if (detail.code === 200) {
            const d = detail.data;
            // 官方口径：打卡详情 code=200 即视为今日已打（vip_sign 接口同款判定）
            if (d && typeof d === 'object' && (d.isSign === false || d.signed === false)) {
                isVipSigned = false;
            } else {
                isVipSigned = true;
            }
        } else {
            // eapi 检查不可用 → 用成长值接口兜底
            const growth = await getVipGrowth();
            if (growth.code === 200 && growth.data &&
                (growth.data.isSign === true || growth.data.userLevel?.isSign === true)) {
                isVipSigned = true;
            }
        }

        if (isVipSigned) {
            console.log('   ℹ️ 黑胶乐签今日已打卡');
            message += '💎 黑胶乐签：今日已打卡\n';
        } else {
            const vipSignResult = await vipSign();
            if (vipSignResult.code === 200 && vipSignResult.data === true) {
                console.log('   ✅ 黑胶乐签打卡成功！+3成长值');
                message += '✅ 黑胶乐签成功 (+3成长值)\n';
            } else if (vipSignResult.code === 200 && vipSignResult.data === false) {
                console.log('   ℹ️ 黑胶乐签今日已打卡');
                message += '💎 黑胶乐签：今日已打卡\n';
            } else {
                console.log(`   ⚠️ 黑胶乐签：${vipSignResult.message || vipSignResult.msg || `接口返回异常 (code=${vipSignResult.code})`}`);
            }
        }
    } catch (e) {
        console.log(`   ⚠️ 黑胶乐签执行异常: ${e.message}`);
    }

    // 5. VIP 成长日常任务
    console.log('\n📋 VIP成长日常任务...');
    try {
        const missions = await getVipMissionProgress(userId);
        if (missions.code === 200 && Array.isArray(missions.data)) {
            let missionCount = 0;
            let totalGrowth = 0;
            for (const mission of missions.data) {
                if (mission.stageProgressDTOS) {
                    for (const stage of mission.stageProgressDTOS) {
                        if (stage.stageStatus === 100 && stage.userRewardId && stage.userProgressId) {
                            const claim = await receiveVipMissionReward(stage.userRewardId, stage.userProgressId);
                            if (claim.code === 200) {
                                const taskName = mission.basicMissionDTO?.name || '任务';
                                const worth = stage.worth || stage.rewardCount || 0;
                                console.log(`   ✅ [${taskName}] +${worth}成长值`);
                                missionCount++;
                                totalGrowth += worth;
                            }
                        }
                    }
                }
            }
            if (missionCount > 0) {
                console.log(`   📈 共领取 ${missionCount} 个任务，+${totalGrowth}成长值`);
                message += `✅ VIP任务×${missionCount} (+${totalGrowth})\n`;
            } else {
                console.log('   ℹ️ 暂无可领取的VIP日常任务');
            }
        } else {
            console.log(`   ℹ️ VIP任务列表返回 code=${missions.code}${missions.msg ? '：' + missions.msg : ''}`);
        }
    } catch (e) {
        console.log(`   ⚠️ VIP任务执行异常: ${e.message}`);
    }

    // 6. VIP 成长值及批量奖励
    console.log('\n📊 VIP成长值...');
    const vipGrowth = await getVipGrowth();
    if (vipGrowth.code === 200 && vipGrowth.data) {
        const data = vipGrowth.data.userLevel || vipGrowth.data;
        console.log(`   等级：${data.levelName || 'Lv.' + (data.level ?? 0)}`);
        console.log(`   成长值：${data.growthPoint ?? 0}`);
        message += `\n💎 VIP等级：${data.levelName || 'Lv.' + (data.level ?? 0)}\n`;
        message += `📊 成长值：${data.growthPoint ?? 0}\n`;
    } else {
        console.log(`   ⚠️ 成长值接口返回异常 (code=${vipGrowth.code}${vipGrowth.msg ? ', ' + vipGrowth.msg : ''})`);
    }

    const reward = await receiveAllVipReward();
    if (reward.code === 200 && reward.data?.result) {
        console.log('   ✅ VIP任务奖励一键领取成功！');
        message += '✅ VIP任务奖励已领取\n';
    } else if (reward.code === 200) {
        console.log('   ℹ️ 暂无新增可领取的VIP奖励');
    } else {
        console.log(`   ⚠️ VIP一键领取接口异常 (code=${reward.code}${reward.msg ? ', ' + reward.msg : ''})`);
    }

    // 7. 每日任务自动化（实验性，默认关闭；由 NCM_TASKS 开启）
    if (TASK_SWITCH.length > 0) {
        try {
            message += await runDailyTasks(userId);
        } catch (e) {
            console.log(`   ⚠️ 每日任务执行异常：${e.message}`);
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('🎉 签到流程执行完成！');
    message += '\n🎉 签到完成！';

    await safeNotify('🎵 网易云音乐签到', message);
}

async function safeNotify(title, content) {
    try {
        await notify.sendNotify(title, content);
    } catch (e) {
        console.log(`📢 ${title}\n${content}`);
        console.log(`⚠️ 通知推送失败: ${e.message}`);
    }
}

main().catch(async (error) => {
    console.log(`\n❌ 运行错误：${error.stack || error.message}`);
    await safeNotify('🎵 网易云音乐签到', `❌ 签到出错：${error.message}`);
    process.exit(1);
});
