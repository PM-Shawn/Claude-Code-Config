#!/bin/bash
# Claude API 配置自动激活脚本
# 使用方法: 在终端运行此脚本，它会自动监听配置变化并激活

ENV_FILE="$HOME/.claude-api-env"
WATCH_INTERVAL=1

echo "🔄 Claude API 配置自动激活已启动"
echo "📁 监听文件: $ENV_FILE"
echo "按 Ctrl+C 停止"
echo ""

last_checksum=""

# 保存原始环境变量
ORIGINAL_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN"
ORIGINAL_BASE_URL="$ANTHROPIC_BASE_URL"
ORIGINAL_MODEL="$ANTHROPIC_MODEL"

while true; do
    if [ -f "$ENV_FILE" ]; then
        # 计算文件校验和检测变化
        current_checksum=$(md5 -q "$ENV_FILE" 2>/dev/null || md5sum "$ENV_FILE" 2>/dev/null | cut -d' ' -f1)

        if [ "$current_checksum" != "$last_checksum" ]; then
            # 读取并应用新的环境变量
            source "$ENV_FILE"

            # 显示激活信息
            echo "✓ 配置已激活 $(date '+%H:%M:%S')"
            echo "  模型: $ANTHROPIC_MODEL"
            echo "  API:  $ANTHROPIC_BASE_URL"

            last_checksum="$current_checksum"
        fi
    fi

    sleep $WATCH_INTERVAL
done
