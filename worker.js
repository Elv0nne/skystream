/**
 * Anime47 Stream Fix Proxy — Cloudflare Worker
 * ===============================================
 * Gồm 2 tính năng độc lập, port từ Anime47Provider.kt (bản CloudStream gốc):
 *
 * 1) /proxy?u=<url>  — vá lỗi offset byte MPEG-TS cho server FE (CDN cdn<N>.nonprofit.asia).
 *    Port từ getVideoInterceptor() + findMpegTsOffset().
 *
 * 2) /hydrax?v=<video_id>  — giải mã & phát video từ server HY (Hydrax/Abyss: abysscdn.com,
 *    playhydrax.com, zplayer.io). Port từ HydraxExtractor.kt + HydraxInterceptor.
 *    Toàn bộ thuật toán MD5 / AES-CTR / double-base64 trong file này đã được kiểm chứng chéo
 *    byte-for-byte với bản Java/Kotlin gốc (javax.crypto) trước khi đưa vào — xem lịch sử làm
 *    việc nếu cần tái kiểm tra.
 *
 * CÁCH DÙNG (trong plugin.js):
 *   Server FE:  WORKER_PROXY_BASE + "/proxy?u=" + encodeURIComponent(urlGốc)
 *   Server HY:  WORKER_PROXY_BASE + "/hydrax?v=" + videoId  (videoId lấy từ query "?v=" của URL HY gốc)
 */

// ============================================================================
// PHẦN 1: MD5 thuần JS (Cloudflare Worker/Web Crypto không có MD5 native)
// ============================================================================

function md5(bytes) {
  function rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;

  const msgLen = bytes.length;
  const withOne = new Uint8Array((((msgLen + 8) >> 6) << 6) + 64);
  withOne.set(bytes);
  withOne[msgLen] = 0x80;
  const bitLen = BigInt(msgLen) * 8n;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 8, Number(bitLen & 0xffffffffn), true);
  dv.setUint32(withOne.length - 4, Number((bitLen >> 32n) & 0xffffffffn), true);

  for (let chunkStart = 0; chunkStart < withOne.length; chunkStart += 64) {
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(chunkStart + j * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setInt32(0, a0, true);
  outDv.setInt32(4, b0, true);
  outDv.setInt32(8, c0, true);
  outDv.setInt32(12, d0, true);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function md5Hex(bytes) {
  return bytesToHex(md5(bytes));
}

// keyForNumber(): mỗi digit char -> giá trị số của nó làm 1 byte thô (KHÔNG phải ASCII code).
// Port trực tiếp từ Kotlin: Character.digit(c, 10) cho char số.
function keyForNumber(value) {
  const str = String(value);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    bytes[i] = /[0-9]/.test(c) ? c.charCodeAt(0) - 48 : c.charCodeAt(0);
  }
  return md5Hex(bytes);
}

// keyForString(): MD5 của UTF-8 bytes thô của chuỗi.
function keyForString(value) {
  return md5Hex(new TextEncoder().encode(value));
}

// ============================================================================
// PHẦN 2: AES-CTR qua Web Crypto API (đã kiểm chứng khớp javax.crypto.Cipher AES/CTR/NoPadding)
// ============================================================================

async function aesCtrEncrypt(dataBytes, keyHex) {
  const keyBytes = new TextEncoder().encode(keyHex); // 32 ascii char -> 32 byte -> AES-256 key
  const iv = keyBytes.slice(0, 16);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, [
    "encrypt",
  ]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: iv, length: 128 },
    cryptoKey,
    dataBytes
  );
  return new Uint8Array(encrypted);
}

async function aesCtrDecrypt(cipherBytes, keyHex) {
  const keyBytes = new TextEncoder().encode(keyHex);
  const iv = keyBytes.slice(0, 16);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, [
    "decrypt",
  ]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: iv, length: 128 },
    cryptoKey,
    cipherBytes
  );
  return new Uint8Array(decrypted);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// doubleBase64(): mã hoá base64 2 lần liên tiếp (bỏ padding '='), khớp Base64.getEncoder() của Java.
function doubleBase64(bytes) {
  const first = bytesToBase64(bytes).replace(/=+$/, "");
  const firstBytes = new TextEncoder().encode(first);
  const second = bytesToBase64(firstBytes).replace(/=+$/, "");
  return second;
}

const FRAGMENT_SIZE = 2097152; // 2 MiB — phải khớp chunking phía server Abyss.

