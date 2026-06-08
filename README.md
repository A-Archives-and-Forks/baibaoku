# 柏宝库 BaiBaoKu

柏宝库是一个 SillyTavern server plugin，为纯前端扩展提供统一的本地 KV 数据库能力。

它对开发者暴露简单的 `open / set / set-many / get / get-many / delete / delete-many / keys / entries` 接口，底层使用 SQLite 保存数据。数据库文件会保存到当前 SillyTavern 用户的数据目录中，所以用户备份自己的 `data/<user>/` 文件夹时，柏宝库数据会一起被备份。

## 特性

- 每个数据库一个独立 SQLite 文件。
- `open(database)` 有则打开，没有则创建。
- 支持 `store + key + value` 的 KV 模型，value 类型包括 `json`、`text`、`blob` 和 `float32`。
- 支持 `ttl` 过期时间，适合缓存。
- 自动兼容 SillyTavern 单用户和多用户模式。
- 不开放 SQL，不允许前端指定文件路径。
- 没有 UI，只提供功能接口和开发者文档。

## 安装

详见 [docs/install.md](docs/install.md)。

简短版本：

```bash
cd SillyTavern/plugins
git clone <your-repo-url> baibaoku
cd baibaoku
npm install --omit=dev
```

然后在 SillyTavern `config.yaml` 中启用：

```yaml
enableServerPlugins: true
```

重启 SillyTavern 后访问：

```text
GET /api/plugins/baibaoku/v1/status
```

其他扩展也可以用这个接口探测柏宝库是否安装、当前版本号和 SQLite 驱动状态。

前端扩展也可以加载 companion 脚本：

```js
await import('/api/plugins/baibaoku/v1/client.js');
```

脚本会注册 `window.BaiBaoKu` 并派发 `baibaoku:ready` 事件。其他扩展可以先判断前端 bridge 是否存在，再调用 `window.BaiBaoKu.isAvailable()` 做后端和 SQLite 驱动细查。

## 数据位置

单用户模式：

```text
data/default-user/baibaoku/databases/<database>.sqlite
```

多用户模式：

```text
data/<user-handle>/baibaoku/databases/<database>.sqlite
```

柏宝库不会硬编码 `default-user`，而是使用 SillyTavern 当前请求中的 `req.user.directories.root`。

SQLite 使用 WAL 模式时会出现 `<database>.sqlite-wal` 和 `<database>.sqlite-shm`。柏宝库会在后端设置 WAL 保留上限，并在累计写入较多数据后自动执行 checkpoint/truncate；前端扩展不需要自己维护这些文件。

## 开发者文档

- [API 文档](docs/api.md)
- [前端调用示例](docs/sdk.md)
- [使用场景示例](docs/examples.md)

## 安全边界

柏宝库用于本地扩展数据和缓存，不是密钥管理器。不要用它保存 API key、密码、令牌或真实身份信息。

前端扩展运行在同一个页面环境中，柏宝库无法对不同前端扩展做真正的强隔离。数据库名用于组织数据，不应被当作安全权限边界。
