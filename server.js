const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { Mutex } = require('async-mutex');

const app = express();
const PORT = 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ENV_FILE = path.join(process.env.HOME, '.claude-api-env');
const WRAPPER_FILE = path.join(process.env.HOME, '.claude-wrapper');
const ZSHRC_FILE = path.join(process.env.HOME, '.zshrc');
const TOKEN_STATS_FILE = path.join(__dirname, 'token-stats.json');
const CLAUDE_DESKTOP_CONFIG = path.join(process.env.HOME, 'Library/Application Support/Claude/claude_desktop_config.json');

// 读取配置
async function loadConfig() {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      profiles: [],
      activeProfile: null
    };
  }
}

// 保存配置
async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

// 读取token统计数据
async function loadTokenStats() {
  try {
    const content = await fs.readFile(TOKEN_STATS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { records: [] };
  }
}

// 保存token统计数据
async function saveTokenStats(stats) {
  await fs.writeFile(TOKEN_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  return stats;
}

const statsMutex = new Mutex();

// 记录token使用
async function recordTokenUsage(profileId, modelName, inputTokens, outputTokens) {
  return await statsMutex.runExclusive(async () => {
    const stats = await loadTokenStats();
    const now = new Date().toISOString();

    // 查找是否已存在该profile和model的记录
    let record = stats.records.find(r => r.profileId === profileId && r.modelName === modelName);

    if (record) {
      // 更新现有记录
      record.inputTokens += inputTokens;
      record.outputTokens += outputTokens;
      record.totalTokens = record.inputTokens + record.outputTokens;
      record.requestCount += 1;
      record.lastUsedAt = now;
    } else {
      // 创建新记录
      record = {
        id: Date.now().toString(),
        profileId,
        modelName,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestCount: 1,
        createdAt: now,
        lastUsedAt: now
      };
      stats.records.push(record);
    }

    await saveTokenStats(stats);
    return record;
  });
}

// 从环境文件读取当前配置
async function readEnvConfig() {
  try {
    const content = await fs.readFile(ENV_FILE, 'utf-8');
    const config = {};

    content.split('\n').forEach(line => {
      const match = line.match(/^export\s+([A-Z_]+)=(.+)$/);
      if (match) {
        config[match[1]] = match[2].replace(/^"|"$/g, '');
      }
    });

    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

// 写入配置到环境文件
async function writeEnvConfig(profile) {
  try {
    const envContent = [
      '# Claude Code Config - 由可视化配置管理器自动生成',
      `export ANTHROPIC_AUTH_TOKEN="${profile.apiKey}"`,
      `export ANTHROPIC_BASE_URL="${profile.apiUrl}"`,
      `export ANTHROPIC_MODEL="${profile.modelName}"`,
    ].join('\n');

    await fs.writeFile(ENV_FILE, envContent, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// 检查包装器是否已安装
async function checkWrapperInstalled() {
  try {
    // 检查包装器文件是否存在
    const wrapperExists = await fs.access(WRAPPER_FILE).then(() => true).catch(() => false);

    // 检查 .zshrc 是否引用了包装器
    const zshrcContent = await fs.readFile(ZSHRC_FILE, 'utf-8');
    const zshrcHasWrapper = zshrcContent.includes('.claude-wrapper');

    return wrapperExists && zshrcHasWrapper;
  } catch {
    return false;
  }
}

// 根据 API Key 获取 Profile
async function getProfileByApiKey(apiKey) {
  const config = await loadConfig();
  const profile = config.profiles.find(p => p.apiKey === apiKey);
  return profile || null;
}

// API 路由

// 获取所有配置
app.get('/api/config', async (req, res) => {
  const config = await loadConfig();
  res.json(config);
});

// 保存配置
app.post('/api/config', async (req, res) => {
  const config = req.body;
  await saveConfig(config);
  res.json({ success: true });
});

// 添加配置方案
app.post('/api/profiles', async (req, res) => {
  const profile = req.body;
  const config = await loadConfig();

  // 检查名称是否已存在
  if (config.profiles.find(p => p.name === profile.name)) {
    return res.status(400).json({ error: '方案名称已存在' });
  }

  config.profiles.push({
    id: Date.now().toString(),
    name: profile.name,
    apiUrl: profile.apiUrl,
    apiKey: profile.apiKey,
    modelName: profile.modelName,
    createdAt: new Date().toISOString()
  });

  await saveConfig(config);
  res.json({ success: true });
});

// 删除配置方案
app.delete('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
  const config = await loadConfig();

  const index = config.profiles.findIndex(p => p.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '方案不存在' });
  }

  config.profiles.splice(index, 1);

  // 如果删除的是激活的方案，清除激活状态
  if (config.activeProfile === id) {
    config.activeProfile = null;
  }

  await saveConfig(config);
  res.json({ success: true });
});

// 更新配置方案
app.put('/api/profiles/:id', async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const config = await loadConfig();

  const index = config.profiles.findIndex(p => p.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '方案不存在' });
  }

  // 检查新名称是否与其他方案冲突
  const nameConflict = config.profiles.find(p => p.name === updateData.name && p.id !== id);
  if (nameConflict) {
    return res.status(400).json({ error: '方案名称已存在' });
  }

  // 更新方案数据（保留 id 和 createdAt）
  config.profiles[index] = {
    ...config.profiles[index],
    name: updateData.name,
    apiUrl: updateData.apiUrl,
    apiKey: updateData.apiKey,
    modelName: updateData.modelName
  };

  await saveConfig(config);
  res.json({ success: true, profile: config.profiles[index] });
});

// 激活配置方案（写入环境文件）
app.post('/api/profiles/:id/activate', async (req, res) => {
  const { id } = req.params;
  const config = await loadConfig();

  const profile = config.profiles.find(p => p.id === id);
  if (!profile) {
    return res.status(404).json({ error: '方案不存在' });
  }

  const success = await writeEnvConfig(profile);
  if (success) {
    config.activeProfile = id;
    await saveConfig(config);
    const isInstalled = await checkWrapperInstalled();
    res.json({ success: true, profile, isInstalled });
  } else {
    res.status(500).json({ error: '写入配置失败' });
  }
});

// 读取当前环境文件中的配置
app.get('/api/current-config', async (req, res) => {
  const config = await readEnvConfig();
  res.json(config);
});

// 检查包装器是否已安装
app.get('/api/check-setup', async (req, res) => {
  const isInstalled = await checkWrapperInstalled();
  res.json({ isInstalled });
});

// 获取安装脚本内容
app.get('/api/setup-script', (req, res) => {
  const scriptPath = path.join(__dirname, 'setup.sh');
  res.sendFile(scriptPath);
});

// ========== Proxy Endpoint (New) ==========

app.post('/v1/messages', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const anthropicVersion = req.headers['anthropic-version'];
  const isStream = req.body.stream === true;
  const modelName = req.body.model;

  if (!apiKey) {
    return res.status(401).json({ error: { type: 'authentication_error', message: 'Missing API Key' } });
  }

  // Identify Profile
  const profile = await getProfileByApiKey(apiKey);
  // Note: We proceed even if profile is null (treat as anonymous/unknown usage, or fail?
  // User request implies we want to count tokens, so we'll log it even if we can't map it to a local profile,
  // OR we can decide to fail. Given the context, let's proceed and use a placeholder ID if needed, or just skip recording stats if unknown.
  // Better approach: If profileId is found, record stats. If not, maybe just proxy without recording (or record to 'unknown').
  // Let's use 'unknown' if not found so at least we see usage.
  const targetProfileId = profile ? profile.id : 'unknown';

  // Determine upstream URL
  // If profile found, use its apiUrl. If not, fallback to Anthropic (or error out?)
  // Let's fallback to Anthropic default if no profile found, but if found, use the configured one.
  const baseUrl = profile ? profile.apiUrl : 'https://api.anthropic.com';
  const targetUrl = baseUrl.replace(/\/$/, '') + '/v1/messages';

  try {
    const response = await axios({
      method: 'post',
      url: targetUrl,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': anthropicVersion || '2023-06-01',
        'content-type': 'application/json'
      },
      data: req.body,
      responseType: isStream ? 'stream' : 'json'
    });

    if (isStream) {
      // Handle Streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let inputTokens = 0;
      let outputTokens = 0;
      let buffer = '';

      response.data.on('data', (chunk) => {
        // Forward data to client immediately
        res.write(chunk);

        // Process for token counting
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const event = JSON.parse(dataStr);
              if (event.type === 'message_start' && event.message && event.message.usage) {
                inputTokens = event.message.usage.input_tokens || 0;
              } else if (event.type === 'message_delta' && event.usage) {
                outputTokens = event.usage.output_tokens || 0;
              } else if (event.type === 'message_stop') {
                 // Finalize aggregation if needed, but message_delta usually has the cumulative output tokens in some versions?
                 // Actually, message_delta events usually contain *delta* usage or *accumulated*?
                 // Anthropic API docs:
                 // message_start: contains input_tokens
                 // message_delta: contains output_tokens (cumulative for this delta? No, usually it's just the delta)
                 // WAIT: checks docs or behavior.
                 // Correct behavior:
                 // message_start.usage.input_tokens (Static)
                 // message_delta.usage.output_tokens (The number of output tokens generated *in this delta*) -> NO.
                 // Let's re-verify Standard Anthropic SSE format.
                 // content_block_delta -> text deltas.
                 // message_delta -> "usage": {"output_tokens": X} where X is the count of tokens in this update.
                 // We need to ACCUMULATE output tokens from message_delta events.
              }

              // Correction on message_delta:
              // documentation says: "usage": {"output_tokens": 1} in a message_delta event means 1 NEW token.
              // So we += outputTokens.
              if (event.type === 'message_delta' && event.usage && event.usage.output_tokens) {
                 outputTokens += event.usage.output_tokens;
              }

            } catch (e) {
              // Ignore parse errors for partial chunks
            }
          }
        }
      });

      response.data.on('end', async () => {
        res.end();
        // Record Stats
        if (targetProfileId !== 'unknown') {
            try {
                await recordTokenUsage(targetProfileId, modelName, inputTokens, outputTokens);
            } catch (err) {
                console.error('Error recording stream stats:', err);
            }
        }
      });

    } else {
      // Handle Non-Streaming
      const data = response.data;
      res.json(data);

      // Record Stats
      if (data.usage && targetProfileId !== 'unknown') {
        try {
          await recordTokenUsage(
            targetProfileId,
            modelName,
            data.usage.input_tokens || 0,
            data.usage.output_tokens || 0
          );
        } catch (err) {
            console.error('Error recording stats:', err);
        }
      }
    }

  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      console.error('Proxy Error:', error);
      res.status(500).json({ error: { type: 'internal_server_error', message: error.message } });
    }
  }
});

