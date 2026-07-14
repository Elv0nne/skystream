(function () {
    /**
     * Anime47 — SkyStream Gen 2 Plugin
     * Port từ CloudStream plugin gốc (Anime47Provider.kt) sang JavaScript cho SkyStream.
     *
     * Ghi chú port:
     * - mainUrl (manifest.baseUrl) dùng để build link xem / poster / referer.
     * - apiBaseUrl KHÔNG đổi theo domain đã chọn (giống bản gốc Kotlin: mainUrl và apiBaseUrl
     *   là 2 domain khác nhau -- anime47.best cho trang xem, anime47.love/api cho API).
     * - Đăng nhập: bản CloudStream gốc có màn hình Settings để người dùng tự nhập email/password.
     *   SkyStream JS-plugin không có UI riêng cho việc này nên theo yêu cầu, tài khoản dùng chung
     *   được hardcode thẳng bên dưới (ACCOUNT_EMAIL / ACCOUNT_PASSWORD). Đổi lại giá trị của bạn.
     *
     * VÁ LỖI PHÁT VIDEO (server FE + HY):
     * - Server FE dùng CDN `cdn<N>.nonprofit.asia`, CDN này trả về vài byte rác ở đầu mỗi segment
     *   .ts khiến player không tìm được sync-byte MPEG-TS hợp lệ. Bản gốc vá bằng OkHttp Interceptor
     *   (getVideoInterceptor()).
     * - Server HY (Hydrax/Abyss) không trả link phát trực tiếp: trang embed chứa blob mã hoá AES-CTR
     *   cần giải mã để lấy danh sách nguồn CDN, và video chia thành segment 2MB cũng mã hoá riêng
     *   từng phần — bản gốc phải viết hẳn 1 Interceptor giả lập file ảo (HydraxInterceptor).
     * - SkyStream JS runtime không có hook can thiệp byte-stream khi player đang phát, nên không
     *   port y hệt ở tầng plugin được. Giải pháp: một Cloudflare Worker riêng (xem worker.js cùng
     *   thư mục) đứng giữa player và nguồn thật, tự vá byte (FE) hoặc giải mã + ghép segment (HY)
     *   rồi trả lại dữ liệu sạch. Deploy Worker đó rồi điền domain vào WORKER_PROXY_BASE bên dưới.
     */

    // ===================== Config =====================

    const API_BASE = "https://anime47.love/api";

    // Domain Cloudflare Worker (xem file worker.js) đã deploy — vá lỗi phát cho cả server FE và HY.
    // Để trống ("") nếu chưa deploy — lúc đó cả 2 server nhiều khả năng sẽ không phát được.
    const WORKER_PROXY_BASE = "https://anime47-fix.sumaymanlon.workers.dev";

    // TODO: điền tài khoản Anime47 dùng chung tại đây.
    const ACCOUNT_EMAIL = "sumaymanlon@gmail.com";
    const ACCOUNT_PASSWORD = "Kobe1234@";

    const DEFAULT_UA =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    const SUBTITLE_LANGUAGE_MAP = {
        Vietnamese: ["tiếng việt", "vietnamese", "vietsub", "viet", "vi"],
        English: ["tiếng anh", "english", "engsub", "eng", "en"],
    };

    // Domain server HY (Hydrax/Abyss) — khớp HY_HOSTS trong HydraxExtractor.kt gốc.
    const HYDRAX_HOSTS = ["abysscdn.com", "playhydrax.com", "zplayer.io", "short.ink"];

    function getHydraxVideoId(rawUrl) {
        try {
            const u = new URL(rawUrl);
            if (u.hostname.indexOf("short.ink") !== -1) {
                const parts = u.pathname.split("/").filter(Boolean);
                return parts[parts.length - 1] || null;
            }
            return u.searchParams.get("v");
        } catch (e) {
            return null;
        }
    }

    // Cache token trong phiên chạy hiện tại (tương đương cachedToken trong bản Kotlin)
    let cachedToken = null;

    // ===================== Helpers =====================

    function fixUrl(url) {
        if (!url) return null;
        if (url.indexOf("via.placeholder.com") !== -1) return null;
        if (/^http/i.test(url)) return url;
        if (url.startsWith("//")) return "https:" + url;
        const path = url.startsWith("/") ? url : "/" + url;
        const base = manifest.baseUrl || "https://anime47.best";
        return /^http/i.test(base) ? base + path : "https:" + base + path;
    }

    function toIntOrNull(v) {
        if (v === null || v === undefined) return null;
        const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
        return Number.isNaN(n) ? null : n;
    }

    function mapSubtitleLabel(label) {
        const trimmed = (label || "").trim();
        const lower = trimmed.toLowerCase();
        if (!lower) return "Subtitle";
        for (const standardName in SUBTITLE_LANGUAGE_MAP) {
            const keywords = SUBTITLE_LANGUAGE_MAP[standardName];
            if (keywords.some((k) => lower.indexOf(k) !== -1)) {
                return standardName;
            }
        }
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }

    function determineType(detail) {
        // Bản gốc luôn map về TvType.Anime/Cartoon để không mất tập với "movie" nhiều phần.
        // Với schema SkyStream (movie/series/anime/livestream), Anime47 luôn là "anime".
        return "anime";
    }

    async function httpGetJson(url, headers) {
        const res = await http_get(url, headers || {});
        const text = res.body;
        if (typeof text === "string" && text.indexOf('"PRIVATE_MODE"') !== -1) {
            throw new Error(
                "Trang web yêu cầu đăng nhập. Vui lòng kiểm tra tài khoản Anime47 trong code plugin."
            );
        }
        try {
            return typeof text === "string" ? JSON.parse(text) : text;
        } catch (e) {
            throw new Error("Không parse được JSON từ " + url + ": " + e.message);
        }
    }

    async function ensureToken() {
        if (cachedToken) return cachedToken;
        if (!ACCOUNT_EMAIL || !ACCOUNT_PASSWORD || ACCOUNT_EMAIL.indexOf("example.com") !== -1) {
            return null;
        }
        try {
            const body = JSON.stringify({ login: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });
            const res = await http_post(
                API_BASE + "/auth/login",
                {
                    origin: manifest.baseUrl,
                    referer: manifest.baseUrl + "/",
                    "Content-Type": "application/json",
                },
                body
            );
            const data = JSON.parse(res.body);
            cachedToken = data.access_token || null;
            return cachedToken;
        } catch (e) {
            return null;
        }
    }

    async function getAuthHeaders() {
        const token = await ensureToken();
        return token ? { Authorization: "Bearer " + token } : {};
    }

    async function fetchApi(url) {
        const authHeaders = await getAuthHeaders();
        return httpGetJson(url, authHeaders);
    }

    // Dùng cho: mainpage "Post" và "RecommendationItem" (API trả field "poster")
    function createMultimediaItemFromPost(post) {
        const link = fixUrl(post.link);
        if (!link) return null;
        const episodesStr = post.current_episode || post.episodes;
        return new MultimediaItem({
            title: post.title,
            url: link,
            posterUrl: fixUrl(post.poster) || "",
            type: "anime",
            year: toIntOrNull(post.year) || undefined,
            description: episodesStr ? "Tập hiện tại: " + episodesStr : undefined,
        });
    }

    // Dùng cho: "SearchItem" (API trả field "image" thay vì "poster")
    function createMultimediaItemFromSearchItem(item) {
        const link = fixUrl(item.link);
        if (!link) return null;
        const episodesStr = item.current_episode || item.episodes;
        return new MultimediaItem({
            title: item.title,
            url: link,
            posterUrl: fixUrl(item.image) || "",
            type: "anime",
            description: episodesStr ? "Tập hiện tại: " + episodesStr : undefined,
        });
    }

    // ===================== Core: getHome =====================

    async function getHome(cb) {
        try {
            const pages = [
                { key: "Mới Cập Nhật", path: "/anime/filter?lang=vi&sort=latest" },
                { key: "Top Đánh Giá", path: "/anime/filter?lang=vi&sort=rating" },
                { key: "Anime TV", path: "/anime/filter?lang=vi&type=tv" },
                { key: "Anime Movie", path: "/anime/filter?lang=vi&type=movie" },
            ];

            const data = {};

            for (const page of pages) {
                try {
                    const url = API_BASE + page.path + "&page=1";
                    const response = await fetchApi(url);
                    const posts = (response && response.data && response.data.posts) || [];
                    const items = posts
                        .map((post) => createMultimediaItemFromPost(post))
                        .filter(Boolean);
                    if (items.length > 0) {
                        data[page.key] = items;
                    }
                } catch (e) {
                    // Bỏ qua lỗi từng category riêng lẻ, các category khác vẫn hiển thị.
                }
            }

            if (Object.keys(data).length === 0) {
                cb({
                    success: false,
                    errorCode: "NOT_FOUND",
                    message: "Không tải được dữ liệu trang chủ Anime47.",
                });
                return;
            }

            // "Mới Cập Nhật" đóng vai trò Trending (Hero Carousel)
            if (data["Mới Cập Nhật"]) {
                data["Trending"] = data["Mới Cập Nhật"];
            }

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.stack || String(e) });
        }
    }

    // ===================== Core: search =====================

    async function search(query, cb) {
        try {
            const encoded = encodeURIComponent(query);
            const url = API_BASE + "/search/full/?lang=vi&keyword=" + encoded + "&page=1";
            const response = await fetchApi(url);
            const results = (response && response.results) || [];

            const items = results
                .map((item) => createMultimediaItemFromSearchItem(item))
                .filter(Boolean);

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.stack || String(e) });
        }
    }

    // ===================== Core: load =====================

    function extractAnimeId(url) {
        const match = url.replace(/\/$/, "").match(/(\d+)(?:\.html|\/)?$/);
        return match ? match[1] : null;
    }

    async function load(url, cb) {
        try {
            const animeId = extractAnimeId(url);
            if (!animeId) {
                cb({
                    success: false,
                    errorCode: "LOAD_ERROR",
                    message: "Không tìm thấy ID anime hợp lệ từ URL: " + url,
                });
                return;
            }

            const [infoResponse, episodeResponse, recsResponse] = await Promise.all([
                fetchApi(API_BASE + "/anime/info/" + animeId + "?lang=vi").catch(() => null),
                fetchApi(API_BASE + "/anime/" + animeId + "/episodes?lang=vi").catch(() => null),
                fetchApi(API_BASE + "/anime/info/" + animeId + "/recommendations?lang=vi").catch(
                    () => null
                ),
            ]);

            const detail = infoResponse && infoResponse.data;
            if (!detail) {
                cb({
                    success: false,
                    errorCode: "LOAD_ERROR",
                    message: "Lỗi tải thông tin phim: dữ liệu rỗng.",
                });
                return;
            }

            const title = detail.title || "Unknown Title";
            const posterUrl = fixUrl(detail.poster) || "";
            const bannerUrl = fixUrl(detail.cover) || undefined;
            const plot = detail.description || "";
            const tags = (detail.genres || []).map((g) => g.name).filter(Boolean);
            const year = toIntOrNull(detail.year) || undefined;
            const score = typeof detail.score === "number" ? detail.score : undefined;

            const cast = (detail.characters || [])
                .filter((c) => c.name)
                .map(
                    (c) =>
                        new Actor({
                            name: c.name,
                            role: c.role || undefined,
                            image: fixUrl(c.image_url) || undefined,
                        })
                );

            // Gom tập theo "number" trên toàn bộ team/group, giống groupBy { number } trong bản Kotlin.
            // Mỗi tập có thể có nhiều bản dịch (nhiều id) -> lưu mảng id vào Episode.url dạng JSON.
            const allEpisodeItems = [];
            (episodeResponse && episodeResponse.teams ? episodeResponse.teams : []).forEach(
                (team) => {
                    (team.groups || []).forEach((group) => {
                        (group.episodes || []).forEach((ep) => {
                            if (ep.number !== null && ep.number !== undefined) {
                                allEpisodeItems.push(ep);
                            }
                        });
                    });
                }
            );

            const grouped = {};
            allEpisodeItems.forEach((ep) => {
                const num = ep.number;
                if (!grouped[num]) grouped[num] = [];
                if (grouped[num].indexOf(ep.id) === -1) grouped[num].push(ep.id);
            });

            const episodes = Object.keys(grouped)
                .map((numStr) => {
                    const number = parseInt(numStr, 10);
                    const ids = grouped[numStr];
                    return new Episode({
                        name: "Tập " + number,
                        url: JSON.stringify(ids),
                        season: 1,
                        episode: number,
                        dubStatus: "subbed",
                    });
                })
                .sort((a, b) => a.episode - b.episode);

            const recommendations = ((recsResponse && recsResponse.data) || [])
                .map((item) => createMultimediaItemFromPost(item))
                .filter(Boolean);

            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url,
                    posterUrl,
                    bannerUrl,
                    type: determineType(detail),
                    description: plot,
                    year,
                    score,
                    tags,
                    cast,
                    recommendations,
                    episodes,
                    headers: { Referer: manifest.baseUrl + "/" },
                }),
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.stack || String(e) });
        }
    }

    // ===================== Core: loadStreams =====================

    async function loadStreams(url, cb) {
        try {
            let episodeIds;
            try {
                episodeIds = url.trim().startsWith("[") ? JSON.parse(url) : [parseInt(url, 10)];
            } catch (e) {
                cb({ success: false, errorCode: "STREAM_ERROR", message: "Dữ liệu tập không hợp lệ." });
                return;
            }

            if (!episodeIds || episodeIds.length === 0) {
                cb({ success: true, data: [] });
                return;
            }

            const referer = manifest.baseUrl + "/";
            const streamResults = [];

            const authHeaders = await getAuthHeaders();

            await Promise.all(
                episodeIds.map(async (id) => {
                    try {
                        const watchUrl = API_BASE + "/anime/watch/episode/" + id + "?lang=vi";
                        const watchResponse = await httpGetJson(watchUrl, authHeaders);
                        const streams = (watchResponse && watchResponse.streams) || [];

                        for (const stream of streams) {
                            let streamUrl = stream.url;
                            if (!streamUrl) continue;

                            const isVlogphim = streamUrl.indexOf("vlogphim.net") !== -1;
                            const isHydrax = HYDRAX_HOSTS.some((h) => streamUrl.indexOf(h) !== -1);
                            let usingWorkerProxy = false;

                            if (isVlogphim && WORKER_PROXY_BASE) {
                                // Server FE dùng CDN cdn<N>.nonprofit.asia cho các segment .ts, CDN này
                                // trả về vài byte rác ở đầu mỗi segment (lỗi offset MPEG-TS). Route qua
                                // Worker để vá lỗi đó — Worker tự gắn Referer khi gọi ngược lại CDN gốc,
                                // nên client (SkyStream) chỉ cần gọi thẳng domain Worker, không cần giả
                                // header của domain gốc (Origin/authority) nữa.
                                streamUrl =
                                    WORKER_PROXY_BASE.replace(/\/$/, "") +
                                    "/proxy?u=" +
                                    encodeURIComponent(streamUrl);
                                usingWorkerProxy = true;
                            } else if (isHydrax && WORKER_PROXY_BASE) {
                                // Server HY (Hydrax/Abyss) không trả link phát trực tiếp — trang embed
                                // chứa 1 blob mã hoá AES-CTR cần giải mã để lấy danh sách CDN nguồn, và
                                // video được chia thành segment 2MB cũng mã hoá riêng từng phần. Worker
                                // tự giải mã + ghép segment + giả lập 1 file .mp4 phản hồi đúng Range
                                // request của player. Chỉ cần truyền videoId (tham số "v" của URL gốc).
                                const videoId = getHydraxVideoId(streamUrl);
                                if (videoId) {
                                    // Dùng path "/hydrax/video.mp4?v=..." (có đuôi .mp4) thay vì chỉ
                                    // "/hydrax?v=...". Bản Kotlin gốc (HydraxExtractor.buildRelayUrl)
                                    // luôn đặt path relay là "$RELAY_HOST/video.mp4?...". Nhiều app
                                    // (khả năng cao gồm SkyStream) tự nhận diện HLS vs mp4 progressive
                                    // dựa trên đuôi file trong URL chứ không đọc Content-Type trả về,
                                    // nên URL không đuôi có thể khiến app không nhận ra đây là mp4 và
                                    // phát sai/không phát được, dù Worker trả dữ liệu hoàn toàn đúng.
                                    streamUrl =
                                        WORKER_PROXY_BASE.replace(/\/$/, "") +
                                        "/hydrax/video.mp4?v=" +
                                        encodeURIComponent(videoId);
                                    usingWorkerProxy = true;
                                }
                            }

                            const headers = usingWorkerProxy
                                ? {
                                      "User-Agent": DEFAULT_UA,
                                  }
                                : {
                                      Referer: referer,
                                      "User-Agent": DEFAULT_UA,
                                      "sec-ch-ua": '"Chromium";v="120", "Not?A_Brand";v="24"',
                                      "sec-ch-ua-mobile": "?1",
                                      "sec-ch-ua-platform": '"Android"',
                                  };

                            if (isVlogphim && !usingWorkerProxy) {
                                headers["Origin"] = referer;
                                try {
                                    headers["authority"] = new URL(streamUrl).host;
                                } catch (e) {
                                    headers["authority"] = "pl.vlogphim.net";
                                }
                            }

                            const subtitles = (stream.subtitles || [])
                                .filter((s) => s.file)
                                .map((s) => ({
                                    url: s.file,
                                    label: mapSubtitleLabel(s.label || "Vietnamese"),
                                    lang: mapSubtitleLabel(s.label || "Vietnamese"),
                                }));

                            streamResults.push(
                                new StreamResult({
                                    url: streamUrl,
                                    source: stream.server_name || "Anime47",
                                    headers,
                                    subtitles: subtitles.length > 0 ? subtitles : undefined,
                                })
                            );
                        }
                    } catch (e) {
                        // Bỏ qua lỗi từng episode id riêng lẻ, các stream khác vẫn trả về.
                    }
                })
            );

            cb({ success: true, data: streamResults });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.stack || String(e) });
        }
    }

    // Export to SkyStream
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
