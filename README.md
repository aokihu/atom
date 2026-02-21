# atom

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts --workspace=./Playground
```

### Startup arguments

- `--workspace <path>` / `--workspace=<path>`
  - 工作目录，默认是启动时的当前目录（`process.cwd()`）。
  - 启动时会从 `<workspace>/AGENT.md` 加载提示词。
- `--config <path>` / `--config=<path>`
  - 指定配置文件路径，可选。
  - 未传时默认读取 `<workspace>/agent.config.json`。

示例：

```bash
bun run src/index.ts --workspace ./Playground
bun run src/index.ts --workspace ./Playground --config ./agent.config.json
```

## Tool permission config

Atom 会在启动时加载 `agent.config.json`（默认路径为 `<workspace>/agent.config.json`），用于限制 tools 的读写路径和网络访问地址。

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
    },
    "read_email": {
      "allow": [
        "^gmail\\.googleapis\\.com$",
        "^imap\\.gmail\\.com$",
        "^imap\\.mail\\.me\\.com$",
        "^outlook\\.office365\\.com$",
        "^imap\\.example\\.com$"
      ],
      "deny": []
    },
    "send_email": {
      "allow": [
        "^gmail\\.googleapis\\.com$",
        "^smtp\\.gmail\\.com$",
        "^smtp\\.mail\\.me\\.com$",
        "^smtp\\.office365\\.com$",
        "^smtp\\.example\\.com$"
      ],
      "deny": []
    }
  }
}
```

默认配置文件位于 `<workspace>/agent.config.json`。

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
