import os
import json
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from services.aliyun_translator import AliyunTranslator

load_dotenv()

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

app = FastAPI(title="V2T - 实时同声传译系统")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.websocket("/ws/translate")
async def websocket_translate(ws: WebSocket):
    await ws.accept()
    print("[WS] 客户端已连接")

    translator = AliyunTranslator()
    loop = asyncio.get_event_loop()

    async def ws_send_json(data: dict):
        await ws.send_json(data)

    try:
        # 第一条消息：客户端发送语种配置
        config_raw = await ws.receive_text()
        config = json.loads(config_raw)
        source_lang = config.get("source_lang", "en")
        target_lang = config.get("target_lang", "zh")
        print(f"[WS] 语种配置: {source_lang} -> {target_lang}")

        translator.start(source_lang, target_lang, ws_send_json)

        while True:
            try:
                msg = await ws.receive()
            except Exception:
                break

            if ws.client_state != WebSocketState.CONNECTED:
                break

            if "bytes" in msg and msg["bytes"] is not None:
                translator.send_audio(msg["bytes"])

            elif "text" in msg and msg["text"] is not None:
                try:
                    data = json.loads(msg["text"])
                    if "source_lang" in data and "target_lang" in data:
                        translator.stop()
                        source_lang = data["source_lang"]
                        target_lang = data["target_lang"]
                        translator.start(source_lang, target_lang, ws_send_json)
                        print(f"[WS] 语种已切换: {source_lang} -> {target_lang}")
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        print("[WS] 客户端断开连接")
    except Exception as e:
        print(f"[WS] 错误: {e}")
    finally:
        translator.stop()
        print("[WS] 资源已清理")


if __name__ == "__main__":
    import uvicorn
    ssl_dir = Path(__file__).parent
    certfile = ssl_dir / "cert.pem"
    keyfile = ssl_dir / "key.pem"
    if certfile.exists() and keyfile.exists():
        uvicorn.run("main:app", host=HOST, port=PORT, reload=True,
                    ssl_certfile=str(certfile), ssl_keyfile=str(keyfile))
    else:
        uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
