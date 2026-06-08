# 安装

柏宝库是 SillyTavern server plugin，不是普通前端扩展。

普通前端扩展通常安装到：

```text
public/scripts/extensions/third-party/
```

柏宝库需要安装到：

```text
SillyTavern/plugins/baibaoku/
```

## 安装步骤

```bash
cd SillyTavern/plugins
git clone <your-repo-url> baibaoku
cd baibaoku
npm install --omit=dev
```

然后修改 SillyTavern 的 `config.yaml`：

```yaml
enableServerPlugins: true
```

重启 SillyTavern。

## 验证安装

打开：

```text
GET /api/plugins/baibaoku/v1/status
```

正常响应：

```json
{
  "ok": true,
  "data": {
    "id": "baibaoku",
    "name": "柏宝库",
    "version": "0.1.0",
    "apiVersion": "v1",
    "storage": "per-user",
    "driver": {
      "available": true,
      "package": "better-sqlite3"
    }
  }
}
```

如果 `driver.available` 是 `false`，通常是没有在 `plugins/baibaoku` 中执行 `npm install --omit=dev`。

## 单用户和多用户兼容

柏宝库不固定写入 `data/default-user`。每次请求都会使用 SillyTavern 当前登录用户的目录。

单用户模式时：

```text
data/default-user/baibaoku/databases/my-extension.sqlite
```

多用户模式时：

```text
data/alice/baibaoku/databases/my-extension.sqlite
data/bob/baibaoku/databases/my-extension.sqlite
```

同一个数据库名在不同用户下会得到不同的数据库文件。

## 依赖说明

柏宝库使用 `better-sqlite3`。它是原生 Node 依赖，安装时可能需要当前系统能正常编译或下载预构建包。

如果安装失败，优先确认：

- Node.js 版本满足 SillyTavern 要求。
- 当前机器可以访问 npm registry。
- Windows 环境具备安装原生 Node 包所需组件。
