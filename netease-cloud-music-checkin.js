/**
 * 网易云音乐自动签到脚本（完善版）
 * 
 * @description 支持青龙面板的全自动签到脚本（云贝 + 黑胶乐签 + VIP 成长任务，先查后签）
 * @version 1.6.2
 * @license MIT
 * 
 * @changelog v1.6.2（找到分享任务的正确接口）
 *  - 新增分享触发上报作为**主通道**：POST interface3 /xeapi/music/song/share/trigger
 *    { songId, channel }（依据 ncmctl api/eapi/daily_song_share.go:640），
 *    依次尝试 channel = cloudmusic / wechat / qq；失败才回退原来的分享到动态接口
 *  - 原来的 /api/share/friends/resource 与 /api/note/share/friends/resource 实测均返回
 *    code=250，降级为备用通道
 * 
 * @changelog v1.6.1（依据 ProxyPin 抓包实测）
 *  - openH5Page 补全为真实 App webview 请求特征：
 *    · UA 换成实测的 Android webview UA（PLC110 / Android 16 / Chrome 138 /
 *      CloudMusic 0.1.2 NeteaseMusic 9.3.0）
 *    · 新增 X-Requested-With: com.netease.cloudmusic、Accept-Language、Sec-Fetch-* 等头
 *    · Cookie 补全 NMTID / brand / osver / versioncode / sDeviceId / mobilename /
 *      resolution / packageType 等字段（实测 App 请求携带）
 *  - 中台页面上报统一使用同一个 webview UA（原来使用 iPhone UA，现改为本机实测的 Android UA）
 * 
 * @changelog v1.6.0
 *  - 新增「自动取消红心」：为完成任务而点的红心会被记录到状态文件，
 *    待服务端把该任务标记为完成后的下一次运行自动取消（只取消脚本自己点的，
 *    不会动你手动收藏的歌曲）；任务未完成时不会取消
 *  - 查看/分享类任务上报前先 GET 打开其 H5 跳转页（带 Cookie + webview UA），
 *    更贴近真实流程（打开页面 → 停留 → 页面上报）
 *  - missionDTO / schemaContent 全文输出改为由 NCM_TASKS_DEBUG=1 控制，默认不再刷屏
 *  - 云贝收支记录的合计文案修正（接口不受 limit 限制，会返回全部记录）
 * 
 * @changelog v1.5.3（依据 2026-09-26 真机日志修正）
 *  - 【关键】页面浏览上报参数修正：实测网易云用的是带前缀的参数名——
 *    jumpUrl 里的 view_task_id / view_task_business / view_time 才对应上报的
 *    taskId / taskBusiness / viewTime；actionType 取自任务的 actionType 字段
 *    （如 vip_growth_view_activity_page）。原来硬编码 actionType='view' 且不认这些
 *    前缀名，导致上报虽返回 200 但不被计入任务完成
 *  - 浏览上报的目标任务扩展为 查看|浏览|体验|逛逛|分享（分享类任务的 H5 同样带 view_task_*）
 *  - 云贝余额改回权威接口 /weapi/v1/user/info 的 data.userPoint.balance（ncmctl YunBeiUserInfo），
 *    middle/mall/balance 降为备用并逐个打印返回，便于对照
 *  - 云贝收支记录字段修正为 pointCost（原来找 point 导致显示 +?），并输出合计
 * 
 * @changelog v1.5.2（追加诊断输出，用于定位剩余三个未解决问题）
 *  - 新增云贝收支记录查询（/store/api/point/receipt），核对任务奖励是否真的到账
 *    （实测余额显示 0，与"领取成功 +700云贝"矛盾，需要流水佐证）
 *  - 查看类任务上报时输出 missionDTO 与 schemaContent 的**完整内容**（原来截断 300 字符），
 *    以便从真实数据里找到 taskBusiness / pageCode / actionType 的正确取值
 *  - 云贝任务列表补充 link 与 extInfoMap 输出（定位"分享歌曲"任务该走哪个页面）
 * 
 * @changelog v1.5.1（首次真机实测后修正，含任务模块）
 *  【云贝链路】
 *  - 云贝签到判定修正：/pointmall/user/sign 返回 data.sign=true 才是签到成功，
 *    false 表示重复签到（原代码把两者都当成成功，日志会误报"签到成功"）
 *  - "今日是否已签到"改用 /point/today/get 的 data.shells（今天已获得的云贝数），
 *    原来的 isSign/signed/status 字段在该接口里根本不存在，导致每次都重复请求签到
 *  - 云贝余额改用官方接口 middle/mall/balance（interface.music.163.com），
 *    原 /v1/user/info 与 /pointmall/user/info 均已 404
 *  - 连签进度改用 /pointmall/user/sign/config（原 /sign/progress 已 404）
 *  - 连签奖励领取改用 /pointmall/user/sign/lottery/get（interface.music.163.com），
 *    且判定条件修正为 baseLotteryId > 0（原用 baseLotteryStatus === 1 判断，
 *    而该字段 1 的含义是"已领取"，条件正好相反，导致奖励永远领不到）
 *  【任务模块】
 *  - 红心改用 weapi 的 radio/like 为主通道（实测 eapi song/like 不带易盾 token 会返回
 *    524 当前环境异常），失败再回退 eapi + 易盾 token v3
 *  - 会员任务"已完成"判定修正为 missionStatus === 100（实测口径，50 = 未完成），
 *    原按 2/3 判断导致复查始终显示 0
 *  - 任务列表日志改为中文状态 + taskId + 成长值，便于人工核对
 *  - 分享改为多通道尝试（xeapi → eapi note 路径），并对其 H5 跳转页补一次页面浏览上报
 *  - 分享任务的跳转页上报可完成"分享单曲到站外"这类 H5 型任务
 *  - 会员福利领取：实测 claim 端点返回 404（两个参考项目里仅有此路径且无实测记录），
 *    改为双 host 尝试 + 404 安静跳过，不再逐条刷告警
 *  - 移除无用的"会员任务结构（诊断）"输出（view 小节已输出完整任务列表与状态）
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

// 任务模块调试输出（完整 missionDTO / schemaContent）：NCM_TASKS_DEBUG=1
const TASKS_DEBUG = process.env.NCM_TASKS_DEBUG === '1';

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

// 云贝连签进度与阶段奖励
// 官方路径是 pointmall/user/sign/config（旧的 /progress 已 404）；
// lotteryConfig[].baseLotteryId > 0 才表示"可领取"，baseLotteryStatus=1 表示已领取
async function yunbeiSignProgress() {
    return await withRetry(() => weapiRequest('/weapi/pointmall/user/sign/config', {}), '连签进度');
}

// 连签阶段奖励领取（interface.music.163.com；data=true 领取成功、false 表示已领过）
async function yunbeiSignLottery(userLotteryId) {
    return await withRetry(
        () => weapiRequest('/weapi/pointmall/user/sign/lottery/get', {
            userLotteryId: String(userLotteryId),
        }, { hostname: 'interface.music.163.com' }),
        '连签奖励领取'
    );
}

async function yunbeiTaskTodo() {
    return await withRetry(() => weapiRequest('/weapi/usertool/task/todo/query', {}), '云贝任务列表');
}

// 云贝收支记录（核对任务奖励是否真的到账；路径为 /store/api/point/receipt）
async function getYunbeiReceipt(limit = 5) {
    return await withRetry(
        () => weapiRequest('/store/api/point/receipt', { limit, offset: 0 }),
        '云贝收支记录'
    );
}

async function yunbeiTaskFinish(task) {
    const data = {
        userTaskId: String(task.userTaskId || task.taskId || ''),
        depositCode: task.depositCode ? String(task.depositCode) : '0',
    };
    if (task.period !== undefined) data.period = String(task.period);
    return await withRetry(() => weapiRequest('/weapi/usertool/task/point/receive', data), '云贝任务领取');
}

// 云贝余额
// 权威来源（ncmctl YunBeiUserInfo）：music.163.com/weapi/v1/user/info → data.userPoint.balance
// 备用：interface.music.163.com/weapi/middle/mall/balance → data.balance
// （实测备用接口的池子可能为 0，与收支记录里的 +1100 矛盾，故降为备用）
async function getYunbeiInfo() {
    const attempts = [
        ['/weapi/v1/user/info', {}],
        ['/weapi/middle/mall/balance', { hostname: 'interface.music.163.com' }],
    ];
    let last = { code: -1, message: '未尝试' };
    for (const [path, extra] of attempts) {
        const r = await withRetry(() => weapiRequest(path, {}, extra), `云贝余额(${path})`);
        if (r.code === 200 && parseYunbeiBalance(r) !== null) return r;
        console.log(`   ℹ️ 余额接口 ${path} 返回 code=${r.code}${r.data ? ' data=' + JSON.stringify(r.data).slice(0, 120) : ''}`);
        last = r;
    }
    return last;
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

// 解析云贝余额（middle/mall/balance 的 data.balance = 可用数量）
function parseYunbeiBalance(info) {
    if (!info || info.code !== 200) return null;
    const candidates = [
        info.data?.balance,
        info.data?.userPoint,
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

// 红心 / 取消红心
// 首选 weapi 的 radio/like（经典接口，不需要易盾 token）；
// 失败时回退 eapi song/like 并携带易盾 token v3（实测不带 token 会返回 524 环境异常）
async function likeSong(trackId, like = true) {
    const label = like ? '红心' : '取消红心';
    const weapiRes = await withRetry(
        () => weapiRequest('/weapi/radio/like', {
            alg: 'itembased',
            trackId: String(trackId),
            like,
            time: '3',
        }),
        `${label}(weapi)`
    );
    if (weapiRes.code === 200) return weapiRes;

    console.log(`      ℹ️ weapi 通道 code=${weapiRes.code}${weapiRes.msg ? ' ' + weapiRes.msg : ''}，改用 eapi + 易盾 token`);
    const token = await fetchAntiCheatTokenV3();
    return await withRetry(
        () => eapiRequest('/api/song/like', {
            trackId: String(trackId),
            like: like ? 'true' : 'false',
            time: '3',
            checkToken: token || '',
        }, { hostname: 'interface3.music.163.com' }),
        `${label}(eapi)`
    );
}

// 会员任务状态表：{ 任务名: missionStatus }（100 = 已完成）
async function getVipMissionStatusMap(userId) {
    const res = await vipMissionProgressWeapi(userId);
    const list = Array.isArray(res?.data) ? res.data : [];
    const map = {};
    for (const m of list) {
        const name = m?.basicMissionDTO?.name;
        if (name) map[name] = Number(m.missionStatus);
    }
    return { map, list, code: res.code };
}

// App 内 webview 的真实 UA（2026-09-26 ProxyPin 抓包实测）
const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 16; PLC110 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.179 Mobile Safari/537.36 CloudMusic/0.1.2 NeteaseMusic/9.3.0';

// 打开 H5 页面（模拟 App 内 webview 访问）
// 抓包实测的必要条件：webview UA + X-Requested-With: com.netease.cloudmusic + 完整 Cookie
async function openH5Page(url) {
    if (!url || typeof url !== 'string') return { status: -1, message: '无链接' };
    let u;
    try {
        u = new URL(url);
    } catch (e) {
        return { status: -1, message: '链接非法' };
    }
    if (u.protocol !== 'https:') return { status: -1, message: `跳过非 https 链接 (${u.protocol})` };
    return await rawRequest({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
            'Cookie': buildCookie({
                os: 'android',
                osver: '16',
                appver: '9.3.0',
                versioncode: '9003000',
                brand: 'OnePlus',
                channel: 'netease',
                packageType: 'release',
                mobilename: 'PLC110',
                resolution: '2659x1272',
                buildver: String(Date.now()).substr(0, 10),
                sDeviceId: deviceId,
                NMTID: '00O' + crypto.randomBytes(19).toString('hex'),
            }),
            'User-Agent': WEBVIEW_UA,
            'X-Requested-With': 'com.netease.cloudmusic',
            'Referer': 'https://music.163.com/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
        },
        timeout: 15000,
    });
}

// 分享触发上报（分享类任务的真正完成口径）
// 依据 ncmctl api/eapi/daily_song_share.go:640
//   POST interface3 /xeapi/music/song/share/trigger  { songId, channel }
//   channel 默认 "cloudmusic"，其他渠道如 wechat / qq / weibo
async function shareTrigger(songId, channel = 'cloudmusic') {
    return await withRetryStrict(
        () => xeapiRequest('/api/music/song/share/trigger', {
            songId: String(songId),
            channel,
        }, { checkToken: true }),
        `分享触发(${channel})`
    );
}

// 分享单曲（备用通道：xeapi → eapi note 路径；实测单通道可能返回 250）
async function shareSong(songId) {
    const channels = [
        ['xeapi /api/share/friends/resource', () => xeapiRequest('/api/share/friends/resource', {
            type: 'song', msg: '', id: String(songId),
        }, { checkToken: true })],
        ['eapi /api/note/share/friends/resource', async () => {
            const token = await fetchAntiCheatTokenV3();
            return await eapiRequest('/api/note/share/friends/resource', {
                type: 'song', msg: '', id: String(songId), checkToken: token || '',
            }, { hostname: 'interface3.music.163.com' });
        }],
    ];
    let last = { code: -1, msg: '未尝试' };
    for (const [label, fn] of channels) {
        try {
            const r = await withRetryStrict(fn, `分享(${label})`);
            if (r.code === 200) return { ...r, channel: label };
            last = r;
            console.log(`      ℹ️ ${label} 返回 code=${r.code}${r.msg ? ' ' + r.msg : ''}`);
        } catch (e) {
            console.log(`      ℹ️ ${label} 异常：${e.message}`);
        }
    }
    return last;
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
// 实测（2026-09-26）网易云用的是带前缀的名字：
//   ?nm_style=sbt&view_task_id=16212254&view_task_business=music.vip_growth&view_time=15
function parseJumpUrlParams(jumpUrl) {
    const out = {};
    if (!jumpUrl || typeof jumpUrl !== 'string') return out;
    const q = jumpUrl.indexOf('?');
    if (q < 0) return out;
    try {
        const sp = new URLSearchParams(jumpUrl.slice(q + 1));
        const map = {
            taskId: ['view_task_id', 'taskId'],
            taskType: ['view_task_type', 'taskType'],
            taskBusiness: ['view_task_business', 'taskBusiness'],
            resourceType: ['view_resource_type', 'resourceType'],
            pageCode: ['view_page_code', 'pageCode'],
            activityPlatformId: ['activityPlatformId'],
        };
        for (const [key, names] of Object.entries(map)) {
            for (const n of names) {
                const v = sp.get(n);
                if (v) { out[key] = v; break; }
            }
        }
        const vt = sp.get('view_time') || sp.get('viewTime');
        if (vt) out.viewTimeSec = Number(vt);
    } catch (e) { /* 忽略解析失败 */ }
    return out;
}

