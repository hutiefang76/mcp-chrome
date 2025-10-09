import { type Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    SEARCH_TABS_CONTENT: 'search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    GO_BACK_OR_FORWARD: 'chrome_go_back_or_forward',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    INJECT_SCRIPT: 'chrome_inject_script',
    SEND_COMMAND_TO_INJECT_SCRIPT: 'chrome_send_command_to_inject_script',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    USERSCRIPT: 'chrome_userscript',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
  },
};

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description: 'Get all currently open browser windows and tabs',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    description:
      'Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description:
            'Determines if, once tracing has started, the page should be automatically reloaded (ignore cache).',
        },
        autoStop: {
          type: 'boolean',
          description: 'Determines if the trace should be automatically stopped (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in milliseconds when autoStop is true (default 5000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    description: 'Stops the active performance trace recording on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        saveToDownloads: {
          type: 'boolean',
          description: 'Whether to save the trace as a JSON file in Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional filename prefix for the downloaded trace JSON.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    description:
      'Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        insightName: {
          type: 'string',
          description:
            'Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.READ_PAGE,
    description:
      'Get an accessibility tree representation of visible elements on the page. Only returns elements that are visible in the viewport. Optionally filter for only interactive elements.\nTip: If the returned elements do not include the specific element you need, use the computer tool\'s screenshot (action="screenshot") to capture the element\'s on-screen coordinates, then operate by coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Filter elements: "interactive" for such as  buttons/links/inputs only (default: all visible elements)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult a read_page to determine the ref of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try screenshot and then adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Action to perform: left_click | right_click | double_click | triple_click | left_click_drag | scroll | type | key | fill | hover | wait | screenshot',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from chrome_read_page. For click/scroll/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          description:
            'Coordinates for actions (in screenshot space if a recent screenshot was taken, otherwise viewport). Required for click/scroll and as end point for drag.',
        },
        startCoordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Starting coordinates for drag action',
        },
        startRef: {
          type: 'string',
          description: 'Drag start ref from chrome_read_page (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description: 'For action=fill_form: list of elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref from chrome_read_page' },
              value: { type: 'string', description: 'Value to set (stringified if non-string)' },
            },
            required: ['ref', 'value'],
          },
        },
        width: { type: 'number', description: 'For action=resize_page: viewport width' },
        height: { type: 'number', description: 'For action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        timeout: {
          type: 'number',
          description:
            'For action=wait with text: timeout in milliseconds (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.USERSCRIPT,
    description:
      'Unified userscript tool (create/list/get/enable/disable/update/remove/send_command/export). Paste JS/CSS/Tampermonkey script and the system will auto-select the best strategy (insertCSS / persistent script in ISOLATED or MAIN world / once by CDP) with CSP-aware fallbacks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Operation to perform: create | list | get | enable | disable | update | remove | send_command | export',
        },
        args: {
          type: 'object',
          description:
            'Arguments for the specified action. For create: { script, name?, description?, matches?, excludes?, persist?, runAt?, world?, allFrames?, mode?, dnrFallback?, tags? }',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description: 'Navigate to a URL or refresh the current tab',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to the website specified' },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        width: { type: 'number', description: 'Viewport width in pixels (default: 1280)' },
        height: { type: 'number', description: 'Viewport height in pixels (default: 720)' },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      '[Prefer read_page over taking a screenshot and Prefer chrome_computer] Take a screenshot of the current page or a specific element. For new usage, use chrome_computer with action="screenshot". Use this tool if you need advanced options.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'return screenshot in base64 format (default: false) if you want to see the page, recommend set this to be true',
        },
        fullPage: {
          type: 'boolean',
          description: 'Store screenshot of the entire page (default: true)',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save screenshot as PNG file (default: true)，if you want to see the page, recommend set this to be false, and set storeBase64 to be true',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to close. If not provided, will close the active tab.',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GO_BACK_OR_FORWARD,
    description: 'Navigate back or forward in browser history',
    inputSchema: {
      type: 'object',
      properties: {
        isForward: {
          type: 'boolean',
          description: 'Go forward in history if true, go back if false (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
    description:
      'Start capturing network requests from a web page using Chrome Debugger API（with responseBody）',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. If not provided, uses the current active tab',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
    description:
      'Stop capturing network requests using Chrome Debugger API and return the captured data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
    description:
      'Start capturing network requests from a web page using Chrome webRequest API(without responseBody)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. If not provided, uses the current active tab',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
    description:
      'Stop capturing network requests using webRequest API and return the captured data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
    description:
      'search for related content from the currently open tab and return the corresponding web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'the query to search for related content.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
    description:
      'inject the user-specified content script into the webpage. By default, inject into the currently active tab',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'If a URL is specified, inject the script into the webpage corresponding to the URL.',
        },
        type: {
          type: 'string',
          description:
            'the javaScript world for a script to execute within. must be ISOLATED or MAIN',
        },
        jsScript: {
          type: 'string',
          description: 'the content script to inject',
        },
      },
      required: ['type', 'jsScript'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
    description:
      'if the script injected using chrome_inject_script listens for user-defined events, this tool can be used to trigger those events',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'the tab where you previously injected the script(if not provided,  use the currently active tab)',
        },
        eventName: {
          type: 'string',
          description: 'the eventName your injected content script listen for',
        },
        payload: {
          type: 'string',
          description: 'the payload passed to event, must be a json string',
        },
      },
      required: ['eventName'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture and retrieve all console output from the current active browser tab/page. This captures console messages that existed before the tool was called.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description: 'Maximum number of console messages to capture (default: 100)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    description:
      'Upload files to web forms with file input elements using Chrome DevTools Protocol',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the file input element (input[type="file"])',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description: 'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description: 'Whether the input accepts multiple files (default: false)',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'accept | dismiss' },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
      },
      required: ['action'],
    },
  },
];
