/**
 * Cartesia speech service wrapper for text-to-speech and streaming speech-to-text.
 * Handles WebSocket based STT streaming, transcript aggregation, and TTS synthesis.
 */

'use strict';

require('dotenv').config();

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CartesiaClient } = require('@cartesia/cartesia-js');

const DEFAULT_TTS_MODEL = process.env.CARTESIA_TTS_MODEL_ID || 'sonic-2';
const DEFAULT_STT_MODEL = process.env.CARTESIA_STT_MODEL_ID || 'ink-whisper';
const DEFAULT_VOICE_ID = process.env.CARTESIA_VOICE_ID || '694f9389-aac1-45b6-b726-9d9369183238';

class CartesiaSpeechService extends EventEmitter {
    constructor() {
        super();

        this.client = null;
        this.sttWs = null;
        this.pendingSend = Promise.resolve();
        this.sampleRate = 24000;
        this.language = 'en';
        this.debounceMs = 1200;
        this.batchTimer = null;
        this.batchSegments = [];
        this.warnedMissingApiKey = false;
        this.isStreaming = false;
    }

    async ensureClient() {
        if (this.client) {
            return true;
        }

        const apiKey = process.env.CARTESIA_API_KEY;

        if (!apiKey) {
            if (!this.warnedMissingApiKey) {
                console.warn('[Cartesia] Missing CARTESIA_API_KEY; speech features disabled.');
                this.warnedMissingApiKey = true;
            }
            return false;
        }

        try {
            this.client = new CartesiaClient({ apiKey });
            // Client initialized silently
            return true;
        } catch (error) {
            console.error('[Cartesia] Failed to initialize client:', error.message || error);
            this.client = null;
            return false;
        }
    }

    async startTranscription(options = {}) {
        console.log(`🎙️ [Cartesia] Starting transcription with options:`, options);
        
        if (this.sttWs) {
            console.log(`⚠️ [Cartesia] WebSocket already exists, skipping initialization`);
            return true;
        }

        const ready = await this.ensureClient();
        if (!ready) {
            console.log(`❌ [Cartesia] Client not ready, cannot start transcription`);
            return false;
        }

        const {
            sampleRate = 24000,
            language = 'en',
            minVolume = 0.1,
            maxSilenceDurationSecs = 2.0,
            debounceMs = 1200,
        } = options;

        this.sampleRate = sampleRate;
        this.language = (language || 'en').split('-')[0];
        this.debounceMs = debounceMs;
        this.resetBatch();

        console.log(`🔧 [Cartesia] Config: sampleRate=${this.sampleRate}, language=${this.language}, debounceMs=${this.debounceMs}`);

        try {
            this.sttWs = this.client.stt.websocket({
                model: DEFAULT_STT_MODEL,
                language: this.language,
                encoding: 'pcm_s16le',
                sampleRate: this.sampleRate,
                minVolume,
                maxSilenceDurationSecs,
            });

        this.sttWs.onMessage(message => {
            try {
                this.handleSttMessage(message);
            } catch (err) {
                console.error('[Cartesia] Error handling STT message:', err);
            }
        });

            this.pendingSend = Promise.resolve();
            this.isStreaming = true;
            console.log(`✅ [Cartesia] STT WebSocket initialized successfully`);
            return true;
        } catch (error) {
            console.error('[Cartesia] Failed to start STT websocket:', error.message || error);
            this.sttWs = null;
            return false;
        }
    }

    handleSttMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }

        if (message.type === 'transcript') {
            const text = (message.text || '').trim();
            if (!text) {
                return;
            }

            if (message.isFinal) {
                console.log(`[Cartesia STT][FINAL] ${text}`);
                this.emit('final-transcript', text, message);
                this.enqueueBatch(text);
            } else {
                this.emit('interim-transcript', text, message);
            }
            return;
        }

        if (message.type === 'flush_done') {
            this.emit('stt-flush');
            return;
        }

        if (message.type === 'done') {
            const combined = this.flushBatch();
            if (combined) {
                this.emit('transcript-complete', combined);
            }
            this.emit('stt-complete');
            return;
        }

        if (message.type === 'error') {
            console.error('[Cartesia STT] Error:', message.message || message);
            this.emit('stt-error', message);
        }
    }

    enqueueBatch(segment) {
        if (!segment) {
            return;
        }

        this.batchSegments.push(segment);

        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
        }

        this.batchTimer = setTimeout(() => {
            const combined = this.flushBatch();
            if (combined) {
                this.emit('transcript-batch', combined);
            }
        }, this.debounceMs);
    }

    flushBatch() {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        if (this.batchSegments.length === 0) {
            return '';
        }

        const combined = this.batchSegments.join(' ').replace(/\s+/g, ' ').trim();
        this.batchSegments = [];
        return combined;
    }

    resetBatch() {
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        this.batchSegments = [];
    }

    enqueueBase64Audio(base64Data) {
        if (!base64Data || typeof base64Data !== 'string') {
            return false;
        }

        try {
            const buffer = Buffer.from(base64Data, 'base64');
            return this.enqueueAudioChunk(buffer);
        } catch (error) {
            console.error('[Cartesia] Failed to decode base64 audio chunk:', error);
            return false;
        }
    }

    enqueueAudioChunk(buffer) {
        if (!this.sttWs || !buffer || buffer.length === 0) {
            return false;
        }

        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

        this.pendingSend = this.pendingSend
            .then(() => {
                return this.sttWs.send(arrayBuffer);
            })
            .catch(error => {
                console.error('[Cartesia] Error sending audio chunk:', error);
            });

        return true;
    }

    async finalizeTranscription() {
        if (!this.sttWs) {
            return;
        }

        try {
            await this.pendingSend;
            if (typeof this.sttWs.finalize === 'function') {
                await this.sttWs.finalize();
            }
        } catch (error) {
            console.error('[Cartesia] Error during STT finalization:', error);
        }
    }

    async stopTranscription(options = {}) {
        if (!this.sttWs) {
            return;
        }

        const { flush = true } = options;

        try {
            if (flush) {
                await this.finalizeTranscription();
            }

            if (typeof this.sttWs.done === 'function') {
                await this.sttWs.done();
            }
        } catch (error) {
            console.error('[Cartesia] Error stopping STT websocket:', error);
        }

        try {
            if (typeof this.sttWs.disconnect === 'function') {
                this.sttWs.disconnect();
            }
        } catch (error) {
            console.error('[Cartesia] Error disconnecting STT websocket:', error);
        }

        this.sttWs = null;
        this.isStreaming = false;
        this.resetBatch();
        // STT streaming stopped silently
    }

    async synthesizeSpeech(text, options = {}) {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) {
            return null;
        }

        const ready = await this.ensureClient();
        if (!ready) {
            return null;
        }

        const {
            modelId = DEFAULT_TTS_MODEL,
            voice,
            voiceId = DEFAULT_VOICE_ID,
            language = 'en',
            outputFormat = null,
            sampleRate = 44100,
        } = options;

        const normalizedLanguage = language.split('-')[0];

        const request = {
            modelId,
            transcript: trimmed,
            voice: voice || {
                mode: 'id',
                id: voiceId,
            },
            language: normalizedLanguage,
            outputFormat:
                outputFormat || {
                    container: 'wav',
                    sampleRate,
                    encoding: 'pcm_f32le',
                },
        };

        try {
            const response = await this.client.tts.bytes(request);
            return Buffer.from(response);
        } catch (error) {
            console.error('[Cartesia] TTS synthesis error:', error.message || error);
            return null;
        }
    }

    async synthesizeSpeechToFile(text, options = {}) {
        const buffer = await this.synthesizeSpeech(text, options);
        if (!buffer) {
            return null;
        }

        const {
            filePath = path.join(os.tmpdir(), `cartesia-tts-${Date.now()}.wav`),
        } = options;

        try {
            await fs.promises.writeFile(filePath, buffer);
            return filePath;
        } catch (error) {
            console.error('[Cartesia] Failed to write synthesized audio to disk:', error);
            return null;
        }
    }
}

const cartesiaSpeechService = new CartesiaSpeechService();

module.exports = {
    cartesiaSpeechService,
};

