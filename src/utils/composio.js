/**
 * Composio service for Gmail integration using Google/Gemini provider
 * Handles authentication and connection management
 */

// Load environment variables
require('dotenv').config();

class ComposioService {
    constructor() {
        this.composio = null;
        this.connectedAccounts = new Map(); // Store connected accounts by externalUserId
        this.isInitialized = false;
        this.geminiClient = null;
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
    async connectGmail(externalUserId, authConfigId = 'ac_AEOPhhO57Zsk') {
        if (!this.isInitialized) {
            return { success: false, error: 'Composio service not initialized' };
        }

        try {
            console.log(`Starting Gmail connection for user: ${externalUserId}`);
            
            const connectionRequest = await this.composio.connectedAccounts.link(
                externalUserId,
                authConfigId
            );

            // Store the connection request for later polling
            this.connectedAccounts.set(externalUserId, {
                request: connectionRequest,
                status: 'pending',
                connectedAccount: null
            });

            return {
                success: true,
                redirectUrl: connectionRequest.redirectUrl
            };
        } catch (error) {
            console.error('Failed to start Gmail connection:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Wait for Gmail connection to be established
     * @param {string} externalUserId - User identifier
     * @param {number} timeoutMs - Timeout in milliseconds (default: 300000 = 5 minutes)
     * @returns {Promise<{success: boolean, connectedAccount?: object, error?: string}>}
     */
    async waitForGmailConnection(externalUserId, timeoutMs = 300000) {
        const userConnection = this.connectedAccounts.get(externalUserId);
        if (!userConnection) {
            return { success: false, error: 'No connection request found for user' };
        }

        try {
            console.log(`Waiting for Gmail connection for user: ${externalUserId}`);
            
            const connectedAccount = await userConnection.request.waitForConnection();
            
            // Update stored connection info
            userConnection.status = 'connected';
            userConnection.connectedAccount = connectedAccount;

            console.log(`Gmail connection established for user: ${externalUserId}, account ID: ${connectedAccount.id}`);
            
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
            console.error('Failed to establish Gmail connection:', error);
            userConnection.status = 'failed';
            return { success: false, error: error.message };
        }
    }

    /**
     * Get connection status for a user
     * @param {string} externalUserId - User identifier
     * @returns {Promise<{success: boolean, status?: string, connectedAccount?: object, error?: string}>}
     */
    async getGmailConnectionStatus(externalUserId) {
        const userConnection = this.connectedAccounts.get(externalUserId);
        if (!userConnection) {
            // Check if we have a real connection through Composio
            try {
                const tools = await this.composio.tools.get(externalUserId, {
                    tools: ["GMAIL_SEND_EMAIL"],
                });
                if (tools && tools.length > 0) {
                    return { 
                        success: true, 
                        status: 'connected',
                        connectedAccount: { id: 'real-composio-connection' }
                    };
                }
            } catch (error) {
                console.log('No real Gmail connection found:', error.message);
            }
            return { success: false, error: 'No Gmail connection found. Please connect Gmail in Composio dashboard.' };
        }

        return {
            success: true,
            status: userConnection.status,
            connectedAccount: userConnection.connectedAccount
        };
    }

    /**
     * Disconnect Gmail for a user
     * @param {string} externalUserId - User identifier
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async disconnectGmail(externalUserId) {
        const userConnection = this.connectedAccounts.get(externalUserId);
        if (!userConnection) {
            return { success: false, error: 'No connection found for user' };
        }

        try {
            // Remove from local storage
            this.connectedAccounts.delete(externalUserId);
            console.log(`Gmail disconnected for user: ${externalUserId}`);
            
            return { success: true };
        } catch (error) {
            console.error('Failed to disconnect Gmail:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * List all connected accounts
     * @returns {Array} Array of connected account info
     */
    getConnectedAccounts() {
        const accounts = [];
        for (const [externalUserId, connection] of this.connectedAccounts.entries()) {
            accounts.push({
                externalUserId,
                status: connection.status,
                connectedAccount: connection.connectedAccount
            });
        }
        return accounts;
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
    composioService
};