// ========== Token统计相关API ==========

// 获取所有token统计记录（带profile信息）
app.get('/api/token-stats', async (req, res) => {
  const stats = await loadTokenStats();
  const config = await loadConfig();

  // 为每条记录添加profile信息
  const recordsWithProfile = stats.records.map(record => {
    const profile = config.profiles.find(p => p.id === record.profileId);
    return {
      ...record,
      profileName: profile ? profile.name : '未知方案',
      apiUrl: profile ? profile.apiUrl : ''
    };
  });

  res.json({ records: recordsWithProfile });
});

// 记录token使用
app.post('/api/token-stats', async (req, res) => {
  const { profileId, modelName, inputTokens, outputTokens } = req.body;

  if (!profileId || !modelName || inputTokens === undefined || outputTokens === undefined) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  try {
    const record = await recordTokenUsage(profileId, modelName, inputTokens, outputTokens);
    res.json({ success: true, record });
  } catch (error) {
    res.status(500).json({ error: '记录失败' });
  }
});

// 删除token统计记录
app.delete('/api/token-stats/:id', async (req, res) => {
  const { id } = req.params;
  const stats = await loadTokenStats();

  const index = stats.records.findIndex(r => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '记录不存在' });
  }

  stats.records.splice(index, 1);
  await saveTokenStats(stats);
  res.json({ success: true });
});

