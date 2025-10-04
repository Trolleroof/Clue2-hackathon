/**
 * Composio service for managing third-party connectors via the Composio API.
 * Handles authentication, connection workflows, and basic status tracking.
 */

// Load environment variables
require('dotenv').config();

const CONNECTORS = [
    {
        key: 'linear',
        displayName: 'Linear',
        authConfigId: 'ac_C5mpd5r37bH4',
        logoUrl: 'https://logos.composio.dev/api/linear',
        authType: 'OAUTH2'
    },
    {
        key: 'googleDocs',
        displayName: 'Google Docs',
        authConfigId: 'ac_SMDf4M_jKYE1',
        logoUrl: 'https://logos.composio.dev/api/googledocs',
        authType: 'OAUTH2'
    },
    {
        key: 'twitter',
        displayName: 'Twitter',
        authConfigId: 'ac_pTUxOmkyKFHJ',
        logoUrl: 'https://logos.composio.dev/api/twitter',
        authType: 'OAUTH2'
    },
    {
        key: 'googleSheets',
        displayName: 'Google Sheets',
        authConfigId: 'ac__DPVy8XWTDGX',
        logoUrl: 'https://logos.composio.dev/api/googlesheets',
        authType: 'OAUTH2'
    },
    {
        key: 'googleSlides',
        displayName: 'Google Slides',
        authConfigId: 'ac_b9UhoJR0WgT3',
        logoUrl: 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/google-slides.svg',
        authType: 'OAUTH2'
    },
    {
        key: 'github',
        displayName: 'GitHub',
        authConfigId: 'ac_b7RFgtr7s1Uf',
        logoUrl: 'https://logos.composio.dev/api/github',
        authType: 'OAUTH2'
    },
    {
        key: 'googleDrive',
        displayName: 'Google Drive',
        authConfigId: 'ac_0yXGuyFmAacK',
        logoUrl: 'https://logos.composio.dev/api/googledrive',
        authType: 'OAUTH2'
    },
    {
        key: 'linkedin',
        displayName: 'LinkedIn',
        authConfigId: 'ac_9NVcBfIIjuMU',
        logoUrl: 'https://logos.composio.dev/api/linkedin',
        authType: 'OAUTH2'
    },
    {
        key: 'slack',
        displayName: 'Slack',
        authConfigId: 'ac_ohDLI9rewHgG',
        logoUrl: 'https://logos.composio.dev/api/slack',
        authType: 'OAUTH2'
    },
    {
        key: 'gmail',
        displayName: 'Gmail',
        authConfigId: 'ac_AEOPhhO57Zsk',
        logoUrl: 'https://logos.composio.dev/api/gmail',
        authType: 'OAUTH2'
    }
];

const CONNECTOR_LOOKUP = new Map(CONNECTORS.map(connector => [connector.key, connector]));
const CONNECTOR_BY_AUTH_ID = new Map(CONNECTORS.map(connector => [connector.authConfigId, connector]));

class ComposioService {
    constructor() {
        this.composio = null;
        this.connectionSessions = new Map(); // Store connection attempts keyed by user+connector
        this.isInitialized = false;
        this.geminiClient = null;
    }

    _getSessionKey(externalUserId, connectorKey) {
        return `${externalUserId}::${connectorKey}`;
    }

    _resolveConnector(connectorKey, authConfigIdOverride = null) {
        if (connectorKey && CONNECTOR_LOOKUP.has(connectorKey)) {
            return CONNECTOR_LOOKUP.get(connectorKey);
        }
        if (authConfigIdOverride && CONNECTOR_BY_AUTH_ID.has(authConfigIdOverride)) {
            return CONNECTOR_BY_AUTH_ID.get(authConfigIdOverride);
        }
        throw new Error(`Unknown Composio connector: ${connectorKey || authConfigIdOverride}`);
    }

    getAvailableConnectors() {
        return CONNECTORS.map(({ key, displayName, authConfigId, logoUrl, authType }) => ({
            key,
            displayName,
            authConfigId,
            logoUrl,
            authType
        }));
    }

