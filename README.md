# Clue2 AI Assistant

Clue2 is a real-time AI assistant designed to help you during video calls, interviews, presentations, and meetings. It uses advanced screen capture and audio analysis to understand your context and provide intelligent responses in real time.

## What It Does

Think of Clue2 as having a smart assistant sitting next to you during important calls. It watches your screen, listens to conversations, and provides helpful suggestions and answers when you need them most. Whether you're in a job interview, giving a presentation, or having a business meeting, Clue2 analyzes what's happening and offers relevant assistance.

## Key Features

**Real-Time AI Assistance**: Powered by Google Gemini 2.0 Flash Live, the assistant provides instant, contextual help based on what it sees and hears.

**Smart Screen Analysis**: The app captures screenshots of your screen at regular intervals and analyzes the content to understand what you're working with.

**Audio Processing**: It listens to both system audio and microphone input, transcribing conversations and detecting when questions are being asked.

**Flexible Profiles**: Choose from different assistance modes like Interview, Sales Call, Business Meeting, Presentation, or Negotiation to get tailored responses.

**Always-On-Top Window**: The assistant window stays visible on top of other applications, so you can always see the help it's providing.

**Click-Through Mode**: When you need to interact with other applications, you can make the window transparent to mouse clicks while keeping it visible.

**Manual Screenshot Capture**: Take screenshots on demand to get instant analysis of specific content.

**Google Search Integration**: The assistant can search Google for current information when you need up-to-date data.

**Gmail Integration**: Connect your Gmail account to enable email-related assistance and workflow automation.

## How It Works

The application runs as a desktop app built with Electron. When you start a session, it begins capturing your screen and audio. The captured data is sent to Google's Gemini AI model, which analyzes the content and provides relevant responses. The AI understands context from both visual and audio information, making its suggestions more accurate and helpful.

## Getting Started

1. **Get an API Key**: You'll need a Google Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

2. **Install the App**: Run `npm install` to install all dependencies

3. **Start the Application**: Use `npm start` to launch the app

4. **Configure Settings**: Enter your API key and choose your preferred assistance profile

5. **Begin a Session**: Click "Start Session" to begin real-time assistance

## Usage Tips

The app works best when you're in an active conversation or presentation. It's designed to respond to questions and provide assistance based on the context it observes. During testing, you might need to simulate an interviewer asking questions to see the full functionality.

## Keyboard Shortcuts

- **Ctrl/Cmd + Arrow Keys**: Move the assistant window around your screen
- **Ctrl/Cmd + M**: Toggle click-through mode (make window transparent to clicks)
- **Ctrl/Cmd + Backtick**: Close window or go back to previous view
- **Enter**: Send a text message to the AI assistant

## Technical Requirements

- macOS, Windows, or Linux operating system
- Google Gemini API key
- Screen recording permissions
- Microphone and audio permissions
- Internet connection for AI processing

## Audio Capture Details

The app handles audio differently depending on your operating system:

- **macOS**: Uses SystemAudioDump for capturing system audio alongside microphone input
- **Windows**: Employs loopback audio capture for system sound
- **Linux**: Relies on microphone input (system audio capture has limited support)

## Privacy and Security

All audio and screen data is processed through Google's Gemini API. The app includes stealth features to help maintain privacy during sensitive conversations. You have control over what data is captured and when.

## Development

This project is built with modern web technologies including Electron for the desktop app framework, LitElement for the user interface, and various AI service integrations. The codebase is designed to be extensible and includes support for multiple AI providers and workflow automation.

## Open Source Foundation

Clue2 is built on top of the open source [CheatingDaddy](https://github.com/sohzm/cheating-daddy) project, which provides the core real-time AI assistance functionality. We've extended and enhanced the original codebase with additional features like Gmail integration, improved UI components, and expanded AI provider support.

**Attribution**: This project is a fork of CheatingDaddy by [sohzm](https://github.com/sohzm), licensed under GPL-3.0. We're grateful for the solid foundation that made Clue2 possible.

## License

This project is licensed under the GPL-3.0 license, inheriting from the original CheatingDaddy project.