// 清空所有token统计
app.delete('/api/token-stats', async (req, res) => {
  await saveTokenStats({ records: [] });
  res.json({ success: true });
});

// ========== Skills 安装相关API ==========

// 检查 skills 是否已安装
app.get('/api/skills/status', async (req, res) => {
  const pluginsDir = path.join(process.env.HOME, '.claude', 'plugins');
  const marketplacesFile = path.join(pluginsDir, 'known_marketplaces.json');
  const installedPluginsFile = path.join(pluginsDir, 'installed_plugins.json');

  try {
    let knownMarketplaces = {};
    let marketplaceNames = [];

    // 读取已知的marketplaces
    try {
      const content = await fs.readFile(marketplacesFile, 'utf-8');
      knownMarketplaces = JSON.parse(content);
      marketplaceNames = Object.keys(knownMarketplaces);
    } catch (e) {
      // 文件不存在
    }

    // 检查anthropics/skills是否已添加
    const hasAnthropicsSkills = marketplaceNames.some(name =>
      knownMarketplaces[name]?.source?.repo === 'anthropics/skills'
    );

    // 读取已安装的 plugins
    let installedPlugins = {};
    try {
      const installedContent = await fs.readFile(installedPluginsFile, 'utf-8');
      const installedData = JSON.parse(installedContent);
      installedPlugins = installedData.plugins || {};
    } catch (e) {
      // 文件不存在
    }

    // 检查 document-skills 和 example-skills 是否已安装
    const documentSkillsInstalled = !!installedPlugins['document-skills@anthropic-agent-skills'];
    const exampleSkillsInstalled = !!installedPlugins['example-skills@anthropic-agent-skills'];

    res.json({
      marketplaceAdded: hasAnthropicsSkills,
      marketplaces: marketplaceNames,
      documentSkillsInstalled,
      exampleSkillsInstalled,
      installedPlugins: Object.keys(installedPlugins)
    });
  } catch (error) {
    console.error('Error in /api/skills/status:', error);
    res.json({
      marketplaceAdded: false,
      marketplaces: [],
      documentSkillsInstalled: false,
      exampleSkillsInstalled: false,
      installedPlugins: []
    });
  }
});

