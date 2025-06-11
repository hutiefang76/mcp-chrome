# windows 安装指南 🔧

Chrome MCP Server 在windows电脑的详细安装和配置步骤

## 📋 安装

1. **从github上下载最新的chrome扩展**

下载地址：https://github.com/hangwin/mcp-chrome/releases

2. **全局安装mcp-chrome-bridge**

确保电脑上已经安装了node，如果没安装请自行先安装

```bash
# 确保安装的是最新版本的npm包，否则可能有问题
npm install -g mcp-chrome-bridge
```

3. **加载 Chrome 扩展**

   - 打开 Chrome 并访问 `chrome://extensions/`
   - 启用"开发者模式"
   - 点击"加载已解压的扩展程序"，选择 `your/dowloaded/extension/folder`
   - 点击插件图标打开插件，点击连接即可看到mcp的配置
     <img width="475" alt="截屏2025-06-09 15 52 06" src="https://github.com/user-attachments/assets/241e57b8-c55f-41a4-9188-0367293dc5bc" />

4. **在 CherryStudio 中使用**

类型选streamableHttp，url填http://127.0.0.1:12306/mcp

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

## 🚀 安装和连接问题

### 点击扩展的连接按钮后如果没连接成功

1. **检查mcp-chrome-bridge是否安装成功**，确保是全局安装的

```bash
mcp-chrome-bridge -v
```

2. **检查清单文件是否已放在正确目录**

路径：C:\Users\xxx\AppData\Roaming\Google\Chrome\NativeMessagingHosts

3. **检查npm包的安装目录下是否有日志**

具体要看你的安装路径（如果不清楚，可以打开第2步的清单文件，里面的path就是安装目录），比如安装路径如下：
C:\Users\admin\AppData\Local\nvm\v20.19.2\node_modules\mcp-chrome-bridge\dist\logs
