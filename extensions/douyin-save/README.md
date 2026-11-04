# 抖音链接转存

Aurabot 用户扩展。主人发来一条抖音链接，她把里面的**视频**或**图集**取下来，直接发回 QQ——视频走视频消息，图集一张张发图片。解析用本机的 [DouYinDownload](../../README.md)（`dtk`）MCP，下载和发送都在插件这边做。

只给主人私聊（「完整」权限）用。群聊、别人私聊里没有这个工具。

## 它怎么工作

```
QQ 链接 → douyin_save → dtk MCP parse_url（认出作品类型 + 媒体地址）
        → 视频：下载到 QQ 工作区 → OneBot video 段（单独成条）
        → 图集：逐张下载 → webp 转 jpg → 当图片发
        → 临时文件清掉
```

媒体只走本机到 QQ，**不进模型上下文**：36 MB 的视频对 token 的消耗是 0，模型只看到一句「视频发出去了」。

## 需要什么

- Aurabot（扩展接口 1），主人私聊是「完整」权限
- 本机装好 [DouYinDownload](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) 的 `dtk`，并且服务在跑（`dtk start`，或直接 `dtk dl <链接>` 它会自己拉起来）
- `ffmpeg` 在 PATH 里（图集的 webp 要转 jpg；没有就原样发 webp，QQ 不一定认）

## 安装

从本 repo 的 `extensions/douyin-save` 目录：

```sh
npm run install:module
```

默认装到 `~/.dsh/plugins-data/aurabot/modules/douyin-save`，遵守 `DSH_HOME`、`AURABOT_DATA_DIR`；也可以指定目标：

```sh
npm run install:module -- "D:/my-data/aurabot/modules/douyin-save"
```

没有依赖、不用构建。装好后 Aurabot 几秒内自动热重载，面板「扩展」页能看到它。

## 设置

面板「扩展 → 抖音链接转存」：

| 项 | 默认 | 说明 |
|---|---|---|
| MCP 地址 | `http://127.0.0.1:8000/mcp/` | 末尾斜杠要保留 |
| API Key | 空 | 留空时自动找：账号文件 → `dtk where` 指的项目目录里的 `console-account.txt` |
| 账号文件 | 空 | 想手动指定 `console-account.txt` 时填 |
| 收到链接就自动发 | 关 | 开着时，主人私聊里出现抖音链接就直接发，**她不再走正常回复**（只发媒体、不闲聊） |
| 视频怎么发 | 视频消息 | 发不了会自动改成当文件发 |
| 图集最多发几张 | 9 | 长图集只发前几张 |
| 视频大小上限 | 200 MB | 超过就不发，回一句提示 |
| ffmpeg 路径 | `ffmpeg` | 留空用 PATH 里的 |

## 用法

三种触发方式，确定性从低到高：

1. **发链接**：她自己判断（多数时候会发，尤其你说「下载」「发我」）
2. **`/dy <链接>`**：命令直达，不经过模型判断
3. **打开「收到链接就自动发」**：任何抖音链接都直接发

工具名 `douyin_save`，参数只有 `url`（链接或整段分享文案）。

## 已知边界

- **短链偶尔展不开**：dtk 会回一句 `retryable`，扩展隔 1.2 秒自动重试一次，再不行才报错
- **主页 / 直播 / 合集**：`parse_url` 认得出但不是作品，会回「没解析出这个作品」
- **视频当文件发**：QQ 视频消息这条路失败时的兜底，受面板「发文件」的目录和大小限制（默认 50 MB）
- **图集是 webp**：抖音图集基本都返回 webp，靠 ffmpeg 转 jpg；转失败就原样发
- **服务没开**：她会回「先跑 dtk start」，不会卡住

## 安全

- API Key 只在本机读、只发给 `mcpUrl`，不进日志、不进模型上下文
- 下载的媒体落在 QQ 工作区临时目录（`_douyin_tmp/`），发完即删
- 只有主人私聊能用；群聊里没有这个工具

## 测试

```sh
npm test
```

纯逻辑测试（链接提取、key 解析、MCP 响应解析、工具挂载范围），不联网、不碰 QQ。