// Helper to check if a command exists
function checkCommand(command) {
  try {
    require('child_process').execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// 安装官方 skills（使用 Claude CLI）
app.post('/api/skills/install', async (req, res) => {
  const { type } = req.body; // 'marketplace', 'document', 'example', 'all'
  const { execSync, spawn } = require('child_process');

  // Validate environment
  if (!checkCommand('git')) {
    return res.status(400).json({ error: 'Git not found. Please install git to use skills.' });
  }
  if ((type === 'document' || type === 'example' || type === 'all') && !checkCommand('claude')) {
    return res.status(400).json({ error: 'Claude CLI not found. Please install it first.' });
  }

  try {
    const results = [];
    const marketplacesFile = path.join(process.env.HOME, '.claude', 'plugins', 'known_marketplaces.json');
    const marketplacesDir = path.join(process.env.HOME, '.claude', 'plugins', 'marketplaces');

    // 确保 marketplaces 目录存在
    await fs.mkdir(marketplacesDir, { recursive: true });

    // 读取当前的 marketplaces 配置
    let marketplacesConfig = {};
    try {
      const content = await fs.readFile(marketplacesFile, 'utf-8');
      marketplacesConfig = JSON.parse(content);
    } catch (e) {
      // 文件不存在，创建新的
    }

    // 检查是否已存在 anthropic-agent-skills
    const hasSkillsMarketplace = Object.values(marketplacesConfig).some(
      m => m.source?.repo === 'anthropics/skills'
    );

    if (type === 'marketplace' || type === 'all') {
      if (hasSkillsMarketplace) {
        results.push({ success: true, message: 'Marketplace 已存在', type: 'marketplace' });
      } else {
        // 异步克隆 anthropics/skills 仓库
        const targetDir = path.join(marketplacesDir, 'anthropic-agent-skills');

        // 先检查目录是否已存在
        try {
          const stat = await fs.stat(targetDir);
          // 目录已存在，直接更新配置
          marketplacesConfig['anthropic-agent-skills'] = {
            source: { source: 'github', repo: 'anthropics/skills' },
            installLocation: targetDir,
            lastUpdated: new Date().toISOString()
          };
          await fs.writeFile(marketplacesFile, JSON.stringify(marketplacesConfig, null, 2));
          results.push({ success: true, message: 'Marketplace 目录已存在，配置已更新', type: 'marketplace' });
        } catch (e) {
          // 目录不存在，开始克隆
          await new Promise((resolve) => {
            const git = spawn('git', ['clone', 'https://github.com/anthropics/skills.git', targetDir], {
              cwd: marketplacesDir,
              stdio: 'pipe'
            });

            let output = '';
            let error = '';
            let isTimedOut = false;
            let isResolved = false;

            git.stdout.on('data', (data) => { output += data.toString(); });
            git.stderr.on('data', (data) => { error += data.toString(); });

            git.on('close', async (code) => {
              if (isResolved) return; // 已经处理过（超时或完成）
              isResolved = true;

              if (code === 0) {
                try {
                  // 验证克隆是否完整（检查关键文件）
                  const gitDir = path.join(targetDir, '.git');
                  const marketplaceJsonPath = path.join(targetDir, '.claude-plugin', 'marketplace.json');

                  await fs.stat(gitDir);
                  await fs.stat(marketplaceJsonPath); // 确保 marketplace.json 存在

                  // 更新配置文件
                  marketplacesConfig['anthropic-agent-skills'] = {
                    source: { source: 'github', repo: 'anthropics/skills' },
                    installLocation: targetDir,
                    lastUpdated: new Date().toISOString()
                  };
                  await fs.writeFile(marketplacesFile, JSON.stringify(marketplacesConfig, null, 2));
                  results.push({ success: true, message: 'Marketplace 安装成功！', type: 'marketplace' });
                  resolve();
                } catch (err) {
                  // 安装失败，清理部分文件
                  results.push({ success: false, message: '安装验证失败: ' + err.message, type: 'marketplace' });
                  try {
                    await fs.rm(targetDir, { recursive: true, force: true });
                  } catch (cleanupErr) {
                    console.error('清理失败的安装目录时出错:', cleanupErr);
                  }
                  resolve();
                }
              } else {
                // 克隆失败，清理部分文件
                results.push({ success: false, message: '克隆失败: ' + (error || '未知错误'), type: 'marketplace' });
                try {
                  await fs.rm(targetDir, { recursive: true, force: true });
                } catch (cleanupErr) {
                  console.error('清理失败的克隆目录时出错:', cleanupErr);
                }
                resolve();
              }
            });

            // 120秒超时
            const timeout = setTimeout(async () => {
              if (isResolved) return;
              isResolved = true;
              isTimedOut = true;

              git.kill('SIGTERM');
              results.push({ success: false, message: '克隆超时（120秒）', type: 'marketplace' });

              // 清理部分下载的文件
              try {
                await fs.rm(targetDir, { recursive: true, force: true });
              } catch (cleanupErr) {
                console.error('清理超时的克隆目录时出错:', cleanupErr);
              }

              resolve();
            }, 120000);

            // 确保 timeout 被清理
            git.on('close', () => {
              if (!isTimedOut) {
                clearTimeout(timeout);
              }
            });
          });
        }
      }
    }

    // 安装 plugins（document-skills 和 example-skills）使用 Claude CLI
    if (type === 'document' || type === 'all') {
      if (!hasSkillsMarketplace) {
        results.push({
          success: false,
          message: '请先安装 Marketplace',
          type: 'document'
        });
      } else {
        try {
          // 使用 claude plugin install 安装 document-skills
          execSync('claude plugin install document-skills@anthropic-agent-skills', {
            stdio: 'pipe',
            encoding: 'utf-8'
          });
          results.push({
            success: true,
            message: 'Document Skills 安装成功',
            type: 'document'
          });
        } catch (error) {
          // 检查是否已经安装
          if (error.stderr && error.stderr.includes('already installed')) {
            results.push({
              success: true,
              message: 'Document Skills 已安装',
              type: 'document'
            });
          } else {
            results.push({
              success: false,
              message: '安装失败: ' + (error.stderr || error.message),
              type: 'document'
            });
          }
        }
      }
    }

    if (type === 'example' || type === 'all') {
      if (!hasSkillsMarketplace) {
        results.push({
          success: false,
          message: '请先安装 Marketplace',
          type: 'example'
        });
      } else {
        try {
          // 使用 claude plugin install 安装 example-skills
          execSync('claude plugin install example-skills@anthropic-agent-skills', {
            stdio: 'pipe',
            encoding: 'utf-8'
          });
          results.push({
            success: true,
            message: 'Example Skills 安装成功',
            type: 'example'
          });
        } catch (error) {
          // 检查是否已经安装
          if (error.stderr && error.stderr.includes('already installed')) {
            results.push({
              success: true,
              message: 'Example Skills 已安装',
              type: 'example'
            });
          } else {
            results.push({
              success: false,
              message: '安装失败: ' + (error.stderr || error.message),
              type: 'example'
            });
          }
        }
      }
    }

    // 等待克隆完成（仅在有 git clone 时才需要等待）
    if (results.some(r => r.type === 'marketplace' && r.message.includes('成功'))) {
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 卸载 skills（使用 Claude CLI）
app.post('/api/skills/uninstall', async (req, res) => {
  const { type } = req.body; // 'marketplace', 'document', 'example', 'all'
  const { execSync } = require('child_process');

  try {
    const results = [];
    const marketplacesFile = path.join(process.env.HOME, '.claude', 'plugins', 'known_marketplaces.json');
    const marketplacesDir = path.join(process.env.HOME, '.claude', 'plugins', 'marketplaces');

    // 读取当前的 marketplaces 配置
    let marketplacesConfig = {};
    try {
      const content = await fs.readFile(marketplacesFile, 'utf-8');
      marketplacesConfig = JSON.parse(content);
    } catch (e) {
      return res.json({ success: false, error: '无法读取 marketplaces 配置文件' });
    }

    // 找到 anthropic-agent-skills marketplace
    const skillsMarketplace = Object.values(marketplacesConfig).find(
      m => m.source?.repo === 'anthropics/skills'
    );

    if (!skillsMarketplace) {
      return res.json({
        success: false,
        results: [{ success: false, message: 'Marketplace 未安装，无需卸载', type: 'marketplace' }]
      });
    }

    // 卸载 plugins 使用 Claude CLI
    if (type === 'document' || type === 'all') {
      try {
        execSync('claude plugin uninstall document-skills@anthropic-agent-skills', {
          stdio: 'pipe',
          encoding: 'utf-8'
        });
        results.push({
          success: true,
          message: 'Document Skills 已卸载',
          type: 'document'
        });
      } catch (error) {
        if (error.stderr && error.stderr.includes('not installed')) {
          results.push({
            success: true,
            message: 'Document Skills 未安装',
            type: 'document'
          });
        } else {
          results.push({
            success: false,
            message: '卸载失败: ' + (error.stderr || error.message),
            type: 'document'
          });
        }
      }
    }

    if (type === 'example' || type === 'all') {
      try {
        execSync('claude plugin uninstall example-skills@anthropic-agent-skills', {
          stdio: 'pipe',
          encoding: 'utf-8'
        });
        results.push({
          success: true,
          message: 'Example Skills 已卸载',
          type: 'example'
        });
      } catch (error) {
        if (error.stderr && error.stderr.includes('not installed')) {
          results.push({
            success: true,
            message: 'Example Skills 未安装',
            type: 'example'
          });
        } else {
          results.push({
            success: false,
            message: '卸载失败: ' + (error.stderr || error.message),
            type: 'example'
          });
        }
      }
    }

    // 根据类型执行卸载 marketplace
    if (type === 'marketplace' || type === 'all') {
      try {
        // 删除整个 marketplace 目录
        await fs.rm(skillsMarketplace.installLocation, { recursive: true, force: true });

        // 从配置文件中移除
        const marketplaceName = Object.keys(marketplacesConfig).find(
          name => marketplacesConfig[name].source?.repo === 'anthropics/skills'
        );
        if (marketplaceName) {
          delete marketplacesConfig[marketplaceName];
          await fs.writeFile(marketplacesFile, JSON.stringify(marketplacesConfig, null, 2));
        }

        results.push({
          success: true,
          message: 'Marketplace 已卸载（包含所有 skills）',
          type: 'marketplace'
        });
      } catch (error) {
        results.push({
          success: false,
          message: '卸载失败: ' + error.message,
          type: 'marketplace'
        });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

    // 获取所有可用的 plugins 列表
app.get('/api/skills/available', async (req, res) => {
  try {
    const pluginsDir = path.join(process.env.HOME, '.claude', 'plugins');
    const marketplacesFile = path.join(pluginsDir, 'known_marketplaces.json');
    const installedPluginsFile = path.join(pluginsDir, 'installed_plugins.json');

    // 读取 marketplaces 配置
    let marketplacesConfig = {};
    try {
      const content = await fs.readFile(marketplacesFile, 'utf-8');
      marketplacesConfig = JSON.parse(content);
    } catch (e) {
      return res.json({ available: [], enabled: [] });
    }

    // 找到 anthropic-agent-skills marketplace
    const skillsMarketplace = Object.values(marketplacesConfig).find(
      m => m.source?.repo === 'anthropics/skills'
    );

    if (!skillsMarketplace) {
      return res.json({ available: [], enabled: [] });
    }

    // 读取 marketplace.json 获取 plugins 定义
    const marketplaceJsonPath = path.join(
      skillsMarketplace.installLocation,
      '.claude-plugin',
      'marketplace.json'
    );

    let availablePlugins = [];
    try {
      const marketplaceContent = await fs.readFile(marketplaceJsonPath, 'utf-8');
      const marketplaceData = JSON.parse(marketplaceContent);

      // 读取已安装的 plugins
      let installedPlugins = {};
      let enabledPlugins = [];
      try {
        const installedContent = await fs.readFile(installedPluginsFile, 'utf-8');
        const installedData = JSON.parse(installedContent);
        installedPlugins = installedData.plugins || {};
        // Enabled skills are just the keys of the installed plugins (e.g. "skill@repo")
        // But for frontend matching, we just need the list of installed keys
        enabledPlugins = Object.keys(installedPlugins).map(key => {
            // key is like "skill-name@anthropic-agent-skills"
            // we want just "skill-name"
            return key.split('@')[0];
        });
      } catch (e) {
        // 文件不存在
      }

      // 返回 plugins 信息
      for (const plugin of marketplaceData.plugins || []) {
        availablePlugins.push({
          id: plugin.name,
          name: plugin.name,
          description: plugin.description,
          skills: plugin.skills.map(s => s.replace('./skills/', '')),
          skillCount: plugin.skills.length,
          installed: enabledPlugins.includes(plugin.name) // Helper field, but we send explicit list too
        });
      }

      res.json({
        available: availablePlugins,
        enabled: enabledPlugins
      });

    } catch (e) {
      console.error('Error reading marketplace.json:', e);
      return res.json({ available: [], enabled: [] });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== MCP Server 管理相关API ==========

// 读取 MCP 配置
async function loadMcpConfig() {
  try {
    const content = await fs.readFile(CLAUDE_DESKTOP_CONFIG, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return { mcpServers: {} };
  }
}

// 保存 MCP 配置
async function saveMcpConfig(config) {
  // 确保存储目录存在
  const configDir = path.dirname(CLAUDE_DESKTOP_CONFIG);
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(CLAUDE_DESKTOP_CONFIG, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Error saving MCP config:', e);
    return false;
  }
}

// 获取所有 MCP Servers
app.get('/api/mcp/servers', async (req, res) => {
  const config = await loadMcpConfig();
  const servers = Object.entries(config.mcpServers || {}).map(([name, server]) => ({
    name,
    ...server
  }));
  res.json({ servers });
});

// 测试 MCP 命令 (New)
app.post('/api/mcp/test-command', async (req, res) => {
  const { command, args } = req.body;
  if (!command) return res.status(400).json({ error: 'Missing command' });

  const { spawn } = require('child_process');

  // 尝试运行命令 (使用 --help 或 --version，或者只是检查是否能启动)
  // 为了安全和通用性，我们只尝试 spawn 并立即捕获 error 或 close
  // 注意：某些命令可能没有 version 标志，但我们主要检查 ENOENT (未找到)

  try {
    const child = spawn(command, args || [], {
      stdio: 'ignore' // 忽略输入输出，只关心是否能启动
    });

    child.on('error', (err) => {
      res.json({ success: false, error: err.message });
    });

    // 如果 500ms 内没有报错，认为启动成功 (hacky but works for validation)
    setTimeout(() => {
      if (!child.killed) {
        child.kill();
        // 只有当响应还没发送时才发送
        if (!res.headersSent) {
          res.json({ success: true, message: 'Command found and executable' });
        }
      }
    }, 500);

  } catch (e) {
    if (!res.headersSent) res.json({ success: false, error: e.message });
  }
});

// 添加/更新 MCP Server
app.post('/api/mcp/servers', async (req, res) => {
  const { name, type, command, args, env, url } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Missing server name' });
  }

  const config = await loadMcpConfig();
  if (!config.mcpServers) config.mcpServers = {};

  if (type === 'sse' || url) {
    // Remote SSE Server
    if (!url) return res.status(400).json({ error: 'Missing URL for SSE server' });
    config.mcpServers[name] = {
      url
    };
  } else {
    // Local Stdio Server (default)
    if (!command) return res.status(400).json({ error: 'Missing command for Stdio server' });
    config.mcpServers[name] = {
      command,
      args: args || [],
      env: env || {}
    };
  }

  if (await saveMcpConfig(config)) {
    res.json({ success: true, server: { name, ...config.mcpServers[name] } });
  } else {
    res.status(500).json({ error: '保存配置失败' });
  }
});

// 更新 MCP Server (Rename/Update)
app.put('/api/mcp/servers/:oldName', async (req, res) => {
  const { oldName } = req.params;
  const { name, type, command, args, env, url } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Missing server name' });
  }

  const config = await loadMcpConfig();
  if (!config.mcpServers) config.mcpServers = {};

  // Check if old server exists
  if (!config.mcpServers[oldName]) {
    return res.status(404).json({ error: 'Server not found' });
  }

  // Check name conflict if renaming
  if (oldName !== name && config.mcpServers[name]) {
    return res.status(400).json({ error: 'Server name already exists' });
  }

  // Prepare new server config
  let newServerConfig = {};
  if (type === 'sse' || url) {
    if (!url) return res.status(400).json({ error: 'Missing URL for SSE server' });
    newServerConfig = { url };
  } else {
    if (!command) return res.status(400).json({ error: 'Missing command for Stdio server' });
    newServerConfig = {
      command,
      args: args || [],
      env: env || {}
    };
  }

  // Delete old key if name changed
  if (oldName !== name) {
    delete config.mcpServers[oldName];
  }

  // Save new config
  config.mcpServers[name] = newServerConfig;

  if (await saveMcpConfig(config)) {
    res.json({ success: true, server: { name, ...newServerConfig } });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// 删除 MCP Server
app.delete('/api/mcp/servers/:name', async (req, res) => {
  const { name } = req.params;
  const config = await loadMcpConfig();

  if (config.mcpServers && config.mcpServers[name]) {
    delete config.mcpServers[name];
    if (await saveMcpConfig(config)) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '保存配置失败' });
    }
  } else {
    res.status(404).json({ error: 'Server 不存在' });
  }
});

// ========== 配置冲突检测和修复 API ==========

// 检测配置冲突
app.get('/api/config/conflicts', async (req, res) => {
  const conflicts = [];

  try {
    // 读取 .zshrc 内容
    const zshrcContent = await fs.readFile(ZSHRC_FILE, 'utf-8');

    // 检测硬编码的 ANTHROPIC_* 变量
    const anthropicVars = zshrcContent.match(/^export\s+ANTHROPIC_[A-Z_]+/gm);

    if (anthropicVars && anthropicVars.length > 0) {
      conflicts.push({
        type: 'zshrc_hardcoded',
        severity: 'error',
        message: `.zshrc 中发现 ${anthropicVars.length} 个硬编码的 ANTHROPIC_* 环境变量`,
        lines: anthropicVars,
        recommendation: '移除 .zshrc 中的硬编码配置，使用 Web UI 管理所有 API 配置'
      });
    }

    // 读取当前激活的配置
    const envConfig = await readEnvConfig();
    const config = await loadConfig();
    const activeProfile = config.profiles.find(p => p.id === config.activeProfile);

    // 比对当前环境变量和激活的配置
    if (envConfig && activeProfile) {
      const currentUrl = process.env.ANTHROPIC_BASE_URL;
      if (currentUrl && currentUrl !== activeProfile.apiUrl) {
        conflicts.push({
          type: 'env_mismatch',
          severity: 'warning',
          message: `Shell 环境中的 API URL 与激活配置不匹配`,
          current: currentUrl,
          expected: activeProfile.apiUrl
        });
      }
    }

    res.json({ conflicts, hasConflicts: conflicts.length > 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 自动修复配置冲突
app.post('/api/config/fix-conflicts', async (req, res) => {
  try {
    const zshrcContent = await fs.readFile(ZSHRC_FILE, 'utf-8');
    const lines = zshrcContent.split('\n');

    // 过滤掉 ANTHROPIC_* 相关的 export
    const fixedLines = lines.filter(line => {
      const trimmed = line.trim();
      // 保留注释和非 ANTHROPIC 的行
      return !trimmed.startsWith('export ANTHROPIC_');
    });

    // 添加注释说明
    const header = [
      '# ============================================',
      '# Claude API 配置 - 由 Web UI 管理',
      '# 请访问 http://localhost:3000 管理所有 API 配置',
      '# ============================================',
      ''
    ];

    const fixedContent = [...header, ...fixedLines].join('\n');
    await fs.writeFile(ZSHRC_FILE, fixedContent, 'utf-8');

    res.json({
      success: true,
      message: '已清理 .zshrc 中的硬编码配置',
      requiresRestart: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== API 健康检查 ==========

// 测试 API 配置是否可用
app.post('/api/profiles/:id/test', async (req, res) => {
  const { id } = req.params;
  const config = await loadConfig();
  const profile = config.profiles.find(p => p.id === id);

  if (!profile) {
    return res.status(404).json({ error: '方案不存在' });
  }

  try {
    const startTime = Date.now();

    // 构建测试请求
    const testUrl = profile.apiUrl.replace(/\/$/, '') + '/v1/messages';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(testUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': profile.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: profile.modelName,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const latency = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      res.json({
        success: true,
        latency,
        model: data.model || profile.modelName,
        message: 'API 连接成功'
      });
    } else {
      const errorText = await response.text();
      res.json({
        success: false,
        error: `API 返回错误: ${response.status}`,
        details: errorText.substring(0, 200)
      });
    }
  } catch (error) {
    res.json({
      success: false,
      error: error.name === 'AbortError' ? '连接超时（10秒）' : error.message,
      message: '连接失败，请检查 API URL 和 API Key'
    });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Claude Code Config 可视化配置管理器已启动`);
  console.log(`访问: http://localhost:${PORT}`);
  console.log(`按 Ctrl+C 停止`);
});
