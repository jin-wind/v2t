# V2T - 实时同声传译系统

基于 Web Audio API + FastAPI + 阿里云百炼的实时语音同声传译系统。浏览器端采集麦克风音频，通过 WebSocket 传输到后端，调用阿里云 DashScope 同声传译 API，实时返回双语字幕。

## 功能特性

- 实时语音识别 + 翻译（支持英/中/日/韩/法/德/西）
- 前端 VAD 静音检测，静音时自动暂停发送（节省 API 调用量）
- 音频波形可视化 + 音量条指示
- 双语滚动字幕，最新句高亮
- WebSocket 断线自动重连
- 导出翻译纪要为 `.txt` 文件
- HTTPS 自签名证书支持（麦克风权限需要安全上下文）

## 技术栈

- **后端**: Python / FastAPI / WebSocket
- **前端**: 原生 HTML / CSS / JavaScript / Web Audio API
- **翻译引擎**: 阿里云百炼 DashScope `gummy-realtime-v1`
- **通信协议**: WebSocket（二进制音频上传 + JSON 结果下发）

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 API Key

```bash
cp .env.example .env
```

编辑 `.env`，填入你的阿里云百炼 API Key：

```
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. 生成 HTTPS 证书（可选，局域网手机访问需要）

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=你的局域网IP"
```

### 4. 启动服务

```bash
python main.py
```

- 有证书时自动启用 HTTPS: `https://0.0.0.0:8000`
- 无证书时使用 HTTP: `http://0.0.0.0:8000`

### 5. 使用

电脑或手机浏览器访问服务地址，选择源语言和目标语言，点击麦克风按钮开始说话。

## 项目结构

```
v2t/
├── main.py                    # FastAPI 入口 + WebSocket 路由
├── services/
│   └── aliyun_translator.py   # DashScope 同声传译 API 封装
├── static/
│   ├── index.html             # 前端页面
│   ├── style.css              # 样式（深色主题）
│   └── app.js                 # 前端逻辑（麦克风/VAD/波形/WebSocket）
├── requirements.txt           # Python 依赖
├── .env.example               # 环境变量模板
└── .gitignore
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DASHSCOPE_API_KEY` | 阿里云百炼 API Key | - |
| `HOST` | 监听地址 | `0.0.0.0` |
| `PORT` | 监听端口 | `8000` |

## License

MIT
