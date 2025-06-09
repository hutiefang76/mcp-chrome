# Chrome MCP Server 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue.svg)](https://www.typescriptlang.org/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://developer.chrome.com/docs/extensions/)

> 🌟 **Turn your Chrome browser into your intelligent assistant** - Let AI take control of your browser, transforming it into a powerful AI-controlled automation tool.

**📖 Documentation**: [English](README.md) | [中文](README_zh.md)

---

## 🎯 What is Chrome MCP Server?

Chrome MCP Server is a Chrome extension-based **Model Context Protocol (MCP) server** that exposes your Chrome browser functionality to AI assistants like Claude, enabling complex browser automation, content analysis, and semantic search. Unlike traditional browser automation tools (like Playwright), **Chrome MCP Server** directly uses your daily Chrome browser, leveraging existing user habits, configurations, and login states, allowing various large models or chatbots to take control of your browser and truly become your everyday assistant.

## ✨ Core Features

- 😁 **Chatbot/Model Agnostic**: Let any LLM or chatbot client or agent you prefer automate your browser
- ⭐️ **Use Your Original Browser**: Seamlessly integrate with your existing browser environment (your configurations, login states, etc.)
- 💻 **Fully Local**: Pure local MCP server ensuring user privacy
- 🚄 **Streamable HTTP**: Streamable HTTP connection method
- 🏎 **Cross-Tab**: Cross-tab context
- 🧠 **Semantic Search**: Built-in vector database for intelligent browser tab content discovery
- 🔍 **Smart Content Analysis**: AI-powered text extraction and similarity matching
- 🌐 **20+ Tools**: Support for screenshots, network monitoring, interactive operations, bookmark management, browsing history, and 20+ other tools
- 🚀 **SIMD-Accelerated AI**: Custom WebAssembly SIMD optimization for 4-8x faster vector operations

## 🆚 Comparison with Similar Projects

| Comparison Dimension    | Playwright-based MCP Server                                                                                               | Chrome Extension-based MCP Server                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Resource Usage**      | ❌ Requires launching independent browser process, installing Playwright dependencies, downloading browser binaries, etc. | ✅ No need to launch independent browser process, directly utilizes user's already open Chrome browser |
| **User Session Reuse**  | ❌ Requires re-login                                                                                                      | ✅ Automatically uses existing login state                                                             |
| **Browser Environment** | ❌ Clean environment lacks user settings                                                                                  | ✅ Fully preserves user environment                                                                    |
| **API Access**          | ⚠️ Limited to Playwright API                                                                                              | ✅ Full access to Chrome native APIs                                                                   |
| **Startup Speed**       | ❌ Requires launching browser process                                                                                     | ✅ Only needs to activate extension                                                                    |
| **Response Speed**      | 50-200ms inter-process communication                                                                                      | ✅ Faster                                                                                              |

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Chrome/Chromium browser

### Installation Steps

1. **Download the latest Chrome extension from GitHub**

Download link: https://github.com/hangwin/chrome-mcp-server/releases

2. **Install mcp-chrome-bridge globally**

npm

```bash
npm install -g mcp-chrome-bridge
```

pnpm

```bash
pnpm install -g mcp-chrome-bridge
```

3. **Load Chrome Extension**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select `your/dowloaded/extension/folder`
   - Click the extension icon to open the plugin, then click connect to see the MCP configuration
     <img width="475" alt="Screenshot 2025-06-09 15 52 06" src="https://github.com/user-attachments/assets/241e57b8-c55f-41a4-9188-0367293dc5bc" />

### Usage with Claude Desktop

Add the following configuration to Claude Desktop's MCP configuration:

```json
{
  "mcpServers": {
    "streamable-mcp-server": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

## 🛠️ Available Tools

Complete tool list: [Complete Tool List](docs/TOOLS.md)

<details>
<summary><strong>📊 Browser Management (4 tools)</strong></summary>

- `get_windows_and_tabs` - List all browser windows and tabs
- `chrome_navigate` - Navigate to URLs and control viewport
- `chrome_close_tabs` - Close specific tabs or windows
- `chrome_go_back_or_forward` - Browser navigation control
</details>

<details>
<summary><strong>📸 Screenshots & Visual (1 tool)</strong></summary>

- `chrome_screenshot` - Advanced screenshot capture with element targeting, full-page support, and custom dimensions
</details>

<details>
<summary><strong>🌐 Network Monitoring (4 tools)</strong></summary>

- `chrome_network_capture_start/stop` - webRequest API network capture
- `chrome_network_debugger_start/stop` - Debugger API with response bodies
- `chrome_network_request` - Send custom HTTP requests
</details>

<details>
<summary><strong>🔍 Content Analysis (3 tools)</strong></summary>

- `search_tabs_content` - AI-powered semantic search across browser tabs
- `chrome_get_web_content` - Extract HTML/text content from pages
- `chrome_get_interactive_elements` - Find clickable elements
</details>

<details>
<summary><strong>🎯 Interaction (3 tools)</strong></summary>

- `chrome_click_element` - Click elements using CSS selectors
- `chrome_fill_or_select` - Fill forms and select options
- `chrome_keyboard` - Simulate keyboard input and shortcuts
</details>

<details>
<summary><strong>📚 Data Management (5 tools)</strong></summary>

- `chrome_history` - Search browser history with time filters
- `chrome_bookmark_search` - Find bookmarks by keywords
- `chrome_bookmark_add` - Add new bookmarks with folder support
- `chrome_bookmark_delete` - Delete bookmarks
</details>

## 🧪 Usage Examples

### AI automatically captures network requests for you

query: I want to know what the search API for Xiaohongshu is and what the response structure looks like

https://github.com/user-attachments/assets/063f44ae-1754-46b6-b141-5988c86e4d96

### AI helps analyze your browsing history

query: Analyze my browsing history from the past month

https://github.com/user-attachments/assets/e7a35118-e50e-4b1c-a790-0878aa2505ab

### Web page conversation

query: Translate and summarize the current web page

https://github.com/user-attachments/assets/08aa86aa-7706-4df2-b400-576e2c7fcc7f

### AI automatically takes screenshots for you (web page screenshots)

query: Take a screenshot of Hugging Face's homepage

https://github.com/user-attachments/assets/b081e41b-6309-40d6-885b-0da01691b12e

### AI automatically takes screenshots for you (element screenshots)

query: Capture the icon from Hugging Face's homepage

https://github.com/user-attachments/assets/25657076-b84b-4459-a72f-90f896f06364

### AI helps manage bookmarks

query: Add the current page to bookmarks and put it in an appropriate folder

https://github.com/user-attachments/assets/73c1ea26-65fb-4b5e-b537-e32fa9bcfa52

### Automatically close web pages

query: Close all shadcn-related web pages

https://github.com/user-attachments/assets/ff160f48-58e0-4c76-a6b0-c4e1f91370c8

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed guidelines.

## 🚧 Future Roadmap

We have exciting plans for the future development of Chrome MCP Server:

- [ ] Authentication
- [ ] Recording and Playback
- [ ] Workflow Automation
- [ ] Enhanced Browser Support (Firefox Extension)

---

**Want to contribute to any of these features?** Check out our [Contributing Guide](docs/CONTRIBUTING.md) and join our development community!

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📚 More Documentation

- [Architecture Design](docs/ARCHITECTURE.md) - Detailed technical architecture documentation
- [TOOLS API](docs/TOOLS.md) - Complete tool API documentation
- [Troubleshooting](docs/TROUBLESHOOTING.md) - Common issue solutions
