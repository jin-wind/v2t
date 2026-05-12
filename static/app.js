(() => {
  // ─── DOM ───
  const btnRecord = document.getElementById("btnRecord");
  const btnExport = document.getElementById("btnExport");
  const btnClear = document.getElementById("btnClear");
  const sourceLang = document.getElementById("sourceLang");
  const targetLang = document.getElementById("targetLang");
  const wsStatusEl = document.getElementById("wsStatus");
  const waveformCanvas = document.getElementById("waveform");
  const subtitleContainer = document.getElementById("subtitleContainer");
  const volumeBar = document.getElementById("volumeBar");
  const vadLabel = document.getElementById("vadLabel");

  const waveformCtx = waveformCanvas.getContext("2d");
  const TARGET_SAMPLE_RATE = 16000;

  // 适配设备像素比
  function resizeCanvas() {
    const rect = waveformCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;
    waveformCtx.scale(dpr, dpr);
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // ─── 状态 ───
  let isRecording = false;
  let ws = null;
  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let scriptProcessor = null;
  let animFrameId = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 5;
  const RECONNECT_DELAY = 2000;

  // VAD
  const VAD_THRESHOLD = 0.015;
  const VAD_SILENCE_MS = 800;
  let isSpeaking = false;
  let lastSpeakTime = 0;

  // 重采样缓冲区
  let resampleBuffer = new Float32Array(0);

  let translationHistory = [];

  // ─── 工具函数 ───
  function setWsStatus(state, text) {
    wsStatusEl.className = "status " + state;
    wsStatusEl.textContent = text;
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function computeRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  // Float32 → Int16 PCM
  function float32ToInt16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  // 重采样：srcRate → 16kHz
  function resampleTo16k(samples, srcRate) {
    if (srcRate === TARGET_SAMPLE_RATE) return float32ToInt16(samples);

    const ratio = srcRate / TARGET_SAMPLE_RATE;
    const newLen = Math.round(samples.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      result[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
    }
    return float32ToInt16(result);
  }

  // ─── 字幕渲染 ───
  function appendSubtitle(original, translated) {
    const placeholder = subtitleContainer.querySelector(".subtitle-placeholder");
    if (placeholder) placeholder.remove();

    const prev = subtitleContainer.querySelector(".subtitle-item.latest");
    if (prev) prev.classList.remove("latest");

    const item = document.createElement("div");
    item.className = "subtitle-item latest";
    item.innerHTML =
      `<div class="original">${escHtml(original)}</div>` +
      `<div class="translated">${escHtml(translated)}</div>`;
    subtitleContainer.appendChild(item);
    subtitleContainer.scrollTop = subtitleContainer.scrollHeight;

    translationHistory.push({ original, translated, time: new Date() });
    btnExport.disabled = translationHistory.length === 0;
  }

  // ─── WebSocket ───
  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/translate`);
    ws.binaryType = "arraybuffer";

    setWsStatus("connecting", "连接中…");

    ws.onopen = () => {
      reconnectAttempts = 0;
      setWsStatus("connected", "已连接");
      ws.send(JSON.stringify({
        source_lang: sourceLang.value,
        target_lang: targetLang.value,
      }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "translation") {
          appendSubtitle(msg.original || "", msg.translated || "");
        } else if (msg.type === "error") {
          console.error("[WS] 服务端错误:", msg.message);
        }
      } catch {
        console.warn("[WS] 非 JSON 消息:", evt.data);
      }
    };

    ws.onclose = () => {
      if (isRecording) {
        scheduleReconnect();
      } else {
        setWsStatus("disconnected", "未连接");
      }
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      setWsStatus("disconnected", "重连失败");
      stopRecording();
      return;
    }
    reconnectAttempts++;
    setWsStatus("reconnecting", `重连中 (${reconnectAttempts}/${MAX_RECONNECT})…`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, RECONNECT_DELAY);
  }

  function disconnectWs() {
    clearTimeout(reconnectTimer);
    reconnectAttempts = MAX_RECONNECT;
    if (ws) {
      ws.close();
      ws = null;
    }
    setWsStatus("disconnected", "未连接");
  }

  // ─── 麦克风 & 音频 ───
  async function startRecording() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
        },
      });
    } catch (err) {
      alert("无法获取麦克风权限: " + err.message);
      return;
    }

    audioContext = new AudioContext();
    const srcRate = audioContext.sampleRate;
    console.log("[Audio] 采样率:", srcRate);

    const source = audioContext.createMediaStreamSource(mediaStream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const BUFFER_SIZE = 4096;
    scriptProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    resampleBuffer = new Float32Array(0);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const rms = computeRMS(inputData);

      // 音量条
      const pct = Math.min(rms / 0.1, 1) * 100;
      volumeBar.style.width = pct + "%";

      const now = Date.now();
      if (rms > VAD_THRESHOLD) {
        lastSpeakTime = now;
        if (!isSpeaking) {
          isSpeaking = true;
          volumeBar.classList.add("speaking");
          volumeBar.classList.remove("muted");
          vadLabel.textContent = "正在说话…";
          vadLabel.classList.add("speaking");
        }
      } else if (isSpeaking && now - lastSpeakTime > VAD_SILENCE_MS) {
        isSpeaking = false;
        volumeBar.classList.remove("speaking");
        volumeBar.classList.add("muted");
        vadLabel.textContent = "静音中";
        vadLabel.classList.remove("speaking");
      }

      // 累积原始采样到缓冲区
      const newBuf = new Float32Array(resampleBuffer.length + inputData.length);
      newBuf.set(resampleBuffer);
      newBuf.set(inputData, resampleBuffer.length);
      resampleBuffer = newBuf;

      // 每累积约 320 采样（@16k = 20ms）就发送一帧
      const chunkSize16k = 320;
      const chunkSizeSrc = Math.round(chunkSize16k * (srcRate / TARGET_SAMPLE_RATE));

      while (resampleBuffer.length >= chunkSizeSrc) {
        const chunk = resampleBuffer.subarray(0, chunkSizeSrc);
        resampleBuffer = resampleBuffer.slice(chunkSizeSrc);

        // 只在说话时发送
        if (isSpeaking && ws && ws.readyState === WebSocket.OPEN) {
          const pcm = resampleTo16k(chunk, srcRate);
          ws.send(pcm.buffer);
        }
      }
    };

    isRecording = true;
    isSpeaking = false;
    lastSpeakTime = 0;
    btnRecord.classList.add("recording");
    btnRecord.querySelector(".btn-text").textContent = "停止";
    btnRecord.querySelector(".mic-icon").textContent = "⏹";
    vadLabel.textContent = "静音中";
    volumeBar.classList.add("muted");

    drawWaveform();
    connectWs();
  }

  function stopRecording() {
    isRecording = false;
    isSpeaking = false;
    btnRecord.classList.remove("recording");
    btnRecord.querySelector(".btn-text").textContent = "开始";
    btnRecord.querySelector(".mic-icon").textContent = "🎤";
    vadLabel.textContent = "";
    vadLabel.classList.remove("speaking");
    volumeBar.style.width = "0%";
    volumeBar.classList.remove("speaking", "muted");
    resampleBuffer = new Float32Array(0);

    if (animFrameId) cancelAnimationFrame(animFrameId);
    clearWaveform();

    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyser = null;
    }

    disconnectWs();
  }

  // ─── 波形 ───
  function drawWaveform() {
    if (!analyser) return;

    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);
    const rect = waveformCanvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    function draw() {
      animFrameId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArr);
      waveformCtx.clearRect(0, 0, W, H);

      const barCount = Math.min(bufLen, 48);
      const barGap = 2;
      const barW = (W - barGap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i++) {
        const val = dataArr[i] / 255;
        const barH = Math.max(2, val * H * 0.9);

        let color;
        if (!isSpeaking) {
          color = `rgba(113, 113, 122, ${0.2 + val * 0.3})`;
        } else {
          const hue = 200 + val * 60;
          color = `hsl(${hue}, 80%, ${50 + val * 15}%)`;
        }

        const x = i * (barW + barGap);
        const y = (H - barH) / 2;
        waveformCtx.fillStyle = color;
        waveformCtx.beginPath();
        waveformCtx.roundRect(x, y, barW, barH, 2);
        waveformCtx.fill();
      }
    }
    draw();
  }

  function clearWaveform() {
    const rect = waveformCanvas.getBoundingClientRect();
    waveformCtx.clearRect(0, 0, rect.width, rect.height);
  }

  // ─── 导出 ───
  function exportTranscript() {
    if (translationHistory.length === 0) return;

    const lines = translationHistory.map((item, i) => {
      const ts = item.time.toLocaleTimeString();
      return `[${i + 1}] ${ts}\n原文: ${item.original}\n译文: ${item.translated}\n`;
    });
    const content = `V2T 同声传译纪要\n导出时间: ${new Date().toLocaleString()}\n${"=".repeat(40)}\n\n${lines.join("\n")}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `v2t_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── 事件 ───
  btnRecord.addEventListener("click", () => {
    isRecording ? stopRecording() : startRecording();
  });

  btnExport.addEventListener("click", exportTranscript);

  btnClear.addEventListener("click", () => {
    translationHistory = [];
    subtitleContainer.innerHTML = '<div class="subtitle-placeholder">点击上方按钮开始同声传译</div>';
    btnExport.disabled = true;
  });

  function sendLangConfig() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        source_lang: sourceLang.value,
        target_lang: targetLang.value,
      }));
    }
  }
  sourceLang.addEventListener("change", sendLangConfig);
  targetLang.addEventListener("change", sendLangConfig);
})();
