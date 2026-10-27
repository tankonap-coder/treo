try { require('dotenv').config(); } catch (e) {}
const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https'); // Dùng https để gọi URL public của Render

// Lấy PORT từ biến môi trường của Render
const PORT = process.env.PORT || 8080;

// Tạo HTTP server đáp ứng healthcheck nội bộ
http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
}).listen(PORT, () => {
    console.log(`[HTTP] Server keep-alive đang chạy trên cổng ${PORT}`);
});

// Tự động lấy URL public do Render cung cấp sẵn qua biến môi trường
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (EXTERNAL_URL) {
    console.log(`[+] Đã nhận diện URL Public của Render: ${EXTERNAL_URL}`);
} else {
    console.log(`[-] Lưu ý: Không tìm thấy RENDER_EXTERNAL_URL (chỉ chạy nội bộ).`);
}

// Cơ chế tự ping chống ngủ (Chạy mỗi 3 phút / lần = 180000 ms)
setInterval(() => {
    // 1. Ping nội bộ để giữ tiến trình
    http.get(`http://127.0.0.1:${PORT}/health`, () => {}).on('error', () => {});

    // 2. Ping trực tiếp vào URL Public của Render để đánh thức hệ thống từ bên ngoài
    if (EXTERNAL_URL) {
        https.get(`${EXTERNAL_URL}/health`, (res) => {
            // Đã tự ping thành công, giữ service luôn tỉnh táo
        }).on('error', (err) => {
            // Bỏ qua lỗi kết nối tạm thời nếu có
        });
    }
}, 180000);

// Lấy Token từ biến môi trường của Render
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
    console.error('[-] Lỗi: Không tìm thấy DISCORD_TOKEN trong biến môi trường!');
    process.exit(1);
}

// Đọc danh sách Application ID game từ file id.json
let gamesToPush = [];
try {
    const rawData = fs.readFileSync('id.json', 'utf-8');
    const data = JSON.parse(rawData);
    
    gamesToPush = data.used_games || data;

    if (!Array.isArray(gamesToPush) || gamesToPush.length === 0) {
        throw new Error('File id.json không chứa mảng ID hợp lệ!');
    }
    
    console.log(`[+] Đã tải thành công ${gamesToPush.length} Game ID từ file id.json.`);
} catch (error) {
    console.error('[-] Lỗi đọc file id.json:', error.message);
    process.exit(1);
}

let currentGameIndex = 0;
let heartbeatInterval = null;
let gameInterval = null;

function connectDiscord() {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

    ws.on('open', () => {
        console.log('Đã kết nối tới Discord Gateway WebSocket...');
    });

    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        const { op, d, t } = payload;

        if (op === 10) {
            const { heartbeat_interval } = d;
            
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ op: 1, d: null }));
                }
            }, heartbeat_interval);

            ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: TOKEN,
                    capabilities: 8189,
                    properties: {
                        os: 'Windows',
                        browser: 'Chrome',
                        device: ''
                    },
                    presence: {
                        status: 'online',
                        since: 0,
                        activities: [{
                            name: 'Custom Game',
                            type: 0,
                            application_id: gamesToPush[currentGameIndex],
                            timestamps: { start: Date.now() }
                        }],
                        afk: false
                    }
                }
            }));
        }

        if (t === 'READY') {
            console.log(`[+] Đã đăng nhập thành công vào Gateway! Tài khoản hiện đã ONLINE.`);
            
            if (gameInterval) clearInterval(gameInterval);

            // Luân chuyển game mỗi 1 giờ (3,600,000 ms)
            gameInterval = setInterval(() => {
                currentGameIndex = (currentGameIndex + 1) % gamesToPush.length;
                const appId = gamesToPush[currentGameIndex];

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        op: 3,
                        d: {
                            since: Date.now(),
                            activities: [{
                                name: 'Custom Game',
                                type: 0,
                                application_id: appId,
                                timestamps: { start: Date.now() }
                            }],
                            status: 'online',
                            afk: false
                        }
                    }));

                    console.log(`[+] Đã chuyển sang Game App ID: ${appId} (${currentGameIndex + 1}/${gamesToPush.length})`);
                }
            }, 3600000);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Kết nối bị đóng (${code}): ${reason}. Đang kết nối lại sau 5 giây...`);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (gameInterval) clearInterval(gameInterval);
        setTimeout(connectDiscord, 5000);
    });

    ws.on('error', (error) => {
        console.error('Lỗi WebSocket:', error.message);
    });
}

connectDiscord();
