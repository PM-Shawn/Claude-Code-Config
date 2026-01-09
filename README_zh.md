# Claude Code Config

[English](README.md) | [中文](README_zh.md)

Claude Code 可视化配置管理器 - 让你的 Claude Code CLI 配置管理更简单

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)

## 功能截图

### API 配置管理
![API Config](screenshots/api-config.png)

### Skills 管理
![Skills](screenshots/skills.png)

### MCP 服务器管理
![MCP Server](screenshots/mcp-server.png)

### Token 使用统计
![Token Stats](screenshots/token-stats.png)

---

## 功能特性

- **多方案管理** - 创建、编辑、删除、切换多个 API 配置方案
- **Token 使用统计** - 按方案和模型追踪 API 调用和 Token 消耗
- **API 代理** - 内置代理服务器，转发请求到第三方 API 提供商
- **MCP Server 管理** - 管理 Claude Desktop 的 MCP Server 配置
- **Skills 安装** - 一键安装/卸载 Anthropic 官方 Skills
- **配置冲突检测** - 检测并修复 `.zshrc` 中的环境变量冲突
- **API 健康检查** - 测试 API 连通性和延迟

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Web 管理界面                            │
│  http://localhost:3000                                       │
│  ├─ 配置方案管理（新增/编辑/删除/激活）                        │
│  ├─ Token 使用统计                                           │
│  ├─ MCP Server 管理                                          │
│  └─ Skills 安装管理                                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                      Shell Wrapper                           │
│  ~/.claude-wrapper                                           │
│  └─ 自动加载配置 + Token 统计                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Claude CLI                                │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/PM-Shawn/Claude-Code-Config.git
cd Claude-Code-Config
npm install
```

### 2. 运行安装脚本

```bash
bash setup.sh
source ~/.zshrc
```

### 3. 启动服务

```bash
npm start
# 或
node server.js
```

访问 http://localhost:3000

## 使用说明

### 添加 API 配置

1. 点击 **「+ 新增方案」**
2. 填写配置信息：
   - **方案名称**: 如「七牛云API」「智谱GLM」
   - **API URL**: 第三方 API 地址，如 `https://api.qnaigc.com`
   - **API Key**: 你的 API 密钥
   - **模型名称**: 如 `claude-4.5-sonnet`

### 激活方案

点击方案卡片上的 **「激活」** 按钮，激活后的方案会：
- 在终端使用 `claude` 命令时自动生效
- 显示绿色边框高亮

### 命令行使用

激活方案后，直接使用 `claude` 命令即可：

```bash
# 交互模式
claude

# 单次执行
claude -p "your prompt"

# JSON 输出（启用自动 Token 统计）
claude -p --output-format json "your prompt"
```

## Token 统计说明

### 自动统计条件

使用 `--print --output-format json` 模式会自动统计 Token：

```bash
claude -p --output-format json "your prompt"
```

### 统计内容

- **输入 Tokens**: 请求消耗的输入 Token
- **输出 Tokens**: 响应消耗的输出 Token
- **请求次数**: 该方案的总调用次数
- **最后使用**: 最近一次调用时间

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/config` | GET/POST | 获取/保存所有配置 |
| `/api/profiles` | POST | 创建新方案 |
| `/api/profiles/:id` | PUT/DELETE | 更新/删除方案 |
| `/api/profiles/:id/activate` | POST | 激活方案 |
| `/api/profiles/:id/test` | POST | 测试 API 连通性 |
| `/api/token-stats` | GET/POST/DELETE | Token 使用统计 |
| `/api/mcp/servers` | GET/POST | MCP Server 管理 |
| `/api/skills/status` | GET | 检查 Skills 安装状态 |
| `/api/skills/install` | POST | 安装官方 Skills |
| `/v1/messages` | POST | API 请求代理端点 |

## 配置文件说明

| 文件 | 说明 |
|------|------|
| `config.json` | API 配置方案存储 |
| `token-stats.json` | Token 使用统计数据 |
| `~/.claude-api-env` | 当前激活的环境变量 |
| `~/.claude-wrapper` | Shell 包装函数 |

## 常见问题

### Q: 为什么 Token 统计没有更新？

A: 确保使用 `--output-format json` 参数：

```bash
claude -p --output-format json "prompt"
```

### Q: 如何切换 API 方案？

A: 在 Web 界面点击对应方案的「激活」按钮，然后直接使用 `claude` 命令即可。

### Q: 支持哪些第三方 API？

A: 支持任何兼容 Anthropic API 格式的第三方服务，如：
- 七牛云 API
- 智谱 GLM
- OpenRouter
- AnyRouter
- 其他兼容服务

### Q: 如何查看当前使用的配置？

A: 在 Web 界面顶部查看当前激活方案，或在终端运行：

```bash
source ~/.claude-api-env
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_MODEL
```

## 技术栈

- **后端**: Node.js + Express
- **前端**: 原生 HTML/CSS/JavaScript
- **数据存储**: JSON 文件

## 目录结构

```
Claude-Code-Config/
├── server.js           # Web 服务器
├── index.html          # 管理界面
├── config.json         # 配置存储（已忽略）
├── token-stats.json    # 统计数据（已忽略）
├── setup.sh            # 安装脚本
├── claude-activate.sh  # 激活脚本
└── package.json        # 依赖配置
```

## 开源协议

MIT License

## 贡献

欢迎提交 Pull Request。如有重大更改，请先开 Issue 讨论。
