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
     * GIỚI HẠN KHÔNG PORT ĐƯỢC:
     * - Bản gốc có `getVideoInterceptor()` (OkHttp Interceptor) để vá lỗi offset byte MPEG-TS
     *   cho các CDN dạng `nonprofit.asia` / `cdn<N>.nonprofit...` (tìm packet sync-byte 0x47 và
     *   cắt bỏ phần rác ở đầu response). SkyStream JS runtime KHÔNG cung cấp hook để can thiệp vào
     *   luồng byte của response khi player đang phát (http_get/http_post chỉ dùng để lấy dữ liệu
     *   trang, không nằm trong pipeline phát video). Nên phần vá byte này không thể tái tạo ở tầng
     *   plugin JS — nếu stream từ CDN đó bị lỗi phát, đó là giới hạn nền tảng, không phải bug plugin.
     */

    // ===================== Config =====================

    const API_BASE = "https://anime47.love/api";

    // TODO: điền tài khoản Anime47 dùng chung tại đây.
    const ACCOUNT_EMAIL = "sumaymanlon@gmail.com";
    const ACCOUNT_PASSWORD = "Kobe1234@";

    const DEFAULT_UA =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    const SUBTITLE_LANGUAGE_MAP = {
        Vietnamese: ["tiếng việt", "vietnamese", "vietsub", "viet", "vi"],
        English: ["tiếng anh", "english", "engsub", "eng", "en"],
    };

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
                            const streamUrl = stream.url;
                            if (!streamUrl) continue;

                            const headers = {
                                Referer: referer,
                                "User-Agent": DEFAULT_UA,
                                "sec-ch-ua": '"Chromium";v="120", "Not?A_Brand";v="24"',
                                "sec-ch-ua-mobile": "?1",
                                "sec-ch-ua-platform": '"Android"',
                            };

                            if (streamUrl.indexOf("vlogphim.net") !== -1) {
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
