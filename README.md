# atom

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Tool permission config

Atom 会在启动时加载项目根目录下的 `agent.config.json`，用于限制 tools 的读写路径和网络访问地址。

### 规则说明

- 每个工具支持 `allow` / `deny` 两组正则。
- `deny` 优先级高于 `allow`。
- 如果未配置 `allow`，默认允许（仅受 `deny` 限制）。
- 如果配置了 `allow`，则必须命中其中至少一条才允许。
- 支持两个路径变量：`{workspace}`（当前工作目录）与 `{root}`（系统根目录），会在加载配置时自动展开为正则安全的绝对路径文本。

### 配置示例

```json
{
  "tools": {
    "read": {
      "allow": ["^{workspace}/src/.*", "^{workspace}/.*\\.md$"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "ls": {
      "allow": ["^{workspace}/.*"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "tree": {
      "allow": ["^{workspace}/.*"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "ripgrep": {
      "allow": ["^{workspace}/src/.*", "^{workspace}/.*\\.md$"],
      "deny": ["^{workspace}/.*/secret.*"]
    },
    "write": {
      "allow": ["^{workspace}/Playground/.*"],
      "deny": ["^{workspace}/src/.*"]
    },
    "webfetch": {
      "allow": ["^https://docs\\.example\\.com/.*"],
      "deny": ["^https?://(localhost|127\\.0\\.0\\.1)(:.*)?/.*"]
    }
  }
}
```

项目根目录内附带了一个可直接修改的默认模板文件：`agent.config.json`。

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
