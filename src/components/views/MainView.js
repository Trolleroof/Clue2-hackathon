import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class MainView extends LitElement {
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

        .welcome {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 24px;
            color: var(--text-color);
        }

        .api-keys-container {
            display: flex;
            flex-direction: column;
            gap: 16px;
            margin-bottom: 24px;
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
            min-width: 60px;
        }

        .api-key-input {
            flex: 1;
            background: var(--input-background, rgba(0, 0, 0, 0.3));
            color: var(--text-color);
            border: 1px solid var(--input-border, rgba(255, 255, 255, 0.15));
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 12px;
            transition: all 0.15s ease;
        }

        .api-key-input:focus {
            outline: none;
            border-color: var(--focus-border-color, #007aff);
            box-shadow: 0 0 0 2px var(--focus-shadow, rgba(0, 122, 255, 0.1));
        }

        .api-key-error {
            background: rgba(255, 68, 68, 0.1);
            border-color: rgba(255, 68, 68, 0.4);
        }

        .api-key-error:focus {
            background: rgba(255, 68, 68, 0.15);
            border-color: rgba(255, 68, 68, 0.6);
        }

        .input-group {
            margin-bottom: 20px;
        }

        .start-button {
            width: 100%;
            background: var(--start-button-background);
            color: var(--start-button-color);
            border: 1px solid var(--start-button-border);
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .start-button:hover:not(:disabled) {
            background: var(--start-button-hover-background);
            border-color: var(--start-button-hover-border);
        }

        .start-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .start-button.initializing {
            background: var(--start-button-background);
            color: var(--start-button-color);
        }

        .description {
            font-size: 12px;
            color: var(--description-color);
            text-align: center;
            line-height: 1.4;
            margin-top: 12px;
        }

        .link {
            color: var(--link-color);
            cursor: pointer;
            text-decoration: underline;
        }

        .link:hover {
            opacity: 0.8;
        }

        .shortcut-shint {
            color: var(--description-color);
            font-size: 11px;
            opacity: 0.8;
        }

        /* Compact layout adjustments */
        :host([compact]) .welcome {
            font-size: 20px;
            margin-bottom: 16px;
        }

        :host([compact]) .api-keys-container {
            margin-bottom: 16px;
            gap: 12px;
        }

        :host([compact]) .start-button {
            padding: 10px 16px;
            font-size: 13px;
        }

        :host([compact]) .description {
            font-size: 11px;
            margin-top: 8px;
        }
    `;

    static properties = {
        onStart: { type: Function },
        onAPIKeyHelp: { type: Function },
        isInitializing: { type: Boolean },
        onLayoutModeChange: { type: Function },
        showApiKeyError: { type: Boolean },
    };

    constructor() {
        super();
        this.onStart = () => {};
        this.onAPIKeyHelp = () => {};
        this.isInitializing = false;
        this.onLayoutModeChange = () => {};
        this.showApiKeyError = false;
        this.boundKeydownHandler = this.handleKeydown.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        window.electron?.ipcRenderer?.on('session-initializing', (event, isInitializing) => {
            this.isInitializing = isInitializing;
            this.requestUpdate();
        });

        document.addEventListener('keydown', this.boundKeydownHandler);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('keydown', this.boundKeydownHandler);
    }

    handleInput(e) {
        localStorage.setItem('apiKey', e.target.value);
        if (this.showApiKeyError) {
            this.showApiKeyError = false;
        }
    }

    handleKeydown(e) {
        if (e.key === 'Enter' && !this.isInitializing && !e.target.matches('input')) {
            this.handleStartClick();
        }
    }

    getStartButtonText() {
        if (this.isInitializing) {
            return 'Initializing...';
        }
        return 'Start Session';
    }

    async handleStartClick() {
        if (this.isInitializing) {
            return;
        }

        this.isInitializing = true;
        this.requestUpdate();

        try {
            await this.onStart();
        } catch (error) {
            console.error('Failed to start session:', error);
            this.showApiError = true;
            this.requestUpdate();

            setTimeout(() => {
                this.showApiError = false;
                this.requestUpdate();
            }, 5000);
        } finally {
            this.isInitializing = false;
            this.requestUpdate();
        }
    }

    handleAPIKeyHelpClick() {
        this.onAPIKeyHelp();
    }

    render() {
        return html`
            <div class="welcome">Welcome</div>

            <div class="api-keys-container">
                <div class="api-key-row">
                    <div class="api-key-label">Gemini:</div>
                    <input
                        type="password"
                        placeholder="Gemini API Key (loaded from .env file)"
                        .value=${localStorage.getItem('apiKey') || ''}
                        @input=${this.handleInput}
                        class="api-key-input ${this.showApiKeyError ? 'api-key-error' : ''}"
                        disabled
                        title="Gemini API key is loaded from GEMINI_API_KEY environment variable"
                    />
                </div>
            </div>

            <div class="input-group">
                <button @click=${this.handleStartClick} class="start-button ${this.isInitializing ? 'initializing' : ''}">
                    ${this.getStartButtonText()}
                </button>
            </div>
            <!-- <p class="description">
                Gemini API key is loaded from .env file. 
                <span @click=${this.handleAPIKeyHelpClick} class="link">Need help?</span>
            </p> -->
        `;
    }
}

customElements.define('main-view', MainView);