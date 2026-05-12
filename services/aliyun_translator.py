import os
import json
import asyncio
from dashscope.audio.asr import (
    TranslationRecognizerRealtime,
    TranslationRecognizerCallback,
)

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
MODEL_NAME = "gummy-realtime-v1"


class TranslationCallback(TranslationRecognizerCallback):
    """DashScope 翻译回调 → 将结果推送给前端 WebSocket"""

    def __init__(self, ws_send_json):
        super().__init__()
        self._ws_send_json = ws_send_json
        self._loop = asyncio.get_event_loop()

    def on_open(self):
        print("[DashScope] 连接已建立")

    def on_close(self):
        print("[DashScope] 连接已关闭")

    def on_error(self, message):
        print(f"[DashScope] 错误: {message}")
        asyncio.run_coroutine_threadsafe(
            self._ws_send_json({"type": "error", "message": str(message)}),
            self._loop,
        )

    def on_complete(self):
        print("[DashScope] 翻译完成")

    def on_event(self, request_id, transcription_result, translation_result, usage):
        original_text = ""
        translated_text = ""

        if transcription_result and transcription_result.text:
            original_text = transcription_result.text

        if translation_result and translation_result.translations:
            for lang, translation in translation_result.translations.items():
                if translation.text:
                    translated_text = translation.text
                    break

        if original_text or translated_text:
            asyncio.run_coroutine_threadsafe(
                self._ws_send_json({
                    "type": "translation",
                    "original": original_text,
                    "translated": translated_text,
                    "is_sentence_end": getattr(transcription_result, "is_sentence_end", False),
                }),
                self._loop,
            )


class AliyunTranslator:
    """阿里云百炼同声传译服务封装"""

    def __init__(self, api_key=None):
        self.api_key = api_key or DASHSCOPE_API_KEY
        self._recognizer = None

    def start(self, source_lang, target_lang, ws_send_json):
        """启动实时翻译会话"""
        callback = TranslationCallback(ws_send_json)
        self._recognizer = TranslationRecognizerRealtime(
            model=MODEL_NAME,
            callback=callback,
            format="pcm",
            sample_rate=16000,
            source_language=source_lang,
            transcription_enabled=True,
            translation_enabled=True,
            translation_target_languages=[target_lang],
        )
        self._recognizer.start()
        print(f"[DashScope] 开始翻译: {source_lang} -> {target_lang}")

    def send_audio(self, audio_bytes: bytes):
        """发送音频数据"""
        if self._recognizer:
            self._recognizer.send_audio_frame(audio_bytes)

    def stop(self):
        """停止翻译会话"""
        if self._recognizer:
            self._recognizer.stop()
            self._recognizer = None
            print("[DashScope] 翻译会话结束")