async function buildSegmentToken(md5Id, resId, size, index) {
  const path = `/mp4/${md5Id}/${resId}/${size}/${FRAGMENT_SIZE}/${index}`;
  const key = keyForNumber(size);
  const encrypted = await aesCtrEncrypt(new TextEncoder().encode(path), key);
  return doubleBase64(encrypted);
}

// ============================================================================
// PHẦN 3: lấy & giải mã metadata từ trang embed abysscdn.com
// ============================================================================

const ABYSS_BASE_URL = "https://abysscdn.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

async function fetchMp4Metadata(videoId, referer) {
  const embedUrl = `${ABYSS_BASE_URL}/?v=${encodeURIComponent(videoId)}`;
  const resp = await fetch(embedUrl, {
    headers: {
      Referer: referer,
      "User-Agent": DEFAULT_UA,
    },
  });
  if (!resp.ok) {
    throw new Error("Embed page fetch failed: " + resp.status);
  }
  const html = await resp.text();

  // Tìm biến `const datas = "..."` trong bất kỳ thẻ <script> nào chứa từ khoá "datas".
  const match = html.match(/const\s+datas\s*=\s*"([^"]*)"/);
  if (!match) {
    throw new Error("Không tìm thấy biến datas trong trang embed");
  }
  const encodedDatas = match[1];

  // decodedJson: base64-decode ra bytes rồi đọc như ISO-8859-1 (mỗi byte = 1 code unit,
  // khớp `String(bytes, Charsets.ISO_8859_1)` trong Kotlin) trước khi JSON.parse.
  const decodedBytes = base64ToBytes(encodedDatas);
  let decodedJsonStr = "";
  for (let i = 0; i < decodedBytes.length; i++) decodedJsonStr += String.fromCharCode(decodedBytes[i]);

  const datas = JSON.parse(decodedJsonStr);
  const md5Id = datas.md5_id;
  const media = datas.media;
  const slug = datas.slug;
  const userId = datas.user_id;

  if (!media) throw new Error("Thiếu field media trong datas");

  const mediaKey = keyForString(`${userId}:${slug}:${md5Id}`);

  // media là chuỗi ISO-8859-1 (lossless byte<->char) -> chuyển lại thành bytes trước khi decrypt.
  const mediaBytes = new Uint8Array(media.length);
  for (let i = 0; i < media.length; i++) mediaBytes[i] = media.charCodeAt(i) & 0xff;

  const decryptedBytes = await aesCtrDecrypt(mediaBytes, mediaKey);
  const decryptedJsonStr = new TextDecoder().decode(decryptedBytes);
  const video = JSON.parse(decryptedJsonStr);

  const mp4 = video.mp4;
  if (!mp4) throw new Error("Thiếu field mp4 trong video data");

  return {
    domains: mp4.domains || [],
    sources: mp4.sources || [],
    slug,
    md5_id: md5Id,
  };
}

function getVideoIdFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes("short.ink")) {
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || null;
    }
    return u.searchParams.get("v");
  } catch (e) {
    return null;
  }
}

// ============================================================================
// PHẦN 4: endpoint /hydrax — giả lập file mp4, dịch Range request thành segment token request
// ============================================================================

// Cloudflare Workers (free plan) giới hạn ~50 subrequest / lần invocation. Mỗi segment Abyss = 1
// subrequest, nên KHÔNG BAO GIỜ được cố tải toàn bộ file trong 1 lần gọi — luôn ép trả về từng
// phần nhỏ và để player tự gửi tiếp Range request cho phần sau (đúng hành vi HTTP streaming chuẩn).
const MAX_SEGMENTS_PER_REQUEST = 45; // Cloudflare free tier: ~50 subrequest/invocation; chừa 1 cho fetch trang embed

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) {
    // Không có Range: đây thường là request đầu tiên của player để "dò" định dạng file.
    // Chỉ trả về 1 segment đầu (đủ để player đọc header mp4 + bắt đầu buffer), KHÔNG trả cả file.
    const end = Math.min(FRAGMENT_SIZE - 1, totalSize - 1);
    return { start: 0, end, isPartial: true };
  }
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!m) {
    const end = Math.min(FRAGMENT_SIZE - 1, totalSize - 1);
    return { start: 0, end, isPartial: true };
  }
  const start = parseInt(m[1], 10) || 0;
  let end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;

  // Giới hạn số segment tải trong 1 lần, để không vượt subrequest limit của Worker.
  const maxEnd = start + MAX_SEGMENTS_PER_REQUEST * FRAGMENT_SIZE - 1;
  if (end > maxEnd) {
    end = Math.min(maxEnd, totalSize - 1);
  }

  return { start, end, isPartial: true };
}