    /**
     * Initialize Composio with API key using Google provider
     * @param {string} apiKey - Composio API key
     * @param {string} geminiApiKey - Google Gemini API key (optional, will use process.env.GEMINI_API_KEY if not provided)
     */
    async initialize(apiKey, geminiApiKey = null) {
        // Use environment variable if geminiApiKey is not provided
        const finalGeminiApiKey = geminiApiKey || process.env.GEMINI_API_KEY;
        try {
            // Use dynamic import to handle ES modules
            const { Composio } = await import('@composio/core');
            const { GoogleProvider } = await import('@composio/google');
            const { GoogleGenAI } = await import('@google/genai');
            
            this.composio = new Composio({
                apiKey: apiKey,
                provider: new GoogleProvider(),
            });
            
            // Initialize Gemini client for function calling
            this.geminiClient = new GoogleGenAI({
                apiKey: finalGeminiApiKey,
            });
            
            this.isInitialized = true;
            this.connectionSessions.clear();
            console.log('Composio service initialized successfully with Google provider');
            return true;
        } catch (error) {
            console.error('Failed to initialize Composio service:', error);
            return false;
        }
    }

    /**
     * Start Gmail authentication flow for a user
     * @param {string} externalUserId - User identifier in your system
     * @param {string} authConfigId - Gmail auth config ID
     * @returns {Promise<{success: boolean, redirectUrl?: string, error?: string}>}
     */
    async connectConnector(externalUserId, connectorKey, options = {}) {
        if (!this.isInitialized) {
            return { success: false, error: 'Composio service not initialized' };
        }

        try {
            const connector = this._resolveConnector(connectorKey, options.authConfigId);
            console.log(`Starting ${connector.displayName} connection for user: ${externalUserId}`);

            const connectionRequest = await this.composio.connectedAccounts.link(
                externalUserId,
                options.authConfigId || connector.authConfigId,
                options.linkOptions
            );

            const key = this._getSessionKey(externalUserId, connector.key);
            this.connectionSessions.set(key, {
                request: connectionRequest,
                status: 'pending',
                connectedAccount: null,
                connector
            });

            return {
                success: true,
                connector: connector.key,
                redirectUrl: connectionRequest.redirectUrl
            };
        } catch (error) {
            console.error(`Failed to start ${connectorKey} connection:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Wait for a connector connection to be established
     * @param {string} externalUserId - User identifier
     * @param {string} connectorKey - Connector identifier
     * @param {number} timeoutMs - Timeout in milliseconds (default: 300000 = 5 minutes)
     * @returns {Promise<{success: boolean, connectedAccount?: object, error?: string}>}
     */
    async waitForConnectorConnection(externalUserId, connectorKey, timeoutMs = 300000) {
        const sessionKey = this._getSessionKey(externalUserId, connectorKey);
        const userConnection = this.connectionSessions.get(sessionKey);
        if (!userConnection) {
            return { success: false, error: 'No connection request found for user and connector' };
        }

        try {
            console.log(`Waiting for ${userConnection.connector.displayName} connection for user: ${externalUserId}`);
            
            const connectedAccount = await userConnection.request.waitForConnection(timeoutMs);
            
            // Update stored connection info
            userConnection.status = 'connected';
            userConnection.connectedAccount = connectedAccount;

            console.log(`${userConnection.connector.displayName} connection established for user: ${externalUserId}, account ID: ${connectedAccount.id}`);
            
            return {
                success: true,
                connectedAccount: {
                    id: connectedAccount.id,
                    externalUserId: externalUserId,
                    status: 'connected',
                    connectedAt: new Date().toISOString()
                }
            };
        } catch (error) {
            console.error(`Failed to establish ${userConnection.connector.displayName} connection:`, error);
            userConnection.status = 'failed';
            return { success: false, error: error.message };
        }
    }

    /**
     * Get connection status for a user and connector
     * @param {string} externalUserId - User identifier
     * @param {string} connectorKey - Connector identifier
     * @returns {Promise<{success: boolean, status?: string, connectedAccount?: object, error?: string}>}
     */
    async getConnectorStatus(externalUserId, connectorKey) {
        if (!this.isInitialized) {
            return { success: false, error: 'Composio service not initialized' };
        }

        const connector = this._resolveConnector(connectorKey);
        const sessionKey = this._getSessionKey(externalUserId, connector.key);
        const userConnection = this.connectionSessions.get(sessionKey);

        try {
            const listResponse = await this.composio.connectedAccounts.list({
                userIds: [externalUserId],
                authConfigIds: [connector.authConfigId],
            });

            const items = Array.isArray(listResponse?.items) ? listResponse.items : [];
            const activeAccount = items.find(item => item.status === 'ACTIVE');
            const account = activeAccount || items[0];

            if (account) {
                const normalizedStatus = account.status === 'ACTIVE' ? 'connected' : account.status?.toLowerCase?.() || 'unknown';
                const connectedAccountInfo = {
                    id: account.id,
                    status: account.status,
                    statusReason: account.statusReason || null,
                    updatedAt: account.updatedAt || null,
                    createdAt: account.createdAt || null,
                    connector: connector.key,
                };

                this.connectionSessions.set(sessionKey, {
                    request: userConnection?.request || null,
                    status: normalizedStatus,
                    connectedAccount: connectedAccountInfo,
                    connector,
                });

                return {
                    success: true,
                    status: normalizedStatus,
                    connectedAccount: connectedAccountInfo,
                };
            }
        } catch (error) {
            console.error(`Failed to query ${connector.displayName} connection status:`, error);
        }

        if (userConnection) {
            return {
                success: true,
                status: userConnection.status,
                connectedAccount: userConnection.connectedAccount,
            };
        }

        return { success: false, error: `No ${connector.displayName} connection found. Please connect via Composio.` };
    }

    /**
     * Disconnect a connector for a user (local cache only)
     * @param {string} externalUserId - User identifier
     * @param {string} connectorKey - Connector identifier
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async disconnectConnector(externalUserId, connectorKey) {
        const sessionKey = this._getSessionKey(externalUserId, connectorKey);
        const userConnection = this.connectionSessions.get(sessionKey);
        if (!userConnection) {
            return { success: false, error: 'No connection found for user' };
        }

        try {
            // Remove from local storage
            this.connectionSessions.delete(sessionKey);
            console.log(`${userConnection.connector.displayName} disconnected (local cache cleared) for user: ${externalUserId}`);
            
            return { success: true };
        } catch (error) {
            console.error(`Failed to disconnect ${userConnection.connector.displayName}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * List all connected accounts
     * @returns {Array} Array of connected account info
     */
    getConnectedAccounts() {
        const accounts = [];
        for (const [sessionKey, connection] of this.connectionSessions.entries()) {
            const [externalUserId, connectorKey] = sessionKey.split('::');
            accounts.push({
                externalUserId,
                connectorKey,
                status: connection.status,
                connectedAccount: connection.connectedAccount
            });
        }
        return accounts;
    }

    // Legacy Gmail-specific wrappers maintained for backwards compatibility
    async connectGmail(externalUserId, authConfigId = 'ac_AEOPhhO57Zsk') {
        return this.connectConnector(externalUserId, 'gmail', { authConfigId });
    }

    async waitForGmailConnection(externalUserId, timeoutMs = 300000) {
        return this.waitForConnectorConnection(externalUserId, 'gmail', timeoutMs);
    }

    async getGmailConnectionStatus(externalUserId) {
        return this.getConnectorStatus(externalUserId, 'gmail');
    }

    async disconnectGmail(externalUserId) {
        return this.disconnectConnector(externalUserId, 'gmail');
    }

    /**
     * Check if Composio is initialized
     * @returns {boolean}
     */
    isServiceInitialized() {
        return this.isInitialized;
    }

    /**
     * Execute a custom email task using Google provider with Gemini function calling
     * @param {string} externalUserId - User identifier
     * @param {string} task - Natural language description of the email task
     * @param {Array} tools - Array of Gmail tools to use (e.g., ["GMAIL_SEND_EMAIL", "GMAIL_GET_EMAILS"])
     * @returns {Promise<{success: boolean, result?: object, error?: string}>}
     */
    async executeEmailTaskWithAgent(externalUserId, task, tools = ["GMAIL_SEND_EMAIL", "GMAIL_GET_EMAILS"]) {
        if (!this.isInitialized) {
            return { success: false, error: 'Composio service not initialized' };
        }

        try {
            console.log(`🤖 Executing email task via Google provider for user: ${externalUserId}`);
            console.log(`📝 Task: ${task}`);
            
            // Get tools for Gmail toolkit
            const availableTools = await this.composio.tools.get(externalUserId, {
                tools: tools,
            });

            console.log(`✅ Got tools:`, availableTools.length);

            // Clean tools to match Gemini functionDeclarations schema
            const cleanedTools = availableTools.map(this._cleanToolForGemini);
            
            // Use Gemini with function calling
            const response = await this.geminiClient.models.generateContent({
                model: 'gemini-2.0-flash-001',
                contents: `You are a helpful assistant. ${task}. Use the Gmail function to send this email.`,
                config: {
                    tools: [{ functionDeclarations: cleanedTools }],
                },
            });

            console.log('🤖 Gemini response:', JSON.stringify(response, null, 2));
            
            if (response.functionCalls && response.functionCalls.length > 0) {
                console.log(`🔧 Calling tool ${response.functionCalls[0].name}`);
                const functionCall = {
                    name: response.functionCalls[0].name || '',
                    args: response.functionCalls[0].args || {},
                };
                console.log('🔧 Function call details:', functionCall);
                const result = await this.composio.provider.executeToolCall(externalUserId, functionCall);
                console.log(`✅ Tool execution result:`, result);
                return {
                    success: true,
                    result: result
                };
            } else {
                console.log('📝 No function calls in the response');
                console.log('📝 Response text:', response.text);
                return {
                    success: false,
                    error: 'No function calls generated. Response: ' + (response.text || 'No response text')
                };
            }
        } catch (error) {
            console.error('Failed to execute email task via Google provider:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get Composio tools formatted for Gemini function calling
     * @param {string} externalUserId - User identifier
     * @param {Array} tools - Array of tool names
     * @returns {Promise<Array>} Formatted tools for Gemini
     */
    async getToolsForGemini(externalUserId, tools = ["GMAIL_SEND_EMAIL", "GMAIL_GET_EMAILS"]) {
        if (!this.isInitialized) {
            throw new Error('Composio service not initialized');
        }

        try {
            const availableTools = await this.composio.tools.get(externalUserId, {
                tools: tools,
            });
            // Return cleaned tool declarations compatible with Gemini
            return availableTools.map(this._cleanToolForGemini);
        } catch (error) {
            console.error('Failed to get tools for Gemini:', error);
            throw error;
        }
    }

    /**
     * Execute a function call using Composio provider
     * @param {string} externalUserId - User identifier
     * @param {Object} functionCall - Function call object with name and args
     * @returns {Promise<Object>} Function call result
     */
    async executeFunctionCall(externalUserId, functionCall) {
        if (!this.isInitialized) {
            throw new Error('Composio service not initialized');
        }

        try {
            const result = await this.composio.provider.executeToolCall(externalUserId, functionCall);
            return result;
        } catch (error) {
            console.error('Failed to execute function call:', error);
            throw error;
        }
    }

    /**
     * Clean a Composio tool definition to be compatible with Gemini functionDeclarations
     * - Removes unsupported fields (examples, file_uploadable, title, format, etc.)
     * - Recursively cleans parameter schemas
     */
    _cleanToolForGemini(tool) {
        const clone = JSON.parse(JSON.stringify(tool || {}));
        delete clone.security;
        delete clone.externalToolId;
        delete clone.external_provider;
        delete clone.externalProvider;
        delete clone.rateLimit;

        // Ensure required fields
        if (!clone.name) clone.name = clone.tool_name || 'composio_tool';
        if (!clone.description) clone.description = 'Composio tool';

        // Parameters cleaning
        const cleanSchema = (schema) => {
            if (!schema || typeof schema !== 'object') return undefined;
            const { type } = schema;
            const cleaned = { type: type || 'object' };

            // Preserve common fields
            if (schema.description) cleaned.description = schema.description;
            if (Array.isArray(schema.enum)) cleaned.enum = schema.enum.slice(0, 100);
            if (schema.nullable === true) cleaned.nullable = true;

            // Recurse by type
            if (cleaned.type === 'object') {
                cleaned.properties = {};
                const props = schema.properties || {};
                for (const [key, val] of Object.entries(props)) {
                    // Skip unsupported or noisy fields
                    if (key === 'file_uploadable') continue;
                    cleaned.properties[key] = cleanSchema(val) || { type: 'string' };
                }
                if (Array.isArray(schema.required)) cleaned.required = schema.required;
            } else if (cleaned.type === 'array') {
                cleaned.items = cleanSchema(schema.items) || { type: 'string' };
            } else if (['string', 'number', 'integer', 'boolean'].includes(cleaned.type)) {
                // primitives already handled above
            } else {
                // Fallback to string if unknown
                cleaned.type = 'string';
            }

            // Strip fields Gemini rejects
            const stripKeys = [
                'examples', 'file_uploadable', 'format', 'minLength', 'maxLength', 'pattern',
                'default', 'title', 'deprecated', 'readOnly', 'writeOnly', '$schema', '$id',
            ];
            for (const k of stripKeys) delete cleaned[k];
            return cleaned;
        };

        if (clone.parameters) {
            clone.parameters = cleanSchema(clone.parameters);
        } else {
            clone.parameters = { type: 'object', properties: {} };
        }

        return clone;
    }
}

// Create singleton instance
const composioService = new ComposioService();

module.exports = {
    ComposioService,
    composioService,
    CONNECTORS
};
