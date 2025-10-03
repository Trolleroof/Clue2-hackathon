/**
 * Assistant orchestration layer powered by Cartesia (speech) and Cerebras (LLM).
 * Google Gemini is only used for the Google Search tool when transcripts require web lookups.
 */

'use strict';

const { GoogleGenAI } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');

const { saveDebugAudio } = require('../audioUtils');
const { cartesiaSpeechService } = require('./cartesia');
const { cerebrasService } = require('./cerebras');
const { composioService } = require('./composio');
// Removed prompts dependency

// Audio / transcription configuration
const DEFAULT_SAMPLE_RATE = 24000;
const ACTIVE_AUDIO_SOURCE = 'system'; // Persist only the faster system capture path

// Conversation tracking variables
let currentSessionId = null;
let conversationHistory = [];
let sessionState = {
    customPrompt: '', // User's custom AI instructions
    googleSearchEnabled: true,
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    active: false,
};

// Audio capture variables
let systemAudioProc = null;

// Response helpers
let lastProcessedTranscript = '';
const recentTranscripts = new Set();
let ttsQueue = Promise.resolve();

// Google Search state (Gemini used strictly for search tool)
const searchState = {
    client: null,
    apiKey: null,
    model: null,
};

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

cartesiaSpeechService.on('final-transcript', transcript => {
    handleCartesiaTranscript(transcript, { isFinal: true }).catch(error => {
        console.error('Cartesia transcript handler failed:', error);
    });
});

cartesiaSpeechService.on('stt-error', error => {
    console.error('Cartesia STT error reported:', error?.message || error);
});

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

function initializeNewSession() {
    currentSessionId = Date.now().toString();
    conversationHistory = [];
    lastProcessedTranscript = '';
    recentTranscripts.clear();
    console.log('New conversation session started:', currentSessionId);
}

function saveConversationTurn(transcription, aiResponse = '') {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: (aiResponse || '').toString().trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        return stored || '${defaultValue}';
                    } catch (e) {
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    return defaultValue;
}

function buildCerebrasHistory() {
    const history = [];
    for (const turn of conversationHistory) {
        if (turn.transcription) {
            history.push({ role: 'user', content: turn.transcription });
        }
        if (turn.ai_response) {
            history.push({ role: 'assistant', content: turn.ai_response });
        }
    }
    return history;
}

function classifyTranscript(text) {
    const normalized = text.toLowerCase();
    switch (true) {
        case /\bsearch\b|\blook up\b|\bgoogle\b|\bfind\b/.test(normalized):
        case /\bwhat is\b|\bwho is\b|\bwhen is\b|\bwhere is\b|\bhow do\b/.test(normalized):
        case normalized.endsWith('?'):
            return 'SEARCH';
        default:
            return 'RESPOND';
    }
}

async function ensureSearchModel(apiKey) {
    const finalKey = apiKey || process.env.GEMINI_API_KEY;
    if (!finalKey) {
        console.warn('Google Search requested but no GEMINI_API_KEY is available.');
        return null;
    }

    if (!searchState.client || searchState.apiKey !== finalKey) {
        searchState.client = new GoogleGenAI({ apiKey: finalKey });
        searchState.apiKey = finalKey;
        searchState.model = searchState.client.getGenerativeModel({
            model: 'gemini-1.5-flash',
            tools: [{ googleSearch: {} }],
        });
    }

    return searchState.model;
}

function extractTextFromGeminiResponse(response) {
    if (!response) {
        return '';
    }

    if (typeof response.text === 'function') {
        return response.text();
    }

    if (response.response && typeof response.response.text === 'function') {
        return response.response.text();
    }

    if (Array.isArray(response.candidates)) {
        const parts = [];
        for (const candidate of response.candidates) {
            if (!candidate || !Array.isArray(candidate.content?.parts)) {
                continue;
            }
            for (const part of candidate.content.parts) {
                if (part?.text) {
                    parts.push(part.text);
                }
            }
        }
        return parts.join('\n');
    }

    return '';
}

async function performGoogleSearch(query) {
    if (!sessionState.googleSearchEnabled) {
        return null;
    }

    const model = await ensureSearchModel(sessionState.geminiApiKey);
    if (!model) {
        return null;
    }

    try {
        const prompt = `Use Google Search to gather the most current, factual highlights for the following request. ` +
            `Return a concise bulleted summary with sources when possible.\n\nRequest: ${query}`;

        const response = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        const summary = extractTextFromGeminiResponse(response);
        if (summary) {
            console.log('[Google Search] Summary:', summary);
            return summary.trim();
        }
        } catch (error) {
        console.error('Google Search failed:', error.message || error);
    }

    return null;
}