// 中台页面浏览上报（模拟 App 内 webview；UA 用抓包实测的 Android webview UA）
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
            ua: WEBVIEW_UA,
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

// 领取尊享福利（实测 music.163.com 会 404，补一个 interface3 兜底；仍失败则视为端点失效）
async function vipWelfareClaim(welfareId) {
    let last = { code: -1, msg: '未尝试' };
    for (const hostname of ['music.163.com', 'interface3.music.163.com']) {
        const r = await withRetry(
            () => weapiRequest('/weapi/vipnewcenter/app/level/welfare/claim', { welfareId: Number(welfareId) }, { hostname }),
            `福利领取(${hostname})`
        );
        if (r.code === 200) return r;
        last = r;
    }
    return last;
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
    // 为了完成任务而点的红心，会在任务被服务端标记为完成后自动取消（只取消脚本自己点的）
    if (taskEnabled('like')) {
        console.log('   ❤️ 红心歌曲...');
        const pending = Array.isArray(state.pendingUnlike) ? state.pendingUnlike : [];

        // 查询会员任务状态，判断"红心N首会员单曲"是否已完成
        let likeTaskDone = false;
        let likeTaskName = '';
        try {
            const st = await getVipMissionStatusMap(userId);
            for (const [name, status] of Object.entries(st.map)) {
                if (/红心/.test(name)) {
                    likeTaskName = name;
                    likeTaskDone = status === 100;
                    break;
                }
            }
            if (likeTaskName) {
                console.log(`      ℹ️ 任务「${likeTaskName}」状态：${likeTaskDone ? '已完成' : '未完成'}`);
            } else {
                console.log(`      ℹ️ 未找到红心类任务（code=${st.code}），按未完成处理`);
            }
        } catch (e) {
            console.log(`      ⚠️ 查询任务状态失败：${e.message}`);
        }

        // 1a) 任务已完成 → 取消之前为完成任务而点的红心
        if (likeTaskDone && pending.length) {
            console.log(`      🔄 任务已完成，取消上次为完成任务点的 ${pending.length} 首红心`);
            let undone = 0;
            for (const item of pending) {
                const r = await likeSong(item.id, false);
                if (r.code === 200) {
                    undone++;
                    console.log(`      ↩️ 已取消红心：${item.name || item.id}`);
                } else {
                    console.log(`      ⚠️ 取消红心失败 ${item.name || item.id} code=${r.code}${r.msg ? '：' + r.msg : ''}`);
                }
            }
            state.pendingUnlike = [];
            saveState();
            if (undone) summary.push(`↩️ 取消红心×${undone}`);
        } else if (!likeTaskDone && pending.length) {
            console.log(`      ℹ️ 任务尚未标记完成，暂不取消（共 ${pending.length} 首待取消）`);
        }

        // 1b) 任务未完成 → 点红心
        if (likeTaskDone) {
            console.log('      ℹ️ 红心任务今日已完成，跳过点赞');
        } else if (!picked.length) {
            console.log('      ⚠️ 没有可用歌曲（每日推荐为空），跳过');
        } else {
            let ok = 0;
            let likedPlaylistId = '';
            const newlyLiked = [];
            for (const s of picked) {
                const r = await likeSong(s.id, true);
                if (r.code === 200) {
                    ok++;
                    if (r.playlistId) likedPlaylistId = r.playlistId;
                    newlyLiked.push({ id: s.id, name: s.name });
                    console.log(`      ✅ ${s.name}${s.fee === 1 ? ' (VIP)' : ''}`);
                } else {
                    console.log(`      ⚠️ ${s.name} 失败 code=${r.code}${r.msg ? '：' + r.msg : ''}`);
                }
            }
            if (likedPlaylistId) {
                console.log(`      ℹ️ 我喜欢的音乐 playlistId=${likedPlaylistId}`);
            }
            if (newlyLiked.length) {
                // 记录下来，等任务被标记完成后自动取消
                state.pendingUnlike = newlyLiked;
                saveState();
                console.log(`      ℹ️ 已记录 ${newlyLiked.length} 首待取消（任务完成后会自动取消红心）`);
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
            let shared = false;
            // 主通道：分享触发上报（官方"分享完成"口径）
            for (const channel of ['cloudmusic', 'wechat', 'qq']) {
                try {
                    const r = await shareTrigger(picked[0].id, channel);
                    if (r.code === 200) {
                        shared = true;
                        console.log(`      ✅ 分享触发成功 channel=${channel} data=${JSON.stringify(r.data ?? null)}`);
                        break;
                    }
                    console.log(`      ℹ️ 分享触发 channel=${channel} 返回 code=${r.code}${r.msg ? '：' + r.msg : ''}`);
                } catch (e) {
                    console.log(`      ℹ️ 分享触发 channel=${channel} 异常：${e.message}`);
                }
            }
            // 备用通道：分享到动态
            if (!shared) {
                try {
                    const r = await shareSong(picked[0].id);
                    console.log(`      ${r.code === 200 ? '✅' : '⚠️'} 分享(备用) [${picked[0].name}] code=${r.code}${r.msg ? '：' + r.msg : ''}${r.channel ? ` (${r.channel})` : ''}`);
                    if (r.code === 200) shared = true;
                } catch (e) {
                    console.log(`      ⚠️ 分享(备用)失败：${e.message}`);
                }
            }
            if (shared) summary.push('🔗 分享×1');
            // 「分享单曲到站外」的跳转页是 H5（/st/vipsharesong），补一次页面浏览上报
            try {
                const res = await vipMissionProgressWeapi(userId);
                const list = Array.isArray(res?.data) ? res.data : [];
                const task = list.find((m) => /分享/.test(m.basicMissionDTO?.name || '') && Number(m.missionStatus) !== 100);
                if (task) {
                    const schema = parseSchemaContent(task.basicMissionDTO?.schemaContent);
                    const jumpUrl = schema.jumpUrl || schema['jumpUrl '] || '';
                    const fromUrl = parseJumpUrlParams(jumpUrl);
                    const rep = await middlePageViewReport({
                        actionType: 'view',
                        taskId: fromUrl.taskId || task.basicMissionDTO?.missionId || '',
                        taskType: fromUrl.taskType || task.basicMissionDTO?.missionType || 0,
                        viewTime: 20000,
                        jumpUrl,
                        taskBusiness: fromUrl.taskBusiness || '',
                        resourceType: fromUrl.resourceType || '',
                        pageCode: fromUrl.pageCode || '',
                    });
                    console.log(`      ${rep.code === 200 ? '✅' : '⚠️'} [${task.basicMissionDTO.name}] 分享页上报 code=${rep.code} data=${JSON.stringify(rep.data ?? null)}`);
                }
            } catch (e) {
                console.log(`      ℹ️ 分享任务页面上报跳过：${e.message}`);
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
                    if (t.link) console.log(`           link=${t.link}`);
                    if (t.extInfoMap) console.log(`           extInfoMap=${JSON.stringify(t.extInfoMap)}`);
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

        // 会员侧任务结构的完整输出由 view 开关负责（见下方 5) 小节）
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
                let unavailable = 0;
                for (const it of items) {
                    const paid = Number(it.specialPrice || 0) > 0;
                    const received = Number(it.userReceiveStatus) === 1;
                    console.log(`         · [Lv.${it.level ?? '-'}] ${it.showName ?? it.id} id=${it.id} 状态=${it.status ?? '-'} 已领=${received}${paid ? ' 付费' : ''}`);
                    if (paid) continue;
                    if (received) continue;
                    const r = await vipWelfareClaim(it.id);
                    if (r.code === 200) {
                        claimed++;
                        console.log(`         ✅ 领取成功：${it.showName ?? it.id}`);
                    } else if (r.code === 404) {
                        // 该端点已失效（两个项目里仅有此路径且无实测记录），安静跳过
                        unavailable++;
                    } else {
                        console.log(`         ⚠️ 领取失败 code=${r.code}${r.msg ? '：' + r.msg : ''}`);
                    }
                }
                if (unavailable > 0 && claimed === 0) {
                    console.log(`      ℹ️ 有 ${unavailable} 项待领取，但领取端点返回 404（接口已失效），已跳过`);
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
                let completedCount = 0;
                for (const m of missions) {
                    const dto = m.basicMissionDTO || {};
                    const schema = parseSchemaContent(dto.schemaContent);
                    const jumpUrl = schema.jumpUrl || schema['jumpUrl '] || '';
                    const name = dto.name || '';
                    const status = Number(m.missionStatus);
                    // 实测口径：100 = 已完成，50 = 未完成
                    const doneText = status === 100 ? '已完成' : status === 50 ? '未完成' : `状态${status}`;
                    if (status === 100) completedCount++;
                    console.log(`         · [${doneText}] ${name} missionCode=${dto.missionCode ?? '-'} taskId=${dto.missionId ?? '-'} 成长值+${dto.alue ?? '-'}`);
                    if (status === 100) continue;
                    // 查看/浏览类 → 页面浏览上报；分享类也一并上报（其 H5 同样带 view_task_* 参数）
                    if (/查看|浏览|体验|逛逛|分享/.test(name)) targets.push({ name, dto, schema, jumpUrl });
                }
                console.log(`      ℹ️ 会员任务：已完成 ${completedCount}/${missions.length} 项`);
                if (!targets.length) {
                    console.log('      ℹ️ 没有匹配到查看类任务（名称需含 查看/浏览/体验/逛逛）');
                }
                for (const t of targets) {
                    const fromUrl = parseJumpUrlParams(t.jumpUrl);
                    const fields = {
                        // 实测：动作类型来自任务的 actionType 字段（如 vip_growth_view_activity_page）
                        actionType: t.dto.actionType || 'vip_growth_view_activity_page',
                        taskId: fromUrl.taskId || t.dto.missionId || '',
                        taskType: fromUrl.taskType || t.dto.missionType || 0,
                        // view_time=15 是秒，上报字段按毫秒传
                        viewTime: fromUrl.viewTimeSec ? fromUrl.viewTimeSec * 1000 : 15000,
                        jumpUrl: t.jumpUrl,
                        taskBusiness: fromUrl.taskBusiness || '',
                        resourceType: fromUrl.resourceType || '',
                        pageCode: fromUrl.pageCode || '',
                        activityPlatformId: fromUrl.activityPlatformId,
                    };
                    console.log(`      ℹ️ [${t.name}] 上报参数：${JSON.stringify({ ...fields, jumpUrl: fields.jumpUrl ? '(略)' : '' })}`);
                    console.log(`      ℹ️ [${t.name}] actionType=${t.dto.actionType ?? '-'} missionEntityId=${t.dto.missionEntityId ?? '-'}`);
                    if (TASKS_DEBUG) {
                        console.log(`      ℹ️ [${t.name}] missionDTO 全文：${JSON.stringify(t.dto)}`);
                        console.log(`      ℹ️ [${t.name}] schemaContent 全文：${JSON.stringify(t.schema)}`);
                    }
                    // 真实流程是「打开 H5 页面 → 停留 view_time 秒 → 页面自己上报」，
                    // 所以这里先 GET 打开页面，再发上报
                    if (fields.jumpUrl) {
                        const page = await openH5Page(fields.jumpUrl);
                        const bodyLen = page?.data ? page.data.length : 0;
                        console.log(`      ℹ️ [${t.name}] 打开跳转页 HTTP ${page?.status ?? '-'}（${bodyLen} 字节）${page?.message ? ' ' + page.message : ''}`);
                    }
                    try {
                        const r = await middlePageViewReport(fields);
                        console.log(`      ${r.code === 200 ? '✅' : '⚠️'} [${t.name}] 上报 code=${r.code} data=${JSON.stringify(r.data ?? null)}${r.msg ? ' msg=' + r.msg : ''}`);
                    } catch (e) {
                        console.log(`      ⚠️ [${t.name}] 上报失败：${e.message}`);
                    }
                }
                // 复查（实测口径：missionStatus 100 = 已完成）
                const after = await vipMissionProgressWeapi(userId);
                const afterList = Array.isArray(after?.data) ? after.data : [];
                const doneCount = afterList.filter((m) => Number(m.missionStatus) === 100).length;
                console.log(`      ℹ️ 复查：会员任务已完成 ${doneCount}/${afterList.length} 项`);
                if (doneCount > completedCount) {
                    console.log(`      ✅ 较上报前新增完成 ${doneCount - completedCount} 项`);
                    summary.push(`👀 查看任务+${doneCount - completedCount}`);
                }
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
    console.log('🎵 网易云音乐自动签到 (v1.6.2)');
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
    // 官方语义（ncmctl api/weapi/yunbei.go）：
    //   /weapi/point/today/get     → data.shells = 今天签到已获得的云贝数
    //   /weapi/pointmall/user/sign → data.sign = true 签到成功 / false 重复签到
    console.log('\n☁️ 云贝签到...');
    try {
        const checkRes = await yunbeiCheckToday();
        const shells = Number(checkRes?.data?.shells ?? 0);
        let yunbeiSigned = shells > 0;
        if (!yunbeiSigned && checkRes.code === 200 && checkRes.data && typeof checkRes.data === 'object') {
            const d = checkRes.data;
            if (d.isSign === true || d.sign === true || d.signed === true) yunbeiSigned = true;
        }

        if (yunbeiSigned) {
            console.log(`   ℹ️ 云贝今日已签到（今日已得 ${shells} 云贝）`);
            message += '☁️ 云贝：今日已签到\n';
        } else {
            const yunbei = await yunbeiSign();
            const msg = yunbei.msg || yunbei.message || '';
            const d = yunbei.data;

            if (yunbei.code === 200 && d && typeof d === 'object' && 'sign' in d) {
                // 官方口径：sign=true 签到成功，false 重复签到
                const got = Number(d.yunbeiNum ?? d.point ?? 0);
                if (d.sign === true) {
                    console.log(`   ✅ 云贝签到成功！${got > 0 ? `获得 ${got} 云贝` : ''}`);
                    message += `✅ 云贝签到成功${got > 0 ? ` (+${got}云贝)` : ''}\n`;
                } else {
                    console.log(`   ℹ️ 云贝今日已签到（重复签到）`);
                    message += '☁️ 云贝：今日已签到\n';
                }
            } else {
                const alreadySigned = yunbei.code === -2 || isAlreadySignedMsg(msg) ||
                    d === false ||
                    (yunbei.code === 200 && (d?.code === -2 || isAlreadySignedMsg(d?.msg)));
                if (alreadySigned) {
                    console.log('   ℹ️ 云贝今日已签到');
                    message += '☁️ 云贝：今日已签到\n';
                } else if (yunbei.code === 200) {
                    console.log(`   ✅ 云贝签到成功${d ? `（${JSON.stringify(d).substring(0, 80)}）` : ''}`);
                    message += '✅ 云贝签到成功\n';
                } else {
                    console.log(`   ⚠️ 云贝签到反馈：${msg || `接口返回异常 (code=${yunbei.code})`}`);
                }
            }
        }
    } catch (e) {
        console.log(`   ⚠️ 云贝签到执行异常: ${e.message}`);
    }

    // 3.1 云贝连签阶段奖励（baseLotteryId > 0 才表示可领取）
    console.log('\n📅 云贝连签进度奖励...');
    try {
        const progress = await yunbeiSignProgress();
        const configs = progress?.data?.lotteryConfig;
        if (progress.code === 200 && Array.isArray(configs) && configs.length) {
            let rewardCount = 0;
            for (const config of configs) {
                const dayText = config.signDay ? `连续签到 ${config.signDay} 天` : '连签';
                const grantName = config.baseGrant?.name || '';
                const jobs = [
                    ['阶段奖励', Number(config.baseLotteryId || 0)],
                    ['额外抽奖', Number(config.extraLotteryId || 0)],
                ];
                for (const [kind, id] of jobs) {
                    if (!id) continue;
                    const lottery = await yunbeiSignLottery(id);
                    if (lottery.code === 200) {
                        if (lottery.data === true) {
                            rewardCount++;
                            console.log(`   ✅ ${dayText}${grantName ? `「${grantName}」` : ''} ${kind}领取成功`);
                        } else {
                            console.log(`   ℹ️ ${dayText}${grantName ? `「${grantName}」` : ''} ${kind}已领取过`);
                        }
                    } else {
                        console.log(`   ⚠️ ${dayText} ${kind}领取失败 code=${lottery.code}${lottery.msg ? ', ' + lottery.msg : ''}`);
                    }
                }
            }
            if (rewardCount > 0) message += `✅ 云贝连签奖励×${rewardCount}\n`;
            else console.log('   ℹ️ 暂无连签阶段奖励可领');
        } else {
            console.log(`   ℹ️ 连签进度接口返回 code=${progress.code}${progress.msg ? '：' + progress.msg : '（无 lotteryConfig）'}`);
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

    // 3.4 云贝收支记录（核对任务奖励是否真的到账）
    try {
        const rec = await getYunbeiReceipt(5);
        const list = Array.isArray(rec?.data) ? rec.data
            : Array.isArray(rec?.data?.list) ? rec.data.list
            : Array.isArray(rec?.data?.records) ? rec.data.records : [];
        if (list.length) {
            console.log('   📜 最近云贝收支：');
            for (const r of list.slice(0, 5)) {
                // 实测字段名是 pointCost（不是 point）
                const point = r.pointCost ?? r.point ?? r.pointAdd ?? r.pointNum ?? r.amount ?? '?';
                const desc = [r.fixed, r.variable].filter(Boolean).join('') || r.typeName || r.description || '';
                const time = r.date || r.time || r.createTime || '';
                console.log(`      · +${point} ${desc} ${time}`);
            }
            const total = list.reduce((sum, r) => sum + Number(r.pointCost ?? r.point ?? 0), 0);
            if (total > 0) console.log(`      ℹ️ 接口共返回 ${list.length} 条，合计 +${total} 云贝`);
        } else if (rec.code === 200) {
            console.log('   ℹ️ 云贝收支记录为空');
        } else {
            console.log(`   ℹ️ 云贝收支记录返回 code=${rec.code}${rec.msg ? '：' + rec.msg : ''}`);
        }
    } catch (e) {
        console.log(`   ⚠️ 云贝收支记录异常: ${e.message}`);
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
