#!/bin/bash
# Claude Code Config - 一键安装脚本
# 运行此脚本后，每次使用 claude 命令会自动应用最新配置

ENV_FILE="$HOME/.claude-api-env"
WRAPPER_FUNC="$HOME/.claude-wrapper"

# 创建包装函数
cat > "$WRAPPER_FUNC" << 'EOF'
# Claude API 配置包装器 - 自动应用最新配置
claude() {
    if [ -f "$HOME/.claude-api-env" ]; then
        source "$HOME/.claude-api-env"
    fi
    command claude "$@"
}
EOF

# 检查 .zshrc 是否已添加
ZSHRC_FILE="$HOME/.zshrc"
WRAPPER_LINE="test -f $WRAPPER_FUNC && source $WRAPPER_FUNC"

if grep -q "$WRAPPER_FUNC" "$ZSHRC_FILE" 2>/dev/null; then
    echo "✓ 已配置"
else
    echo "" >> "$ZSHRC_FILE"
    echo "# Claude API 配置包装器" >> "$ZSHRC_FILE"
    echo "$WRAPPER_LINE" >> "$ZSHRC_FILE"
    echo "✓ 已添加到 ~/.zshrc"
fi

echo ""
echo "=========================================="
echo "  安装完成！"
echo "=========================================="
echo ""
echo "请运行以下命令使配置生效："
echo ""
echo "  source ~/.zshrc"
echo ""
echo "之后每次使用 claude 命令会自动应用最新配置"
echo ""
