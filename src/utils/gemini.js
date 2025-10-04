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
const { getSystemPrompt } = require('./prompts');

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
    autoResponseEnabled: false, // Default to disabled
};

// Audio capture variables
let systemAudioProc = null;

// Response helpers
let lastProcessedTranscript = '';
const recentTranscripts = new Set();
let ttsQueue = Promise.resolve();

// Throttling variables
let lastMicLogTime = 0;

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

async function respondWithCerebras(transcript, searchSummary = null, options = {}) {
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
        
        // Send response with source information
        if (options.source === 'chat') {
            sendToRenderer('update-response', { reply, source: 'chat' });
        } else {
            sendToRenderer('update-response', reply); // Default behavior for backward compatibility
        }
        
        saveConversationTurn(transcript, reply);
        queueTtsSynthesis(reply);
        sendToRenderer('update-status', 'Listening...');
        console.log(`[Cerebras] Completed respondWithCerebras successfully`);
    } catch (error) {
        console.error('[Cerebras] Error in respondWithCerebras:', error);
        sendToRenderer('update-status', 'Listening...');
    }
}

function shouldGenerateResponse(transcript, options = {}) {
    // Always generate response for manual user input
    if (options.isManual) {
        return true;
    }
    
    // Check if automatic responses are disabled via session state
    if (sessionState.autoResponseEnabled === false) {
        return false;
    }
    
    // Skip trivial single words or very short phrases
    const words = transcript.split(/\s+/).filter(w => w.length > 0);
    if (words.length <= 3) {
        // Skip common trivial phrases
        const trivialPhrases = [
            'ok', 'yes', 'no', 'uh', 'um', 'well', 'right', 'alright', 'hello', 'hi',
            'thank you', 'thanks', 'bye', 'goodbye', 'see you', 'next', 'continue',
            'ready', 'go', 'start', 'stop', 'pause', 'time', 'minutes', 'seconds',
            'hour', 'late', 'early', 'good', 'bad', 'fine', 'great', 'excellent'
        ];
        
        const lowercase = transcript.toLowerCase().trim();
        if (trivialPhrases.includes(lowercase)) {
            return false;
        }
    }
    
    // Skip very short content (less than 15 characters)
    if (transcript.length < 15) {
        return false;
    }
    
    // Skip audio/video announcements (common in meetings, presentations)
    const announcementPatterns = [
        /(\d+)\s*(minute|second)s?\s*on\s*the\s*clock/i,
        /(mute|unmute|audio|video|screen|share)/i,
        /(please|let|allow|give|take)\s*(us|me|him|her)\s*(the|a|an)\s*\w+/i,
        /(this is|that is|we have|they have)\s*(a|an)\s*\w+/i,
        /recording|record/i,
    ];
    
    for (const pattern of announcementPatterns) {
        if (pattern.test(transcript)) {
            return false;
        }
    }
    
    // Skip simple acknowledgments
    const acknowledgmentPatterns = [
        /^(alright|okay|ok|yes|sure|yep|right)\s*,?\s*(let|we|let's)/i,
        /^(let|we|let's)\s*(go|see|do|try|start|begin)/i,
        /^(good|great|excellent|perfect|wonderful)\s*,?/i,
        /^(i|we|you|he|she|they)\s*(think|believe|feel|know)\s*(so|that)/i,
    ];
    
    for (const pattern of acknowledgmentPatterns) {
        if (pattern.test(transcript.trim())) {
            return false;
        }
    }
    
    // Default to generating response for substantial content
    return true;
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

    console.log(`🎤 [Audio Processing] Raw transcript captured: "${cleaned}"`);
    console.log(`📈 [Audio Processing] Length: ${cleaned.length} characters, Quality: ${cleaned.length > 20 ? 'Good' : 'Short'}`);

    // Always save transcript to conversation history (separate from chat messages)
    saveConversationTurn(cleaned, '');
    
    // Send transcript to renderer to be stored in transcriptMessages array
    sendToRenderer('transcript-captured', {
        transcript: cleaned,
        timestamp: Date.now(),
        source: 'audio'
    });
    
    console.log(`📤 [Audio Processing] Transcript forwarded to UI`);
    
    // Only generate AI response for significant content that warrants a response
    if (shouldGenerateResponse(cleaned, options)) {
        console.log(`[Decision] Generating Cerebras response for: "${cleaned}"`);
        try {
            await respondWithCerebras(cleaned);
        } catch (error) {
            console.error('Error generating Cerebras response:', error);
        }
    } else {
        console.log(`[Decision] Skipping Cerebras response for: "${cleaned}" (trivial content)`);
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

    console.log('🎤 Starting macOS audio capture with SystemAudioDump...');

    // Define audio constants first
    const OUTPUT_SAMPLE_RATE = parseInt(process.env.MAC_AUDIO_SAMPLE_RATE || String(DEFAULT_SAMPLE_RATE), 10);
    const CHANNELS = parseInt(process.env.MAC_AUDIO_CHANNELS || '2', 10);
    const BYTES_PER_SAMPLE = 2;
    const CHUNK_DURATION = 0.1;
    const CHUNK_SIZE = Math.round(OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION);

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

    const spawnArgs = [];

    console.log(
        `🎤 [SystemAudioDump] Starting audio capture (${OUTPUT_SAMPLE_RATE}Hz, ${CHANNELS} channel${CHANNELS !== 1 ? 's' : ''})`
    );

    systemAudioProc = spawn(systemAudioPath, spawnArgs, spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('❌ [SystemAudioDump] Failed to start SystemAudioDump');
        return false;
    }

    console.log(`✅ [SystemAudioDump] Started with PID: ${systemAudioProc.pid}`);

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

        const maxBufferSize = OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS;
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
        const rightSample = stereoBuffer.readInt16LE(i * 4 + 2);
        const monoSample = Math.max(-32768, Math.min(32767, Math.round((leftSample + rightSample) / 2)));
        monoBuffer.writeInt16LE(monoSample, i * 2);
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
    // Auto-initialize Composio if API key is available
    async function autoInitializeComposio() {
        const composioApiKey = process.env.COMPOSIO_API_KEY;
        if (composioApiKey && !composioService.isServiceInitialized()) {
            console.log('Auto-initializing Composio service with environment API key...');
            const success = await composioService.initialize(composioApiKey, process.env.GEMINI_API_KEY);
            if (success) {
                console.log('Composio service auto-initialized successfully');
            } else {
                console.warn('Failed to auto-initialize Composio service');
            }
        }
    }

    // Initialize Composio on startup
    autoInitializeComposio();

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, composioApiKey = null) => {
        sendToRenderer('session-initializing', true);

        sessionState = {
            ...sessionState,
            customPrompt: customPrompt || '',
            geminiApiKey: apiKey || process.env.GEMINI_API_KEY || null,
            active: true,
        };

        sessionState.googleSearchEnabled = (await getStoredSetting('googleSearchEnabled', 'true')) === 'true';
        sessionState.autoResponseEnabled = (await getStoredSetting('autoResponseEnabled', 'false')) === 'true';

        initializeNewSession();

        await cartesiaSpeechService.startTranscription({
            sampleRate: DEFAULT_SAMPLE_RATE,
            language: 'en-US',
            debounceMs: 1200,
        });

        // Initialize Composio if API key is provided and service is not already initialized
        if (composioApiKey && !composioService.isServiceInitialized()) {
            console.log('Initializing Composio service with provided API key...');
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

    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        // Throttled microphone logging (once per second)
        if (data && typeof data === 'string') {
            const now = Date.now();
            if (now - lastMicLogTime >= 1000) {
                console.log(`[Mic Audio Received] ${mimeType || 'audio/pcm'}, Base64 length: ${data.length}`);
                lastMicLogTime = now;
            }
            
            // Optional: Send to Cartesia for transcription if configured to use mic-only mode
            if (sessionState.active) {
                try {
                    cartesiaSpeechService.enqueueBase64Audio(data);
                } catch (error) {
                    console.error('[Mic Audio] Error sending to Cartesia:', error);
                }
            }
        }
        
        return { success: true };
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

        // For manual chat messages, generate immediate response and mark as chat
        console.log(`[Chat Message] Processing manual chat: "${text}"`);
        try {
            await respondWithCerebras(text, null, { source: 'chat' });
            return { success: true };
        } catch (error) {
            console.error('Error handling chat message:', error);
            return { success: false, error: error.message };
        }
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

    ipcMain.handle('update-auto-response-setting', async (event, enabled) => {
        sessionState.autoResponseEnabled = enabled;
        console.log(`[Auto Response] Setting updated: ${enabled ? 'enabled' : 'disabled'}`);
        return { success: true };
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

    ipcMain.handle('check-composio-status', async () => {
        try {
            const isInitialized = composioService.isServiceInitialized();
            return { 
                success: true, 
                isInitialized,
                message: isInitialized ? 'Composio service is initialized' : 'Composio service is not initialized'
            };
        } catch (error) {
            console.error('Error checking Composio status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-composio-connectors', async () => {
        try {
            const connectors = composioService.getAvailableConnectors();
            return { success: true, connectors };
        } catch (error) {
            console.error('Error fetching Composio connectors:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('connect-composio-connector', async (event, externalUserId, connectorKey, options = {}) => {
        try {
            const result = await composioService.connectConnector(externalUserId, connectorKey, options);
            return result;
        } catch (error) {
            console.error('Error connecting Composio connector:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('wait-composio-connection', async (event, externalUserId, connectorKey) => {
        try {
            const result = await composioService.waitForConnectorConnection(externalUserId, connectorKey);
            return result;
        } catch (error) {
            console.error('Error waiting for Composio connection:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-composio-connector-status', async (event, externalUserId, connectorKey) => {
        try {
            const result = await composioService.getConnectorStatus(externalUserId, connectorKey);
            return result;
        } catch (error) {
            console.error('Error getting Composio connector status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('disconnect-composio-connector', async (event, externalUserId, connectorKey) => {
        try {
            const result = await composioService.disconnectConnector(externalUserId, connectorKey);
            return result;
        } catch (error) {
            console.error('Error disconnecting Composio connector:', error);
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