function queueTtsSynthesis(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length < 12) {
        return;
    }

    ttsQueue = ttsQueue
        .catch(() => {})
        .then(async () => {
            try {
                const audioPath = await cartesiaSpeechService.synthesizeSpeechToFile(trimmed);
                if (audioPath) {
                    // TTS synthesis completed silently
                }
            } catch (error) {
                console.error('Cartesia TTS synthesis failed:', error.message || error);
            }
        });
}

async function respondWithCerebras(transcript, searchSummary = null) {
    console.log(`[Cerebras] Starting respondWithCerebras for: "${transcript.substring(0, 50)}..."`);
    
    const history = buildCerebrasHistory();
    const systemPrompt = getSystemPrompt('default', sessionState.customPrompt, sessionState.googleSearchEnabled);

    const context = searchSummary
        ? `${transcript}\n\nWeb search context:\n${searchSummary}`
        : transcript;

    sendToRenderer('update-status', 'Responding...');

    try {
        const reply = await cerebrasService.generateReply(context, {
            history,
            systemPrompt,
        });

        if (!reply) {
            console.log('[Cerebras] No reply generated');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        console.log(`[Cerebras] Sending response to renderer: "${reply.substring(0, 100)}..."`);
        sendToRenderer('update-response', reply);
        saveConversationTurn(transcript, reply);
        queueTtsSynthesis(reply);
        sendToRenderer('update-status', 'Listening...');
        console.log(`[Cerebras] Completed respondWithCerebras successfully`);
    } catch (error) {
        console.error('[Cerebras] Error in respondWithCerebras:', error);
        sendToRenderer('update-status', 'Listening...');
    }
}

async function handleCartesiaTranscript(rawTranscript, options = {}) {
    if (!sessionState.active) {
        return;
    }

    const cleaned = typeof rawTranscript === 'string' ? rawTranscript.replace(/\s+/g, ' ').trim() : '';
    if (!cleaned || cleaned.length < 4) {
        return;
    }

    if (cleaned === lastProcessedTranscript) {
        return;
    }

    if (recentTranscripts.has(cleaned)) {
        return;
    }

    if (recentTranscripts.size > 12) {
        const iterator = recentTranscripts.values();
        const first = iterator.next().value;
        if (first) {
            recentTranscripts.delete(first);
        }
    }

    recentTranscripts.add(cleaned);
    lastProcessedTranscript = cleaned;

    console.log(`[Cartesia Transcript] ${cleaned}`);

    // Save transcript and generate AI response automatically
    saveConversationTurn(cleaned, '');
    
    // Generate AI response using Cerebras
    try {
        await respondWithCerebras(cleaned);
    } catch (error) {
        console.error('Error generating Cerebras response:', error);
    }
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', () => resolve());
        killProc.on('error', () => resolve());

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture() {
    if (process.platform !== 'darwin') {
        return false;
    }

    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PROCESS_NAME: 'AudioService',
            APP_NAME: 'System Audio Service',
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHANNELS = 2;
    const BYTES_PER_SAMPLE = 2;
    const CHUNK_DURATION = 0.1;
    const CHUNK_SIZE = DEFAULT_SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const base64Data = monoChunk.toString('base64');

            if (ACTIVE_AUDIO_SOURCE === 'system') {
                cartesiaSpeechService.enqueueBase64Audio(base64Data);
            }

            // Do not persist audio to disk; keep system lightweight
        }

        const maxBufferSize = DEFAULT_SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }

    cartesiaSpeechService.stopTranscription({ flush: true }).catch(error => {
        if (error) {
            console.error('Error stopping Cartesia STT:', error);
        }
    });
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, composioApiKey = null) => {
        sendToRenderer('session-initializing', true);

        sessionState = {
            ...sessionState,
            customPrompt: customPrompt || '',
            geminiApiKey: apiKey || process.env.GEMINI_API_KEY || null,
            active: true,
        };

        sessionState.googleSearchEnabled = (await getStoredSetting('googleSearchEnabled', 'true')) === 'true';

        initializeNewSession();

        await cartesiaSpeechService.startTranscription({
            sampleRate: DEFAULT_SAMPLE_RATE,
            language: 'en-US',
            debounceMs: 1200,
        });

        if (composioApiKey && !composioService.isServiceInitialized()) {
            console.log('Initializing Composio service...');
            await composioService.initialize(composioApiKey, sessionState.geminiApiKey);
        }

        geminiSessionRef.current = {
            close: async () => {
                await cartesiaSpeechService.stopTranscription({ flush: true });
                sessionState.active = false;
            },
        };

        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Listening...');

        return true;
    });

    ipcMain.handle('send-audio-content', async (event, { data }) => {
        if (!sessionState.active) {
            return { success: false, error: 'No active session' };
        }

        try {
            if (ACTIVE_AUDIO_SOURCE === 'system' && typeof data === 'string') {
                cartesiaSpeechService.enqueueBase64Audio(data);
            }
            return { success: true };
        } catch (error) {
            console.error('Error handling system audio chunk:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-mic-audio-content', async () => {
        // Mic channel ignored intentionally to avoid duplicate transcripts
        return { success: true, skipped: true };
    });

    ipcMain.handle('send-image-content', async () => {
        return { success: false, error: 'Image input is disabled when Gemini realtime is not in use.' };
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!sessionState.active) {
            return { success: false, error: 'No active session' };
        }

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        // Treat explicit user text as a transcript line unless user requests a response via generate-ai-response
        await handleCartesiaTranscript(text, { isManual: true });
        return { success: true };
    });

    // Optional: generate an AI response on-demand when explicitly requested by the renderer.
    ipcMain.handle('generate-ai-response', async (event, prompt) => {
        if (!sessionState.active) {
            return { success: false, error: 'No active session' };
        }

        const text = (prompt && typeof prompt === 'string' && prompt.trim().length > 0)
            ? prompt.trim()
            : lastProcessedTranscript;

        if (!text) {
            return { success: false, error: 'No transcript to respond to' };
        }

        try {
            await respondWithCerebras(text);
            return { success: true };
        } catch (error) {
            console.error('AI response error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async () => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture();
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async () => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async () => {
        try {
            stopMacOSAudioCapture();
            sessionState.active = false;
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async () => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async () => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            sessionState.googleSearchEnabled = enabled === true || enabled === 'true';
            console.log('Google Search setting updated to:', sessionState.googleSearchEnabled);
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('initialize-composio', async (event, composioApiKey, geminiApiKey = null) => {
        try {
            const finalGeminiApiKey = geminiApiKey || sessionState.geminiApiKey || process.env.GEMINI_API_KEY;
            const success = await composioService.initialize(composioApiKey, finalGeminiApiKey);
            return { success };
        } catch (error) {
            console.error('Error initializing Composio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('connect-gmail', async (event, externalUserId, authConfigId) => {
        try {
            const result = await composioService.connectGmail(externalUserId, authConfigId);
            return result;
        } catch (error) {
            console.error('Error connecting Gmail:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-gmail-connection-status', async (event, externalUserId) => {
        try {
            const result = await composioService.getGmailConnectionStatus(externalUserId);
            return result;
        } catch (error) {
            console.error('Error getting Gmail connection status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('execute-email-task', async (event, externalUserId, task, tools) => {
        try {
            const result = await composioService.executeEmailTaskWithAgent(externalUserId, task, tools);
            return result;
        } catch (error) {
            console.error('Error executing email task:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('analyze-email-intent', async (event, prompt) => {
        try {
            console.log(`[Email Analysis] Checking email intent for: "${prompt.substring(0, 50)}..."`);
            const analysisPrompt = `Reply strictly with YES or NO. Does the following email request require sending or drafting an email?\n\n${prompt}`;
            const response = await cerebrasService.generateReply(analysisPrompt, {
                temperature: 0,
                maxTokens: 5,
                systemPrompt: 'You are an intent classifier that only answers YES or NO.',
            });

            const normalized = (response || '').trim().toUpperCase();
            const result = normalized.startsWith('Y') ? 'YES' : 'NO';
            console.log(`[Email Analysis] Result: ${result} for "${prompt.substring(0, 50)}..."`);
            return { success: true, result };
        } catch (error) {
            console.error('Error analyzing email intent:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    formatSpeakerResults,
    sendToRenderer,
    stopMacOSAudioCapture,
    setupGeminiIpcHandlers,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
};
