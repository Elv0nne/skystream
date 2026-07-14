# Anime47 Repo — SkyStream

Repo extension SkyStream cho **Anime47**, port từ plugin CloudStream gốc (`Anime47Provider.kt`) sang JS (Sky Gen 2).

## ⚠️ Việc cần làm trước khi deploy

Mở file `Anime47Provider/plugin.js`, tìm 2 dòng đầu phần Config và điền tài khoản Anime47 dùng chung:

```js
const ACCOUNT_EMAIL = "your-email@example.com";
const ACCOUNT_PASSWORD = "your-password";
```

Nếu để nguyên placeholder, plugin vẫn chạy nhưng sẽ **không đăng nhập** — nếu Anime47 bật `PRIVATE_MODE`
cho API, các request sẽ báo lỗi yêu cầu đăng nhập.

## 🚀 Deploy lên GitHub

```bash
cd anime47-repo
git init
git add .
git commit -m "init: Anime47 SkyStream plugin"
git branch -M main
git remote add origin https://github.com/Elv0nne/anime47-repo.git
git push -u origin main
```

Sau khi push, GitHub Action (`.github/workflows/build.yml`) sẽ tự chạy `skystream deploy` và tạo ra
`dist/plugins.json` + gói `.zip` cho từng plugin. Không cần chạy build tay.

## 📱 Thêm vào app SkyStream

Trong app SkyStream: **Settings → Manage Extensions → Add Repository**, dán URL:

```
https://raw.githubusercontent.com/Elv0nne/anime47-repo/main/repo.json
```

Đợi danh sách hiện ra rồi bấm tải plugin **Anime47**.

## 🛠 Test cục bộ (cần máy có `npm`)

```bash
npm install -g skystream-cli
cd Anime47Provider
skystream test -f getHome
skystream test -f search -q "one piece"
skystream test -f load -q "https://anime47.best/anime/one-piece-12345"
skystream test -f loadStreams -q "[123456]"
```

## 📋 Đối chiếu với bản Kotlin gốc

Đã port đầy đủ:
- `getHome` (4 danh mục: Mới cập nhật, Top đánh giá, Anime TV, Anime Movie)
- `search`
- `load` (thông tin phim, diễn viên, gộp tập theo số tập từ nhiều team/group dịch)
- `loadStreams` (gọi API watch theo từng id tập, header đặc biệt cho `vlogphim.net`, map nhãn phụ đề)
- Đăng nhập lấy `access_token`, cache token trong phiên chạy

**Không port được** (giới hạn nền tảng SkyStream, xem chi tiết trong comment đầu `plugin.js`):
- `getVideoInterceptor()` — vá lỗi offset byte MPEG-TS cho CDN `nonprofit.asia`/`cdn<N>.nonprofit...`.
  SkyStream JS runtime không có hook can thiệp byte-stream của response khi player đang phát.

## 📁 Cấu trúc

```
anime47-repo/
├── Anime47Provider/
│   ├── plugin.json     # Manifest (tên, domain, category...)
│   └── plugin.js       # Toàn bộ logic scrape/API
├── package.json
├── repo.json            # Trỏ tới dist/plugins.json sau khi deploy
└── .github/workflows/build.yml   # Auto build + deploy khi push lên main
```