async function fetchAbyssSegment(baseUrl, md5Id, resId, totalSize, segIndex) {
  const path = `/mp4/${md5Id}/${resId}/${totalSize}/${FRAGMENT_SIZE}/${segIndex}`;
  const key = keyForNumber(totalSize);
  const encrypted = await aesCtrEncrypt(new TextEncoder().encode(path), key);
  const token = doubleBase64(encrypted);
  const segUrl = `${baseUrl}/sora/${totalSize}/${token}`;

  const resp = await fetch(segUrl, {
    headers: { Referer: "https://abysscdn.com/" },
  });
  if (!resp.ok) return new Uint8Array(0);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

// Đọc đúng khoảng [start, end] (inclusive) bằng cách tải các segment 2MB cần thiết rồi cắt ghép.
async function readRangeFromAbyss(baseUrl, md5Id, resId, totalSize, start, end) {
  const firstSeg = Math.floor(start / FRAGMENT_SIZE);
  const lastSeg = Math.floor(end / FRAGMENT_SIZE);

  const parts = [];
  for (let segIndex = firstSeg; segIndex <= lastSeg; segIndex++) {
    const segBytes = await fetchAbyssSegment(baseUrl, md5Id, resId, totalSize, segIndex);
    if (segBytes.length === 0) break;

    const segStart = segIndex * FRAGMENT_SIZE;
    const segEnd = segStart + segBytes.length - 1;

    const sliceStart = Math.max(start, segStart) - segStart;
    const sliceEnd = Math.min(end, segEnd) - segStart;
    if (sliceStart <= sliceEnd) {
      parts.push(segBytes.subarray(sliceStart, sliceEnd + 1));
    }
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

async function handleHydrax(request, reqUrl) {
  const videoId = reqUrl.searchParams.get("v");
  const resIndexParam = reqUrl.searchParams.get("res"); // tuỳ chọn: chọn resolution theo index (0 = đầu tiên)
  if (!videoId) {
    return new Response("Missing ?v= param", { status: 400 });
  }

  const referer = "https://anime47.best/";
  let meta;
  try {
    meta = await fetchMp4Metadata(videoId, referer);
  } catch (e) {
    return new Response("Metadata error: " + e.message, { status: 502 });
  }

  const domain = (meta.domains || []).find((d) => d && d.trim());
  if (!domain) {
    return new Response("Không tìm thấy domain CDN trong metadata", { status: 502 });
  }
  const sources = (meta.sources || []).filter(Boolean);
  if (sources.length === 0) {
    return new Response("Không có source nào khả dụng", { status: 502 });
  }

  // Nếu có ?res=, ưu tiên theo index; mặc định chọn nguồn CHẤT LƯỢNG CAO NHẤT theo label số (720 > 360...).
  let chosen;
  if (resIndexParam !== null) {
    chosen = sources[parseInt(resIndexParam, 10)] || sources[0];
  } else {
    chosen = sources.slice().sort((a, b) => {
      const qa = parseInt((a.label || "").replace(/\D/g, ""), 10) || 0;
      const qb = parseInt((b.label || "").replace(/\D/g, ""), 10) || 0;
      return qb - qa;
    })[0];
  }

  const sub = chosen.sub;
  const size = chosen.size;
  const resId = chosen.res_id;
  const md5Id = meta.md5_id;

  if (!sub || !size || resId === undefined || resId === null || !md5Id) {
    return new Response("Thiếu thông tin source (sub/size/res_id/md5_id)", { status: 502 });
  }

  // Domain thật của segment: "sub.<domain gốc bỏ phần subdomain đầu>", khớp Kotlin:
  // "https://$sub.${domain.substringAfter(".")}"
  const domainAfterFirstDot = domain.indexOf(".") !== -1 ? domain.substring(domain.indexOf(".") + 1) : domain;
  const baseUrl = `https://${sub}.${domainAfterFirstDot}`;

  const rangeHeader = request.headers.get("Range");
  const { start, end } = parseRange(rangeHeader, size);

  if (start > end || start < 0) {
    return new Response(null, { status: 416 });
  }

  let bodyBytes;
  try {
    bodyBytes = await readRangeFromAbyss(baseUrl, md5Id, resId, size, start, end);
  } catch (e) {
    return new Response("Segment fetch error: " + e.message, { status: 502 });
  }

  const debugHeaders = {
    "X-Debug-Range-Header": rangeHeader || "(none)",
    "X-Debug-Resolved-Range": `${start}-${end}`,
    "X-Debug-Total-Size": String(size),
    "X-Debug-Segments-Fetched": String(Math.ceil((end - start + 1) / FRAGMENT_SIZE)),
  };

  const isFullFile = start === 0 && end === size - 1;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(bodyBytes.length),
    ...corsHeaders,
    ...debugHeaders,
  };

  if (!isFullFile) {
    // Dữ liệu trả về chỉ là 1 phần của file thật (dù request gốc có Range hay không) — LUÔN báo
    // 206 + Content-Range để player biết tổng kích thước thật và tự gửi tiếp Range request cho
    // phần còn lại. Trả 200 ở đây sẽ khiến player tưởng đây là toàn bộ file.
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(bodyBytes, { status: 206, headers });
  }
  return new Response(bodyBytes, { status: 200, headers });
}

// ============================================================================
// PHẦN 5: /proxy — vá lỗi offset byte MPEG-TS (server FE / vlogphim.net / nonprofit.asia)
// ============================================================================

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

function findMpegTsOffset(bytes) {
  const minLen = TS_PACKET_SIZE * 3;
  if (bytes.length < minLen) return -1;
  for (let i = 0; i <= bytes.length - minLen; i++) {
    if (
      bytes[i] === TS_SYNC_BYTE &&
      bytes[i + TS_PACKET_SIZE] === TS_SYNC_BYTE &&
      bytes[i + TS_PACKET_SIZE * 2] === TS_SYNC_BYTE
    ) {
      return i;
    }
  }
  return -1;
}

function workerProxyUrl(origin, targetUrl) {
  return origin + "/proxy?u=" + encodeURIComponent(targetUrl);
}

function isM3u8(url, contentType) {
  if (contentType && contentType.indexOf("mpegurl") !== -1) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

function rewriteM3u8(text, baseUrl, workerOrigin) {
  const lines = text.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    let absolute;
    try {
      absolute = new URL(trimmed, baseUrl).toString();
    } catch (e) {
      return line;
    }
    return workerProxyUrl(workerOrigin, absolute);
  });
  return rewritten.join("\n");
}

async function handleProxy(request, reqUrl) {
  const target = reqUrl.searchParams.get("u");
  if (!target) {
    return new Response("Missing ?u= param", { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(target);
  } catch (e) {
    return new Response("Invalid u param", { status: 400 });
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("Referer", "https://anime47.best/");
  upstreamHeaders.set("User-Agent", DEFAULT_UA);

  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);

  const upstreamResp = await fetch(targetUrl, { headers: upstreamHeaders });

  if (!upstreamResp.ok && upstreamResp.status !== 206) {
    return new Response("Upstream error: " + upstreamResp.status, {
      status: upstreamResp.status,
    });
  }

  const contentType = upstreamResp.headers.get("Content-Type") || "";

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (isM3u8(targetUrl, contentType)) {
    const text = await upstreamResp.text();
    const workerOrigin = reqUrl.origin;
    const rewritten = rewriteM3u8(text, targetUrl, workerOrigin);
    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        ...corsHeaders,
      },
    });
  }

  const buffer = await upstreamResp.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let fixedBytes = bytes;
  if (bytes.length > 0 && bytes[0] !== TS_SYNC_BYTE) {
    const offset = findMpegTsOffset(bytes);
    if (offset > 0) {
      fixedBytes = bytes.subarray(offset);
    }
  }

  return new Response(fixedBytes, {
    status: upstreamResp.status,
    headers: {
      "Content-Type": contentType || "video/mp2t",
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders,
    },
  });
}

// ============================================================================
// Router
// ============================================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      });
    }

    try {
      if (url.pathname === "/proxy") {
        return await handleProxy(request, url);
      }
      if (url.pathname === "/hydrax") {
        return await handleHydrax(request, url);
      }
    } catch (e) {
      return new Response("Worker error: " + (e && e.message ? e.message : String(e)), {
        status: 500,
      });
    }

    return new Response(
      "Anime47 Stream Fix Proxy — dùng /proxy?u=<url> (server FE) hoặc /hydrax?v=<video_id> (server HY)",
      { status: 200 }
    );
  },
};
