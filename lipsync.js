/**
 * MotionPNG Tuber - Browser Lipsync Engine (DOM overlay)
 */
class LipsyncEngine {
    constructor() {
        // DOM要素
        this.folderInput = document.getElementById('folder-input');
        this.fileStatus = document.getElementById('file-status');
        this.micSelect = document.getElementById('mic-select');
        this.micStartBtn = document.getElementById('mic-start-btn');
        this.micStopBtn = document.getElementById('mic-stop-btn');
        this.volumeMeter = document.getElementById('volume-meter');
        this.sensitivitySlider = document.getElementById('sensitivity');
        this.sensitivityValue = document.getElementById('sensitivity-value');
        this.hqAudioToggle = document.getElementById('hq-audio');
        this.stage = document.getElementById('stage');
        this.video = document.getElementById('base-video');
        this.mouthCanvas = document.getElementById('mouth-canvas');
        this.mouthCtx = this.mouthCanvas.getContext('2d');
        this.startBtn = document.getElementById('start-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.debugInfo = document.getElementById('debug-info');

        // セクション
        this.micSection = document.getElementById('mic-section');
        this.previewSection = document.getElementById('preview-section');

        // データ
        this.trackData = null;
        this.mouthSprites = {};
        this.mouthSpriteUrls = {};
        this.activeSprite = null;
        this.videoUrl = null;
        this.isRunning = false;

        // 音声関連
        this.audioContext = null;
        this.micStream = null;
        this.workletNode = null;
        this.gainNode = null;
        this.volume = 0;
        this.smoothedHighRatio = 0;
        this.sensitivity = 50;
        this.hqAudioEnabled = false;
        this.envelope = 0;
        this.noiseFloor = 0.002;
        this.levelPeak = 0.02;
        this.mouthChangeMinMs = 70;

        // 口状態
        this.mouthState = 'closed';
        this.lastMouthChange = 0;
        this.lastFrameIndex = null;
        this.resizeObserver = null;

        // ループ用
        this.animationId = null;
        this.statusInterval = null;

        this.init();
    }

    init() {
        this.folderInput.addEventListener('change', (e) => this.handleFolderSelect(e));
        this.micStartBtn.addEventListener('click', () => this.startMicrophone());
        this.micStopBtn.addEventListener('click', () => this.stopMicrophone());
        this.micStopBtn.disabled = true;
        this.sensitivitySlider.addEventListener('input', (e) => {
            this.sensitivity = parseInt(e.target.value, 10);
            this.sensitivityValue.textContent = this.sensitivity;
        });
        if (this.hqAudioToggle) {
            this.hqAudioEnabled = this.hqAudioToggle.checked;
            this.mouthChangeMinMs = this.hqAudioEnabled ? 45 : 70;
            this.hqAudioToggle.addEventListener('change', (e) => {
                this.hqAudioEnabled = e.target.checked;
                this.mouthChangeMinMs = this.hqAudioEnabled ? 45 : 70;
                this.resetAudioStats();
                this.log(this.hqAudioEnabled ? 'HQ Audio: ON' : 'HQ Audio: OFF');
            });
        }
        this.startBtn.addEventListener('click', () => this.start());
        this.stopBtn.addEventListener('click', () => this.stop());

        this.loadMicDevices();

        window.addEventListener('resize', () => this.handleResize());
        window.addEventListener('beforeunload', () => this.cleanup());
        if ('ResizeObserver' in window) {
            this.resizeObserver = new ResizeObserver(() => this.handleResize());
            this.resizeObserver.observe(this.stage);
            this.resizeObserver.observe(this.video);
        }
    }

    log(msg) {
        console.log(msg);
        if (this.debugInfo) {
            this.debugInfo.textContent = msg;
        }
    }

    async loadMicDevices() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter((d) => d.kind === 'audioinput');

            this.micSelect.innerHTML = '';
            audioInputs.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `マイク ${i + 1}`;
                this.micSelect.appendChild(option);
            });
        } catch (err) {
            console.error('マイクアクセスエラー:', err);
        }
    }

    async handleFolderSelect(event) {
        const files = Array.from(event.target.files);
        this.log('ファイル数: ' + files.length);

        let videoFile = null;
        let trackFile = null;
        const spriteFiles = {};

        for (const file of files) {
            const name = file.name.toLowerCase();
            const path = file.webkitRelativePath.toLowerCase().replace(/\\/g, '/');

            if (name.includes('mouthless') && name.endsWith('.mp4')) {
                if (name.includes('h264') || !videoFile) {
                    videoFile = file;
                    this.log('動画発見: ' + file.name);
                }
            }
            if (name === 'mouth_track.json') {
                trackFile = file;
            }
            if (path.includes('/mouth/') || path.includes('\\mouth\\')) {
                if (name === 'closed.png') spriteFiles.closed = file;
                if (name === 'open.png') spriteFiles.open = file;
                if (name === 'half.png') spriteFiles.half = file;
                if (name === 'e.png') spriteFiles.e = file;
                if (name === 'u.png') spriteFiles.u = file;
            }
        }

        const missing = [];
        if (!videoFile) missing.push('*_mouthless.mp4');
        if (!trackFile) missing.push('mouth_track.json');
        if (!spriteFiles.closed) missing.push('mouth/closed.png');
        if (!spriteFiles.open) missing.push('mouth/open.png');

        if (missing.length > 0) {
            this.fileStatus.className = 'error';
            this.fileStatus.textContent = `不足: ${missing.join(', ')}`;
            return;
        }

        try {
            this.cleanup();
            this.log('動画読み込み中...');

            this.videoUrl = URL.createObjectURL(videoFile);
            this.video.src = this.videoUrl;
            this.video.loop = true;
            this.video.muted = true;
            this.video.playsInline = true;
            this.video.preload = 'auto';
            this.video.controls = false;

            await new Promise((resolve, reject) => {
                const onReady = () => {
                    this.log(
                        '動画準備完了: ' +
                            this.video.videoWidth +
                            'x' +
                            this.video.videoHeight
                    );
                    this.video.removeEventListener('canplaythrough', onReady);
                    this.video.removeEventListener('loadeddata', onReady);
                    resolve();
                };
                this.video.addEventListener('canplaythrough', onReady);
                this.video.addEventListener('loadeddata', onReady);
                this.video.onerror = (e) => {
                    this.log('動画エラー: ' + e.message);
                    reject(new Error('動画の読み込みに失敗'));
                };
                this.video.load();
            });

            this.mouthCanvas.width = this.video.videoWidth || 1;
            this.mouthCanvas.height = this.video.videoHeight || 1;
            if (this.mouthCtx) {
                this.mouthCtx.setTransform(1, 0, 0, 1, 0, 0);
                this.mouthCtx.imageSmoothingEnabled = true;
                this.mouthCtx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
            }

            const trackText = await trackFile.text();
            this.trackData = JSON.parse(trackText);
            this.log('トラッキング: ' + this.trackData.frames.length + 'フレーム');

            this.mouthSprites = {};
            this.mouthSpriteUrls = {};
            for (const [key, file] of Object.entries(spriteFiles)) {
                const img = await this.loadImage(file);
                this.mouthSprites[key] = img;
                this.mouthSpriteUrls[key] = img.src;
            }

            this.fileStatus.className = 'success';
            this.fileStatus.textContent = `読み込み完了: ${this.trackData.frames.length}フレーム, ${this.trackData.fps}fps (${this.video.videoWidth}x${this.video.videoHeight})`;

            this.micSection.style.display = 'block';
            this.previewSection.style.display = 'block';

            this.setMouthState('closed', true);
            this.renderPreview();
        } catch (err) {
            this.fileStatus.className = 'error';
            this.fileStatus.textContent = `読み込みエラー: ${err.message}`;
            console.error(err);
        }
    }

    loadImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
        });
    }

    cleanup() {
        this.stop();
        this.stopMicrophone();
        if (this.videoUrl) {
            URL.revokeObjectURL(this.videoUrl);
            this.videoUrl = null;
        }
        for (const url of Object.values(this.mouthSpriteUrls)) {
            if (url) URL.revokeObjectURL(url);
        }
        this.mouthSpriteUrls = {};
        this.mouthSprites = {};
        this.activeSprite = null;
        if (this.video) {
            this.video.removeAttribute('src');
            this.video.load();
        }
        if (this.mouthCtx && this.mouthCanvas) {
            this.mouthCtx.setTransform(1, 0, 0, 1, 0, 0);
            this.mouthCtx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
        }
    }

    async startMicrophone() {
        if (this.micStream) return;

        try {
            const deviceId = this.micSelect.value;
            const baseAudio = {};
            if (deviceId) {
                baseAudio.deviceId = { exact: deviceId };
            }
            let audioConstraints = { ...baseAudio };
            if (this.hqAudioEnabled) {
                audioConstraints.echoCancellation = false;
                audioConstraints.noiseSuppression = false;
                audioConstraints.autoGainControl = false;
            }
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({
                    audio: audioConstraints,
                });
            } catch (err) {
                if (this.hqAudioEnabled) {
                    console.warn(
                        'HQ Audio constraints failed, fallback to default:',
                        err
                    );
                    this.micStream = await navigator.mediaDevices.getUserMedia({
                        audio: baseAudio,
                    });
                } else {
                    throw err;
                }
            }

            this.micStartBtn.textContent = 'マイク接続中';
            this.micStartBtn.disabled = true;
            this.micStopBtn.disabled = false;

            this.resetAudioStats();
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (!this.audioContext.audioWorklet) {
                throw new Error('AudioWorklet未対応のブラウザです');
            }

            await this.audioContext.audioWorklet.addModule('audio-worklet.js');
            await this.audioContext.resume();

            const source = this.audioContext.createMediaStreamSource(this.micStream);
            this.workletNode = new AudioWorkletNode(this.audioContext, 'volume-analyzer');
            this.workletNode.port.onmessage = (event) => this.handleAudioData(event.data);

            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0;

            source.connect(this.workletNode);
            this.workletNode.connect(this.gainNode).connect(this.audioContext.destination);

        } catch (err) {
            console.error('マイク開始エラー:', err);
            this.stopMicrophone();
            alert('マイクの開始に失敗しました: ' + err.message);
        }
    }

    stopMicrophone() {
        if (this.workletNode) {
            try {
                this.workletNode.port.onmessage = null;
            } catch {
                // ignore
            }
            try {
                this.workletNode.disconnect();
            } catch {
                // ignore
            }
            this.workletNode = null;
        }

        if (this.gainNode) {
            try {
                this.gainNode.disconnect();
            } catch {
                // ignore
            }
            this.gainNode = null;
        }

        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }

        this.resetAudioStats();

        this.micStartBtn.textContent = 'マイクを開始';
        this.micStartBtn.disabled = false;
        this.micStopBtn.disabled = true;
    }

    resetAudioStats() {
        this.volume = 0;
        this.envelope = 0;
        this.noiseFloor = 0.002;
        this.levelPeak = 0.02;
        this.smoothedHighRatio = 0;
        if (this.volumeMeter) {
            this.volumeMeter.style.width = '0%';
        }
    }

    handleAudioData(data) {
        if (!data) return;

        if (this.hqAudioEnabled) {
            this.handleAudioDataHQ(data);
            return;
        }

        const smoothing = 0.2;
        const ratio = data.high / (data.low + data.high + 1e-6);
        this.volume = this.volume * (1 - smoothing) + data.rms * smoothing;
        this.smoothedHighRatio =
            this.smoothedHighRatio * (1 - smoothing) + ratio * smoothing;

        const thresholds = this.getVolumeThresholds();
        const meter = Math.min(100, (this.volume / (thresholds.half * 1.8)) * 100);
        this.volumeMeter.style.width = meter + '%';

        const nextState = this.selectMouthState(
            this.volume,
            this.smoothedHighRatio,
            thresholds
        );
        this.setMouthState(nextState);
    }

    handleAudioDataHQ(data) {
        const ratio = data.high / (data.low + data.high + 1e-6);
        const ratioSmoothing = 0.25;
        this.smoothedHighRatio =
            this.smoothedHighRatio * (1 - ratioSmoothing) +
            ratio * ratioSmoothing;

        const rms = data.rms;
        const sensitivity = this.sensitivity / 100;
        const attack = 0.35;
        const release = 0.6;
        const k = rms > this.envelope ? attack : release;
        this.envelope = this.envelope * (1 - k) + rms * k;

        if (!this.noiseFloor) {
            this.noiseFloor = this.envelope;
        }
        if (this.envelope < this.noiseFloor) {
            const fall = 0.25;
            this.noiseFloor = this.noiseFloor * (1 - fall) + this.envelope * fall;
        } else {
            const rise = 0.01;
            this.noiseFloor = this.noiseFloor * (1 - rise) + this.envelope * rise;
        }

        const peakDecay = 0.985;
        this.levelPeak = Math.max(this.envelope, this.levelPeak * peakDecay);
        const minRange = 0.006;
        if (this.levelPeak < this.noiseFloor + minRange) {
            this.levelPeak = this.noiseFloor + minRange;
        }

        const gateMargin = 0.002 + (1 - sensitivity) * 0.008;
        const gateLevel = this.noiseFloor + gateMargin;
        if (this.envelope < gateLevel) {
            this.volume = 0;
            this.volumeMeter.style.width = '0%';
            this.setMouthState('closed');
            return;
        }

        const rawLevel =
            (this.envelope - this.noiseFloor) / (this.levelPeak - this.noiseFloor);
        const level = Math.max(0, Math.min(1, rawLevel));
        const gain = 0.6 + sensitivity * 0.8;
        const shaped = Math.min(1, Math.pow(level, 0.75) * gain);

        this.volume = shaped;
        this.volumeMeter.style.width = Math.min(100, shaped * 100) + '%';

        const thresholds = this.getVolumeThresholdsHQ();
        const nextState = this.selectMouthStateHQ(
            shaped,
            this.smoothedHighRatio,
            thresholds
        );
        this.setMouthState(nextState);
    }

    getVolumeThresholds() {
        const sensitivity = this.sensitivity / 100;
        const closed = 0.008 + (1 - sensitivity) * 0.018;
        const half = 0.02 + (1 - sensitivity) * 0.06;
        return { closed, half };
    }

    getVolumeThresholdsHQ() {
        const sensitivity = this.sensitivity / 100;
        const closed = 0.07 + (1 - sensitivity) * 0.08;
        const half = 0.22 + (1 - sensitivity) * 0.12;
        return { closed, half };
    }

    selectMouthState(volume, highRatio, thresholds) {
        if (volume < thresholds.closed) return 'closed';
        if (volume < thresholds.half) return this.mouthSpriteUrls.half ? 'half' : 'open';

        if (highRatio > 0.62 && this.mouthSpriteUrls.e) return 'e';
        if (highRatio < 0.38 && this.mouthSpriteUrls.u) return 'u';
        return 'open';
    }

    selectMouthStateHQ(level, highRatio, thresholds) {
        const hasHalf = !!this.mouthSpriteUrls.half;
        const hasE = !!this.mouthSpriteUrls.e;
        const hasU = !!this.mouthSpriteUrls.u;

        const closeTh = Math.max(0.02, thresholds.closed - 0.03);
        const halfDownTh = Math.max(closeTh + 0.02, thresholds.half - 0.02);

        let state = this.mouthState;
        if (state === 'e' || state === 'u') {
            state = 'open';
        }

        if (state === 'closed') {
            if (level >= thresholds.half) {
                state = 'open';
            } else if (level >= thresholds.closed && hasHalf) {
                state = 'half';
            } else if (level >= thresholds.closed) {
                state = 'open';
            } else {
                state = 'closed';
            }
        } else if (state === 'half') {
            if (level < closeTh) {
                state = 'closed';
            } else if (level >= thresholds.half) {
                state = 'open';
            } else {
                state = 'half';
            }
        } else {
            if (level < closeTh) {
                state = 'closed';
            } else if (level < halfDownTh && hasHalf) {
                state = 'half';
            } else {
                state = 'open';
            }
        }

        if (state === 'open') {
            if (highRatio > 0.62 && hasE) return 'e';
            if (highRatio < 0.38 && hasU) return 'u';
        }
        return state;
    }

    setMouthState(state, force = false) {
        const sprite =
            this.mouthSprites[state] ||
            this.mouthSprites.open ||
            this.mouthSprites.closed;
        if (!sprite) return;

        const now = performance.now();
        if (
            !force &&
            state !== this.mouthState &&
            now - this.lastMouthChange < this.mouthChangeMinMs
        ) {
            return;
        }

        if (force || state !== this.mouthState) {
            this.mouthState = state;
            this.activeSprite = sprite;
            this.lastMouthChange = now;
        }
    }

    renderPreview() {
        if (!this.video || !this.trackData) return;
        this.video.pause();
        this.video.currentTime = 0;
        setTimeout(() => {
            this.renderFrame();
            this.log('プレビュー描画完了');
        }, 80);
    }

    async start() {
        if (!this.video || !this.trackData) {
            alert('先にデータフォルダを選択してください');
            return;
        }

        this.isRunning = true;
        this.startBtn.disabled = true;
        this.stopBtn.disabled = false;

        try {
            this.log('動画再生開始...');
            this.video.currentTime = 0;
            const playPromise = this.video.play();
            if (playPromise !== undefined) {
                await playPromise;
            }

            this.log(
                '再生中: paused=' +
                    this.video.paused +
                    ', readyState=' +
                    this.video.readyState +
                    ', size=' +
                    this.video.videoWidth +
                    'x' +
                    this.video.videoHeight
            );

            this.statusInterval = setInterval(() => {
                if (this.video && this.isRunning) {
                    this.log(
                        'time=' +
                            this.video.currentTime.toFixed(2) +
                            's, mouth=' +
                            this.mouthState +
                            ', vol=' +
                            this.volume.toFixed(3)
                    );
                }
            }, 500);

            this.startRenderLoop();
        } catch (err) {
            this.log('再生エラー: ' + err.message);
            console.error('動画再生エラー:', err);
            this.startRenderLoop();
        }
    }

    stop() {
        this.isRunning = false;
        this.startBtn.disabled = false;
        this.stopBtn.disabled = true;

        if (this.video) {
            this.video.pause();
        }
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
        }
    }

    startRenderLoop() {
        if (!this.isRunning) return;

        if (this.video.requestVideoFrameCallback) {
            const onFrame = () => {
                if (!this.isRunning) return;
                this.renderFrame();
                this.video.requestVideoFrameCallback(onFrame);
            };
            this.video.requestVideoFrameCallback(onFrame);
        } else {
            const loop = () => {
                if (!this.isRunning) return;
                this.renderFrame();
                this.animationId = requestAnimationFrame(loop);
            };
            loop();
        }
    }

    renderFrame() {
        const video = this.video;
        const data = this.trackData;

        if (!video || video.readyState < 2 || !data) return;

        const totalFrames = data.frames.length;
        if (!totalFrames) return;

        const currentTime = video.currentTime;
        const fps = data.fps || 30;
        const frameIndex = Math.floor(currentTime * fps) % totalFrames;
        this.lastFrameIndex = frameIndex;
        this.updateMouthTransform(frameIndex);
    }

    handleResize() {
        if (!this.trackData || !this.video || this.video.readyState < 2) return;
        const totalFrames = this.trackData.frames.length;
        if (!totalFrames) return;

        const frameIndex =
            this.lastFrameIndex !== null
                ? this.lastFrameIndex
                : Math.floor(this.video.currentTime * (this.trackData.fps || 30)) % totalFrames;
        this.updateMouthTransform(frameIndex);
    }

    updateMouthTransform(frameIndex) {
        const data = this.trackData;
        if (!data || !data.frames || data.frames.length === 0) return;
        if (!this.mouthCtx || !this.mouthCanvas) return;

        const frame = data.frames[frameIndex];
        const ctx = this.mouthCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
        if (!frame || !frame.valid) return;

        const sprite =
            this.activeSprite ||
            this.mouthSprites.open ||
            this.mouthSprites.closed;
        if (!sprite) return;

        const quad = frame.quad;
        const adjustedQuad = this.applyCalibrationToQuad(quad, data);
        this.drawWarpedSprite(sprite, adjustedQuad);
    }

    applyCalibrationToQuad(quad, data) {
        const calib = data.calibration || { offset: [0, 0], scale: 1, rotation: 0 };
        const applyCalib = data.calibrationApplied === true;
        if (!applyCalib) {
            return quad.map((pt) => [pt[0], pt[1]]);
        }

        const offsetX = calib.offset[0] || 0;
        const offsetY = calib.offset[1] || 0;
        const scale = calib.scale || 1;
        const rotation = ((calib.rotation || 0) * Math.PI) / 180;

        let cx = 0;
        let cy = 0;
        for (const [x, y] of quad) {
            cx += x;
            cy += y;
        }
        cx /= 4;
        cy /= 4;

        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);

        return quad.map(([x, y]) => {
            const dx = (x - cx) * scale;
            const dy = (y - cy) * scale;
            const rx = dx * cos - dy * sin + cx + offsetX;
            const ry = dx * sin + dy * cos + cy + offsetY;
            return [rx, ry];
        });
    }

    drawWarpedSprite(sprite, quad) {
        if (!this.mouthCtx) return;
        const sw = sprite.naturalWidth || sprite.width;
        const sh = sprite.naturalHeight || sprite.height;
        if (!sw || !sh) return;

        const s0 = [0, 0];
        const s1 = [sw, 0];
        const s2 = [sw, sh];
        const s3 = [0, sh];

        const q0 = quad[0];
        const q1 = quad[1];
        const q2 = quad[2];
        const q3 = quad[3];

        this.drawTriangle(sprite, s0, s1, s2, q0, q1, q2);
        this.drawTriangle(sprite, s0, s2, s3, q0, q2, q3);
    }

    drawTriangle(image, s0, s1, s2, d0, d1, d2) {
        if (!this.mouthCtx) return;
        const ctx = this.mouthCtx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.moveTo(d0[0], d0[1]);
        ctx.lineTo(d1[0], d1[1]);
        ctx.lineTo(d2[0], d2[1]);
        ctx.closePath();
        ctx.clip();

        const mat = this.computeAffine(s0, s1, s2, d0, d1, d2);
        if (!mat) {
            ctx.restore();
            return;
        }
        ctx.setTransform(mat.a, mat.b, mat.c, mat.d, mat.e, mat.f);
        ctx.drawImage(image, 0, 0);
        ctx.restore();
    }

    computeAffine(s0, s1, s2, d0, d1, d2) {
        const sx0 = s0[0];
        const sy0 = s0[1];
        const sx1 = s1[0];
        const sy1 = s1[1];
        const sx2 = s2[0];
        const sy2 = s2[1];

        const dx0 = d0[0];
        const dy0 = d0[1];
        const dx1 = d1[0];
        const dy1 = d1[1];
        const dx2 = d2[0];
        const dy2 = d2[1];

        const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
        if (denom === 0) return null;

        const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
        const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
        const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
        const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
        const e =
            (dx0 * (sx1 * sy2 - sx2 * sy1) +
                dx1 * (sx2 * sy0 - sx0 * sy2) +
                dx2 * (sx0 * sy1 - sx1 * sy0)) /
            denom;
        const f =
            (dy0 * (sx1 * sy2 - sx2 * sy1) +
                dy1 * (sx2 * sy0 - sx0 * sy2) +
                dy2 * (sx0 * sy1 - sx1 * sy0)) /
            denom;

        return { a, b, c, d, e, f };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new LipsyncEngine();
});
