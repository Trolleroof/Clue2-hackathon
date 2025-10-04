import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class ConnectionsView extends LitElement {
    static styles = css`
        * {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            cursor: default;
            user-select: none;
        }

        :host {
            display: block;
            padding: 12px;
            margin: 0 auto;
            max-width: 700px;
        }

        .connections-container {
            display: grid;
            gap: 12px;
            padding-bottom: 20px;
        }

        .connections-section {
            background: var(--card-background, rgba(255, 255, 255, 0.04));
            border: 1px solid var(--card-border, rgba(255, 255, 255, 0.1));
            border-radius: 6px;
            padding: 16px;
            backdrop-filter: blur(10px);
        }

        .section-title {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            font-size: 14px;
            font-weight: 600;
            color: var(--text-color);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .section-title::before {
            content: '';
            width: 3px;
            height: 14px;
            background: var(--accent-color, #007aff);
            border-radius: 1.5px;
        }

        .api-keys-container {
            display: flex;
            flex-direction: column;
            gap: 16px;
            margin-bottom: 20px;
        }

        .api-key-row {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .api-key-label {
            font-weight: 500;
            font-size: 12px;
            color: var(--label-color, rgba(255, 255, 255, 0.9));
            min-width: 80px;
        }

        input[type="password"] {
            flex: 1;
            background: var(--input-background, rgba(0, 0, 0, 0.3));
            color: var(--text-color);
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.15));
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 12px;
            transition: all 0.15s ease;
        }

        input[type="password"]:focus {
            outline: none;
            border-color: var(--focus-border-color, #007aff);
            box-shadow: 0 0 0 2px var(--focus-shadow, rgba(0, 122, 255, 0.1));
            background: var(--input-focus-background, rgba(0, 0, 0, 0.4));
        }

        .connectors-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }

        .connectors-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-color);
        }

        .connector-message {
            font-size: 12px;
            color: var(--description-color, rgba(255, 255, 255, 0.5));
        }

        .connectors-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }

        .connector-card {
            background: var(--input-background, rgba(0, 0, 0, 0.3));
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.15));
            border-radius: 6px;
            padding: 12px;
            text-align: center;
            cursor: pointer;
            transition: all 0.15s ease;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }

        .connector-card:hover {
            background: var(--hover-background, rgba(255, 255, 255, 0.07));
            border-color: var(--focus-border-color, #007aff);
        }

        .connector-card:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .status-connected {
            background: rgba(34, 197, 94, 0.1);
            border-color: rgba(34, 197, 94, 0.2);
        }

        .status-connected:hover {
            background: rgba(34, 197, 94, 0.15);
        }

        .status-pending {
            background: rgba(251, 191, 36, 0.1);
            border-color: rgba(251, 191, 36, 0.2);
        }

        .status-pending:hover {
            background: rgba(251, 191, 36, 0.15);
        }

        .connector-icon {
            width: 32px;
            height: 32px;
            border-radius: 4px;
            object-fit: cover;
        }

        .connector-name {
            font-size: 11px;
            font-weight: 500;
            color: var(--text-color);
            text-overflow: ellipsis;
            overflow: hidden;
            white-space: nowrap;
            width: 100%;
        }

        .connector-status {
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 2px 6px;
            border-radius: 3px;
            transition: all 0.2s ease;
        }

        .connector-status:not(.connected):not(.pending):not(.failed) {
            color: var(--text-color);
            background: rgba(255, 255, 255, 0.1);
        }

        .connector-status.connected {
            color: #22c55e;
            background: rgba(34, 197, 94, 0.1);
        }

        .connector-status.pending {
            color: #fbbf24;
            background: rgba(251, 191, 36, 0.1);
            animation: pulse 1.5s infinite;
        }

        .connector-status.failed {
            color: #ef4444;
            background: rgba(239, 68, 68, 0.1);
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        .description {
            font-size: 12px;
            color: var(--description-color, rgba(255, 255, 255, 0.5));
            margin-top: 8px;
            line-height: 1.4;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .form-label {
            font-weight: 500;
            font-size: 12px;
            color: var(--label-color, rgba(255, 255, 255, 0.9));
        }

        .form-description {
            font-size: 11px;
            color: var(--description-color, rgba(255, 255, 255, 0.5));
            line-height: 1.3;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--description-color, rgba(255, 255, 255, 0.5));
            font-size: 14px;
            font-style: italic;
        }
    `;

    static properties = {
        composioApiKey: { type: String },
        connectors: { type: Array },
        connectorError: { type: String },
        composioStatusMessage: { type: String },
        composioInitialized: { type: Boolean },
    };

    constructor() {
        super();
        this.composioApiKey = '';
        this.connectors = [];
        this.connectorError = '';
        this.composioStatusMessage = '';
        this.composioInitialized = false;
        
        this.loadComposioKey();
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.checkComposioStatus();
        this.loadConnectors();
    }

    loadComposioKey() {
        this.composioApiKey = localStorage.getItem('composioApiKey') || '';
    }

    async checkComposioStatus() {
        try {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                const result = await ipcRenderer.invoke('check-composio-status');
                
                if (result.success) {
                    this.composioInitialized = result.isInitialized;
                    this.composioStatusMessage = result.message;
                } else {
                    this.composioStatusMessage = `Error checking status: ${result.error}`;
                    this.composioInitialized = false;
                }
            }
        } catch (error) {
            console.error('Failed to check Composio status:', error);
            this.composioStatusMessage = `Failed to check status: ${error.message}`;
            this.composioInitialized = false;
        }
        this.requestUpdate();
    }

    handleInput(e) {
        localStorage.setItem('composioApiKey', e.target.value);
        this.loadComposioKey();
        
        // Initialize Composio when API key is provided
        if (e.target.value.trim()) {
            this.initializeComposio(e.target.value);
        }
    }

    async initializeComposio(apiKey) {
        try {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                const result = await ipcRenderer.invoke('initialize-composio', apiKey);
                
                if (result.success) {
                    this.composioStatusMessage = 'Composio initialized successfully';
                    this.composioInitialized = true;
                    this.loadConnectors();
                } else {
                    this.composioStatusMessage = `Error: ${result.error}`;
                    this.composioInitialized = false;
                }
            }
        } catch (error) {
            console.error('Failed to initialize Composio:', error);
            this.composioStatusMessage = `Failed to initialize Composio: ${error.message}`;
            this.composioInitialized = false;
        }
        this.requestUpdate();
    }

    async loadConnectors() {
        try {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                const result = await ipcRenderer.invoke('get-composio-connectors');
                
                if (result.success) {
                    this.connectors = result.connectors || [];
                    // Check status for each connector
                    for (const connector of this.connectors) {
                        const externalUserId = 'clue2-user-' + Date.now(); // TODO: Use a consistent user ID
                        const statusResult = await ipcRenderer.invoke('get-composio-connector-status', externalUserId, connector.key);
                        connector.status = statusResult.success ? statusResult.status : 'disconnected';
                    }
                    this.connectorError = '';
                } else {
                    this.connectorError = result.error || 'Failed to load connectors';
                    this.connectors = [];
                }
            }
        } catch (error) {
            console.error('Failed to load connectors:', error);
            this.connectorError = `Failed to load connectors: ${error.message}`;
            this.connectors = [];
        }
        this.requestUpdate();
    }

    getConnectorStatus(connector) {
        switch (connector.status) {
            case 'connected':
                return 'Connected';
            case 'pending':
                return 'Connecting...';
            case 'failed':
                return 'Failed';
            default:
                return 'Connect';
        }
    }

    async connectConnector(connectorKey, connectorName, authConfigId, authType) {
        if (!this.composioApiKey) {
            this.connectorError = 'Please enter your Composio API key first';
            return;
        }

        try {
            const externalUserId = 'clue2-user-' + Date.now();
            
            if (authType === 'OAUTH2') {
                const { ipcRenderer, shell } = window.require('electron');
                
                // Start the connection process
                const result = await ipcRenderer.invoke('connect-composio-connector', externalUserId, connectorKey, {
                    authConfigId: authConfigId
                });
                
                if (result.success && result.redirectUrl) {
                    // Update UI to show pending state
                    this.connectorError = `Connecting to ${connectorName}...`;
                    this.requestUpdate();

                    // Open OAuth URL in default browser
                    await shell.openExternal(result.redirectUrl);

                    // Wait for connection to be established
                    const waitResult = await ipcRenderer.invoke('wait-composio-connection', externalUserId, connectorKey);
                    
                    if (waitResult.success) {
                        this.connectorError = `Successfully connected to ${connectorName}`;
                        this.loadConnectors(); // Refresh connectors list
                    } else {
                        this.connectorError = `Failed to connect ${connectorName}: ${waitResult.error}`;
                    }
                } else {
                    this.connectorError = `Failed to start ${connectorName} connection: ${result.error}`;
                }
            } else {
                this.connectorError = `Unsupported auth type: ${authType}`;
            }
        } catch (error) {
            console.error('Failed to connect connector:', error);
            this.connectorError = `Failed to connect ${connectorName}: ${error.message}`;
        }
        this.requestUpdate();
    }

    renderConnectors() {
        if (!this.connectors.length) {
            return html`<div class="empty-state">No connectors available</div>`;
        }

        return html`
            ${this.connectors.map(
                connector => html`
                    <div
                        class="connector-card"
                        @click=${() => this.connectConnector(
                            connector.key,
                            connector.displayName,
                            connector.authConfigId,
                            connector.authType
                        )}
                    >
                        <img
                            src=${connector.logoUrl}
                            alt=${connector.displayName}
                            class="connector-icon"
                            onerror="this.style.display='none'"
                        />
                        <div class="connector-name">${connector.displayName}</div>
                        <div class="connector-status ${connector.status || ''}">${this.getConnectorStatus(connector)}</div>
                    </div>
                `
            )}
        `;
    }

    render() {
        const connectorsList = this.renderConnectors();

        return html`
            <div class="connections-container">
                <div class="connections-section">
                    <div class="section-title">
                        <span>API Configuration</span>
                    </div>
                    
                    <div class="form-grid">
                        <div class="form-group">
                            <label class="form-label">Composio API Key</label>
                            <input
                                type="password"
                                placeholder="Enter your Composio API Key"
                                .value=${this.composioApiKey}
                                @input=${this.handleInput}
                            />
                            <div class="form-description">
                                Required to connect with external services and platforms
                            </div>
                        </div>
                        ${this.composioStatusMessage
                            ? html`<div class="description" style="color: ${this.composioInitialized ? '#22c55e' : '#f59e0b'}">${this.composioStatusMessage}</div>`
                            : ''}
                    </div>
                </div>

                <div class="connections-section">
                    <div class="section-title">
                        <span>Available Connectors</span>
                    </div>
                    
                    <div class="connectors-header">
                        <div class="connectors-title">Services</div>
                        ${!this.connectors.length && !this.connectorError
                            ? html`<div class="connector-message">Loading connectors…</div>`
                            : ''}
                    </div>
                    <div class="connectors-grid">${connectorsList}</div>
                    ${this.connectorError ? html`<div class="description">${this.connectorError}</div>` : ''}
                </div>
            </div>
        `;
    }
}

customElements.define('connections-view', ConnectionsView);