# 前端调用示例

柏宝库不强制提供前端 SDK。扩展作者可以直接用 `fetch`，也可以把下面的轻量封装复制进自己的扩展。

## 前端 companion

如果希望多个前端扩展复用同一个检测结果，可以先加载柏宝库 companion：

```js
await import('/api/plugins/baibaoku/v1/client.js');
```

加载后会得到：

```js
window.BaiBaoKu
```

也会派发：

```js
window.addEventListener('baibaoku:ready', (event) => {
  console.log(event.detail.version);
});
```

推荐判断顺序：

```js
if (!window.BaiBaoKu) {
  console.warn('柏宝库前端 bridge 未加载');
} else if (await window.BaiBaoKu.isAvailable()) {
  const db = window.BaiBaoKu.database('character-notes');
  await db.open({ displayName: '角色笔记', version: 1 });
}
```

## 最小封装

```js
import { getRequestHeaders } from '/script.js';

class BaiBaoKuClient {
  constructor(database) {
    this.database = database;
    this.baseUrl = '/api/plugins/baibaoku/v1';
  }

  static async open(database, options = {}) {
    const client = new BaiBaoKuClient(database);
    await client.request('open', options);
    return client;
  }

  static async status() {
    const response = await fetch('/api/plugins/baibaoku/v1/status');
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok) {
      return {
        installed: false,
        available: false,
        version: null,
        apiVersion: null,
        driver: null,
      };
    }

    return {
      installed: true,
      available: Boolean(payload.data.driver?.available),
      version: payload.data.version,
      apiVersion: payload.data.apiVersion,
      driver: payload.data.driver,
      raw: payload.data,
    };
  }

  static async isAvailable() {
    try {
      const status = await BaiBaoKuClient.status();
      return status.installed && status.available;
    } catch {
      return false;
    }
  }

  async set(store, key, value, options = {}) {
    return this.request('set', {
      store,
      key,
      value,
      ttl: options.ttl,
      type: options.type ?? options.valueType,
    });
  }

  async setMany(store, entries, options = {}) {
    return this.request('set-many', {
      store,
      entries,
      ttl: options.ttl,
      type: options.type ?? options.valueType,
    });
  }

  async get(store, key, fallback = null) {
    const result = await this.request('get', { store, key });
    return result.exists ? result.value : fallback;
  }

  async getMany(store, keys) {
    const result = await this.request('get-many', { store, keys });
    return result.entries;
  }

  async has(store, key) {
    const result = await this.request('has', { store, key });
    return result.exists;
  }

  async delete(store, key) {
    return this.request('delete', { store, key });
  }

  async deleteMany(store, keys) {
    return this.request('delete-many', { store, keys });
  }

  async keys(store, prefix = '', options = {}) {
    const result = await this.request('keys', {
      store,
      prefix,
      limit: options.limit,
      offset: options.offset,
    });
    return result.keys;
  }

  async entries(store, prefix = '', options = {}) {
    const result = await this.request('entries', {
      store,
      prefix,
      limit: options.limit,
      offset: options.offset,
    });
    return result.entries;
  }

  async clear(store, prefix = '') {
    return this.request('clear', { store, prefix });
  }

  async request(action, body = {}) {
    const response = await fetch(`${this.baseUrl}/${action}`, {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({
        database: this.database,
        ...body,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok) {
      const message = payload?.error?.message ?? `BaiBaoKu request failed: ${action}`;
      const error = new Error(message);
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }

    return payload.data;
  }
}
```

## 使用

```js
const db = await BaiBaoKuClient.open('character-notes', {
  displayName: '角色笔记',
  version: 1,
});

await db.set('settings', 'theme', { mode: 'dark' });

const theme = await db.get('settings', 'theme', { mode: 'light' });

const vectorItems = await db.getMany('vectors', [
  'item_001',
  'item_002',
  'item_003',
]);

await db.set('characters', 'char_123/profile', {
  memo: '喜欢雨天',
  updatedAt: Date.now(),
});

const characterKeys = await db.keys('characters', 'char_123/');
```

## 检测柏宝库是否安装

```js
async function isBaiBaoKuAvailable() {
  try {
    const response = await fetch('/api/plugins/baibaoku/v1/status');
    const payload = await response.json();
    return response.ok && payload.ok && payload.data.driver.available;
  } catch {
    return false;
  }
}
```

使用上面的封装时：

```js
const status = await BaiBaoKuClient.status();

if (!status.installed) {
  console.warn('柏宝库未安装');
} else if (!status.available) {
  console.warn('柏宝库已安装，但 SQLite 驱动不可用');
} else {
  console.log(`柏宝库版本：${status.version}`);
}
```
